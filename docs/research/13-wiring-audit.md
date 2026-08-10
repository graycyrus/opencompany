# Wiring Audit — What Is Not Connected

Produced 2026-07-30 against `ca249a7`, after the large email/finances/usage/tour
merge. Five parallel audits (backend HTTP, frontend, harness/runtime, workflows,
email+storage) plus direct empirical probing of a running host.

Companion to [`docs/spec/feature-audit/STATUS.md`](../spec/feature-audit/STATUS.md),
which asks *"is the capability built?"*. This asks a narrower question:
**of the code that exists, what is not connected to anything?**

Every claim carries a `file:line` or a reproducible command.

## Method

Static reading was not trusted alone. The default build was compiled, launched
against `companies/agentic_software_company`, authenticated through the real
magic-link flow, and driven end to end. Where an audit claim was severe, it was
re-verified by hand before being recorded here. Two claims from the prior audit
were found **fixed**; three were found **still true**.

## The headline

The system has two execution paths that never coexist, selected by a cargo
feature that CI never compiles.

| | Default build (`--features oauth`) | `--features openhuman` |
|---|---|---|
| Brain | `EchoBrain` (`src/brain/echo.rs:42`) | `HarnessBrain` (`src/harness/brain.rs:466`) |
| Tools | canned failure (`src/runtime/tools.rs:66`) | real toolbelt (`src/harness/build.rs:150+`) |
| Effects / approvals / journal | wired, but only ever sees `echo.noop` | **never invoked** |
| Workflow execution | 404 `not_wired` | real executor |
| CI coverage | yes | **no** |

Proof the default build is an echo, taken from the running host:

```
POST /api/v1/company/chat  {"message":"Ship a login page. Assign it and start the feature_pipeline workflow."}
→ {"responses":[{"channel":"operator","text":"You said: Ship a login page. Assign it and start the feature_pipeline workflow."}]}
```

`.github/workflows/ci.yml:47-50` runs bare `cargo clippy --all-targets` and
`cargo test` with default features. `Cargo.toml` sets `default = ["oauth"]`.
**15,206 lines under `src/harness/` and 3,359 under `src/workflows/` are never
compiled or tested in CI** (`src/lib.rs:16-17,36-37`).

That is not theoretical. A broken target is sitting in the tree right now:

```
cargo check --features openhuman --examples
error[E0063]: missing fields `overlay_desk_order` and `overlay_desks`
             in initializer of `CompanyRecord`
  --> examples/live_company_turn.rs:84:18
```

The library itself still compiles under `openhuman`; only the example is broken.
But nothing in automation would have told you.

---

## Severity 1 — The production brain is disconnected from the runtime

This is the single most consequential finding, and it is new.

**`HarnessBrain::run_cycle` ignores its `CycleHost`.** `src/harness/brain.rs:466`
takes `_host: &dyn CycleHost` — underscore-prefixed, and never used. Verified:
grep for `host.` across the function body returns nothing.

Everything reached through that host is therefore dead on the production path:

| Machinery | Entry point | Status under harness |
|---|---|---|
| Policy gate / approval parking | `src/runtime/cycle.rs:425` | never called |
| At-most-once effect journal | `src/runtime/cycle.rs:271,285` | never called |
| Tool grant enforcement | `src/runtime/cycle.rs:511` | never called |
| `send_email` interception | `src/runtime/cycle.rs:511-514` | never called |
| `ApprovalPolicy::effect_for` | `src/harness/policy.rs:115` | **zero production callers** |

The gate, the journal, the TTL sweep, the amend path and the console approval
routes are all fully implemented and unit-tested — against a brain that is not
shipped. When a harness agent's tool hits `RequireApproval`, OpenHuman fails it
closed: the agent is told no, nothing is parked, nothing reaches the operator.
The park → resolve → resume flow does not exist in production.

**The same function silently drops three of five event kinds.**
`src/harness/brain.rs:527` is `_ => {}`, then `:531-538` pushes a hardcoded
`"Acknowledged."`. Only `OperatorMessage` and `TaskDispatched` are handled.
Dropped, each with a live producer:

