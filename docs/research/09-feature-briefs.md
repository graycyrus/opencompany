# Feature Briefs

Why / what / how for each item in [08-roadmap.md](08-roadmap.md), in execution
order. Each brief is an engineer's starting point, not a finished plan — read
[07-architecture-facts.md](07-architecture-facts.md) first, and note every brief
incorporates adversarial-review corrections to its original design.

---

## R1 — Fix the inference ledger sign

**Size:** XS, one commit · **Depends on:** nothing · **Default features**

### Why
`src/harness/cost.rs:58-66` constructs `LedgerEntry { kind: "inference.spend",
amount_usd: turn.cost_usd, .. }` — **positive**. `src/metering/finances.rs:44-51`
books `amount_usd < 0.0` into `spent_usd` and `> 0.0` into `revenue_usd`. The
repo's own fixture agrees with the negative convention:
`src/server/graphql/test.rs:421-422` writes `inference.spend` at `-2.0`.

So on any managed-backend turn that echoes a real charge, **the operator's
Finances surface reports the cost as income.**

*Cost of not doing:* an operator-facing falsehood on the accountability surface
(invariant 1), and R6 would enforce against numbers of the wrong sign.

### What
**In scope:** the sign, plus a regression test.
**Out of scope:** the estimator, `CostBasis`, `TurnUsage` renames, and
**backfilling historical rows** — the ledger is append-only; document the
discontinuity instead.

**Acceptance:**
1. A turn charged $0.05 produces `amount_usd == -0.05` (epsilon compare).
2. Feeding that entry to `finances_from` increments `spent_usd` and
   `spend_by_category["Inference"]`, leaving `revenue_usd` at zero.
3. Passes under bare `cargo test`, no flags.

### How
1. `src/harness/cost.rs` — `amount_usd: -turn.cost_usd`; update the doc comment at
   `:50-57`.
2. `src/metering/finances.rs` tests — add
   `inference_spend_entry_is_categorised_as_spend_not_revenue`, constructing the
   entry via `cost::ledger_entry_for` rather than a literal, so the two modules
   cannot drift again.
3. One doc line noting pre-change rows carry an inverted sign.

### Risks
Float equality: use `(x - y).abs() < 1e-9`. Review caught the original design
asserting `0.42` where f64 yields `0.42000000000000004`.

---

## R2 — `--features openhuman` CI job

**Size:** XS · **Depends on:** nothing

### Why
`src/lib.rs:16` gates `pub mod harness;` behind `#[cfg(feature = "openhuman")]`,
`Cargo.toml` has `default = []`, `.github/workflows/ci.yml:49-50` is a bare
`cargo test`, and `Dockerfile:19-21` defaults `FEATURES` empty. **The owned
runtime — the entire differentiation claim — has never been compiled by CI.**

*Cost of not doing:* R4, R5, and R6 all ship code nobody builds. A skew between
`vendor/tinyagents` and openhuman's own vendored copy fails to compile **only**
under this feature and would go undetected.

### What
**In scope:** one CI job.
**Out of scope:** fixing whatever it turns red — that is a separate first commit.

**Acceptance:** a `harness` job runs `cargo clippy --features openhuman
--all-targets -- -D warnings` then `cargo test --features openhuman`, is green on
a PR, and turns red when a `use` is deleted from `src/harness/build.rs`.

### How
1. **Spike before scheduling R4:** run `cargo check --features openhuman
   --all-targets` locally. If red, that fix is commit zero and R4's estimate is
   invalid.
2. `.github/workflows/ci.yml` — add a job reusing the existing checkout and
   `Init vendored openhuman crate submodules` steps at `:21-36` (they exist for
   precisely this), plus `Swatinem/rust-cache@v2`.
3. Measure cold-runner wall clock. If intolerable, downgrade clippy to
   `cargo check` — but **do not** drop `cargo test --features openhuman`; R4/R5/R6
   tests exist only under that feature.

### Risks
Private submodule checkout may need a token in Actions. Build time unmeasured. If
the job cannot run per-push, nightly + on-label is a real weakening — state it in
the PR rather than glossing it.

