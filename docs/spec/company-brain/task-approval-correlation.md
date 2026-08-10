# Correlating approvals to tasks

**Status:** design note for [#333](https://github.com/tinyhumansai/opencompany/issues/333).
**Blocked on [#242](https://github.com/tinyhumansai/opencompany/issues/242)** (first-class
run records). Nothing here is implemented.

Verified against `origin/main` @ `36c73c4` (2026-08-04), which includes
[#243](https://github.com/tinyhumansai/opencompany/issues/243)'s single-use grants
(`78b554c`). Every claim below carries a `file:line`.

---

## 1. What is broken

A task's **Approvals** tab is empty for every task, always — including a task with
a demonstrably pending approval.

The tab does not query approvals. It filters the task's timeline:

```tsx
// frontend/src/views/TaskDetailView.tsx:384
<ApprovalsTab entries={detail.timeline} />
// frontend/src/views/TaskDetailView.tsx:1036
const approvals = useMemo(() => entries.filter((e) => e.kind === "approval"), [entries]);
```

and the host admits an `approval` row into that timeline only while the task's
**run window** is open:

```rust
// src/server/ops/tasks.rs:688
CompanyEvent::ApprovalResolved { approval_id, verdict, by }
    if window_opened_at.is_some() => { … }
```

The window opens on `TaskDispatched` and closes on `DeskTaskCompleted`
(`src/server/ops/tasks.rs:643`, `:670`). The console already says so out loud:

> *"Waiting is correlated to this task's run window — approvals are not linked"*
> — `frontend/src/views/TaskDetailView.tsx:518`

### 1.1 Why it is empty *always*, not merely imprecise

The window is closed before the approval exists, and stays closed until long after.

1. `run_task` journals `DeskTaskCompleted` at the end of the dispatch, inside the
   event loop — `src/harness/brain.rs:553` → `:633`. **The window closes here.**
2. The approval-request queue is drained and parked *after* the whole event loop:
   `src/harness/brain.rs:1103` → `park_approval_requests` (`:897`) →
   `CycleHost::park_effect` (`src/runtime/cycle.rs:1028`) → `park`
   (`src/runtime/cycle.rs:744`). **The approval is born after the window shut.**
3. The operator resolves minutes or days later. `ApprovalResolved` is appended by
   `resolve_approval` (`src/runtime/cycle.rs:315`) with the window long closed, so
   the guard at `tasks.rs:692` drops it.

openhuman's `ToolPolicy` is fail-closed — it blocks the call and lets the turn
continue (`src/harness/policy.rs:9-18`) — so parking never suspends the cycle.
Every dispatched task therefore *completes*, closing its window, whether or not it
parked something. There is no ordering in which a resolution lands inside its own
task's window.

Two corollaries:

- **`waitingSince` is dead for the same reason.** It is gated on an open window
  (`src/server/ops/tasks.rs:538-546`), so the "In Review · waiting for your
  approval" station of [#183 §4] never lights up on a finished card.
- **The mirror bug is live.** If a *different* task is mid-dispatch when the
  operator approves, that task's window is open and absorbs the row. Issue #333's
  fourth acceptance box ("a second task worked in the same window must not absorb
  the first's approvals") is not hypothetical — it is the only way the current
  code can render an approval row at all, and it renders it on the wrong card.

### 1.2 There is nothing to correlate *with*

Parking emits **no `CompanyEvent` at all**. `ApprovalResolved`
(`src/ports/types.rs:264`) is the only approval-shaped event in the enum; the park
is journal-only (`JournalRecord::ApprovalParked`, `src/runtime/journal.rs:42`).
So even a perfect correlation key would let the timeline show *resolutions* and
never *pending* approvals — which is the state the tab most needs to show.

The identity chain, end to end, and what each hop knows:

| Hop | Code | Carries |
| --- | --- | --- |
| Policy blocks a tool call | `ApprovalPolicy::require_approval` — `src/harness/policy.rs:565` | tool, args, reason |
| Projected to an effect | `effect_for` — `src/harness/policy.rs:370` | + `agent` (#243) |
| Queued | `ApprovalRequest` — `src/harness/policy.rs:128` | as above |
| Parked | `ManifestApprovalGate::park` — `src/policy/gate.rs:293` | mints `ApprovalId` |
| Journaled | `record_parked` — `src/runtime/journal.rs:240` | id, effect, `at_millis` |
| Listed | `pending_approvals` — `src/company/runtime.rs:612` | id, kind, amount, at |
| Resolved | `ApprovalResolved` — `src/ports/types.rs:264` | approval id, verdict, actor |

**No hop carries a task, a run, or even a cycle id.** That is issue #333's one-line
summary, and it is accurate.

Note the precedent, though: #243 added `Effect.agent` (`src/ports/types.rs:612-629`)
as a serde-default optional field, swept across every literal in the tree, and
legacy journal lines replay as `None` with the old behaviour. The same shape works
for a run id.

---

## 2. Why the key must be `run_id`

Three candidate keys, and why two lose.

**(a) A time window — the status quo.** Rejected by acceptance criterion 4, and
independently broken by §1.1. A window is not a key; it is a guess that happens to
be wrong 100% of the time here.

**(b) `task_id` stamped straight onto the approval.** Tempting, and it *would*
light up the tab. It loses on three counts:

- **No attempt identity.** A card re-dragged into `in_progress` runs again
  (`src/server/ops/tasks.rs:570-576` documents exactly this). Attempt 1's denied
  approval and attempt 3's approved one would be indistinguishable in the tab.
- **Nothing to stamp it from.** The park site is `CycleHostImpl`
  (`src/runtime/cycle.rs:684`), whose only task context is whatever
  `CompanyEvent::TaskDispatched` happens to be in the cycle's event batch. Deriving
  a task from that batch is a second heuristic, in the same class as the window.
- **It re-invents #242.** `RunRecord` already carries `task_id` and `attempt`, and
  #242 already generates the id at the dispatch choke-point
  (`dispatch_task`, `src/company/runtime.rs:378`). Inventing a parallel key means #242 replaces
  it on landing — which is precisely why #333 is marked blocked.

**(c) `run_id` — chosen.** One id, minted once per attempt, resolving to a task via
`RunRecord.task_id` and to an attempt ordinal via `RunRecord.attempt`. It is a real
id, not a heuristic. It also lets the tab say *which attempt* an approval belonged
to, and it is the same key #242 uses for trace, status and cost — so approvals join
the run's story rather than sitting beside it.

`task_id` is **denormalised** onto the approval record alongside `run_id` so the
main Approvals page can label a card ("for *Describe Workflow*") in one read
without a run lookup. `run_id` stays authoritative; the denormalised copy is a
render convenience, never the join.

---

## 3. Exactly what #242 must expose

Six dependencies. Four are already in #242's plan; **D2, D4 and D5 are not**, and
should be raised on #242 before it is implemented, because retrofitting them later
touches the same choke-points twice.

### D1 — `RunRecord.task_id` + a task-scoped run query *(in #242's plan)*

`RunRecord { id, company, task, attempt, status, … }` and
`list_runs(filter)` filtering by task, per #242 §1–2. This is the `run_id → task_id`
half of the correlation. sqlite indexes `runs` on task already (#242 §3).

### D2 — the run id must be reachable **at the park site** *(NOT in #242's plan)*

#242 §4 threads `run_id` onto `CycleRequest` (`src/ports/types.rs:803`), which is
the *brain's* view. Parking happens on the **host** side:

```
brain.park_approval_requests  (src/harness/brain.rs:897)
  → CycleHost::park_effect    (src/runtime/cycle.rs:1028)
    → CycleHostImpl::park     (src/runtime/cycle.rs:744)
      → gate.park + journal.record_parked
```

`CycleHostImpl` (`src/runtime/cycle.rs:684`) holds `company`, `cycle_id`, `rt`,
`counter`, `executed`, `parked` — and no run. **Ask of #242:** add
`run_id: Option<String>` to `CycleHostImpl` and its constructor, populated from the
same value `CycleRequest` gets. It costs #242 one field and one constructor
argument; without it, #333 has to reopen the cycle plumbing #242 just settled.

Note this seam is *better* than threading the task through the harness queue:
`ApprovalRequestQueue` is a company-wide shared handle
(`src/harness/policy.rs:145`, one per `HarnessDeps`), so it cannot attribute a
request to a cycle. The host can, because it *is* the cycle.

### D3 — `WaitingApproval` must not be load-bearing *(compatible with #242)*

#242 §1 defines `RunStatus::WaitingApproval` and §6 exempts it from the boot
reaper, but its transition API is `create/begin/finish/append_step` — there is no
park transition — and #242 explicitly scopes out "approval resume into a
`WaitingApproval` run (v1 only records the state)".

**This design does not need it.** The correlation is by id, so an approval can hang
off a run that already reached `Succeeded`. That is the honest record of what
happens today: the turn finished, having been refused the tool. If #242 later adds
a park transition, the tab gets a better status word for free and nothing else
changes.

### D4 — the **resume** run must inherit the task *(NOT in #242's plan)*

This is the deepest finding, and it is invisible from #333's issue text.

When the operator approves a harness tool call, #243 mints a grant and
re-dispatches the agent (`src/runtime/cycle.rs:366-393` → `redispatch_granted_call`,
`src/harness/brain.rs:117`). That re-issued call is *the task's work* — it is the
thing the operator approved. But it is journaled with no task:

```rust
// src/harness/brain.rs:140  (the in-flight steer row)
task_id: None,
// src/harness/brain.rs:196  (the journaled AgentReply)
task_id: None,
// src/harness/brain.rs:209  (the returned bubble)
task_id: None,
```

So today, even with a fixed Approvals tab, the work an approval unblocks never
reaches the task's timeline, its artifacts, or its cost. Under #242 that follow-up
cycle is a run with `task_id = None` — an orphan attempt.

**Ask of #242:** do not treat `dispatch_task` (`src/company/runtime.rs:378`) as the
*only* run-creation site. The approval-resume cycle must be able to create a run
with the parking run's `task_id` and a link back to it (`resumes_run_id`, or simply
the next `attempt` on the same task). Everything needed is available: the grant
carries `approval_id` (`src/runtime/grants.rs`, `GrantedCall`), which resolves
through the park index (D5) to the parking `run_id`, which resolves to `task_id`.
`GrantedCall` (`src/runtime/grants.rs:74`) already carries the approval id for
exactly this kind of join.

This is what makes acceptance box 2 — "approving from either surface reflects on
both" — mean something rather than just flipping a badge.

### D5 — a place to put `run_id` on the approval *(NOT in #242's plan; #333's own work)*

Recommended shape, in preference order:

1. **`JournalRecord::ApprovalParked` gains `run_id: Option<String>` and
   `task_id: Option<String>`**, both `#[serde(default, skip_serializing_if)]`
   (`src/runtime/journal.rs:42`, written at `:251`). Pre-existing journal lines
   replay as `None` — the exact pattern #243 used for `Effect.agent`.
2. **`PendingApproval` (`src/runtime/journal.rs:106`) carries them through**, and
   `ApprovalSummary` (`src/runtime/types.rs:47`, built at
   `src/company/runtime.rs:612`) gains `runId` / `taskId` / `taskTitle`.
3. **Extend the existing park index rather than adding a second one.**
   `State.park_instants` (`src/runtime/journal.rs:129`) already maps
   `ApprovalId → parked-at`, is deliberately never pruned on resolve or expiry, and
   is already snapshotted per request by the task-detail read
   (`src/server/ops/tasks.rs:589`). Widening its value to
   `ParkFacts { at_millis, run_id, task_id }` reuses a structure whose append-only
   lifetime and per-approval cost are already accepted, and gives the resolution
   side its join for free — an `ApprovalResolved` event carries only the approval
   id, and that id is enough.

**Do not put `run_id` on `Effect`.** `Effect` is the policy-facing value object;
`agent` belongs there because it is a property of the *call* being described
(#243 uses it as the native-vs-harness discriminator, `src/ports/types.rs:612-629`).
A run is a property of the *cycle that parked it*, and the same effect could in
principle be parked by two cycles. Keeping it on the park record keeps `Effect`
free of runtime bookkeeping and keeps the grant-matching equality
(`serde_json::Value` on args) untouched.

### D6 — a task-scoped read *(extends #242 §9)*

#242 §9 gives `TaskDetail` a `runs[]` summary. Add `approvals[]` to the same
response rather than a second endpoint: #185's `TaskDetail` is explicitly "one read
for the whole screen" (`frontend/src/api/tasks.ts:112`), and the tab should not
regress that.

---

## 4. The correlation, end to end

Once D1–D6 exist:

```text
park        CycleHostImpl { run_id } ──stamps──▶ ApprovalParked { id, effect, at, run_id, task_id }
                                                        │
                                                        ├─▶ park index (ApprovalId → ParkFacts)
                                                        └─▶ pending queue (unchanged)

resolve     ApprovalResolved { approval_id, verdict, by }
                    │
                    └── join on approval_id ──▶ ParkFacts { run_id, task_id, at }

read        GET …/tasks/{id}
              1. list_runs(task = id)                → [run_id, attempt, status]
              2. park index lookup by run_id          → approval ids parked by those runs
              3. hydrate each: kind, amount, parked-at, verdict, resolved-at, waited
              4. TaskDetail.approvals[] ← that set, newest-parked first
```

No time window anywhere in that path.

### 4.1 Response shape

```ts
interface TaskApproval {
  id: string;
  kind: string;                              // "composio_execute", "email.send", …
  amountUsd?: number;
  agent?: string;                            // Effect.agent, when harness-projected
  runId: string;
  attempt: number;                           // which try parked it
  parkedAt: number;
  state: "pending" | "approved" | "denied" | "expired";
  resolvedAt?: number;
  waitedMillis?: number;                     // parked → resolved, exact
}
```

`state` is what the current tab cannot express at all. `pending` comes from the
live queue (`pending_approvals`), the three terminal states from the resolution
join — `expired` distinguished by `Actor.kind == System`, as
`src/server/ops/tasks.rs:705` already does.

### 4.2 What changes in the console

- `ApprovalsTab` takes `detail.approvals`, not `detail.timeline`
  (`frontend/src/views/TaskDetailView.tsx:384`, `:1036`).
- A `pending` row gets Approve/Decline buttons calling the same
  `client.resolveApproval` the main page uses
  (`frontend/src/views/ApprovalsView.tsx:60`) — one write path, so acceptance box 2
  holds by construction rather than by synchronisation.
- The apologetic caption ("correlated to the dispatch window, not linked per-task",
  `TaskDetailView.tsx:1040-1042`) is deleted, along with the header note at `:518`.
  A caption that explains an approximation must not outlive the approximation.
- The empty state stays exactly as it is (`:1046`) and is now *honest*: no records
  means none were parked.

### 4.3 What changes in the host

- **Delete the window arm** at `src/server/ops/tasks.rs:688-714`. This is a
  deliberate removal, not a leftover: while it exists, a neighbouring task's open
  window keeps absorbing foreign approvals (§1.1). The timeline keeps its
  `approval` kind, fed from the correlated set so a resolution appears in
  chronological order alongside replies.
- `waiting_since` (`:538-546`) is rebuilt from the correlated pending set instead of
  the window, which finally lights the "waiting for your approval" station on a
  card whose run has ended — the common case.

### 4.4 Legacy data

An approval parked before this ships has `run_id = None`. It appears on the main
Approvals page, as today, and on **no** task. That is the correct answer: we do not
know which task it belonged to, and #242 takes the same stance ("No backfill …
synthesising runs from old `AgentReply` events would fabricate identity").

---

## 5. Acceptance mapping

| Issue #333 acceptance | Made true by | Proven by |
| --- | --- | --- |
| An approval raised while working a task appears on its Approvals tab | D2 (stamp at park) + D6 (task-scoped read) | e2e: dispatch a card under `supervised` whose agent calls an external tool → `TaskDetail.approvals[0].state == "pending"` |
| Approving from either surface reflects on both | Single write path (§4.2) + D4 (resume run inherits the task) | e2e: approve from the main page → the tab's row flips to `approved`; the re-issued call's reply lands on the task's timeline |
| A task with no approvals shows the honest empty state | `approvals[]` empty, no window fallback | unit: a run with no parked effects yields `approvals == []` |
| The correlation is a real id, not a time-window heuristic | `run_id` join; window arm deleted (§4.3) | regression: two tasks dispatched concurrently, one parks — the other's tab stays empty. **This test fails on today's code**, which is the point |

---

## 6. Related findings (out of scope, worth their own issues)

1. **`ApprovalRequestQueue::push` dedupes without the agent.**
   `src/harness/policy.rs:171-179` compares `effect.kind` and `effect.payload` only.
   The queue is company-wide, so two roster agents making a byte-identical call in
   one cycle collapse to a single park — and #243's grant is agent-scoped
   (`GrantedCall`, `src/runtime/grants.rs:74`), so only the first agent can redeem it; the second
   re-parks on its next turn. Harmless today because nothing attributes an approval
   to an agent in the UI. Once approvals carry a run and an agent, it becomes a
   visible mis-attribution. Adding `agent` to the dedupe predicate is a two-line
   fix, but it changes queue behaviour and belongs in its own change.

2. **Parking still emits no event** (§1.2). This design routes around it via the
   journal park index, which is sufficient. But the operator-visible trail for
   "the company stopped and asked" lives only in `journal.jsonl`, outside the
   immutable event log every other surface reads. #243's notes already flag
   "moving approvals from `journal.jsonl` to a port-backed table" as a named
   sibling; that migration is the right home for this, and D5's records are
   self-contained per approval id so they lift cleanly.

3. **Non-task parks are permanently queue-only.** A workflow's cold-recipient park
   (#227) belongs to a workflow run, not a board card. It gets `task_id = None` and
   shows only on the main Approvals page. Correct, and worth stating so nobody
   later reads an empty tab as a bug.

---

## 7. Sequencing

```
#242 (runs)  ──must land first──▶  #333 (this)
   ▲                                  │
   └── D2, D4 raised on #242 before implementation ──┘
```

#333 touches `src/runtime/{cycle,journal}.rs`, `src/company/runtime.rs`,
`src/server/ops/tasks.rs`, `src/harness/brain.rs`, and the console's task-detail
files — a subset of #242's own contended set, so the two must be sequenced, never
parallelised. #243 is already merged and needs no change; this design consumes its
`Effect.agent` and grant records as-is.
