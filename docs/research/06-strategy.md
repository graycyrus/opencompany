# Strategy

> **Dated research — as of 2026-07-20.** Landed on 2026-08-21 as a historical
> record. The body is as written in July; correction notes are marked inline
> where shipped code has since falsified a claim. `main` advanced 4,356 commits
> in the month between; a 57-claim spot-check found 19 of this research's
> internal findings flatly false and 16 partly overtaken. External findings were
> true when written and were not re-verified. Full list:
> [README.md — Corrections](README.md#corrections-verified-2026-08-21).

What the evidence supports. Grounded in
[01](01-competitive-landscape.md)–[05](05-evidence-log.md); every recommendation
names the finding it rests on.

## Stop

### Positioning the manifest as the differentiator

Three independent implementations ship declarative agent/company config:
Paperclip, OpenOPC, and Microsoft Agent Framework. CrewAI's default scaffold is
config-first. The schema is a strict subset of CrewAI's role/goal/backstory and
Microsoft's field set.

This framing will not survive a technical reader.

### Positioning the human/org contract layer as the differentiator

Paperclip ships enforced approval gates, revisioned config with rollback, and an
immutable audit log. OpenOPC escalates blockers to a human. And `human_role` is a
display string in OpenCompany
([02](02-moat-assessment.md#why-human_role-is-not-a-moat)).

Keep the approval gate — it is real and well-architected. Do not lead with it.

### Marketing the 19-company catalog

985 lines of TOML, 3–9 agents each, against agency-agents-zh's 268 free MIT
business-role agents and OpenOPC's goal-derived org charts. Breadth is
commoditized.

### Building multi-tenant hosting as a moat

AWS publishes $0.0895/vCPU-hour billed per second on actual CPU consumed.
Paperclip gets company isolation from a `company_id` column. Undifferentiated
heavy lifting until a cost model proves otherwise — and no such model exists.

### Overclaiming autonomy

**This is the sharpest finding in the research.** The best-capitalized player in
the adjacent category is walking the framing back: Eudia's banner is
*"AI-Augmented Human Workforce"*, it acquired 300+ legal professionals, and its
CEO says *"Human + AI teams consistently outperform humans or AI working alone."*

"Headcount of one" is the position the market's winners are retreating from.

Compounding this: the default build is echo-brained, and TechCrunch documents
tolerated ARR inflation across the category. An unshipped project publishing
autonomy claims lands in the same credibility bucket. 5dive's audited-window
badge is the correct antidote — a metric computed from production, with its
limitations stated.

### Keeping GPL-3.0-only *if* an embedding motion is wanted

A pure handicap against MIT/Apache rivals in that motion only, and costless if
the plan is own-hosted SaaS. A product decision, not a legal one.

## Double down

Ranked by evidence strength.

### 1. Measured reliability as the product

The strongest-supported play, and the only candidate that compounds.

MAST finds specification issues are ~41.8% of multi-agent failures **and that
better role specification was tested and found insufficient**. That is a direct
indictment of the manifest — the thing OpenCompany has built best and every rival
also sells.

Meanwhile Paperclip's reported failures — silent mid-task context loss,
hallucinated data, unsandboxed adapters — are runtime failures it **structurally
cannot fix**, because its adoption model depends on not owning a runtime.
OpenCompany vendors OpenHuman/TinyAgents and can.

That asymmetry is the entire differentiation thesis. It is currently unexercised:
the runtime is compiled out of the default build and never built by CI.

**This bet and the owned-runtime bet are the same bet.** Neither pays alone.

### 2. One vertical, deep

Eudia's $100M plus a 300-person acquisition, and GC's services framing, both
point at vertical delivery rather than horizontal tooling. Depth is also what
makes reliability measurable — 19 business types means 19 untestable surfaces.

Honest counter: GC's winning motion is buy-and-transform with an existing
customer book and licensed practitioners. An open-source Rust runtime cannot
execute that. "Go vertical" is a sound diagnosis whose funded form is unavailable.

### 3. Zero-code single-binary distribution

Genuinely differentiated and verified: Paperclip needs VPS/Docker/SSH/Postgres
and reportedly "doesn't scale past a single Postgres"; Eigent is an Electron
desktop app; 5dive needs systemd users. `opencompany serve --company X` with
filesystem-default storage is a real operational advantage.

But it is a feature, not a moat, and it only matters paired with (1).

### 4. Publish a proof-of-working metric

Copy 5dive's mechanism, not its number. A metric computed from production on a
fixed window, republished automatically, with its limitations documented. Cheap,
legible, and the only credibility mechanism on this list that can ship before the
reliability work lands.

## Is horizontal wrong?

**Yes, on current evidence — though this is directional, not dispositive.**

1. **The horizontal slot is taken and cannot be won on features.** Paperclip owns
   it with 74,259 stars, MIT licensing, BYOA adapters, and full governance
   parity. Competing there means a 10⁴ distribution deficit with a strictly worse
   license.
2. **Breadth is commoditized.** 268 free MIT business-role agents exist.
3. **Capital concentrates vertically.**
4. **Breadth conflicts with the reliability strategy** — 19 surfaces cannot all
   be instrumented, and MAST identifies specification breadth as where these
   systems fail.

**Recommendation:** keep the manifest architecture — it is cheap and it works.
Pick **one** vertical to make production-real, instrument it, and publish
reliability numbers for it. Treat the other 18 as demos, not the product.

Not verified: the general horizontal-vs-vertical outcome record in adjacent AI
categories. This rests on category-specific evidence only.

## Critical path

Ordered by unblocking power, not size. Sourced from `STATUS.md`, the
93-capability inventory that was **not** landed with this archive — it is on the
`docs/salvage-research-notes` branch.

> **Correction, 2026-08-21.** Items 1, 2 and 4 have shipped, and item 7 half has.
> The owned runtime is compiled and tested by CI, agents hold real per-agent
> tool vectors, the console write plane is wired and `starterTeam()` is deleted,
> and MongoDB conformance now fails loudly in CI. Item 3 (real inference cost)
> has also landed — `src/metering/inference.rs:126`. Still open: item 5
> (two-phase provisioning), item 6 (manifest revisioning — partly, via typed
> overlays), item 7's `overlay_agents` conformance case, and item 8 (the orphan
> capabilities). See
> [README.md — Corrections](README.md#corrections-verified-2026-08-21).

**1. Attach one real tool to a harness-built agent; compile `--features openhuman` in CI.**
`src/harness/build.rs:85`, `.github/workflows/ci.yml:50`, `Dockerfile:19-21`.
Converts **seven** capabilities from vacuous to testable: per-teammate tool
narrowing, workspace isolation, memory namespacing, spend limits, harness
approval park/resume, workflow execution, and every family-06 metric. The
flagship differentiator is currently not built by CI or shipped in the image.

**2. Make grants per-agent — in the harness, not on `ToolCall`.**
`src/runtime/builder.rs:83-95` (roster-wide union), `src/harness/build.rs:73-88`,
`src/harness/mod.rs:66-85` (`HarnessDeps` carries no manifest or grants).

> **Corrected 2026-07-20.** An earlier version of this item said "put agent
> identity on `ToolCall`." That targets the wrong path. `ToolCall`
> (`src/ports/types.rs:517-522`) belongs to the cycle/brain path; agents will
> actually receive tools through the harness path, where openhuman's
> `AgentBuilder` takes a tool vector **per builder instance**. A design review
> traced the ToolCall approach and found every invocation would be `agent: None`,
> regressing a shipped fixture. See
> `07-architecture-facts.md`, Fact 1 — not landed with this archive; it is on
> the `docs/salvage-research-notes` branch, and its `file:line` citations are
> stale.

Until each agent is built with only its own grants, per-teammate tools, budgets,
and credentials are unimplementable, and a live privilege-escalation shape stays
open.

**3. Land real inference cost** — unblock or work around
`tinyhumansai/openhuman#4940`. Every cost, budget, margin, and reliability claim
sits on a stream of zeros, and the only metering test asserts emptiness. Without
this, "measured reliability" cannot ship. If upstream is slow, a provider-side
estimate written through `UsageMeter` beats zeros — labelled as an estimate.

**4. Wire the console's write plane.** `frontend/src/api/client.ts` +
`src/server/ops/team.rs:28-32`. The backend is done and correct; the
operator-facing half of durability is broken by the absence of a few HTTP calls.
Delete `starterTeam()` in the same change — shipping six fabricated teammates is
a trust failure.

**5. Two-phase provisioning with explicit budget confirmation.**
`src/server/provision.rs:79-221`. Today a caller goes from TOML to a live
work-accepting company in one call, no acceptance gate, no budget recorded.
`docs/spec/agentic/setup.md:113-116` says this MUST NOT be skippable. Clearest
spec-vs-code contract violation in the audit.

**6. Manifest revisioning + Change Proposals.** Largest competitive deficit
against Paperclip, and the prerequisite for post-launch reshape (family 01),
governance rollback (family 05), and any future Architect — which would otherwise
bulldoze provenance. Plan-sized; start the doc now.

**7. Overlay round-trip in the conformance suite; fail MongoDB tests loudly
without a URI.** `src/store/conformance.rs:61`, `src/store/mongodb.rs:1712`. Two
small changes closing a real invariant-4 hole: today a backend that silently
drops `overlay_agents` passes the whole suite.

**8. Assign owning families to the 13 orphans** — starting with multi-user auth
(contradicts a stated non-goal) and shared-DB tenancy (documented cross-tenant
exposure). These need a decision, not a backlog entry.

## Sequencing warning

Items 1–3 are prerequisites for the strategy, not parallel tracks with it.

Defining a reliability metric before agents have tools and before cost is real
produces a dashboard of zeros. That is worse than shipping nothing, because it is
a claim that cannot be honoured — and the category already has a credibility
problem this project would be borrowing against.
