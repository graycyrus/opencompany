# Design Review Log

Twelve implementation designs were produced against source and adversarially
reviewed. **Three passed. Nine were found unsound.** This file records the
rejected approaches and the defect that killed each, so none is revived by
someone who does not know why it was dropped.

An earlier pass produced twelve designs of which **all five that got reviewed
failed**, on two systematic misreads now recorded as
[Facts 1 and 2](07-architecture-facts.md). This log covers the corrected second
pass.

## Outcomes

| Design | Size | Review | Fate |
|---|---|---|---|
| `never-do-and-denial-audit` | small | ⚠️ unreviewed | → R3 |
| `console-write-plane` | small-plan | **passed** | → C2 |
| `conformance-holes` | small-plan | **passed** | → C1 |
| `tools-and-ci` | small-plan | unsound | merged + rescoped → R2, R4 |
| `agent-identity` | small-plan | unsound | merged into R4 |
| `inference-cost` | small-plan | unsound | split → R1 (survives), R7 (blocked) |
| `budget-enforcement` | small-plan | unsound | fixable → R6 |
| `two-phase-provisioning` | large-plan | unsound | **rejected pending revision** |
| `config-revisioning` | large-plan | unsound | **storage half salvageable** |
| `reliability-metric` | large-plan | unsound | **repairable, but deferred to R8** |
| `teammate-lifecycle` | large-plan | unsound | **rejected — fatal step** |
| `desk-task-routing` | small-plan | unsound | **rejected — false evidence** |

## Rejected: the fatal defects

### `two-phase-provisioning` — inverts Fact 2's causality

The problem selection is right and `setup.md:113-116` is genuinely normative and
unimplemented. The port-not-`CompanyRecord`-field decision is correct, and its
`namespaced_company_id`-at-draft-time catch was sharp.

**Fatal:** its central durability claim — *"the confirmed budget lands in the
build-time manifest, which `builder.rs:717-739` re-saves on every rebuild, so it
is not erased"* — has the causality **backwards**. That code re-saves *from* the
build-time manifest, overwriting stored state; it does not preserve state written
into the record.

The acceptance criterion meant to guard this is a tautology: it passes only if the
test happens to rebuild from a source manifest that already carries the budget.

*Revive when:* the budget's durable home is a sibling field or a dedicated port,
with an acceptance test that rebuilds from an **unmodified** source manifest.

### `config-revisioning` — incoherent rollback algebra

The storage half is the strongest work in the series and should survive largely
intact: the `builder.rs:717-739` preserve-list reasoning, the sibling-field
pattern, `fs.rs:188` `toml::to_string(&record.manifest)` forcing base-in-manifest,
and the sqlite CREATE-IF-NOT-EXISTS gap at `sqlite.rs:55-62` requiring an explicit
`ALTER` in `from_conn` (`:239-241`) all verified.

**Fatal:** two rollback mechanisms run at once — step 2 folds only layers with
`rolled_back_by.is_none()` **and** step 9 appends a new layer carrying the stored
inverse. With one change it works by coincidence; with two it corrupts.

**Second:** the precomputed inverse is only valid as the *final* layer.
`invert(pre, ops)` is computed against the apply-time pre-image, so any later
layer touching the same JSON pointer — or an operator editing the
version-controlled `company.toml` — invalidates it.

*Revive when:* one rollback mechanism is chosen, and inverses are computed at
rollback time against the current state rather than stored at apply time.

### `teammate-lifecycle` — the enforcement step is a no-op

Diagnosis accurate, most citations verified, correctly avoids the PATH A/B
confusion and handles Fact 2 via a sibling field.

**Fatal:** step 9's "live enforcement without restart" does nothing.
`CycleRequest.roster` (`src/ports/types.rs:492-493`, populated
`src/runtime/cycle.rs:70-78`) has **zero consumers** — `src/brain/echo.rs:117` and
the hosted/sidecar tests ignore it. Filtering a suspended teammate out of that
field changes no behavior anywhere.

Acceptance criterion 4 is the construct-a-struct-assert-a-getter failure mode: it
asserts `CycleRequest.roster` excludes a suspended id, which passes while nothing
in the system observes the exclusion.

