# Roadmap

Ordered feature list with dependencies. Per-feature briefs (why / what / how) are
in [09-feature-briefs.md](09-feature-briefs.md). The product face of this work —
what a founder actually sees and uses — is
[12-feature-spec.md](12-feature-spec.md); the **Serves** column below links each
infrastructure item to the product feature (F1–F6) it delivers.

Produced from twelve implementation designs, each adversarially reviewed against
source. **Three passed review clean; nine were found unsound and rescoped or
rejected.** Read [10-design-review-log.md](10-design-review-log.md) before
reviving any rejected approach.

## The list

| # | Feature | Size | Serves | Why | Depends on | Status |
|---|---|---|---|---|---|---|
| **R1** | Fix the inference ledger sign | XS | F1 | Every paid turn is booked as **revenue** (`harness/cost.rs:63` writes positive; `metering/finances.rs:44-51` reads positive as income) | — | design passed |
| **R2** | `--features openhuman` CI job | XS | — (enabler) | The owned runtime has never been compiled by CI (Fact 3) | — | design passed |
| **R3** | Enforce `never_do` + journal policy denials | small | F1, F4 | `grep never_do src/` returns two comments and zero code; denials leave no durable record (`runtime/cycle.rs:362`) | — | ⚠️ **unreviewed** |
| **C1** | Close conformance holes | small | — (enabler) | `conformance.rs:55-63` hard-codes `overlay_agents: Vec::new()`; MongoDB conformance self-skips | — | design passed |
| **R4** | Per-agent sandboxed **read-only** tools | small-plan | **F3** | Agents hold zero tools, so the owned-runtime thesis is unfalsifiable | R2, R3 | rescoped |
| **R6** | Per-agent daily budget enforcement | small-plan | F3, F4 | `budget_usd_daily()` has zero callers (`harness/policy.rs:89-92,129-175`) | R1, R2, R3 | fixable |
| **C2** | Console write plane + delete `starterTeam` | small-plan | F5 (first surface) | `listTeam` 404s on every load, so the fabricated roster is what operators always see | R3 | design passed |
| **R5** | Bridge tool denials to `ApprovalGate` | medium | F4 | `RequireApproval` disappears silently (Fact 5) | R3, R4 | **not designed** |
| **R7** | Upstream `charged`/`estimated` split | external | F1 | Both figures exist at `observability.rs:419-434` before being collapsed | upstream PR | blocked |
| **R8** | Reliability metric / dashboard | — | F5 | **Do not schedule.** Before R4+R6 it renders zeros | R4, R6, R7 | not designed |