- `ScheduleFired` (`src/runtime/scheduler.rs:158`) — **every cron schedule a
  company configures fires into a cycle that answers "Acknowledged." and does
  nothing.**
- `WebhookReceived` (`src/server/ops/inbox.rs:94`, `src/server/hooks.rs:129`) —
  **inbound email is stored and displayed, but no agent ever reads it.**
- `A2aTaskReceived` (`src/server/a2a.rs:311`).

Note the direction of travel: `EchoBrain` (`src/brain/echo.rs:54-81`) *does*
handle `WebhookReceived`. The richer brain regressed coverage.

**Single highest-leverage fix in the repo:** route OpenHuman's
`ToolPolicyDecision::RequireApproval` through the already-written
`ApprovalPolicy::effect_for` → `host.emit_effect` → `gate_effect` path, and add
the missing event arms. That one change makes the entire tested
gate/journal/approval machinery load-bearing.

---

## Severity 2 — Three prior findings are still true

Re-verified by hand today.

**`never_do` hard-deny is a comment.** `grep -rn "never_do" src/` returns exactly
two hits, both comments (`src/policy/gate.rs:6,211`). There is no code, no field,
no list. Step 1 of the documented approval taxonomy does not exist — a charter
prohibition like "never contact my customers directly" is unenforceable.

**`budget_usd_daily()` has zero callers.** Verified:
`grep -rn "\.budget_usd_daily()" src/ tests/ examples/` → nothing. The value is
parsed, validated against negatives (`src/company/manifest.rs:137-141`), stored
(`src/company/types.rs:209`), threaded into the policy
(`src/harness/mod.rs:1178,1214`), stored on the struct (`src/harness/policy.rs:69`)
— and never read by `check()` (`policy.rs:133-174`). A teammate capped at $5/day
gets `Allow` on a $50 call.

*Partial mitigation on a different axis:* a genuinely wired budget landed for
issue #108 — `capability_budget.rs:50` is called per turn and fails closed. But
it meters **tokens per tool namespace**, not **USD per agent**.

**Policy-denied effects leave no durable record.** `src/runtime/cycle.rs:453-455`
returns `Denied` and writes nothing. The sibling arms journal
(`record_executed`, `record_parked`); `src/runtime/journal.rs` has no
`record_denied` at all. A denial is invisible to audit, export and console.

### Two prior findings are fixed — credit where due

**Cost metering is no longer zeros.** `src/harness/mod.rs:445-451` reads
OpenHuman's now-public `last_turn_usage()`; every attempt is metered at `:981`.
Cost attribution reads the *live* provider slug per turn (`:977`), so a BYOK
switch re-attributes correctly.

**Per-agent tool narrowing works on the harness path.**
`src/harness/mod.rs:1177,1215` call `agent_effective_grants(...)` and `build.rs`
gates each namespace individually. Caveat: `ports::types::ToolCall`
(`src/ports/types.rs:619-624`) still carries no agent identity, so the port-level
provider can only enforce the company-wide union — moot only because nothing
calls it under the harness.

---

## Severity 3 — Effects that silently succeed without happening

`perform_effect` (`src/runtime/cycle.rs:285-334`) is not a match — it is three
independent `if`s (ledger row, channel message, email send) followed by `Ok(())`.
**No fallback arm, no warning, no error.**

An approved effect of any other kind — `payment.send`, `contract.sign`,
`filing.submit`, `x402.spend`, `a2a.engage` — runs through, gets its journal key
committed as *executed*, and performs no side effect. This is the dangerous
shape: the at-most-once guard (`cycle.rs:276`) will now refuse to ever retry it.

Meanwhile the classification vocabulary is far richer than the executor:
`src/brain/medulla/effects.rs:179-201` maps all of those kinds.

Related: **`AgentEconomy` is 2 of 5 methods wired.** `ensure_registered` and
`publish_card` have callers; `send_a2a_task`, `quote` and `pay` have **zero**.
The x402 payment and agent-hiring flows — the substance of
`src/economy/adapter.rs` (678 lines) — are constructed and never called.
`src/economy/outbox.rs:53` `drain()` likewise has no caller, so queued retries
accumulate in memory and are never retried or persisted.