*Revive when:* a consumer of `CycleRequest.roster` exists, or enforcement moves to
a point that actually gates execution.

### `desk-task-routing` — false evidence

The core mechanism (carry `chat_id` on the event; put the decision in a non-gated
`src/company/roster.rs`) works end to end for an explicitly-addressed REST call,
and wire compat is proven by existing by-field tests
(`src/ports/types.rs:859-881`).

**Fatal:** it cites a synthetic "General" desk that does not exist.
`src/server/graphql/company.rs:225-241` builds desks **only** from
`manifest.group_chats`, so today `OperatorMessage`s match **zero** desks
(`company.rs:315-318`). Its step 4 therefore fixes nothing for the console.

**Second:** the attribution fix does not exist in the default build. `from_agent`
is set only in `src/harness/brain.rs`, and `HarnessBrain` is instantiated
(`builder.rs:663-685`) only under `feature = "openhuman"` **and** a configured
harness inference.

*Revive when:* desk construction is settled (synthetic default desk, or accept
that only manifest group-chats route), and the default-build path is addressed
separately.

### `reliability-metric` — repairable, but correctly deferred

Much stronger than its v1: correctly stays on PATH A, avoids the Fact 2 trap,
does not claim CI coverage for `src/harness`, reuses the existing
`company(id: Option<ID>)` resolver rather than inventing id plumbing, and its
`UsageMeter` precedent citations verify.

**Contradiction:** the error policy says `PolicyDenied` and `BrainErrored` writes
propagate with `?`, while acceptance criterion 2 says "recording never changes
control flow." Both cannot hold — `emit_effect` returns
`Result<EffectDisposition>`.

**Permanent-failure chain:** `src/store/fs.rs:95` aborts the entire read on one
bad line, and `FsOps::record` calls `read_jsonl` on **every** write for retention
compaction (`src/store/fs_ops.rs:472`). `AttemptOutcome` has no `#[serde(other)]`,
so one unreadable row poisons all subsequent writes.

Deferred to R8 regardless of repair: before R4 and R6 land it measures an echo
brain against a ledger of zeros.

## Merged and split

**`tools-and-ci` + `agent-identity` are the same feature**, discovered
independently. Both correctly identified the empty tool vector at
`src/harness/build.rs:88`. Both bound `file_write`, which review showed is dead on
arrival under the shipped supervised fixture (Fact 5). Merged as R4 with mutation
deferred to R5.

`agent-identity`'s specific failure: its mechanism is a runtime no-op as written.
`is_external_effect` (`policy.rs:182-198`) classifies `file_read`/`file_write` as
external, which under the default supervised mode blocks them — and its acceptance
criteria assert the *constructed vector* rather than any execution, so they cannot
catch it. Its author noted the gap ("Agent exposes no tool-list getter we
verified") and shipped the test anyway.

**`inference-cost` splits three ways.** Part (a), the ledger sign inversion, is
verified and shippable alone — review explicitly endorsed it. Parts (b) and (c)
rest on a misread: the proposed host-side estimator duplicates
`estimate_call_cost_usd`, already running upstream
(`observability.rs:419-434,:484`). Two acceptance criteria were falsified
outright — a float equality asserting `0.42` where f64 yields
`0.42000000000000004`, and an `Estimated`-basis assertion that would in fact
observe `Charged`.

**`budget-enforcement`** has a sound mechanism and four fixable defects, one of
which — `CompanyEvent::BudgetDenied` — would have shipped a tenant-bricking
rollback path, presented in the design as "no data migration." Corrections are
folded into [R6](09-feature-briefs.md#r6--per-agent-daily-budget-enforcement).

## Reading this log

The pattern across nine failures is consistent and worth internalizing: **designs
failed on call paths, not on ideas.** Diagnoses were largely accurate; citations
mostly checked out; mechanisms broke when someone traced them end to end.

Two failure shapes recur:

1. **Writing to a field nothing reads** — `CycleRequest.roster`,
   `budget_usd_daily()`, `human_role`. Grep for consumers before designing around
   a field.
2. **Tests that assert construction rather than behavior** — asserting a vector's
   contents, a struct's getter, or a field's value, while nothing in the system
   observes it.

Both are cheap to check and neither is caught by review of the design text alone.
