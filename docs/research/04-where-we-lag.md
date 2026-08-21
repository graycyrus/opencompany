# Where We Lag

Ranked by how hard the gap is to close, not by how bad it looks. Internal
deficits are cited to `file:line`; external ones to the source in
[01-competitive-landscape.md](01-competitive-landscape.md).

## Tier 1 — Structural, not closable by shipping features

### Distribution: ~10⁴ behind

| | Stars | Forks | Created |
|---|---|---|---|
| Paperclip | 74,259 | 13,819 | 2026-03-02 |
| Eigent | ~14,600 | ~1,700 | — |
| OpenOPC | ~924 | — | — |
| **OpenCompany** | **~5** | **~4** | 2026-07-10 |

Paperclip built that in 4.5 months. **No product feature closes a four-order
distribution gap.** Treating this as a roadmap problem is a category error; it
is a distribution problem and needs a distribution answer.

### Capital

Eudia raised $100M and acquired a 300-person delivery team in a single vertical.
That sets the spend bar for anyone competing on the same end-customer outcome.

## Tier 2 — Closable, but each is a real workstream

### Governance: revisioning and rollback are absent

Paperclip ships revisioned config with rollback and an immutable audit log.
OpenCompany has **none**: no Change Proposal type, no reshape path, no manifest
version history. Re-provisioning an existing id returns 409
(`src/server/provision.rs:162-169`), so the manifest is immutable-by-accident
rather than versioned-by-design.

This is the largest single competitive deficit and it is plan-sized — it touches
ports, storage, and the console.

The audit-log comparison is more nuanced: OpenCompany's append-only event journal
is arguably better-built than Paperclip needs, but **teammate lifecycle
transitions are not in it at all** — removal is an unlogged `Vec::retain`
(`src/server/ops/team.rs:117`), and policy-denied effects leave no durable record
(`src/runtime/cycle.rs:362`). Better mechanism, worse coverage.

### Least-privilege is structurally broken

Covered in [03-internal-audit.md](03-internal-audit.md#3-per-agent-least-privilege-is-unimplementable).
Grants are a roster-wide union and `ToolCall` has no agent identity. Paperclip
ships per-agent permissions and budgets.

### Budgets are inert

`budget_usd_daily()` has zero callers. Paperclip ships agent budgets with
`cost_events` per heartbeat run.

### The console does not write

`frontend/src/api/client.ts` has no team write method. The REST endpoints exist
and are correct (`src/server/ops/team.rs:28-32`) — the operator-facing half of
durability is broken purely by the absence of a handful of HTTP calls.

And `starterTeam()` fabricates six teammates on an empty roster
(`frontend/src/lib/team.ts:56-65`).

### No proof of working

5dive publishes a live daily-recomputed autonomy badge from production
(`{"label":"zero-human","message":"86.3%"}`), computed from a real digest command
on a status branch. OpenCompany has **zero production evidence** of anything.

This is the cheapest credibility gap to close on this page and the one most
directly aligned with the recommended strategy.

## Tier 3 — Capability gaps against the specs

From [`STATUS.md`](../spec/feature-audit/STATUS.md). Three families have nothing
shipped at all:

| Family | State |
|---|---|
| 04 Live operations | 0 shipped. Events broadcast into a channel nobody listens on; no HTTP surface accepts a resume cursor; a lagging subscriber loses events with no signal |
| 08 Company commerce | 0 shipped, 4 downgraded by verification. `a2a_task` prices work for a signature that moves no money; `EffectGroup::Hire` reaches no executor; outbox has no drain caller |
| 09 Continuous company review | 0 shipped, 0 partial. Does not exist |

Plus the two-phase provisioning violation: a headless caller goes from TOML to a
live, work-accepting company in one call with no acceptance gate and no budget
recorded — `grep budget src/server/provision.rs` returns nothing — while
`docs/spec/agentic/setup.md:113-116` says this MUST NOT be skippable. It is the
clearest spec-vs-code contract violation in the audit.

## Tier 4 — Ecosystem and posture

**Licensing.** GPL-3.0-only against MIT (Paperclip, OpenOPC, 5dive,
agency-agents-zh) and Apache-2.0 (Eigent). Blocks third-party commercial
embedding; irrelevant to own-hosted SaaS. See
[02-moat-assessment.md](02-moat-assessment.md#licensing).

**Language.** Rust against Python and TypeScript, where nearly all AI tooling and
contributors live. A real contributor-pool tax, partly offset by the
single-binary property nobody else has.

**Adapters.** Paperclip runs any agent — Claude Code, Codex, Cursor, bash,
HTTP/webhook. OpenCompany's default build is echo-brained with no real inference
absent credentials.

**Catalog.** 19 companies, 985 lines of TOML total, 3–9 agents each — against
agency-agents-zh's 268 business-role agents, free, MIT. Breadth has no scarcity
value.

**Hosting economics.** AWS publishes $0.0895/vCPU-hour billed per second on
actual CPU consumed. OpenCompany has published no cost model and no evidence it
beats that floor.

## Not measured

The audit did not assess: evals and observability tooling, memory quality,
security and compliance certifications, documentation quality, or community
health. Absence from this page is not evidence of parity.
