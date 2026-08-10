# Feature Spec — The Company in Glass

The product's defining idea, stated as six features: **everything an AI company
does is traceable, conversational, permissioned, and watchable in the open.**

This is the transparency layer that makes the "runs in public" thesis
([11-moat-thesis.md](11-moat-thesis.md)) real — a prospect can watch OpenCompany's
own AI team work, and a founder can trust their own because nothing is hidden.

Captured from product direction on 2026-07-21. Each feature is graded against
current source so the spec is honest about what exists versus what must be built.
Where wording is interpreted rather than quoted, it is flagged — correct anything
that reads wrong.

## The six features at a glance

| # | Feature | One line | Status today |
|---|---|---|---|
| F1 | **Task provenance** | Every task carries a full trail: where it came from, why, what it touched | mostly missing |
| F2 | **Task threads** | Every task has a conversation between the agents and humans working it | missing |
| F3 | **Per-agent allow-lists** | Each agent may only do what it is explicitly permitted | wrong shape today |
| F4 | **Per-agent autonomy** | Each agent (or action) is set to act alone or ask first | partial |
| F5 | **The company feed** | One live stream of everything, visible to anyone | backend is a seam |
| F6 | **Ask anything** | Anyone can ask any agent what it is doing, why, and what it can do | missing |

"Status today" is graded from the source audit
([03-internal-audit.md](03-internal-audit.md),
[../spec/feature-audit/STATUS.md](../spec/feature-audit/STATUS.md)).

---

## F1 — Task provenance

### What it means
Every task in the company carries a complete, immutable trail: **who or what
created it** (an operator message, a schedule, another agent, an inbound email),
**why** (the goal or upstream task it serves), **what it touched** (tools called,
files read or written, money spent), and **how it ended** (done, denied, waiting,
failed). Pick any task and walk its whole lineage in both directions.

