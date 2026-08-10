# Moat Assessment

> **Superseded in part by [11-moat-thesis.md](11-moat-thesis.md).** This document
> scores the candidates and concludes none survives — that scoring still stands.
> What it could not reach, because it predates the implementation-design pass, is
> *why* the surviving candidate (owned-runtime enforcement) is structurally hard
> to copy, and what would make it real. Read this for the scoring; read `11` for
> the conclusion.

Each candidate scored against verified evidence. The distinction that matters is
**durable advantage** (compounds, hard to copy) versus **replicable feature**
(a well-funded competitor ships it in a quarter).

## Verdict

**There is no defensible technical moat in the current architecture.**

Every architectural pillar is either already shipped by a better-distributed
rival or is packaging convenience. What remains is not a schema property: it is
reliability engineering on an owned runtime, and it is currently blocked.

## Scorecard

| Candidate | Verdict | Why |
|---|---|---|
| Company-as-data manifest | **Not a moat** | Shipped by OpenOPC (role/reporting YAML), Microsoft (agent+workflow YAML), CrewAI (config-first scaffold) |
| 19-company catalog | **Not a moat** | OpenOPC ships 9 verticals *and* generates org charts from a goal; agency-agents-zh ships 268 role agents free under MIT |
| Agent schema (`id`/`role`/`description`) | **Not novel** | Strict subset of CrewAI's role/goal/backstory and Microsoft's field set |
| `human_role` + approval gates | **Not a moat, and partly not real** | Paperclip ships enforced gates + rollback; `human_role` is a display string (see below) |
| GPL-3.0 as strategy | **Net negative** | Two direct rivals are MIT, one Apache-2.0; blocks embedding, no upside for own-hosted SaaS |
| Rust single-binary, zero user code | **Real, but a feature** | The one unprecedented property found — but packaging, and it costs the Python contributor pool |
| Multi-tenant hosting economics | **Unproven, likely not a moat** | AWS publishes $0.0895/vCPU-hr per-second billing; no OpenCompany cost model exists |
| Owning the vertical runtime stack | **The only live candidate** | Unevaluated, but structurally unavailable to BYOA rivals — see below |

## Why `human_role` is not a moat

Pass 1 of this research called it "the last architectural moat candidate still
standing." That was wrong, and the way it was wrong is instructive.

In source, `human_role` appears five times: one struct field
(`src/company/types.rs:97`), one `println` in `effective_summary`
(`src/company/manifest.rs:291`), and three test fixtures. `src/policy/gate.rs`
contains **zero** references to it.

Worse: `docs/spec/product/templates.md:36-39` specifies a lint rule requiring it,
and `validate()` does not enforce that rule. The field is specified, parsed,
printed, and otherwise ignored.

The real approval machinery — `ManifestApprovalGate`, 482 lines, park/resolve/
resume with TTL expiry — is driven by `manifest.policy`, not `human_role`, and it
*is* genuine. But it is at rough parity with Paperclip's shipped gates, and
behind on revisioning and rollback, which Paperclip has and OpenCompany does not.

**Against a 74k-star incumbent, "our gate is nicer" is not a wedge.**

## The one live argument for the owned runtime

Paperclip's reported failures are runtime failures: silent mid-task context loss,
hallucinated data, unsandboxed adapters. It **structurally cannot fix them**,
because it owns no runtime — its entire adoption advantage comes from delegating
cognition to Claude Code, Codex, Cursor, and whatever ships next.

OpenCompany vendors OpenHuman/TinyAgents/tinycortex/tinyflows and therefore *can*
fix them. That asymmetry is real, it is not copyable by a BYOA orchestrator
without abandoning its own adoption model, and it is the only candidate here that
would compound.

**Three conditions before it counts as a moat:**

1. The runtime must be in the build. Today `default = []`, and
   `.github/workflows/ci.yml:50` never compiles `--features openhuman`.
2. Agents must have tools. `src/harness/build.rs:85` is
   `let tools: Vec<Box<dyn Tool>> = Vec::new();`.
