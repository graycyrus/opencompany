# Competitive Landscape

> **Dated research — as of 2026-07-20.** Landed on 2026-08-21 as a historical
> record, with its body as written in July. Everything below is an **external**
> finding — star counts, funding, licences, published prices — true when written
> and **not** re-verified since. Treat every number as a July 2026 reading. For
> the internal, `file:line`-cited claims that shipped code has since falsified,
> see [README.md — Corrections](README.md#corrections-verified-2026-08-21).

Verified 2026-07-20. Star counts and funding figures are date-stamped and will
drift; re-check before reuse in anything durable.

## Segment A — Direct rivals (same thesis, same shape)

These execute "a company of AI agents, declaratively configured" as their stated
product. They are the competitors that matter.

| Project | License | Lang | Scale | Ships |
|---|---|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | MIT | TypeScript | **74,259★ / 13,819 forks** | Enforced approval gates, revisioned config with rollback, immutable audit log, per-company isolation, heartbeat cycles, portable templates, agent budgets |
| [HKUDS/OpenOPC](https://github.com/HKUDS/OpenOPC) | MIT | Python | ~924★, climbing | Nine verticals, declarative role/reporting-line YAML, operator UI, human escalation, **goal-derived org charts** |
| OpenCompany | GPL-3.0-only | Rust | ~5★ / ~4 forks | See `STATUS.md` on the `docs/salvage-research-notes` branch (not landed — stale) |

### Paperclip

Created 2026-03-02; 3,151 commits; 4,925 open issues; release `v2026.707.0`;
pushed same-day as this research. Verified via GitHub REST API, not a
star-farmed shell.

From its README, verbatim:

> Governance with rollback. Approval gates are enforced, config changes are
> revisioned, and bad changes can be rolled back safely… Portable company
> templates. Export/import orgs, agents, and skills with secret scrubbing and
> collision handling… True multi-company isolation. Every entity is
> company-scoped, so one deployment can run many companies with separate data
> and audit trails.

Also: *"Agents have roles, titles, reporting lines, permissions, and budgets"*
and heartbeat execution with a DB-backed wakeup queue, coalescing, and budget
checks. An independent teardown documents the schemas — `activity_log` with
actor/action/entity and `jsonb` details, `heartbeat_runs` with adapter invoke and
`cost_events`, `POST /companies/:id/export` with secret scrubbing, every domain
table `company_id`-indexed, human approval required for hiring, large spend,
strategy changes, and termination.

**Moat type:** distribution/mindshare — primary and durable. 74k stars in 4.5
months is not replicable by building features.

**The strategic inverse.** Paperclip owns *no* agent runtime:

> Bring Your Own Agent — Any agent, any runtime, one org chart. If it can
> receive a heartbeat, it's hired.

Adapters exist for Claude Code, Codex, Cursor, bash, and HTTP/webhook bots. This
is the exact opposite of OpenCompany's vendored OpenHuman/TinyAgents stack, and
it is both Paperclip's adoption engine and its structural weakness — see
[02-moat-assessment.md](02-moat-assessment.md#the-one-live-argument-for-the-owned-runtime).

Reported weaknesses (third-party reviews): hallucinated market data, silent
mid-task context loss, VPS/Docker/SSH setup burden, *"doesn't scale past a single
Postgres,"* unsandboxed local CLI adapters.

Caveat: `doc/PRODUCT.md` is partly spec rather than shipped; the template
marketplace is roadmap. Do not confuse with the unrelated
`agencyenterprise/paperclip-ai`.

### OpenOPC

From HKU's Data Intelligence Lab (the LightRAG/AutoAgent group). Tagline
verbatim: *"OpenOPC: Build Your Personal AI-Native Company — Self-Built,
Self-Run, Self-Grown."*

Nine verticals (AI tech/research, software dev, financial investment, sales
growth, content & media, industry assistants, accounting & finance, brand &
e-commerce, education). Org architecture persists as editable YAML at
`.opc/config/company_orgs/org_<id>_config.yaml`. README: *"Companies use
declarative configurations with structured roles and reporting lines."*

Critically it also **generates** rosters: *"Given a goal, OpenOPC drafts the org
chart — deriving the roles and reporting structure the task demands,"* with a
recruiter agent reusing existing employees or onboarding from a talent pool.

This is concurrent work, not prior art. That is strategically worse than
discovering the bet was tried and abandoned: it is a well-resourced lab executing
it in the dominant language under the permissive license.

Caveat: assessed from its README only — architecture as claimed, not benchmarked.
Warrants hands-on evaluation.

## Segment B — Adjacent open source

Not direct company-runtime rivals; they compete for the same mindshare.

| Project | License | Scale | What it is | Moat type |
|---|---|---|---|---|
| [eigent-ai/eigent](https://github.com/eigent-ai/eigent) | Apache-2.0 | ~14.6k★ | CAMEL-AI-based desktop "Multi-Agent Workforce"; Electron + React | Upstream ecosystem — moderate |
| [5dive-ai/5dive](https://github.com/5dive-ai/5dive) | MIT | small | Self-hosted agent company; **live autonomy badge** | Brand/proof-of-use — low durability, but a mechanism OpenCompany lacks entirely |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | MIT | — | **268 prebuilt business-role agents** across ~20 departments | Content library — low-to-moderate |

**Eigent** ships functional agents (Developer, Browser, Document, Multi-Modal),
not business roles. No org chart, no business-type manifests, no cron runner, no
multi-tenancy. Current positioning is "Local and Free Alternative to Claude
Cowork." Adjacent, not rival.

**5dive** publishes a daily-recomputed autonomy metric from production:

```
raw.githubusercontent.com/5dive-ai/5dive/status/badge.json
→ {"schemaVersion":1,"label":"zero-human","message":"86.3%","color":"blueviolet"}
```

Computed via `5dive digest --json --7d` on a dedicated status branch. Their own
`docs/zero-human.md` concedes the metric is self-reported and excludes human
goal-setting — but it is a cheap, legible credibility mechanism, and it is the
single most copyable good idea found in this research.

**agency-agents-zh** is a markdown persona pack with no runtime (orchestration
lives in a separate repo). Its relevance is that it prices the catalog asset at
zero: 268 business-role agents, free, MIT. OpenCompany's 19-company catalog is
985 lines of TOML total, 3–9 agents each.

## Segment C — First-party declarative agent formats

The "agent as versioned declarative file" abstraction is table stakes shipped by
a hyperscaler, not proprietary IP.

**Microsoft Agent Framework** ([docs](https://learn.microsoft.com/en-us/agent-framework/agents/declarative),
updated 2026-07-10) opens verbatim:

> Declarative agents allow you to define agent configuration using YAML or JSON
> files instead of writing programmatic code. This approach makes agents easier
> to define, modify, and share across teams.

With explicit runtime file-loading: *"You can also store the YAML definition in a
separate file and load it at runtime, which makes it easier to share, version,
and edit the agent configuration independently from your code."*

Shipping artifacts: NuGet `Microsoft.Agents.AI.Declarative`, PyPI
`agent-framework-declarative`; Agent Framework reached 1.0. Corroborated by
`microsoft/AgentSchema`, Microsoft Foundry `agent.yaml`, Google ADK YAML agent
config, M365 Copilot declarative agents.

**Two scope caveats that must travel with this:** Microsoft's unit is a single
agent plus a workflow, not a company roster — it ships agent-as-data, not
company-as-data. And it is an SDK requiring host code, not a
`serve --company X` binary. Same pattern, different distribution model.

**CrewAI** ([docs](https://docs.crewai.com/en/concepts/agents)) scaffolds
config-first by default: *"New projects created with `crewai create crew <name>`
use JSON-first configuration. Each agent is defined in
`agents/<agent_name>.jsonc`, and `crew.jsonc` lists which agents are part of the
crew."* Required attributes are role/goal/backstory — OpenCompany's
`id`/`role`/`description` is that schema with goal and backstory collapsed into
one string, minus tools/llm/max_iter/allow_delegation.

Material qualifier: CrewAI's declarative layer sits inside a Python project; the
scaffold still emits `crew.py`/`main.py`. The "one prebuilt binary, swap the
manifest, zero code" property is genuinely not precedented — but it is packaging,
not IP.

## Segment D — Vertical AI-workforce services

**This is where capital actually flows, and it contradicts the thesis.**

[Eudia](https://www.prnewswire.com/news-releases/eudia-acquires-johnson-hana-to-build-worlds-first-ai-augmented-human-workforce-302499622.html)
— AI platform for Fortune 500 legal teams. $100M Series A led by General Catalyst
(Marc Bhargava). On 2025-07-08 it **acquired ALSP Johnson Hana**, bringing "300+
elite legal professionals" in-house. Independently confirmed: johnsonhana.com now
redirects to Eudia.

CEO Omar Haroun: *"Human + AI teams consistently outperform humans or AI working
alone."* The banner is literally **"AI-Augmented Human Workforce."**

General Catalyst's [portfolio thesis](https://www.generalcatalyst.com/stories/the-future-of-services)
describes Eudia as *"a vertically integrated, AI-native platform that pairs
proprietary technology with a 300+ person legal delivery team."*

**Moat type:** regulatory position + customer book + delivery capacity via M&A.
High durability, structurally unavailable to an open-source runtime.

**Why it matters:** the best-capitalized player in the adjacent category is
walking *back* from full autonomy toward human-plus-AI. "Headcount of one" is the
position the market's winners are retreating from.

Caveats: funding facts come from a company press release. GC's post is VC content
talking its own book — admissible as evidence of what GC argues, not as
independent market sizing. Its $6T-services-vs-$370B-software framing compares
US-only services revenue against *global* software spend; the implied multiple is
inflated and must not be reused as a hard number.

## Segment E — Hosting and infrastructure

[AWS Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/pricing/)
publishes a public price floor for agent-hosting compute:

> $0.0895 per vCPU-hour … $0.00945 per GB-hour … Billing is calculated per
> second, using actual CPU consumption and peak memory consumed up to that
> second, with a 1-second minimum.

Reproduced by three unrelated third-party cost analyses.

**Two qualifications.** Not apples-to-apples: AWS bills actual CPU consumed,
whereas per-tenant containers pay for provisioned vCPU while idle unless they
truly scale to zero — so the real bar is *higher* than the headline rate. And
runtime compute is one of ~12 separately billed components. Defensible framing:
"a published unit price for the compute layer," not a complete unit-economics
benchmark.

Two stronger sibling claims — that AgentCore charges nothing for the hosting
harness, and that it offers true scale-to-zero — were **refuted 0-3** and must not
be reintroduced. See [05-evidence-log.md](05-evidence-log.md).

## Segment F — Commercial AI-employee products

**Largely unverified. Treat this section as a research gap, not a finding.**

Only one figure survived verification: Relevance AI raised a **$24M Series B**
led by Bessemer (2025-05-06), $37M total, valuation undisclosed. Funding is not
traction.

No churn, retention, ARR, or post-mortem data was verified for Lindy, Artisan,
11x, Sierra, Decagon, Devin/Cognition, Harvey, Hebbia, Clay, Zapier Agents,
Gumloop, Replit Agent, Factory.ai, Cosine, or Reflection.ai — despite being the
top priority of a dedicated research pass.

What *was* verified is ARR inflation as a category behavior
([TechCrunch, 2026-05-22](https://techcrunch.com/2026/05/22/how-vcs-and-founders-use-inflated-arr-to-kingmake-ai-startups/)):

> One VC told TechCrunch that he has seen companies where CARR is 70% higher than
> ARR, even though a significant chunk of that contracted revenue will never
> actually materialize.

Plus a reported case of a startup claiming >$100M ARR "when only a fraction of
that revenue came from currently paying customers," and a $50M-marketed vs
$42M-actual discrepancy.

**These are anonymous single-source anecdotes about unnamed companies. They must
not be upgraded into a prevalence rate.** In the $50M/$42M case investors held
accurate books and both sides treated the gap as expected — evidence of tolerated
inflation, not concealed fraud.

The "AI-SDR bubble is deflating" hypothesis remains **untested**.
