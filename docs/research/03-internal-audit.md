# Internal Audit — What Is Actually Real

Companion analysis to [`../spec/feature-audit/STATUS.md`](../spec/feature-audit/STATUS.md),
which holds the per-capability table. This document explains what the numbers mean.

Produced by a 69-agent audit, 868 tool calls, every claim checked against source.

## Headline

**7 of 93 capabilities are shipped with a test proving them — 7.5%.**

| Status | Count | Share |
|---|---|---|
| shipped | 7 | 7.5% |
| partial | 20 | 21.5% |
| seam only | 27 | 29.0% |
| not started | 39 | 41.9% |

Two-thirds of the product (66/93, 71%) is seam or absent. Adversarial
verification downgraded 11 claims the auditors themselves made — an 11.8%
overclaim rate on a first pass that was already instructed to be strict, and
**every downgrade moved toward absence, never away**.

Three families have zero shipped capabilities: 04 live operations, 08 company
commerce, 09 continuous company review. Family 09 is 9 `not started` and 2
`seam only` out of 11 — it does not exist in any form.

## The shape of it

OpenCompany has shipped an excellent company **description** format and almost
none of the company **execution** that format implies.

What is genuinely real, and it is not nothing:

- **The manifest linter** — ~180 rules in prosumer language, enforced identically
  at load (`src/company/manifest.rs:85-93`), at CLI `check`
  (`src/company/mod.rs:54-88`), and at the provisioning ingress
  (`src/server/provision.rs:117-125`). All 20 company definitions lint in CI.
- **Safe defaults, enforced not merely parsed** — a manifest declaring only
  `[company].name` resolves to supervised, non-discoverable, with
  `always_approve = [payment.send, filing.submit, external.publish]`
  short-circuiting before mode dispatch (`src/policy/gate.rs:214-222`).
- **The approval gate on the live effect path** — `src/runtime/cycle.rs:335-365`
  calls `approvals.evaluate()` before every effect; `RequireApproval` genuinely
  parks and journals. Unknown modes fail safe to `RequireApproval`.
- **Manifest as root of trust** — operator edits touch only `overlay_agents`;
  manifest teammates are undeletable (409); rebuilds preserve overlays without
  rewriting `company.toml` (`src/runtime/builder.rs:727-738`).
- **Workflow TOML** parses into a validated six-kind node/edge graph.

Then the trail goes cold at the same place every time.

## The five load-bearing defects

### 1. Agents have no tools

```rust
// src/harness/build.rs:85
let tools: Vec<Box<dyn Tool>> = Vec::new();
```

Every downstream capability — per-teammate tool narrowing, workspace isolation,
memory namespacing, spend limits, workflow execution, and every reliability
metric family 06 wants — is isolation of nothing or gating of nothing.

### 2. CI never compiles the runtime you own

`Cargo.toml` has `default = []`. `.github/workflows/ci.yml:50` is bare
`cargo test`. `Dockerfile:19-21` defaults `FEATURES` empty.

The two tests proving a manifest teammate is a real worker
(`roster_builds_every_manifest_agent`, `run_executes_a_turn_on_the_openhuman_runtime`)
**never execute in automation** — and when run manually they exercise
`MockProvider("mock: ")`.