---

## R3 — Enforce `never_do` + journal policy denials

**Size:** small · **Depends on:** nothing · **Default features** · ⚠️ **design unreviewed**

### Why
Two linked gaps.

1. **`never_do` does not exist.** `src/company/types.rs:252-262` has exactly
   `{ mode, always_approve, auto_approve_under_usd }`, and
   `src/policy/gate.rs:210-212` is a *comment* where precedence step 1 should be.
   Under `mode = "full"` a charter prohibition is **silently allowed**
   (`gate.rs:222`).
2. **Denials vanish.** `src/runtime/cycle.rs:362-364` returns
   `EffectDisposition::Denied { reason }` with no journal write, while the sibling
   `RequireApproval` arm at `:346-359` calls `record_parked`. `JournalRecord`
   (`src/runtime/journal.rs:33-74`) has no denial variant.

*Strategic:* Paperclip ships enforced gates and an immutable audit log. This is
the cheapest item that closes a competitor gap entirely inside default-feature
code. It is also the **prerequisite for tools** — an unenforced `never_do` is a
documentation bug today and a safety hole the moment R4 lands (Fact 5).

### What
**In scope:** `never_do: Vec<String>` on `[policy]` with `#[serde(default)]`;
enforcement as precedence step 1; a `PolicyDenied` journal record written from the
`Deny` arm and replayed on boot; a read-only GraphQL `denials` field.

**Out of scope:** the natural-language delegation-rule compiler
(`docs/spec/company-brain/approvals.md:56` — "Never contact my customers directly"
is a payload-level predicate a dotted glob cannot express); a `[charter]` block
(zero Rust references); runtime editing of `never_do`; anything in `src/harness/`.

**Acceptance:** deny beats `always_approve`; deny beats `mode = "full"`;
`never_do = ["payment.*"]` denies `payment.send` and not `email.send`; a
`"record":"PolicyDenied"` line lands in `journal.jsonl` and survives reopen +
`load()`; **empty `never_do` leaves every existing decision byte-identical**
(guards both shipped fixtures). All under bare `cargo test`.

### How — five commits
1. `refactor:` lift `grant_matches` (`src/runtime/tools.rs:40-48`) into
   `src/company/glob.rs` as `glob_matches`, re-export at the old path. **Verify
   with `cargo check --all-targets --features openhuman`** — the doc comment at
   `tools.rs:38-39` says an OpenHuman-backed provider shares it, and CI will not
   catch a break there until R2.
2. `feat:` `never_do` on `Policy` + `Default` + `gate.rs` step 1 *before* the
   `always_approve` check at `:214`; update the stale module doc at `gate.rs:5-7`;
   validate blank entries in `manifest.rs:98`.
3. `feat:` `JournalRecord::PolicyDenied { effect, reason, at_millis }`,
   `DeniedEffect`, `record_denied`/`denials()` mirroring
   `record_parked`/`pending()` (`journal.rs:181-197,:243-260`), a
   `DENIAL_HISTORY_CAP = 500` in-memory tail, and the `cycle.rs:362` call site.
4. `feat:` `DenialSummary` → `CompanyRuntime::recent_denials()` → `DenialGql`,
   modelled on `ApprovalGql` (`graphql/company.rs:248-269`), `at_millis: f64`.
   Reads only.
5. `docs:` precedence, the glob-vs-natural-language limitation, STATUS.md rows,
   and `never_do = ["payment.send"]` in `companies/openhuman_demo/company.toml:20`
   (harness-oriented, so it cannot alter default-feature behaviour of the signals
   fixture).

### Risks
**Invariant-4 finding, inherited not created:** the journal is always a local
filesystem path (`builder.rs:744-746`) even under `OPENCOMPANY_STORAGE=mongodb`,
so denial records land on the container volume, outside the tenant DB and outside
the conformance suite. Already true for executed/parked/expired/amended. State it;
do not hide it.

**Open:** `[policy]` vs a future `[charter]` block — ship on `Policy`, which is
what `ManifestApprovalGate::new` already receives (`builder.rs:751`), and alias
later. **Open:** should `never_do` also fence PATH B *tool names*? Different
namespace, not a free extension. **Decide before R4, not after.**