---

## Severity 4 — Email: fetched, filed, and ignored

The plumbing is real and careful. The consumer is missing.

**Inbound** — `src/runtime/mailbox_poller.rs` is not an orphan: it is spawned
from `src/bin/opencompany.rs:844`, and the tick logic (`:61-98`) does thoughtful
work (fetch without `\Seen`, ack only after durable filing, per-message failure
isolation). Its payoff lands on `CompanyEvent::WebhookReceived` — which
Severity 1 shows the harness brain drops.

**Outbound** — three independent breaks mean no agent in any shipped
configuration can send mail:

1. The harness brain ignores the host, so the `send_email` interception at
   `cycle.rs:511-514` is unreachable.
2. The harness toolbelt has no email tool at all (`src/harness/build.rs:150-390`).
3. The advertised `ToolSpec` (`src/feedback/tool.rs:82-99`) is dead —
   `ToolProvider::catalog()` is never called by any brain. No shipped
   `company.toml` lists `send_email`.

**A guard that can never pass in the deployment it targets.** Both the sender
(`src/bin/opencompany.rs:235-236`) and poller (`:320-323`) require
`company_id == local_part(OPENCOMPANY_MAIL_ADDRESS)`. But in shared-DB mode the
company id is tenant-namespaced to `<tenant>--<slug>`
(`src/app/types.rs:123-128`), while the mailbox is `<tenant-slug>@…`. **The guard
can never match, and neither branch logs a warning.** Silent no-op.

`smtp` and `imap` are non-default features, so none of this is compiled by CI
either. The per-tenant env vars (`OPENCOMPANY_MAIL_ADDRESS`, `_SMTP_HOST`,
`_IMAP_HOST`, `_USER`, `_PASSWORD`, `OPENCOMPANY_MAIL_POLL_SECONDS`) are
documented nowhere outside the plan docs — `docs/spec/runtime/config.md:63-68`
covers only the host-level vars.

---

## Severity 5 — Workflows: the executor is real; everything around a run is not

The prior audit line *"running a workflow is impossible"* is **no longer true**.
There is a genuine executor, all 12 node kinds have real arms, and the caps layer
enforces real security (SSRF guard proven by test at `src/workflows/runner.rs:659`;
tool sandboxing at `caps/tools.rs:53-107`).

Empirically, on the default build:

```
POST /api/v1/company/workflows/feature_pipeline/run
→ 404 {"error":"workflow execution is not wired in this deployment","code":"not_wired"}
```

What is missing is the run's whole lifecycle:

| Need | Status |
|---|---|
| Execute the graph | **wired** (needs `--features openhuman`) |
| A persisted run entity | **missing** — `WorkflowRun` is a return value, not a record. No run id surfaced, no history, no restart survival |
| Watch progress live | **missing** — agent turns use `LiveStream::Off` (`src/harness/mod.rs:849`), so no frames, no timeline |
| Pause / cancel / steer | **missing** — `run_background` installs no `SteerControl` |
| Approve a gated node | **seam-only** — engine pauses correctly, but `resume*` is called nowhere; the only way to clear a gate re-runs every prior node, repeating side effects and spend |
| Fire on a schedule | **missing** — `Schedule` has only `cron` + `prompt`; no workflow binding |
| Fire on inbound event | **missing** |
| Edit the graph | **missing** — router has only create/list/get/run; no PUT/PATCH/DELETE |

Two more: the run is a single blocking HTTP request with **no timeout** across 7
sequential agent turns (`src/server/ops/workflows.rs:624`), so a proxy timeout
loses the result permanently — it was never written down. And the shipped
`feature_pipeline` graph has a `condition` node with no `config`
(`feature_pipeline.toml:45-49`), so it tests the whole item for truthiness and
**the `yes` branch fires 100% of the time** — the `no` edge is decorative.