3. The reliability advantage must be **measured and published**. An unmeasured
   claim of better reliability is worth less than 5dive's self-reported badge,
   because at least that one is computed from production.

Until all three hold, the vendored-submodule strategy is pure maintenance cost
with no return. This is the load-bearing assumption of the whole plan and it is
currently unverified — see [05-evidence-log.md](05-evidence-log.md#unresolvable-by-research).

## Why the manifest is the wrong lever

The strongest evidence against the current architecture is not competitive, it is
empirical.

[MAST](https://arxiv.org/abs/2503.13657) (Berkeley Sky Computing, NeurIPS 2025
Datasets & Benchmarks) catalogues 14 failure modes across 1,600+ execution traces
from 7 frameworks. Its abstract, verbatim:

> Despite enthusiasm for Multi-Agent LLM Systems (MAS), their performance gains
> on popular benchmarks are often minimal.

Two findings that bear directly on OpenCompany:

1. **Specification issues are the largest failure category (~41.8%).**
2. The authors explicitly tested *"improved specification of agent roles and
   enhanced orchestration strategies"* and concluded the identified failures
   *"require more complex solutions"* — a ChatDev case study moved 33.33% → 48.93%,
   and they conclude *"simple fixes are still insufficient for achieving reliable
   MAS performance. Mitigating identified failures will require more fundamental
   changes in system design."*

OpenCompany's best-shipped engineering is its manifest linter — ~180 rules,
prosumer-language errors, enforced at load, at CLI `check`, and at the
provisioning ingress. That is world-class **role specification**.

**MAST says role specification is precisely the lever that does not work.**

Honest bounds: MAST's inter-annotator kappa of 0.88 was established on a
150-trace development subset, and the intervention study covers two frameworks —
a case study, not a broad ablation. The correct reading is "multi-agent benefits
are conditional and compute-confounded," not "multi-agent does not work."
Documented wins exist for parallelizable read-heavy work. This is a headwind for
everyone in the category, including every competitor listed here. It is not
protection for OpenCompany and must not be cited as such.

## Licensing

Verified locally: `Cargo.toml` carries `license = "GPL-3.0-only"`; `LICENSE`
begins "GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007". Paperclip, OpenOPC,
5dive, and agency-agents-zh are MIT; Eigent is unmodified Apache-2.0.

**The bite is on embedding and redistribution only.** Strong copyleft requires
conveyed derivatives to be GPL-3.0; MIT permits closed-source embedding.

**It does not harm own-hosted SaaS.** GPL-3.0 lacks AGPL §13 entirely. Google's
[policy page](https://opensource.google/documentation/reference/using/agpl-policy)
bans AGPL specifically — triggered because AGPL applies *"if the product or
service can be accessed over a remote network interface, so it does not even
require that the product or service is actually distributed"* — and issues no
categorical plain-GPL prohibition. Counterweight: Google's broader internal
practice does restrict GPL-family code in shipped or linked products via a
separate policy surface. Do not inflate this into "Google is fine with GPL-3.0."

Two offsets bound the damage: OpenCompany is a deployable runtime rather than a
library rivals would link, so the forfeited embedding market may be small; and a
single copyright holder retains the dual-licensing option.

**Decision rule:** if any OEM, white-label, or agency-embedding motion is wanted,
GPL-3.0-only is a hard blocker and should change. If the plan is own-hosted SaaS
only, it costs nothing. This is a product decision, not a legal one.

## What defensibility would have to come from instead

Given every schema-level candidate failed, only three sources remain, none of
them architectural:

1. **Measured reliability on an owned runtime** — the only candidate that
   compounds, blocked on three preconditions above.
2. **Distribution** — currently 10⁴ behind. No feature closes that; it would
   require a distribution strategy, not a roadmap.
3. **A vertical position** — customer book, domain data, or regulatory standing
   in one industry. The funded version of this (Eudia) is executed by
   acquisition, which an open-source runtime cannot replicate. See
   [06-strategy.md](06-strategy.md#is-horizontal-wrong).