`R*` items came from the synthesized roadmap. `C*` items are designs that passed
review but which the synthesizer never saw — see [Honesty](#honesty).

## Product features → roadmap work

The six features in [12-feature-spec.md](12-feature-spec.md) are the product; the
roadmap items are how they get built. Several features need work not yet designed
(marked *new*) — those are the honest additions this mapping surfaces.

| Feature | Delivered by | Still needs (not yet designed) |
|---|---|---|
| **F3 — Per-agent allow-lists** | R4 (read), R5 (write/external) | — the roadmap already centers on this |
| **F1 — Task provenance** | R3 (denials journaled), R1 (real cost) | **correlation-id thread** through `cycle.rs`; `parent_task_id` + `source` on tasks *(new, plan)* |
| **F4 — Per-agent autonomy** | R3 (never_do), R5 (approval bridge), R6 (budgets bind) | **per-agent policy** — take the agent as input to the gate decision *(new, plan)* |
| **F5 — The company feed** | C2 (first real console surface), R8 (reliability tiles) | **live-operations build** — SSE stream, resume cursor, public redaction *(new, large-plan; family 04 is 0 shipped)* |
| **F2 — Task threads** | — | **desk/task routing fix** first (see rejected design in [10](10-design-review-log.md)), then a per-task thread model *(new, large-plan)* |
| **F6 — Ask anything** | — | depends on F1 + F3 + routing; **agent-addressed query surface** over an agent's own trail *(new, large-plan)* |

**Reading this honestly:** the roadmap as it stands fully delivers **F3** and most
of **F1** and **F4**. **F5, F2, and F6 are largely greenfield** — real work, not
yet designed, and each should get the same design-then-adversarial-review pass the
R-items got before it is scheduled. The product spec is the destination; this
roadmap covers the first third of the road.

## Tiers

### Tier 0 — Stop telling the operator things that are false
**R1, R2, R3, C1.** All in default-feature code today's `cargo test` compiles, all
mutually independent, all closing gaps where a shipped surface asserts something
untrue.

*When done:* Finances stops booking spend as income. A charter prohibition is a
real fence rather than a comment. Every policy denial survives restart. A
`--features openhuman` compile break can no longer sit on `main` indefinitely.
Invariant 1 moves from claimed to partially delivered.

### Tier 1 — The runtime can act, under a fence
**R4.** The differentiation thesis made testable.

*When done:* Agents hold real, sandboxed, per-agent tool objects. One agent cannot
read another's files. An ungranted tool never enters that agent's dispatcher.
Least privilege moves from "impossible" to "shipped, read namespace."

The honest headline is **"agents can now observe,"** not "agents can now act" —
mutation is deliberately deferred to Tier 2 (Fact 5).

### Tier 2 — Actions are accountable and bounded
**R5, R6, C2.** Tier 1 ships read-only because a write tool under the shipped
supervised fixture is dead on arrival and silently so. Tier 2 builds the approval
bridge that makes mutation legitimate, makes spend bind, and connects the console.

*When done:* A teammate's write request reaches a human. A daily cap actually
stops a turn, records why, and survives restart. "No feature bypasses budgets or
approvals" becomes true for the harness path for the first time.

### Tier 3 — Measured, honestly
**R7, then R8.** Cost provenance needs an upstream change this repo cannot make
alone; reliability measurement needs cost. Both are last on purpose.

*When done:* A dollar figure on the accountability surface is either a real charge
or is labelled an estimate — never a guess wearing a receipt's clothes.

## Dependency graph

```
        ┌─ R1 sign fix ──────────────────────────┐
        ├─ C1 conformance holes                  │
 START ─┼─ R2 openhuman CI ──┬───────────────┐   │
        └─ R3 never_do + denial journal ─┬───┴───┼──> R6 budgets ──┐
                                         │       │                 │
                                         ├───────┴──> R4 tools ────┤
                                         │             │           ├──> R8 reliability
                                         └──> C2 console write     │      (NOT YET)
                                                       v           │
                                                    R5 approval    │
                                                    bridge ────────┘
 (file upstream now) R7 charged/estimated ·········> R7 local half ──> R8
```

**Parallel lanes:** `{R1, R2, R3, C1}` → then `{R4, R6, C2}` → then `{R5}`.

Tier 0 touches disjoint files — `harness/cost.rs`, `ci.yml`, `policy/gate.rs` +
`runtime/journal.rs`, `store/conformance.rs` — so four people can run with no
coordination. R6 is independent of R4, which matters because R5's feasibility is
uncertain. R7's upstream issue costs nothing locally and belongs on day one.

## What not to do

**Do not build a reliability metric or dashboard yet.** Before R4 and R6 it
renders zeros — agents perform no actions to succeed or fail at, and every dollar
denominator is `0.0` or sign-inverted.
*Trigger:* R4 shipped **and** R6 shipped **and** R7's upstream split merged.

**Do not thread agent identity through `ToolCall`.** That is PATH A, where agents
do not get tools (Fact 1). A design did this and would have regressed a shipped
fixture.
*Trigger:* PATH A grows a real tool provider agents actually invoke. No plan does.

**Do not add `CompanyEvent::BudgetDenied`, or any marker variant.**
`src/runtime/journal.rs:4-8` declares the enum closed to markers, and
`src/store/fs.rs:95` fails the *entire* log read on an unknown `kind` with no
`#[serde(other)]` — so a hosted rollback bricks chat history and export for any
tenant that hit a cap. Use R3's journal machinery.
*Trigger:* `CompanyEvent` gains `#[serde(other)]` **and** the journal-vs-event-log
boundary is deliberately re-litigated.

**Do not build a host-side inference price table.** It duplicates
`agent::cost::estimate_call_cost_usd`, already running in the vendored parent turn
path (`observability.rs:419-434,:484`).
*Trigger:* upstream declines the split — then a host table is the least-bad
option and must label **every** turn `Estimated`, not only zero-charge ones.

**Do not ship `CostBasis::Charged` before R7.** It writes a provenance claim that
is false on the most common turn shape.

**Do not backfill the ledger's historical positive rows.** It is append-only;
rewriting it to fix R1 trades one invariant-2 problem for a worse one.
*Trigger:* never — document the discontinuity.

**Do not build runtime-editable policy or config yet.** Per Fact 2,
`builder.rs:717-739` re-saves `CompanyRecord` from the build-time manifest, so a
config change stored there is erased at the next rebuild *while its audit record
survives*.
*Trigger:* a design using a sibling field or dedicated port (as `overlay_agents`
does) **and** stating how the live runtime picks the change up without a restart.
None of the twelve designs does this.

## Decisions needed from a human

These block scheduling and are not engineering calls.

1. **The `docs.*` grant name.** It currently points at a per-agent private
   scratchpad (`{data}/harness/{company}/{agent}/workspace`), not company
   documents. Shipping it as `docs.*` misleads operators; renaming means editing a
   shipped fixture. **Decide before R4.**
2. **Does `never_do` fence tool names as well as effect kinds?** Different
   namespaces, not a free extension — but a fence covering only effects is partial
   the moment R4 lands. **Decide during R3.**
3. **Journal portability.** The journal is a local file path even under
   `OPENCOMPANY_STORAGE=mongodb` (`builder.rs:744-746`), so in hosted db-per-tenant
   mode every denial, park, and approval record lives outside the tenant database
   and outside the conformance suite. Pre-existing across all five record types;
   R3 and R6 both raise the stakes. **Named invariant-4 finding.**
4. **Estimated inference rates.** The placeholders in R6's path (3.0 / 15.0 USD
   per Mtok) should come from the hosting platform. A wrong rate silently blocking
   an operator's company is R6's worst failure mode.