### Why it matters
This is the backbone of trust and of the "Replay" wow factor. It is also the
thing bring-your-own-agent competitors structurally cannot build, because they do
not own the runtime that would record it
([11-moat-thesis.md](11-moat-thesis.md#the-one-structural-asymmetry)).

### What exists today
- An append-only `EventLog` port with per-company monotonic sequence numbers —
  the right foundation.
- Tasks exist as records, but `assignee` is an unvalidated free-form string
  (`src/server/ops/tasks.rs:104,140-141`) — a task can point at nobody.
- **Correlation is seam only.** The audit found "give every inbound event, cycle,
  task, tool call, approval, and payment a correlation id" unbuilt — there is no
  query that, given a task, returns the cycle and the event that produced it
  ([STATUS.md](../spec/feature-audit/STATUS.md), family 06).
- Policy-denied effects leave **no** record at all (`src/runtime/cycle.rs:362`).

### The gap
A task has no durable parent link, no child links, and no correlation id tying its
tool calls, approvals, and spend back to it. The trail is not partial — for tasks,
it barely exists.

### Acceptance criteria
1. Every task record carries a `source` (operator / schedule / agent / inbound)
   and, where applicable, a `parent_task_id`.
2. Given a task id, one read returns its origin event, every tool call and
   approval made under it, and the total spend — all by correlation id.
3. A denied action appears in the trail with its reason (needs
   [R3](09-feature-briefs.md#r3--enforce-never_do--journal-policy-denials)).
4. The trail survives a restart and is identical after replay.

### Depends on
[R3](09-feature-briefs.md) (denials journaled), a correlation-id thread through
`cycle.rs`, and F3 (so "which agent" is a real answer). Plan-sized.

---

## F2 — Task threads

### What it means
Every task has a conversation attached — a single thread where the agents working
it and the humans overseeing it talk: an agent explains what it is about to do, a
human answers a question or redirects, another agent hands off. The discussion
lives **with the task**, not in a separate chat.

### Why it matters
It turns a task from a status row into a story you can read. It is where F1's
trail becomes human — the *why* in the agent's own words — and it is what makes F6
("ask anything") have somewhere to land.

### What exists today
- "Desks" exist, but are built **only** from `manifest.group_chats`
  (`src/server/graphql/company.rs:225-241`), so an operator message today matches
  zero desks unless the manifest declares one.
- The harness has a **single responder** — every message in every desk is answered
  by `manifest.agents.first()` (`src/harness/brain.rs:41-47`); the desk id is
  dropped before it reaches cognition (`src/server/operator.rs:157-162`).
- No concept of a thread bound to a task exists.

### The gap
There is no per-task thread, and even the existing chat routes every message to
one hard-coded agent. Multi-party (agent + agent + human) discussion on a task is
not modelled at any layer.

### Acceptance criteria
1. Each task has a thread; posting to it appends a durable, ordered message with an
   author (agent id or human id).
2. An agent working the task can post to its thread, and a human reply is
   delivered to the agent on its next turn.
3. A handoff from one agent to another is a thread event, visible in F1's trail.
4. The thread is readable over the read API and survives restart.

### Depends on
Desk/task routing must be fixed first — see the rejected `desk-task-routing`
design and why ([10-design-review-log.md](10-design-review-log.md)). Large-plan.

---

## F3 — Per-agent allow-lists

### What it means
Each agent may do **only** what it is explicitly granted — its own tools, its own
data, its own spend limit. The marketing writer can draft and publish; it cannot
touch billing. Least privilege, per agent, enforced.

### Why it matters
It is half of what "accountable" means, and it is the precondition for F4 (an
agent can only "act on its own" within a boundary) and F1 (attribution needs to
know which agent could even have done a thing).

### What exists today — and why it is the wrong shape
- Grants are a **roster-wide union**: `effective_grants` dedups the allow-list
  across the *entire* company (`src/runtime/builder.rs:83-95`), and `ToolCall`
  carries no agent identity (`src/ports/types.rs:517-522`).
- **Consequence:** grant one agent `payment.send` and every agent has it. Per-agent
  least privilege is not merely unbuilt — on the current path it is
  *unimplementable* ([07-architecture-facts.md](07-architecture-facts.md#fact-1--there-are-two-tool-paths-and-they-do-not-meet)).

### The gap
Permissions exist as a company-wide pool, not a per-agent boundary. The fix is not
a new field — it is resolving grants per agent where the agent is actually built
(the harness), which the runtime already supports via a per-instance tool vector.

### Acceptance criteria
1. Two agents in one company end up with different tool sets from their manifest
   grants — proven on the shipped `signals_opportunity_studio` fixture.
2. An ungranted tool never enters an agent's dispatcher (default-deny on empty).
3. One agent cannot read another agent's workspace files.

### Depends on
This **is** [R4](09-feature-briefs.md#r4--per-agent-sandboxed-read-only-tools) —
the highest-leverage item on the roadmap. Read-only first; write and external
tools follow via [R5](09-feature-briefs.md). Small-plan.

---

## F4 — Per-agent autonomy

### What it means
Each agent — ideally each *kind of action* — is set to one of: **act on its own**,
or **ask for approval first**. The SEO researcher reads freely; the social poster
must get a human yes before anything goes public. The setting is per agent, not
one global switch.

### Why it matters
This is how you climb the trust ladder (F1–F4 of the four marketing jobs): risky
capabilities start gated, and you loosen them per agent as each earns it. It is
also "the human keeps the wheel," made granular.

### What exists today
- A real approval gate: `ManifestApprovalGate` is 482 lines of working
  park → resolve → resume with expiry, and it is the default
  (`src/runtime/builder.rs:751`). Effects are evaluated before execution
  (`src/runtime/cycle.rs:335-365`); unknown modes fail safe to require approval.
- **But policy is company-wide, not per-agent.** The mode lives on `[policy]`, and
  `budget_usd_daily()` — the per-agent knob — has zero callers
  (`src/harness/policy.rs:89-92`).
- `never_do` (hard "never, no matter what") is a stub with a permanently empty
  list (`src/policy/gate.rs:211-212`).
- **Tool approval never reaches a human.** `RequireApproval` on a tool call is
  turned into a model-facing error string and silently dropped
  ([07-architecture-facts.md](07-architecture-facts.md#fact-5--tool-approval-never-reaches-opencompany)).

### The gap
The machinery is real but bound company-wide and, for tools, unwired to any
operator surface. Per-agent autonomy needs the policy decision to take the agent
as input, and the approval to actually surface.

### Acceptance criteria
1. Two agents in one company can hold different autonomy settings; one acts, the
   other parks the same action for approval.
2. A parked action appears in the Approvals inbox and resumes on a human yes.
3. A `never_do` entry hard-denies regardless of mode, and the denial is journaled.
4. A per-agent daily budget actually stops a turn and records why.

### Depends on
[R3](09-feature-briefs.md) (never_do + denials), F3 (agent identity in the
decision), [R5](09-feature-briefs.md) (the approval bridge), and
[R6](09-feature-briefs.md) (budgets bind). Large-plan, but every piece is already
on the roadmap.

---

## F5 — The company feed

### What it means
**One** live stream of everything the company is doing — tasks starting, agents
acting, approvals raised, work shipped — updating in real time, visible to anyone
you choose to show it to (your team, and publicly for the dogfood).

### Why it matters
This is the single biggest wow factor: walk in, watch the company *work*. For the
"markets itself in public" thesis it is the marketing asset itself — a prospect
sees OpenCompany's AI team working the very moment it is working on them.

### What exists today
- The `EventLog` foundation exists and events carry sequence numbers.
- **Live delivery is not built.** The whole "live operations" family is 0 shipped:
  events broadcast into a channel nobody listens on, no HTTP surface accepts a
  resume cursor, a lagging subscriber loses events with no signal
  ([STATUS.md](../spec/feature-audit/STATUS.md), family 04).
- The console's feed today is fabricated placeholder data
  (`frontend/src/lib/team.ts:55-66`).

### The gap
The write side (events) exists; the read side (a live, resumable, multi-viewer
stream over the network) does not. Plus a public-visibility mode that shows the
feed without exposing secrets or private reasoning.

### Acceptance criteria
1. A client opens the feed and sees new events appear live, in order, without
   polling.
2. Disconnect and reconnect with a cursor resumes without gaps or duplicates.
3. A public viewer sees activity with secrets and private reasoning redacted.
4. A slow viewer never blocks the runtime.

### Depends on
Building out live operations (family 04), which is largely greenfield. It reads
what F1 records, so F1's correlation work makes the feed richer. Large-plan.

---

## F6 — Ask anything

### What it means
Anyone can ask any agent, in plain language: *what are you doing right now? why did
you do that? what have you done today? what are you allowed to do?* — and get a
straight answer from that specific agent.

### Why it matters
It is transparency made interactive. F5 lets you *watch*; F6 lets you
*interrogate*. Together they are what "runs in glass" means — and F6 is what turns
a skeptical prospect into a believer, because they can grill the machine.

### What exists today
- Operator chat exists, but routes to a **single** hard-coded agent
  (`src/harness/brain.rs:41-47`) — you cannot address a specific one.
- There is no read path from an agent's memory or recent activity to a query
  surface; execution timelines are seam only
  ([STATUS.md](../spec/feature-audit/STATUS.md), family 06).

### The gap
You cannot address a named agent, and even if you could, there is no surface that
answers "what have you done / why / what can you do" from that agent's own trail
and permissions.

### Acceptance criteria
1. A question can be addressed to a specific agent by id and is answered by *that*
   agent.
2. "What have you done today?" is answered from F1's real trail, not invented.
3. "What are you allowed to do?" is answered from F3's real allow-list.
4. The question and answer are themselves recorded (F1) and appear in the feed
   (F5).

### Depends on
F1 (a trail to answer from), F3 (a permission set to report), and desk/agent
addressing (the F2 routing fix). Large-plan.

---

## How the six fit together

They are not six independent features — they are one system with a dependency
spine:

```
   F3 per-agent allow-lists  ──┐  (who can do what)
                               ├──> F1 provenance ──┬──> F5 live feed
   F4 per-agent autonomy  ─────┘  (record of it)    └──> F6 ask anything
                                                    ▲
   F2 task threads  ───────────────────────────────┘  (the human-readable why)
```

**F3 is the root.** Until an action can be attributed to a specific agent with a
specific permission, F1's trail cannot say who did what, F4's autonomy has no
subject, and F6 has no per-agent answer to give. It is also
[R4](09-feature-briefs.md#r4--per-agent-sandboxed-read-only-tools), the
roadmap's highest-leverage item — which is a strong signal the roadmap and this
vision agree.

Suggested order: **F3 → F1 → F4 → F5 → F2 → F6.** Ship attribution first, then the
record, then control, then the public view, then the human conversation, then the
interrogation. Each stands on the last.

## Honest status

Five of six are largely unbuilt today, and F3 is built in the *wrong shape*. That
is not a setback — it is the same conclusion the audit and roadmap already reached
from the other direction, which is reassuring: **this feature list and the
existing roadmap are the same project.** F3 is R4; F1/F4 lean on R3/R5/R6; F5 is
the live-operations build; F2 and F6 need the routing fix that a rejected design
already mapped.

Nothing here contradicts the roadmap in [08-roadmap.md](08-roadmap.md). It gives
it a *product face* — the reason each infrastructure item exists, stated as
something a founder can see and use.

The two views are now stitched together: [08-roadmap.md](08-roadmap.md) carries a
**Serves** column linking each infrastructure item to the feature (F1–F6) it
delivers, and a **Product features → roadmap work** table showing which features
are covered and which are still greenfield. The honest headline of that mapping:
the roadmap fully delivers **F3** and most of **F1/F4**, while **F5, F2, and F6
are largely unbuilt and not yet designed** — real work that needs the same
design-then-review pass the roadmap items got.