---

## C1 — Close conformance holes

**Size:** small · **Depends on:** nothing · **Review: passed**

### Why
Invariant 4 is asserted but unenforced in two places. `src/store/conformance.rs:55-63`
hard-codes `overlay_agents: Vec::new()` and feeds that record to both
`assert_isolation_by_company` (`:82`) and `assert_export_totality` (`:297`)
**without ever asserting the field** — so a backend that silently drops
`overlay_agents` passes the entire suite. And `src/store/mongodb.rs:1628-1634`
skips silently when no URI is configured; every conformance test at `:1711+` opens
with `let Some(s) = store().await else { return }`.

This matters more after C2, which makes `overlay_agents` the console's primary
durable write.

### What
**In scope:** an overlay round-trip case in the shared suite; MongoDB conformance
that fails or explicitly reports rather than silently returning.
**Out of scope:** new port methods; changing the MongoDB backend itself.

**Acceptance:** saving a record with two `OverlayAgent`s, reloading, and asserting
field-level equality — run for fs, sqlite, and mongodb. A backend that drops the
field fails. Default `cargo test` either runs mongo conformance against a
container or reports an explicit skip.

### How
1. `src/store/conformance.rs` — populate `overlay_agents` in the shared fixture
   and add an equality assertion in the round-trip case.
2. `src/store/mongodb.rs:1712` — replace the silent `else { return }` with an
   explicit skip report, or a failure when a URI is expected.

---

## R4 — Per-agent sandboxed **read-only** tools

**Size:** small-plan · **Depends on:** R2, R3 · **PATH B**

### Why
`src/harness/build.rs:86-88` hands `AgentBuilder` an unconditionally empty tool
vector. `AgentBuilder` accepts `tools`, `visible_tool_names`, and `tool_policy`
**per builder instance**
(`vendor/openhuman/.../session/types.rs:327`) — so per-agent least privilege is
expressible exactly here and nowhere else (Fact 1).

*Strategic:* Paperclip's reported failures, unsandboxed adapters chief among them,
are runtime failures it structurally cannot fix. That claim is unfalsifiable while
our agents hold zero tools.

*Cost of not doing:* agents stay conversation-only, every downstream metric is
zeros, and if tools are wired later *without* identity the first wiring hands
every agent the roster-wide union from `effective_grants` — a security regression
window.

### What
**In scope:** a grant→tool translation table; per-agent grant resolution; a
per-agent `Arc<SecurityPolicy>` rooted at that agent's workspace with trusted
roots stripped; **read-only tools only** (`file_read`, `list`); the read-only name
set fed to `ApprovalPolicy`.

**Out of scope — the key rescope:** `file_write` and every mutating tool. Review
established it is **dead on arrival** on the shipped supervised fixture, because
`RequireApproval` becomes an unlogged model-facing error (Fact 5). Mutation ships
in R5. Also out: PATH A, `web.*` (nothing sandboxed and offline-safe is vendored),
new durable state, ports, REST/GraphQL, budgets.

**Acceptance:**
1. For the shipped signals fixture, `signal_scout` (grants `web.*`) yields an
   **empty** tool vector while `opportunity_analyst` (grants `web.*, docs.*`)
   yields exactly `{file_read, list}` — proving least privilege *and* that the
   fixture's `docs.*` grant is not dropped by a naive roster intersection.
2. **Sandbox escape tested at the right layer:** an *absolute* path
   (`/etc/passwd`) is rejected — this exercises `path_checks.rs:70`, the line
   trusted roots defeat. Plus an out-pointing symlink (`path_checks.rs:88-105`).
   Do **not** use `../escape.txt`; it is caught by a string check at
   `path_checks.rs:241` before any sandbox logic runs, so it passes even with
   trusted roots left in.
3. Constructed `SecurityPolicy` has `trusted_roots.is_empty()` and
   `workspace_only == true`.