Also worth fixing: the console's `POST /workflows` re-implements creation inline
(`ops/workflows.rs:413-558`) instead of calling the hardened
`create_company_workflow` (`src/company/workflow_create.rs:80`) that its own doc
comment says is used by both surfaces. The console path therefore skips the size
caps, the name-uniqueness check, the `company_write_lock`, and the
`WorkflowCreated` audit event.

---

## Severity 6 — Console surfaces that show invented data

Four operator-facing screens render fabricated content while a real backend
endpoint sits unused.

| Screen | What it shows | Backend that exists and is not called |
|---|---|---|
| Workspace | `seedWorkspace()` fabricates "Spring launch.md", "Brand voice.md" — `lib/workspace.ts:158-198`, localStorage | `src/server/ops/workspace.rs:23-26` |
| Inbox | `seedMessages()` fabricates mail from "Priya Sharma", "receipts@stripe.com", "Figma" — `lib/inbox.ts:83-134` | `src/server/ops/mail.rs:19`, `ops/inbox.rs:42` |
| Team | falls back to a fabricated 6-person roster whenever `/team` 404s **or returns empty** — `views/TeamView.tsx:70,75` | — |
| Chat threads | opens on three invented desks — `lib/threads.ts:39-59` | — |

Two buttons in Settings → Domain are pure toasts: "Verify DNS"
(`domain-settings.tsx:135-141`) and "Test connection" (`:278-284`), while
`ops/domain.rs` and `ops/smtp.rs` both exist.

**Security issue in that same screen:** the SMTP password is written to
`localStorage` in plaintext (`lib/domain.ts:82-88`, key `oc-mail:*`), and the DNS
records the operator is told to add to real DNS are generated from a *client-side
hash* (`lib/domain.ts:46-64`). This should go to `PUT {scope}/smtp`.

**8 of 11 connection tiles can never connect.** The backend supports `slack`,
`google`, `gmail`, `github` (`ops/connections.rs:70-87`); the catalog also ships
`google-calendar`, `notion`, `google-drive`, `dropbox`, `stripe`, `hubspot`, `x`,
`linkedin` — every one fails with "provider not enabled". Two are already
commented `// DEAD TILE` in the source (`lib/connections.ts:52-56,73-75`).

**And the OAuth that does work stores tokens nothing consumes.** Every reader of
the `oauth/{provider}` key is a read-only status projection
(`ops/connections_read.rs:56`, `graphql/connections.rs:113`). "Connect GitHub"
completes the dance, persists a bearer, turns a dot green — and no agent can use
it.

**`McpServersView.tsx` (402 lines) is imported nowhere** — not in the view union,
nav, titles or `<main>`. It is unreachable, and three of the client methods it
uses target routes the backend does not have (`/connect`, `/disconnect`,
`/tools/{tool}/call`). Two more that do exist have response-shape mismatches.

Clean, for the record: **Finances, Usage, Memory, Tasks, Desks, DeskCreateDialog,
Connections (OAuth/MCP/Inference/Composio/Channels), Overview, Settings and
Conversation are all genuinely wired** to real endpoints. `finance-sample.ts` and
`usage-sample.ts` are gone and unreferenced. The onboarding tour is mounted
(`app-shell.tsx:618`) and all 9 step anchors resolve. `use-events.ts` is real SSE
(`:147`), not polling.

One risk there: `package.json` pins `react-joyride: ^3.2.0` and the code uses the
v3-only API (`m.Joyride` named export, `skipBeacon`, `options.before/after`). If
the tree resolves to 2.x, the tour silently no-ops.

---

## Severity 7 — Test and storage coverage holes

**`SecretStore` has zero conformance cases.** Three production impls
(`fs.rs:641`, `sqlite.rs:712`, `mongodb.rs:655`), no contract tests — despite
holding OAuth tokens, the Composio bearer, SMTP passwords and the ingest HMAC
secret. Cross-company isolation for secrets is untested; `SecretStore` is not
even imported in `conformance.rs`.

**MongoDB conformance still silently no-ops.** All 15 tests are
`let Some(s) = store().await else { return };` (`mongodb.rs:1726-1824`) — a green
pass that asserted nothing when `OPENCOMPANY_TEST_MONGODB_URI` is unset. And the
`mongodb` feature is not compiled in CI at all.