5. **Does `web.*` stay declared-but-unbound?** After R4,
   `companies/signals_opportunity_studio` has an agent with grants and zero tools.
   Honest, but a manifest declaring capability the runtime does not provide.

## Honesty

**R3 is unreviewed.** Its review record was truncated in the synthesizer's input,
so its `review_sound`, problems, and verdict were never seen. It ranks third on
direct source verification (`gate.rs:210-212` is genuinely a comment;
`cycle.rs:362-364` genuinely omits the journal call) and because two other reviews
independently cite it as a prerequisite. **This is the largest unvalidated
assumption in this roadmap. Review it before scheduling R4 or R6.**

**The synthesizer saw about five of twelve designs.** Its input was capped at
110,000 characters against a 276,890-character payload — a tooling defect, not a
judgement call. `C1` and `C2` are designs that **passed review** and were missing
from its view; they are inserted here on the strength of their own reviews. Five
rejected designs it also never saw are catalogued in
[10-design-review-log.md](10-design-review-log.md).

**No item is safe to hand to an engineer unmodified.** Every entry above is a
reconstruction incorporating review findings, which makes the roadmap more
trustworthy than its inputs — and means the roadmap itself has not been reviewed.

**R5 has no design at all.** It was discovered by a reviewer. Its "medium" size is
a guess, and its feasibility depends on whether openhuman's tool-policy middleware
exposes a host-injectable hook or needs an upstream change. **Trace
`middleware.rs:1423-1462` before committing to R4's read-only scope as permanent
or temporary.**

**R4's sizing is conditional on R2.** If `--features openhuman` is already broken
on `main`, that fix is commit zero and R4 grows by an unknown amount. Spike it
first.