4. `ApprovalPolicy::check` returns `Allow` for `file_read`/`list` on a supervised
   desk; an `always_approve = ["file_read"]` manifest still gates it.
5. Empty `[tools].allow` ⇒ empty vector for every agent (default-deny).
6. `[tools].provider = "builtin"` (`src/company/types.rs:226-243`) gets **no**
   filesystem tools — the field is honoured, not silently ignored.

### How
1. `src/harness/tools.rs` (new, under the existing feature gate):
   `GrantedTools { tools, visible, read_only }` and
   `granted_tools(grants, provider, security)`. The table maps dotted grant globs
   to openhuman constructors and their **registered** names — `ListFilesTool` is
   `"list"`, not `list_files`. Reuse `glob_matches` from R3 so both paths glob
   identically. Add a test asserting each constructed `tool.name()` equals its
   table entry, so an upstream rename cannot desync `visible_tool_names`.
2. Same file: `agent_security(workspace)` — build the policy, then
   **`policy.trusted_roots.clear()` after construction.** This is the
   highest-risk line in the plan; carry the `enforcement.rs:74-140` citation as a
   code comment. Without it every company agent gets read-write access to the
   operator's home directory.
3. Derive `read_only` **from the constructed tool instances** via
   `Tool::external_effect_with_args`/`permission_level()`
   (`vendor/.../tools/traits.rs:405`), not a hand-maintained bool column —
   `FileWriteTool` is args-dependent (`file_write.rs:66-83`) and a static column
   will drift.
4. `src/harness/build.rs` — new `grants: &[String]` parameter;
   `create_dir_all(&workspace)` **before** any tool resolves a path (a missing dir
   degrades sandboxing to a raw-path fallback, `path_checks.rs:186`);
   `.tools(...).visible_tool_names(...)`; delete the stale `// v1: no tools yet`
   comment and the module-doc bullet at `build.rs:6-11`.
5. `src/harness/mod.rs` `build_roster` (`:213-238`) — resolve grants **per agent**
   (company `[tools].allow` narrowed by `agent.tools`, most-restrictive-wins,
   default-deny on empty). Explicitly **not** `effective_grants`, which unions
   across the roster. Add a two-agent divergence test.
6. `src/harness/policy.rs` — add `read_only: HashSet<String>` and short-circuit
   `check()` to `Allow` **after** the `always_approve` branch (so `always_approve`
   still wins) and before the mode match. Keep the prefix heuristic at `:182-197`
   as the fail-safe for unknown tools. Note `classify_group` (`:201-217`) maps
   anything containing `"file"` to `EffectGroup::Sign` — fix or document before R5
   parks a file approval labelled as a signing effect.

### Risks and open questions
**The `docs.*` grant name is a product-language mismatch.** The bound workspace is
`{data}/harness/{company}/{agent}/workspace` — a per-agent private scratchpad no
other agent, port, or console surface can read. An operator reading `docs.read`
expects company documents. **Rename (`workspace.*` / `files.*`) or bind it to
something the ports can see. Do not ship `docs.*` pointing at scratch.**

**Open:** can a session synthesize tools mid-run
(`pending_synthesized_tools_mask`, `session/types.rs:315-322`)? If yes the
per-instance vector is not a complete grant boundary and `visible_tool_names` must
be belt-and-braces. Trace before merge.

---

## R6 — Per-agent daily budget enforcement

**Size:** small-plan · **Depends on:** R1, R2, R3 · **Parallel with R4**

### Why
`Agent.budget_usd_daily` (`src/company/types.rs:121`) is parsed, carried into
`ApprovalPolicy` (`policy.rs:69`, set at `mod.rs:225`), given an accessor
(`policy.rs:89-92`) — **and never read.** `check()` (`policy.rs:129-175`) branches
only on `always_approve`, `auto_approve_under_usd`, and the three tiers; the
string `budget` appears nowhere in its body. `HarnessPool::run` (`mod.rs:187-201`)
has no pre-turn gate.

The enforcement data already exists and is durable:
`UsageSample { at_millis, agent, cost_usd, .. }` (`src/ports/usage.rs:47-64`),
written per turn and readable via `UsageMeter::query`.

