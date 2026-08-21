# Evidence Log

> **Dated research — as of 2026-07-20.** Landed on 2026-08-21 as a historical
> record, with its body as written in July. This file is a record of *method* —
> what was refuted, what was caveated, what could not be answered — and that
> record does not expire: a claim refuted in July is still refuted. The codebase
> claims it references have moved, though; see
> [README.md — Corrections](README.md#corrections-verified-2026-08-21).

Claims that **failed** verification, caveats that bound the ones that passed, and
the questions research could not answer.

This file exists so that refuted claims are not silently reintroduced by a later
pass. Anything below marked refuted must not appear in a strategy document.

## Refuted — do not reintroduce

Nineteen claims were killed across the two external passes. Each was checked by
three independent verifiers; a 2-of-3 refutation kills it.

### Pass 1

| Claim | Vote |
|---|---|
| MetaGPT has ~69.4k GitHub stars | 0-3 |
| MetaGPT is the closest prior art to OpenCompany's thesis | 1-2 |
| MetaGPT encodes the org as SOP-driven role orchestration ("Code = SOP(Team)") | 1-2 |
| NeurIPS 2025 D&B finds multi-agent systems deliver only minimal gains *(as worded — see MAST below)* | 0-3 |
| Best LLM agent completed only 30% of tasks on a software-company benchmark | 0-3 |
| Agent capability is sharply bimodal by task horizon | 0-3 |
| Best multi-agent config reaches 53.50% requirement implementation on E2EDevBench | 1-2 |
| Adding roles degrades performance: 27.71% three-role vs 53.50% two-role vs 49.48% single | 0-3 |
| 55.8% of failures stem from task planning, 5.6% from capability limits | 0-3 |

**Every MetaGPT-specific characterization and every task-completion benchmark
number failed.** These are exactly the kind of specific-sounding statistics that
survive into decks. They did not survive checking.

### Pass 2

| Claim | Vote |
|---|---|
| AgentCore does not bill for I/O wait or idle time (true scale-to-zero) | 0-3 |
| AgentCore charges nothing for the agent-hosting harness itself | 0-3 |
| 5dive is a directly comparable competitor with negligible adoption | 1-2 |
| 5dive's isolation is OS-level (Linux users + systemd) | 0-3 |
| agency-agents-zh has no runtime at all | 0-3 |
| Eigent has ~14.6k stars, far exceeding OpenCompany *(as worded)* | 1-2 |
| Eigent ships human-in-the-loop escalation as a built-in | 0-3 |
| Eudia's positioning explicitly rejects full autonomy | 1-2 |
| General Catalyst's thesis is explicitly vertical, not horizontal | 1-2 |
| Multiple AI CEOs publicly state revenue records rest on a dishonest metric | 1-2 |

**Four of these would have strengthened the conclusions** — AgentCore
scale-to-zero, the zero-harness-fee claim, Eigent HITL parity, and GC's thesis
being explicitly vertical. They were killed anyway. That is the verification
working in the direction that costs something.

## Caveats on claims that passed

**MAST.** The paper is ~16 months old in a fast field. Inter-annotator kappa of
0.88 applies to the 150-trace development subset, not all 1,600+. The
intervention study covers two frameworks — a case study, not a broad ablation,
and one intervention was itself semi-architectural, so the clean
prompt-vs-structural dichotomy is sharper than the paper's own framing. Correct
reading: *benefits are conditional and compute-confounded*, not *multi-agent does
not work*. It is a headwind for the whole category including every competitor,
and must not be cited as protection for OpenCompany.

**OpenOPC.** Assessed entirely from its own README — architecture as claimed, not
benchmarked. ~924 stars is small and durability is unproven. The claim that it
*generates* rather than curates rosters passed only 2-1 and is partly wrong as
worded: it does both.

**Paperclip.** Star count verified via GitHub REST API on 2026-07-20 and will be
stale within weeks. `doc/PRODUCT.md` is partly spec rather than shipped; the
template marketplace is roadmap. "Paperclip inherits adoption from coding agents"
is an unmeasured mechanism, not a measured outcome.

**Eudia and General Catalyst.** Funding and acquisition facts come from a company
press release. GC's post is VC content talking its own book — admissible as
evidence of what GC argues, not as independent market sizing. Its $6T-services
figure is US-only revenue while $370B is *global* software spend; the implied
multiple is inflated and must not be reused. Crescendo's 60–65% gross margin is
unaudited vendor-supplied marketing.

**ARR inflation.** All evidence traces to one TechCrunch piece quoting anonymous
single VCs and one employee about unnamed companies. Evidence of *tolerated*
inflation, not concealed fraud — in the $50M/$42M case investors held accurate
books. Must not be upgraded into a prevalence rate.

**AgentCore pricing.** Date-stamped July 2026; recently GA, rates may change. Not
apples-to-apples against per-tenant containers, and runtime compute is one of ~12
separately billed components.

**Search budget exhaustion.** Several pass-2 verifications ran with the session's
WebSearch budget at 200/200, so contradiction searches could not run on the
TechCrunch, Relevance AI, Eudia funding, and GC portfolio claims. Those are
single-source-confirmed rather than adversarially cleared.

## Method defect in passes 1 and 2

Both external passes described OpenCompany to their agents using `README.md` and
`CLAUDE.md`. Competitors were assessed from verified code, APIs, and independent
teardowns. **OpenCompany's side of every comparison was sourced from its own
marketing.**

This produced at least one materially wrong conclusion: pass 1 named `human_role`
"the last architectural moat candidate still standing." It is a display string
with zero references in `src/policy/gate.rs`
([02-moat-assessment.md](02-moat-assessment.md#why-human_role-is-not-a-moat)).

Pass 3 (the internal audit) was commissioned to correct this and adopted issue
#21's rule: *cite files and line ranges; do not infer from doc prose*. That rule
governs anything added to this directory.

**Any pass-1 or pass-2 finding about OpenCompany's own capabilities should be
treated as unverified until checked against source.** Findings about competitors
are unaffected.

## Method defect in pass 3

The synthesis agent received a truncated payload — the audit data was capped at
90,000 characters against a 446,000-character input, so it saw families 01–03 in
full and none of 04–09. Its narrative sections were written on partial evidence
and flagged as such in its own output.

The per-family rows for 04–09 were recovered directly from the raw agent results
and are complete in `STATUS.md`, which was **not** landed with this archive —
it is on the `docs/salvage-research-notes` branch. The **tally
and the table are sound**; the synthesis narrative was informed inference for six
of nine families.

## Unfilled research gaps

Targeted explicitly, returned nothing verifiable:

1. **Commercial AI-employee churn and retention.** Zero data for Lindy, Artisan,
   11x, Sierra, Decagon, Devin/Cognition, Harvey, Hebbia, Clay, Zapier Agents,
   Gumloop, Replit Agent, Factory.ai, Cosine, Reflection.ai. Only Relevance AI's
   $24M Series B was confirmed, and funding is not traction. **The "AI-SDR bubble
   is deflating" hypothesis is untested.**
2. **Durable-execution infra.** Temporal, Inngest, Restate, LangGraph Platform,
   Modal, E2B, Daytona, Cloudflare Durable Objects, Vercel workflows — not
   researched. Build-vs-rent rests on one data point.
3. **Multi-tenant hosting economics.** No idle-cost, cold-start, inference-margin,
   or egress numbers from anyone. The "most plausible remaining moat" hypothesis
   is neither confirmed nor refuted.
4. **Was "business type as declarative config" ever tried and abandoned?** Only
   concurrent work found. This was pass 1's highest-value question and it remains
   open.

## Unresolvable by research

These require building or measuring, not searching. They are listed here because
the strategy in [06-strategy.md](06-strategy.md) depends on them.

1. **Does owning the runtime produce measurably better reliability than
   bring-your-own?** Paperclip's reported failures — silent mid-task context
   loss, hallucinated data — are the specific target. If this cannot be
   demonstrated with numbers, the vendored-submodule strategy is pure cost with
   no return. **This is the load-bearing assumption of the entire plan.**
2. **Can per-tenant containers beat $0.0895/vCPU-hour at realistic idle ratios?**
   Requires modeling, then benchmarking against Modal, E2B, and Durable Objects.
3. **What vertical motion is available to an open-source Rust runtime with no
   customer book, no practitioners, and no capital?** "Go vertical" may be
   correct as a diagnosis and still non-executable in its funded form.
