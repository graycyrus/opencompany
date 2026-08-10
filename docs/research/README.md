# Research

Evidence-backed competitive and internal analysis, produced 2026-07-20.

These documents record **what was verified**, not what was believed. Every claim
carries a source: a URL for external findings, a `file:line` for internal ones.
Claims that failed verification are recorded as refuted rather than deleted —
see [05-evidence-log.md](05-evidence-log.md).

## Read in this order

| # | Document | Answers |
|---|---|---|
| 01 | [Competitive landscape](01-competitive-landscape.md) | Who competes, at what scale, under what license |
| 02 | [Moat assessment](02-moat-assessment.md) | Which candidate moats survive scrutiny (few) |
| 03 | [Internal audit](03-internal-audit.md) | How much of the product is actually real (7.5%) |
| 04 | [Where we lag](04-where-we-lag.md) | Concrete deficits, internal and external, ranked |
| 05 | [Evidence log](05-evidence-log.md) | Refuted claims, caveats, method limits, open questions |
| 06 | [Strategy](06-strategy.md) | Avoid, double down, horizontal-vs-vertical, critical path |
| 07 | [Architecture facts](07-architecture-facts.md) | Non-obvious code properties that invalidate plausible designs — **read before designing** |
| 08 | [Roadmap](08-roadmap.md) | Ordered feature list, tiers, dependency graph, what not to do |
| 09 | [Feature briefs](09-feature-briefs.md) | Why / what / how per feature, in execution order |
| 10 | [Design review log](10-design-review-log.md) | Rejected approaches and the defect that killed each |
| 11 | [Moat thesis](11-moat-thesis.md) | **The strategic conclusion** — what the moat can be, and what would falsify it |
| 12 | [Feature spec](12-feature-spec.md) | **The product, as six features** — the transparency layer, graded against source |
| 13 | [Wiring audit](13-wiring-audit.md) | Of the code that exists, what is not connected to anything (2026-07-30) |

The per-capability status table lives with the specs it audits:
[`../spec/feature-audit/STATUS.md`](../spec/feature-audit/STATUS.md).

## The one-paragraph version

OpenCompany has no defensible technical moat today. Every architectural pillar it
claims — agents-as-declarative-manifest, a catalog of business-type rosters,
human-approval primitives — is already shipped by better-distributed rivals under
more permissive licenses, most notably `paperclipai/paperclip` (MIT, 74,259 stars
against OpenCompany's ~5). Internally, 7 of 93 audited capabilities are shipped
with a test proving them; 71% is seam or absent.

One structural asymmetry survives: a bring-your-own-agent orchestrator **cannot
enforce anything**, because cognition runs in someone else's process — and it
cannot fix that without abandoning the adoption model that made it popular.
OpenCompany owns its runtime and can. That points at **provable agent execution
sold into one regulated vertical** ([11-moat-thesis.md](11-moat-thesis.md)) — but
the enforcement path does not exist yet: `never_do` is two comments,
`budget_usd_daily()` has zero callers, tool approval never reaches an operator,
and CI never compiles the runtime. The roadmap that builds it is
[08](08-roadmap.md); the per-feature briefs are [09](09-feature-briefs.md).

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

### What is still unresearched

- **Commercial AI-employee churn and retention.** Targeted twice, returned
  nothing verifiable both times. The "is there a credibility ceiling on
  AI-runs-your-company" question is open.
- **Durable-execution infra** (Temporal, Inngest, Restate, Modal, E2B, Cloudflare
  Durable Objects). One data point only — the AWS AgentCore rate card.
- **Multi-tenant hosting economics.** Flagged as the most plausible remaining
  moat and never measured. Requires modeling idle-tenant cost and cold-start,
  not searching.
- **Whether the owned runtime yields better reliability than bring-your-own.**
  This is the load-bearing assumption of the entire strategy and it is a
  benchmark to run, not a question to research.
