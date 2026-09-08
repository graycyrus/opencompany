# Product analytics: the OpenPanel wire contract

Split out of [analytics.md](analytics.md), which owns the policy — which
installs report, under what identity, and what a payload may contain. This file
owns the one HTTP call: how the body is delivered, how the credential is
presented, and what the collector does with each.

`POST {OPENCOMPANY_ANALYTICS_ENDPOINT}`, one request per event, JSON body.

The details below were read from OpenPanel's own source at commit
`3060ca10213693cf0385be2713c8743d16733a2b` — `packages/validation/src/track.validation.ts`,
`apps/api/src/utils/auth.ts`, `apps/api/src/controllers/track.controller.ts`,
`packages/constants/index.ts` — because its published docs are thinner than the
schemas and disagree with them in at least one place (they describe rate
limiting on `/track` that the router does not register).

**Headers.** Authentication is two of them, and the id must be a UUIDv4 or the
collector answers `401` before it looks at anything else:

| Header | Value |
|---|---|
| `openpanel-client-id` | `OPENCOMPANY_ANALYTICS_CLIENT_ID` — a **write** or **root** client |
| `openpanel-client-secret` | `OPENCOMPANY_ANALYTICS_CLIENT_SECRET` |
| `openpanel-sdk-name` | `opencompany` |
| `openpanel-sdk-version` | the crate version |

Both credential values are marked sensitive on the `HeaderValue`, which keeps
them out of `reqwest`'s own `Debug` and out of HPACK's shared table on HTTP/2.

A credential in a header rather than in the body is the quiet improvement in
this change. Mixpanel wanted its token stamped into every event's property bag,
so the transport reached into a rendered payload and mutated it — which meant a
captured body, a recorded event or a test fixture *could* carry it, and nothing
but care stopped one. There is now no code path that could put a credential in a
payload, and `no_credential_reaches_the_request_body` asserts it on the wire.

**Body.** A discriminated union on `type`. Only the `track` variant is used:

```json
{
  "type": "track",
  "payload": {
    "name": "turn_finished",
    "profileId": "i_0123456789abcdef0123456789abcdef",
    "properties": { "outcome": "ok", "duration_ms": 12, "__timestamp": "2026-09-08T12:00:00Z" }
  }
}
```

`name` is `z.string().min(1)` plus the refusals listed above; `properties` is
`z.record(z.string(), z.unknown())`; `profileId` is a string or a number.
`groups` exists and is unused here.

**There is no batch endpoint and no array body.** `/track` takes one object. The
only bulk path, `POST /import/events`, refuses a `write` client outright and
inserts raw ClickHouse rows, bypassing sessions, geo and the queue — it is a
migration tool, not a batching one. So the transport that used to POST a whole
batch now issues one request per event; see [the drain](#failure-is-silent-and-the-drain-gives-up-early).

**Timestamps are arrival time unless the body says otherwise, and this client
says otherwise.** OpenPanel's `timestamp` is not a field in the track schema at
all; the event time is read from `properties.__timestamp`, which the server then
strips before storage. This matters because events are queued for up to thirty
seconds — longer after an outage — so arrival time would record a burst of turns
as all having happened at the moment a drain finally succeeded. Each event is
stamped when it is tracked, second-precision RFC-3339 UTC, from the crate's one
date formatter rather than a second copy of the arithmetic.

Two server-side clamps apply to that field, and neither is a problem here: a
value more than **60 seconds in the future** is discarded for arrival time (this
process only ever stamps the past), and a value more than **15 minutes in the
past** marks the event a backfill, which makes it session-less on the server
(this is a server-side client with no browser session, and events are attributed
by `profileId`).

**Responses.** `200` with `{"deviceId", "sessionId"}` on success. `202` also
means accepted-and-dropped — bot suspicion, or a cloud wind-down — and is
treated as success here because a `2xx` is the collector's answer either way.
`401` is a plain-text body, not JSON, and is the one status this transport
treats as more than a dropped event: see below. Two other behaviours are worth
knowing and neither applies to this client, which sends no `Origin` header:
requests with `ip`, `origin` and a client id are de-duplicated by content hash
inside a 100 ms window, and a verified secret exempts a request from bot
detection.

## Failure is silent, and the drain gives up early

`Tracker::track` is synchronous, infallible and returns nothing, so a call site
cannot await a network or branch on a telemetry error. A dead collector drops
events after one `debug!` line.

The queue is what makes that possible without batching. Losing the batch
endpoint invites the obvious simplification — drop the queue and fire a request
from `track` itself — and it is the wrong trade twice over: `track` is on a
turn's hot path and cannot await, so firing from it means spawning a task per
event, which is unbounded concurrency against a collector this process does not
control, with no back-pressure and no ceiling on memory. The queue bounds both.
At most 500 events exist at once — if the collector is unreachable long enough
to fill it, the right outcome is losing telemetry, not a tenant container — and
at most one drain runs at a time.

**A transport failure abandons the rest of the drain.** Each request has its own
5s timeout, so a full queue against a black-holing collector would be
`500 × 5s`: over forty minutes of proving the same thing five hundred times,
during which the shutdown flush is blocked behind the same lock and the
container's `SIGTERM` budget is long gone. The collector is down, the remaining
events are going nowhere, and the next interval tries again with whatever has
accumulated since. `an_unreachable_collector_costs_one_timeout_for_the_whole_drain`
asserts it on connections a black-hole listener actually accepted — one, not
three — rather than on elapsed time, which would be a flaky test.

**An HTTP status failure does not.** That is a per-event answer — a rejected
name, a body the collector will not take — and the events behind it may be fine;
treating the two alike would let one malformed event silence a whole drain.

**A `401` is the exception on both counts.** It is not a per-event answer at
all: it is the collector's verdict on this process's credential, so every event
behind it in the queue gets the same one. Carrying on would fire up to 500
requests every thirty seconds for the life of a misconfigured tenant — a
thousand a minute at the operator's own collector — to learn something already
known, so it abandons the drain like a transport failure does.

It is also the one failure said out loud. Every other failure here is transient
and deserves the `debug!` #1739 settled on. A refused credential resolves itself
never: every event for the rest of the process's life is dropped, boot said
"reporting to …", and the only trace is a line nobody has enabled. So it is a
`warn!` — said **once**, because the condition is permanent and repeating it
would drown a busy tenant's log — naming the two variables to fix and the
UUIDv4 requirement on the client id, and never the credential.

`a_refused_credential_stops_the_drain` and `a_refused_event_does_not_stop_the_drain`
are the same collector, the same three events and one status code apart, with
opposite outcomes. Neither means much without the other.