**`overlay_agents` still has no round-trip case** (`conformance.rs:76` builds an
empty vec) — the prior finding stands.

**`OwnershipStore` has no conformance case and only MongoDB implements it**
(`store/select.rs:314-326`). For `sqlite`/`fs` the handle is `None`, so
`state.set_owner` (`bin/opencompany.rs:258-263`) silently skips — **tenant
ownership is lost on restart in sqlite tenant-namespace deployments.**

**Export still has no redaction choice.** `ExportOpts` has two fields
(`store/export.rs:62-70`); `read_via_ports` unconditionally pulls the full
ledger, **all** memory traces (`recent_traces(id, usize::MAX)`, `:175`) and **all**
context chunks with bodies (`:177-181`). Only CLI-reachable, so not an HTTP leak
— but a bundle shared for support carries every agent memory trace verbatim.

---

## Smaller items worth a sweep

- **GraphQL is healthy but console-unreachable.** 976 lines of schema, 12
  resolver modules, `sdl()` asserted byte-equal to `schema.graphql`
  (`graphql/test.rs:616`) — and zero `/graphql` references in the frontend.
  Verified working by hand: `{ company { id name } }` returns real data.
- **The SSE events stream emits nothing in the default build** — verified with a
  3-second subscription. `src/turn_stream.rs` publishers are all
  `#[cfg(feature = "openhuman")]` + `LiveStream::On`.
- **`POST /chat` is still buffered JSON**, not SSE (`operator.rs:940-965`). Live
  progress rides the separate events stream.
- **Overlay teammates get the broadest grants on the roster.**
  `harness/mod.rs:1244-1252` hardcodes `tools: Vec::new()`, which makes
  `agent_effective_grants` fall back to the full company-wide allow list. Also
  `tier: None` → always `chat-v1`.
- **`OPENCOMPANY_BRAIN_MODE` has no observable effect** — both arms degrade to
  `EchoBrain` without `--features medulla`/`sidecar` (`builder.rs:1379-1429`).
- **`HostedProvider` is dead** — constructed only in `#[cfg(test)]`.
- **`toolbelt::subagent_tools()` returns an empty vec** (`toolbelt.rs:363`) —
  honestly documented, but a company can grant `subagent` and get nothing.
- **`src/server/ops/workspace.rs` is write-only** — POST/PUT/PATCH/DELETE with no
  GET. Inbox REST similarly has ingest and mark-read but no list.
- **Dead client functions**: `logout` (no sign-out control exists anywhere in the
  console), `setPassword`, `healthz`, and all six MCP methods.
- **Comment rot** — three files claim an API doesn't exist when it does:
  `lib/tasks-sample.ts:1`, `lib/workspace.ts:3`, `lib/domain.ts:2`.

---

## Recommended order

1. **Close the `CycleHost` seam in `src/harness/brain.rs`.** Unblocks approvals,
   the journal, tool grants, `send_email`, and makes the tested machinery real.
2. **Add the missing event arms** at `brain.rs:527` — cron and inbound mail stop
   being silent no-ops. Cheap, and finishes the mailbox poller that already works.
3. **Build the real feature set in CI.** Add an `--features openhuman,mcp,smtp,imap`
   job. It would already be catching the broken example. Everything in this report
   that says "never compiled" descends from this.
4. **Add a fallback arm to `perform_effect`** that errors instead of silently
   committing an unexecuted effect as done.
5. **Fix the mailbox↔company guard** for tenant-namespaced ids, and log the
   non-matching branch.
6. **Persist a workflow run entity** — id, status, node attempts. Unblocks live
   progress, resume, and history in one move.
7. **Delete or wire the fabricated console surfaces.** Workspace, Inbox, Team
   fallback and thread defaults each have a real backend already; showing invented
   data is worse than showing an empty state.
8. **Move the SMTP password out of `localStorage`.**
9. **Conformance cases for `SecretStore` and `overlay_agents`**; make MongoDB
   conformance fail loudly rather than skip.
