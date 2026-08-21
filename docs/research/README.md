# Research — a dated archive

> **As of 2026-07-20. Not a description of the current codebase.**
>
> These documents were written on 2026-07-20 and describe `main` as it stood
> then. They were landed on **2026-08-21** as a historical record — bodies as
> written, with dated correction notes marked inline and collected below. In
> those thirty-two days `main` advanced **4,356 commits**,
> and a 57-claim spot-check of this research's internal, `file:line`-cited
> findings found 19 flatly false and 16 partly overtaken — see
> [Corrections](#corrections-verified-2026-08-21) below, which is the only part
> of this directory written against current `main`.
>
> **External findings** — competitors, licences, published prices, cited papers —
> are date-stamped in place and were *not* re-verified. They are one month old and
> were true when written.
>
> Do not cite anything here as the current state of OpenCompany. Cite it as
> "as of July 2026", or check it against source first.

Evidence-backed competitive and strategic analysis. These documents record **what
was verified**, not what was believed. Every claim carries a source: a URL for
external findings, a `file:line` for internal ones. Claims that failed
verification are recorded as refuted rather than deleted — see
[05-evidence-log.md](05-evidence-log.md).

## What is here, and what is not

Five of the thirteen numbered documents this research produced are archived here.
The other eight were engineering artifacts — an internal audit, a where-we-lag
ranking, an architecture-facts sheet, a roadmap, feature briefs, a design-review
log, a product feature spec and a wiring audit — as was the separate
93-capability `STATUS.md`. Their entire value was a `file:line` snapshot of a
codebase that has since moved several thousand commits. They were deliberately
**not** landed, because a stale audit checked into `docs/` reads as current, and
that is worse than having none.

They are not lost. The complete set, plus `STATUS.md` and a design note for #333,
is preserved on the branch **`docs/salvage-research-notes`** (commit `746af58b`)
on the `graycyrus` fork. Read them there, as dated evidence, with the same
caution.

## Read in this order

| # | Document | Answers |
|---|---|---|
| 01 | [Competitive landscape](01-competitive-landscape.md) | Who competes, at what scale, under what licence |
| 02 | [Moat assessment](02-moat-assessment.md) | Which candidate moats survive scrutiny (few) |
| 05 | [Evidence log](05-evidence-log.md) | Refuted claims, caveats, method limits, open questions |
| 06 | [Strategy](06-strategy.md) | Avoid, double down, horizontal-vs-vertical, critical path |
| 11 | [Moat thesis](11-moat-thesis.md) | **The strategic conclusion** — what the moat can be, and what would falsify it |

Numbering is preserved from the original set; the gaps are the documents that
were not landed.

## The one-paragraph version

*(as of 2026-07-20 — the internal half of this paragraph is now largely wrong;
see [Corrections](#corrections-verified-2026-08-21).)*

OpenCompany has no defensible technical moat today. Every architectural pillar it
claims — agents-as-declarative-manifest, a catalog of business-type rosters,
human-approval primitives — is already shipped by better-distributed rivals under
more permissive licences, most notably `paperclipai/paperclip` (MIT, 74,259 stars
against OpenCompany's ~5). Internally, 7 of 93 audited capabilities are shipped
with a test proving them; 71% is seam or absent.

One structural asymmetry survives: a bring-your-own-agent orchestrator **cannot
enforce anything**, because cognition runs in someone else's process — and it
cannot fix that without abandoning the adoption model that made it popular.
OpenCompany owns its runtime and can. That points at **provable agent execution
sold into one regulated vertical** ([11-moat-thesis.md](11-moat-thesis.md)).

## Method and its limits

Three passes, all multi-agent with adversarial verification:

| Pass | Scope | Agents | Verification outcome |
|---|---|---|---|
| 1 | External landscape, prior art | 111 | 25 claims checked, 9 refuted |
| 2 | Commercial segment, hosting infra, moats | 105 | 25 claims checked, 10 refuted |
| 3 | Internal feature audit | 69 | 93 capabilities, 11 downgraded |

Verifiers were instructed to **refute**, and to default to refutation under
uncertainty. Roughly a third of external claims died that way; refuted claims are
listed in [05-evidence-log.md](05-evidence-log.md) so they are not silently
reintroduced later.

### A known defect in passes 1 and 2

Both external passes described OpenCompany to their agents using `README.md` and
`CLAUDE.md` — **its documentation, not its source**. Competitors were assessed
from verified code and APIs. That asymmetry inflated OpenCompany's side.

It was caught when `human_role`, which pass 1 called "the last architectural moat
candidate still standing," turned out to be a display string with zero references
in `src/policy/gate.rs`. Pass 3 exists to correct this, and issue #21's constraint
— *"Cite files and line ranges; do not infer from doc prose"* — is the standing
rule for anything added here.

Findings sourced only to passes 1–2 that concern OpenCompany's own capabilities
should be treated as unverified until checked against source.

### A known defect in pass 3

Pass 3's synthesis agent received a truncated payload — the audit data was capped
at 90,000 characters against a 446,000-character input, so it saw families 01–03
in full and none of 04–09. Its narrative sections were written on partial evidence
and flagged as such in its own output. The per-family rows were recovered from the
raw agent results; the tally and table were sound *at the time*, while the
narrative was informed inference for six of nine families.

### What was still unresearched, as of July 2026

- **Commercial AI-employee churn and retention.** Targeted twice, returned
  nothing verifiable both times.
- **Durable-execution infra** (Temporal, Inngest, Restate, Modal, E2B, Cloudflare
  Durable Objects). One data point only — the AWS AgentCore rate card.
- **Multi-tenant hosting economics.** Flagged as the most plausible remaining
  moat and never measured.
- **Whether the owned runtime yields better reliability than bring-your-own.**
  The load-bearing assumption of the entire strategy; a benchmark to run, not a
  question to research.

---

## Corrections, verified 2026-08-21

This section — and only this section — was written against `main` at `e68c2e03`,
one month after the research. It records claims in the archived documents that
shipped code has since falsified, so nobody acts on them.

The pattern is worth stating plainly: **the strategic and external analysis has
held; the internal engineering snapshot rotted almost immediately.** At roughly
136 commits a day, a `file:line` claim about this repository has a shelf life
measured in weeks, not months.

### The five "load-bearing defects" — four of five are fixed

The research's whole internal narrative rested on five defects. As of 2026-08-21:

| Defect, as written in July | Now | Evidence on `main` @ `e68c2e03` |
|---|---|---|
| **1. Agents have no tools** — `src/harness/build.rs:85` is `let tools: Vec<Box<dyn Tool>> = Vec::new();` | **fixed** | `src/harness/built_in/build.rs:289` builds a real tool vector; memory, file, ledger, hosting, Composio and Chargebee toolbelts all ship |
| **2. CI never compiles the owned runtime** — `ci.yml:50` is a bare `cargo test` | **fixed** | A dedicated `Rust (openhuman, tinycortex)` lane builds, clippies and tests `--features openhuman,tinycortex` |
| **3. Per-agent least privilege is unimplementable** — grants are a roster-wide union; `ToolCall` carries no agent identity | **fixed in effect** | Narrowing moved to the harness path, which was always the right seam (`src/harness/built_in/build.rs:11,57,1016`). `ToolCall` (`src/ports/types.rs:2135`) still carries no agent id, but nothing enforces on that path any more |
| **4. Budgets bind nothing** — `budget_usd_daily()` has zero callers | **fixed** | `ApprovalPolicy::daily_budget_verdict` (`src/harness/built_in/policy.rs:1168`) returns `RequireApproval` at `spent >= cap`; the in-turn brake is proven by `src/harness/spend_halt_turn_test.rs`. Caveat: with no `UsageMeter` wired, the pre-dispatch gate fails **open** |
| **5. Cost metering is a stream of zeros** | **fixed** | `src/metering/inference.rs:94,126` writes a negative `inference.spend` entry and a `UsageSample` from real turn usage — which also closes the separate "spend booked as revenue" sign bug |

The survivor from that list is `never_do`: `src/policy/gate.rs:503` and
`src/harness/built_in/policy.rs:1273` still describe a reserved,
deliberately-empty slot. A charter prohibition is still unenforceable.

### Other specific claims now false

- **"Tool approval never reaches OpenCompany."** The bridge is closed — every
  `RequireApproval` is projected onto an approval queue, drained by the harness
  brain and parked through `CycleHost::park_effect`
  (`src/harness/built_in/policy.rs:12-33`). Approving mints a single-use grant
  and re-dispatches.
- **"Events broadcast into a channel nobody listens on."** `GET {scope}/events`
  is a real SSE route (`src/server/operator.rs:109,594`) consuming
  `EventLog::subscribe` at `:614`.
- **"The Operator cannot change autonomy without editing `company.toml` and
  restarting."** `GET`/`PUT`/`DELETE {scope}/policy` ship an attributed
  `PolicyOverride` overlay that takes effect on the next turn
  (`src/server/ops/policy.rs:81-85`).
- **"Running a workflow is impossible."** `src/workflows/runner.rs:90` is a real
  executor; create/update/delete/run/cancel routes all persist.
- **"No run entity is persisted."** `src/ports/runs.rs` ships `RunStore` /
  `RunRecord` with a real status machine (issue #242, closed 2026-08-04).
- **"A failed cycle produces no durable record."** `CompanyEvent::TurnFailed`,
  `RunStatus::Failed` + `RunRecord.error`, and `JournalRecord::CycleFinished`
  all record it.
- **`starterTeam()` fabricates six teammates.** Deleted —
  `frontend/src/lib/team.ts:242` is now a tombstone comment. `addTeamMember` /
  `removeTeamMember` are wired and persist.
- **`McpServersView.tsx` is imported nowhere.** It is mounted at
  `frontend/src/views/SettingsSection.tsx:132`.
- **MongoDB conformance silently no-ops without a URI.** CI now sets
  `OPENCOMPANY_TEST_MONGODB_REQUIRED`, so the skip is a hard failure there.

### Claims that still hold

Not everything rotted. Verified still true on 2026-08-21:

- `never_do` is a reserved, empty slot (`src/policy/gate.rs:503`).
- `human_role` has zero references anywhere in `src/policy/`. It is still a
  display string, and `validate()` (`src/company/manifest.rs:310`) still does not
  enforce the lint rule `docs/spec/product/templates.md` specifies.
- Teammate add and removal are unlogged: `src/server/ops/team.rs:539` is a bare
  `retain` + `save`, and `CompanyEvent` has no teammate variant.
- `overlay_agents` still has no round-trip case in the conformance suite
  (`src/store/conformance.rs:157` hard-codes an empty vec), and `SecretStore`
  still has **zero** conformance cases despite holding OAuth tokens, SMTP
  passwords and the ingest HMAC secret.
- The SMTP password is still written to `localStorage` in plaintext
  (`frontend/src/lib/domain.ts:87`).
- No provisioning draft/activate split; `CompanyRecord::lifecycle` has no `draft`
  state. No teammate lifecycle states at all.
- `perform_effect` (`src/runtime/cycle.rs:1570`) still has no retry, backoff or
  deadline, and commits the at-most-once key before the side effect.
- `/healthz` (`src/server/routes.rs:395`) is still unconditional — it checks
  neither boot replay nor storage reachability.
- No policy simulation, and no rule id / layer / reason on a parked approval.
- No outcome checks, eval datasets or regression scenarios exist.
- Company-wide `[budget].monthly_usd` still does not bound autonomy — its only
  consumer is the tiny.place x402 path.
- Family 08 (company commerce) is essentially unchanged: no service-catalog
  versioning, no console discovery toggle, `send_a2a_task` and `pay` have no
  non-test callers, and one x402 authorisation reused across N SIWX requests
  still appends N ledger entries.
- No config-only export mode — every bundle carries the ledger, memory traces
  and context bodies.

### How the spot-check was done

57 of the 93 `STATUS.md` rows and cross-cutting findings were sampled, 6–7 per
feature family plus both invariant sets, choosing every row whose gap text made a
concrete falsifiable assertion. Each was re-read against `upstream/main` @
`e68c2e03` by an independent agent instructed to default to "still true" unless
absence was positively confirmed.

Result: **19 flatly false, 16 partly overtaken, 22 still true.** The error is not
evenly spread — families 01–03 (setup, teammates, workflows) were ~64% false,
while families 07–09 (template lifecycle, commerce, continuous review) were ~9%
false. The table was wrong precisely where the repository has been active.