*Cost of not doing:* a manifest field that reads as a safety control enforces
nothing. The only budget ceiling that exists (`[budget].monthly_usd`) lives in the
x402 adapter and never covers inference.

### What
**In scope:** pure decision logic in the **un-gated** `src/metering/budget.rs` (so
today's CI covers it); an in-process `SpendTracker` seeded from the durable
`UsageMeter` at roster build; a pre-turn gate; a durable denial record; a GraphQL
`budgets` read.
**Out of scope:** company-wide monthly inference enforcement; mid-turn abort;
per-tool caps; runtime-editable caps (a config-change design — see Fact 2).

**Acceptance:** an over-cap agent plus one operator message ⇒ the turn never runs,
`UsageMeter::query` sample count is unchanged, a plain-language channel reply is
returned, and a durable denial is still present after a runtime rebuild.
`verdict(9.99, Some(10.0))` allowed; `verdict(10.0, Some(10.0))` exhausted.
Yesterday's UTC sample counts $0 toward today.

### How — four review-mandated corrections to the original design
1. **Do not add `CompanyEvent::BudgetDenied.`** `src/runtime/journal.rs:4-8`
   states in source that `CompanyEvent` is "a closed, binding enum with no marker
   variants," and `src/store/fs.rs:95` deserializes inside `read_jsonl` — **one
   unknown line fails the entire log read**, so a rollback to a prior hosted image
   bricks chat history, `/a2a`, and export for any tenant that hit a cap. Use R3's
   `PolicyDenied` machinery. This is why R6 depends on R3.
2. **The headline harness test as originally written is vacuous.**
   `MockProvider` (`src/harness/provider.rs:87-100`) returns a bare string with no
   usage, and `is_zero_usage` (`cost.rs:88-90`) suppresses the sample regardless —
   so "no new sample" passes today with no gate at all. Use an
   **invocation-recording** provider and assert the turn never executed.
3. **Reconcile the two operator surfaces.** `ledger_entry_for` refuses $0 lines
   (`cost.rs:59-61`) and charged USD is 0.0 on every non-managed path
   (`provider.rs:307-311`), so Finances reads "$0 spent" while a teammate is
   blocked for "spending $1.20 of $1.00." Either surface the estimate in Finances
   or make the denial message name its basis explicitly.
4. **Original step 2 does not compile:** there is no `crate::app::config::Env`;
   the trait is `EnvSource` (`src/app/config.rs:138`).

Keep as an **independent commit**: `builder.rs:672` sets the harness meter to
`fs_ops.clone()` while every read path uses `ops.usage` (`builder.rs:539`) — under
a non-fs backend the harness writes samples nobody reads, and the gate would read
a different store than it writes. Real bug, valuable alone.

### Risks
Overshoot is by design (admission-time check) — document it on the manifest field,
not only in docs. `SpendTracker` is per-process; two replicas of one tenant would
each track half the spend. State the single-replica assumption. Placeholder rates
(3.0 / 15.0 USD per Mtok) need real managed-tier numbers — a wrong rate silently
blocking an operator is the worst failure mode here.

---

## C2 — Console write plane + delete `starterTeam`

**Size:** small-plan · **Depends on:** R3 (roster journaling) · **Review: passed**

### Why
Review called this *"the only design in this set whose mechanism traces end to
end."*

`starterTeam()` fabricates six teammates (`frontend/src/lib/team.ts:55-66`) and
`TeamView` falls back to it on any error — including the one that **always**
happens: `client.listTeam` GETs `${scope}/team`
(`frontend/src/api/client.ts:182-184`) and **no such REST read route exists**
(`src/server/ops/team.rs:29-31` registers only post/delete/put). So the fabricated
roster is what operators always see. Add/remove at `TeamView.tsx:84,118` are
purely local React state.

The backend is complete and tested on both planes
(`graphql/company.rs:188-224`, `ops/write_test.rs:322-364`).

### What
**In scope:** route team reads through the existing GraphQL resolver; wire
add/remove/inbox-toggle to the existing REST writes; delete `starterTeam()`.
**Out of scope:** new backend routes — none are needed.

**Acceptance:** add/remove a teammate and toggle an inbox; all three survive a page
reload. An empty or failed roster renders an empty state, never six invented
teammates.

### How
Use `company(id: Option<ID>)` with `None => registry().sole()`
(`src/server/graphql/mod.rs:83-99`) — the single-company alias already exists
(Fact 4). The query document must be `query($id: ID)`, **not** `ID!`, or it fails
validation in single-company mode.

Do **not** assume the 401 hook is inherited: GraphQL auth failures return HTTP
**200** with an errors array (`graphql/mod.rs:125-131`) while `client.ts` fires
`onUnauthorized` only on `status === 401`.

Watch `InboxView`, which derives its entire list from `lib/inbox.ts`
(`InboxView.tsx:16,18,30-32`) — gutting that module while migrating `TeamView`
regresses a second surface.

### Why it waits for R3
Both `add_member` (`team.rs:74-97`) and removal (`:117`, an unlogged
`Vec::retain`) write no `EventLog` record. Connecting the UI first would let an
operator mutate the roster with **no audit trail** (invariant 1). Fold roster
journaling into R3's work if this is wanted sooner.

---

## R5 — Bridge tool denials to `ApprovalGate`; bind write tools

**Size:** medium (estimate) · **Depends on:** R3, R4 · **No design yet**

### Why
This item exists because a reviewer found it, not because anyone designed it. See
[Fact 5](07-architecture-facts.md#fact-5--tool-approval-never-reaches-opencompany):
`RequireApproval` is converted at `middleware.rs:1423-1462` into a model-facing
error string recorded only in openhuman's in-process registry. It never parks,
never journals, never surfaces. On the shipped supervised fixture, **every**
mutating tool call takes that path.

*Cost of not doing:* R4 can never grow a write tool, `web.*` stays permanently
unbound, and the known denial gap goes from zero occurrences to routine.

### What
**In scope:** route openhuman tool-policy denials into `ApprovalGate::park` plus
R3's journal; surface them on the existing approvals GraphQL read; then bind
`file_write`.
**Out of scope:** resume-after-approval for an already-completed turn —
park-and-retry-next-turn is acceptable v1, but say so; `web.*`; payment tools.

### How — sequence, not yet a plan
1. **Trace whether `middleware.rs:1423-1462` exposes a host-injectable hook, or
   whether this needs an upstream openhuman change. This determines whether R5 is
   medium or blocked.**
2. If host-side: wire `HarnessDeps` to carry the `ApprovalGate` and journal.
3. Fix `classify_group` (`policy.rs:201-217`) so a file write is not presented to
   the operator as a *signing* effect.
4. Only then flip `file_write` into R4's table.

### Risks
Highest-uncertainty item on the roadmap. If the bridge needs upstream work, R5
joins R7 in the external-dependency bucket and R4 ships read-only indefinitely —
which is still a real capability, and exactly why R4 was rescoped rather than
blocked.

---

## R7 — Upstream `charged` / `estimated` split

**Size:** medium + external · **Depends on:** upstream openhuman PR

### Why
`LastTurnUsage` collapses two distinct figures into one. Both exist separately at
`vendor/openhuman/src/openhuman/tinyagents/observability.rs:419-434` before being
collapsed, and openhuman's own `TurnCost` (`agent/cost.rs:206-213`) already keeps
them apart.

Without the split, labelling a turn `Charged` is a **new operator-facing
falsehood** on the most common turn shape.

*Note:* this is a **different** upstream ask from `openhuman#4940` (the turn-usage
accessor that blocks cost entirely). File it now — it costs nothing locally and
the lead time is the constraint.

### What
**In scope:** upstream PR exposing `charged_usd` and `estimated_usd` separately;
then host-side `CostBasis` labelling.
**Out of scope:** a host-side price table — it duplicates
`agent::cost::estimate_call_cost_usd`, already running in the vendored parent turn
path (`observability.rs:419-434,:484`).

**Do not ship `CostBasis::Charged` before the split lands.**