The vendored runtime is the entire differentiation thesis
([02-moat-assessment.md](02-moat-assessment.md#the-one-live-argument-for-the-owned-runtime)).
It is not built by CI and not shipped in the image.

### 3. Per-agent least-privilege is unimplementable

`effective_grants` dedups the union across the **entire roster**
(`src/runtime/builder.rs:83-95`), and `ToolCall` carries `{tool, args}` with **no
agent identity** (`src/ports/types.rs:517-522`).

Every agent is authorized against the aggregate of all agents' grants. Grant one
teammate `payment.send` and you have granted it to the whole company.

This is a live privilege-escalation shape, not a missing feature — and it is
unimplementable rather than unimplemented until identity reaches the enforcement
path.

### 4. Budgets bind nothing

`budget_usd_daily()` has **zero callers repo-wide**; `check()` never consults it
(`src/harness/policy.rs:89-92,129-175`). A teammate capped at $5/day gets `Allow`
on a $50 call.

Relatedly, `never_do` — the strongest-sounding primitive in the manifest — is a
stub with a permanently empty list (`src/policy/gate.rs:211-212`). A charter
prohibition like "never contact my customers directly" is unenforceable.

Both break the stated invariant *"No feature bypasses budgets or approvals."*

### 5. Cost metering is a stream of zeros

`docs/spec/roadmap.md` marks real inference cost **Partial**, blocked on
`tinyhumansai/openhuman#4940` (turn-usage accessor): *"until it lands the cost
hook records a zero-usage turn."*

`src/metering/usage.rs` and `finances.rs` are pure projections over `UsageSample`s
that are all zero-cost. The only metering test —
`zero_usage_turn_writes_nothing` (`src/harness/mod.rs:507-518`) — **asserts the
ledger and meter remain empty**. There is no test anywhere proving a nonzero
entry.

Family 06's acceptance criterion is *"cost totals reconcile with ledger entries
within documented rounding rules."* That is trivially satisfiable and completely
meaningless: 0 reconciles with 0. Family 08's revenue and margin tracking sits on
the same empty stream.

**No family document flags this.** It is the most dangerous blind spot in the
audit.

## The console ships fiction

`starterTeam()` (`frontend/src/lib/team.ts:56-65`) renders **six fabricated
teammates** whenever the roster is empty or the GET 404s. An operator's first
impression of the product is invented data.

More broadly, the console writes almost nothing: `frontend/src/api/client.ts` has
`listTeam` and no team write at all. Adds, removes, and inbox toggles are React
state and localStorage. Working REST endpoints exist and sit unused
(`src/server/ops/team.rs:28-32`).

This is a trust failure rather than a UI stub, and the backend half is already
done — see [06-strategy.md](06-strategy.md#critical-path) item 4.

## Orphan capabilities

A drift sweep found **13 substantial capabilities (~12k lines)** of shipped,
user-facing, network-touching code that **no feature family owns**:

- Feedback / privacy-scrub / triage / GitHub issue filing (~3.5k lines) — the
  only path by which operator words leave the box
- Multi-user auth: invites, roles, sessions, admin management (~3k lines)
- Custom-domain DNS verification
- Inbound and outbound email (SMTP)
- OAuth connection lifecycle
- Bundle export/import
- Platform multi-tenancy and per-tenant JWT
- tiny.place economy surface, A2A agent cards, metering/usage projections

Two carry outright contradictions:

**Multi-user auth vs. a stated non-goal.** `docs/spec/roadmap.md:128` states
*"Not multi-human companies. Exactly one Operator per Company."* ~3k lines of
invite-only multi-user auth ship today. One of these is wrong.

**Shared-DB tenancy.** Application-layer isolation only; `CLAUDE.md` concedes a
compromised container reaches every tenant's documents. Highest-severity unowned
item in the sweep.

## Reading the numbers fairly

The 7.5% figure understates the codebase and overstates the gap simultaneously.

There are 51,398 lines of Rust and 637 tests here. Real engineering exists —
`ManifestApprovalGate` is 482 lines of working park/resolve/resume, the storage
port layer covers three backends with a shared conformance suite, and the
provisioning path genuinely validates before it builds.

But the working software is **not the software the nine families describe**. The
audit measures the distance between the spec's product and the code's product,
and finds they are two different products. That is a positioning problem as much
as an engineering one, and it is why open question 2 in
[`STATUS.md`](../spec/feature-audit/STATUS.md#open-questions) — *is
`--features openhuman` the product, or is the default build the product?* — has
to be answered before the roadmap means anything.
