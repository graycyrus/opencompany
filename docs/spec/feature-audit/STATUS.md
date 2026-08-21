# Feature Inventory — Verified Status

Deliverable for [issue #21](https://github.com/tinyhumansai/opencompany/issues/21).
Every row was checked against source. Statuses here are **not** derived from spec prose.

## Method

Nine parallel audits (one per feature family) read each spec, then located the
implementation in `src/`, `frontend/src/`, `companies/`, and `vendor/openhuman/`.
Every non-`not started` claim was then handed to an independent adversarial
verifier instructed to refute it, defaulting to refutation under uncertainty.

**11 of 93 claims were downgraded by verification. Every downgrade moved toward
absence, never away.** Downgraded rows are marked †.

### Status definitions

| Status | Means |
|---|---|
| `shipped` | Behavior exists **and** a named test proves it. No test → capped at `partial`. |
| `partial` | Real behavior exists but the claim is only partly met. |
| `seam only` | Trait/port/struct/route exists; behavior behind it does not, or only a mock/offline impl exists. |
| `not started` | No implementation. |

### Why the bar is "a test proves it"

A prior review claimed `human_role` was a working contractual primitive, based
on the README. In source it appears five times: one struct field
(`src/company/types.rs:97`), one `println` in `effective_summary`
(`src/company/manifest.rs:291`), and three test fixtures.
`src/policy/gate.rs` contains **zero** references to it. It is a display string.

`docs/spec/product/templates.md:36-39` specifies a lint rule requiring
`human_role`; `validate()` does not enforce it. The field is specified, parsed,
printed, and otherwise ignored.

That is the failure mode this inventory exists to prevent.

## Totals

| Status | Count | Share |
|---|---|---|
| shipped | 7 | 7.5% |
| partial | 20 | 21.5% |
| seam only | 27 | 29.0% |
| not started | 39 | 41.9% |
| **total** | **93** | |

Downgraded by adversarial verification: **11 (11.8%)**

## Family summary

| Family | shipped | partial | seam only | not started | Outcome |
|---|---|---|---|---|---|
| [01 Guided company blueprints](01-guided-company-blueprints.md) | 2 | 0 | 1 | 6 | Operator describes a business, reviews a validated company before launch |
| [02 Active runtime teammates](02-active-runtime-teammates.md) | 1 | 4 | 5 | 1 | Every accepted teammate is a real, policy-bound worker |
| [03 Executable workflows](03-executable-workflows.md) | 1 | 1 | 3 | 5 | Workflow graphs edited, run, paused, resumed, inspected |
| [04 Live operations](04-live-operations.md) | **0** | 3 | 3 | 4 | Operator sees work, approvals, failures, replies as they happen |
| [05 Governance and permissions](05-governance-and-permissions.md) | 1 | 2 | 3 | 4 | Autonomy bounded by understandable, testable policy |
| [06 Reliable and measurable execution](06-reliable-and-measurable-execution.md) | 1 | 3 | 3 | 3 | Long-running work recoverable, observable, evaluated |
| [07 Template lifecycle](07-template-lifecycle.md) | 1 | 4 | 1 | 5 | Companies install and adopt versioned template improvements |
| [08 Company commerce](08-company-commerce.md) | **0** | 3 | 6 | 2 | Companies discover, hire, sell, settle work end to end |
| [09 Continuous company review](09-continuous-company-review.md) | **0** | **0** | 2 | 9 | Company proposes evidence-backed improvements without self-modifying |

## The shape of the gap

OpenCompany has shipped an excellent company **description** format and almost
none of the company **execution** that format implies.

The trail goes cold at the same place repeatedly:

- **Agents have no tools.** `src/harness/build.rs:85` is
  `let tools: Vec<Box<dyn Tool>> = Vec::new();`. Per-teammate tool narrowing,
  workspace isolation, spend limits, and workflow execution are all gating of nothing.
- **CI never compiles the owned runtime.** `.github/workflows/ci.yml:50` is bare
  `cargo test`; the Dockerfile defaults `FEATURES` empty. The two tests proving a
  manifest teammate is a real worker never execute in automation.
- **Grants are a roster-wide union** (`src/runtime/builder.rs:83-95`) and `ToolCall`
  carries no agent identity (`src/ports/types.rs:517-522`). Per-agent
  least-privilege is not unimplemented — it is unimplementable.
- **Budgets bind nothing.** `budget_usd_daily()` has zero callers repo-wide;
  `check()` never reads it (`src/harness/policy.rs:89-92,129-175`).
- **Cost metering is a stream of zeros**, blocked upstream on
  `tinyhumansai/openhuman#4940`. The only metering test,
  `zero_usage_turn_writes_nothing` (`src/harness/mod.rs:507-518`), asserts the
  ledger stays **empty**.

Full analysis: [../../research/03-internal-audit.md](../../research/03-internal-audit.md).

## Capability detail

† = status downgraded by adversarial verification.

### 01 — Guided Company Blueprints

`shipped 2` · `partial 0` · `seam only 1` · `not started 6` — [spec](01-guided-company-blueprints.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Validate every draft with the same rules as `opencompany check`. — an inval… | **shipped** | — | opencompany | issue |
| Conservative approvals and private discovery are the defaults | **shipped** | — | opencompany | issue |
| Start from a freeform description, a selected template, or a blend of both… | not started | No code path accepts a freeform business description and returns a draft manifest. Testable… | cross-repo | plan |
| Produce a Blueprint containing the manifest, charter, rationale, provenance… | not started | No durable artifact records why a company was configured the way it was. Testable target: a… | opencompany | plan |
| A provisioning API that separates draft generation from activation… The rev… | seam only | A headless caller today goes straight from manifest to a live registered company with no ac… | opencompany | plan |
| A first-run setup flow in the console, A review screen with team, responsib… | not started | An Operator cannot create a company from the console at all. Testable target: a first-run r… | frontend | plan |
| Fall back to static template onboarding when the preferred brain is unavail… | not started † | Templates are reachable only by filesystem path at CLI start. Testable target: an unauthent… | cross-repo | issue |
| Support iterative revision without applying partial configuration and Onboa… | not started | Testable target: a draft written before restart is re-loadable after restart with its conve… | opencompany | open-question |
| A post-launch 'reshape my company' entry point that emits Change Proposals… | not started | Testable target: a post-launch reshape request produces N Change Proposals queued in the ap… | cross-repo | plan |

### 02 — Active Runtime Teammates

`shipped 1` · `partial 4` · `seam only 5` · `not started 1` — [spec](02-active-runtime-teammates.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Promote an accepted roster overlay into a durable runtime teammate. / An ac… | seam only | POST /api/v1/company/team then addressing that teammate id through the harness fails: `Harn… | opencompany | plan |
| Adding a teammate does not mutate the version-controlled manifest / Rebuild… | **shipped** | — | opencompany | issue |
| Every storage backend passes the same teammate lifecycle contract (invarian… | partial | Add an overlay round-trip case to `src/store/conformance.rs` — save a record with two `Over… | opencompany | issue |
| Materialize an isolated workspace and memory namespace + Cross-company memo… | seam only † | Overlay teammates get no workspace directory and no memory namespace, because `build_roster… | opencompany | issue |
| Apply company policy plus narrower per-teammate restrictions and Attach onl… | partial | Two testable behaviors missing: (1) an agent whose manifest `tools` omits `send_email` shou… | opencompany | plan |
| Enforce daily and per-task spend limits beneath the company budget | seam only | A teammate with `budget_usd_daily = 5.0` that has already spent $5 today still gets `ToolPo… | opencompany | plan |
| Lifecycle: Suggested states are draft, activating, active, suspended, retir… | not started | Testable: DELETE a teammate that owns an open task — today the task keeps a dangling assign… | opencompany | plan |
| Address teammates directly from desks, tasks, schedules, and workflows | seam only | Testable: post an operator message to a desk whose members are [cfo] on a company whose fir… | opencompany | plan |
| Manifest teammates are constructed through the embedded OpenHuman harness… | partial | For the default (feature-less) build the outcome every accepted teammate is a real, policy-… | opencompany | open-question |
| The console Team view is the Operator's surface for accepting teammates (au… | seam only | Testable: add a teammate in the console, reload — it is gone. Wire `addMember`/`onRemove`/`… | frontend | issue |
| Preserve historical attribution after a teammate is removed | partial | Testable: record usage for overlay teammate Dana, DELETE Dana, query usage — the row render… | opencompany | issue |

### 03 — Executable Workflows

`shipped 1` · `partial 1` · `seam only 3` · `not started 5` — [spec](03-executable-workflows.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Workflow TOML is parsed into a validated node/edge graph (six node kinds: t… | **shipped** | — | opencompany | issue |
| Validate cycles, unreachable nodes, missing assignments, unavailable tools… | seam only † | A workflow whose `agent = nobody` names an id absent from the manifest roster parses succes… | opencompany | issue |
| Workflow graphs are readable by the console via GraphQL (`Company.workflows… | partial † | — | opencompany | issue |
| Edit workflow metadata, nodes, edges, assignments, inputs, and enablement… | not started | There is no way to persist a workflow edit: POST/PUT of a workflow graph returns 404. Add R… | opencompany | plan |
| Execute teammate, tool, HTTP, condition, approval, and output nodes — nodes… | seam only | Running a workflow is impossible: no function anywhere takes a WorkflowFile and produces an… | cross-repo | plan |
| Trigger runs manually, on a schedule, from inbound events, or from another… | seam only | A `trigger` node cannot express what starts it and nothing can start a workflow run. Extend… | opencompany | plan |
| Persist run state and node attempts so work resumes safely after restart; p… | not started | A workflow run cannot be paused, resumed, or cancelled because no run entity is persisted t… | opencompany | plan |
| Show a run timeline with inputs, outputs, cost, approvals, and errors; the… | not started † | Opening Workflows for any company shows the same fixed sample graph regardless of the compa… | frontend | issue |
| Retry transient failures with bounded policy and route exhausted work to a… | not started | Blocked on execution existing. Once an executor lands, a dry-run flag must route every side… | opencompany | open-question |
| Secrets are referenced by handle and never embedded in workflow TOML; workf… | not started | Node configuration is unrepresentable, so the secrets/budgets/approvals acceptance boundary… | opencompany | plan |

### 04 — Live Operations

`shipped 0` · `partial 3` · `seam only 3` · `not started 4` — [spec](04-live-operations.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Stream chat output incrementally with cancellation and reconnect support | not started | `POST .../chat` with `Accept: text/event-stream` returns a buffered JSON body instead of in… | opencompany | plan |
| Provide a sequenced company event feed using SSE as the baseline transport… | not started | No endpoint yields a company event stream. Testable: `GET /api/v1/companies/acme/events` re… | opencompany | plan |
| Likely implementation seam: `EventLog::subscribe` implementations in `src/s… | seam only | Live events are broadcast into a channel nobody listens on. Testable: an HTTP client connec… | opencompany | issue |
| Every durable event has a monotonic company-local sequence and Resume from… | partial | Sequences are assigned and readable, but nothing resumes from one. Testable: after appendin… | opencompany | issue |
| Normalize task, workflow, approval, inbox, teammate, commerce, lifecycle, u… | not started | A failed cycle produces no durable record the Operator can see — the stated outcome sees …… | opencompany | plan |
| Maintain unread state and per-category notification preferences | partial | No per-category notification preference is storable or readable. Testable: there is no port… | cross-repo | plan |
| Deliver optional browser, email, or webhook notifications for actionable ev… | seam only | Failure is not recorded and delivery is not idempotent. Testable: make the sink fail 3 time… | opencompany | issue |
| a console feed client with cursor persistence and reconnect backoff ; the O… | not started † | Approval latency is bounded below by the 5s poll and only two resources are polled, so a co… | frontend | plan |
| Aggregate platform-level events while preserving tenant authorization and A… | seam only | The per-request authorization primitives (`visible_companies`, `authorize_address`) are in… | opencompany | issue |
| Define retention, pagination, and backfill behavior and Slow clients cannot… | partial | A lagging subscriber loses events with no signal, and there is no retention policy. Testabl… | opencompany | issue |

### 05 — Governance and Permissions

`shipped 1` · `partial 2` · `seam only 3` · `not started 4` — [spec](05-governance-and-permissions.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Standing rules gate every emitted effect; policy is evaluated at the moment… | **shipped** | — | opencompany | issue |
| Record approvals, denials, amendments, policy changes, and grant use in one… | partial | A policy-denied effect leaves no durable record: after `emit_effect` returns `Denied` nothi… | opencompany | issue |
| Explain every decision in plain language: allowed, denied, or awaiting appr… | not started | An operator cannot see why an effect parked. Add a `reason` (rule id + layer, e.g. `policy… | cross-repo | plan |
| The Operator can ... change what the company may do — manifest policy plus… | not started | The Operator cannot change autonomy without editing company.toml and restarting. Needs an O… | cross-repo | plan |
| Preview how a proposed policy change would affect representative actions; s… | not started | No way to answer what would change if I set mode=full?. Testable target: a pure `simulate(p… | opencompany | plan |
| Deny wins when rules conflict — `never_do` hard prohibitions from the chart… | seam only | A charter prohibition (never contact my customers directly) is unenforceable — it parks for… | opencompany | issue |
| Compose company-wide policy with narrower teammate and workflow grants; per… | seam only | Two teammates on the same company get byte-identical policy decisions regardless of their d… | opencompany | plan |
| Support emergency pause and credential revocation; no feature bypasses budg… | partial | (1) Budget ceilings do not bound autonomy: a company at 200% of `[budget].monthly_usd` stil… | opencompany | issue |
| The runtime enforces the same decision consistently across chat, schedules… | seam only | A teammate tool call that needs approval is silently blocked instead of parked: it never re… | cross-repo | plan |
| Export a redacted governance report for review or incident response; provid… | not started | Stated as three separable behaviors: (a) a `GET …/governance/report` returning parked/resol… | opencompany | open-question |

### 06 — Reliable and Measurable Execution

`shipped 1` · `partial 3` · `seam only 3` · `not started 3` — [spec](06-reliable-and-measurable-execution.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Recovery never repeats an effect whose commit is already journaled — at-mos… | **shipped** | — | opencompany | issue |
| Durable approvals: parked work survives restart, and the Operator can retry… | partial | A cycle whose brain call or effect execution returns `Err` leaves no durable record: the er… | opencompany | plan |
| Give every inbound event, cycle, task, workflow run, tool call, approval, a… | seam only | Given an approval id or a ledger entry, there is no query that returns the cycle and the in… | opencompany | plan |
| Define bounded retries, backoff, deadlines, and nonretryable failures and R… | not started | A transient failure in `perform_effect` (e.g. a channel adapter returning Err) permanently… | opencompany | plan |
| Detect stalled work and surface it as an actionable feed item / The Operato… | not started | A cycle that hangs indefinitely (brain never returns) is indistinguishable from a healthy i… | cross-repo | plan |
| Expose execution timelines without revealing secrets or unnecessary private… | seam only | The Operator cannot view what a cycle did — there is no read path from `MemoryStore::recent… | cross-repo | plan |
| Measure latency, completion, failure, approval wait, token use, model cost… | partial | No latency, completion-rate, failure-rate, or approval-wait metric can be computed — no dur… | opencompany | plan |
| Let templates define outcome checks for recurring work and Run regression s… | not started | There is no way to assert that a prompt/policy change did not regress behavior. Define an o… | opencompany | plan |
| Capture Operator corrections and ratings as evaluation data / Evaluation da… | seam only † | Operator amendments are written but never readable as training/eval data — `RuntimeJournal:… | opencompany | issue |
| Provide health and readiness signals suitable for hosted wake-on-request… | partial | `/healthz` returns 200 even when company boot replay failed or the storage backend is unrea… | cross-repo | issue |

### 07 — Template Lifecycle

`shipped 1` · `partial 4` · `seam only 1` · `not started 5` — [spec](07-template-lifecycle.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Define a template package manifest with stable id, semantic version, schema… | not started | A `company.toml` cannot declare `[template] id/version`; therefore no code can compare an i… | opencompany | plan |
| Package the complete company directory without executable code or secrets a… | partial | There is no `opencompany package companies/<name>` producing a reviewable template artifact… | opencompany | issue |
| Browse a local or remote catalog with capability, industry, risk, required… | not started | An operator cannot list installable templates from the host. Testable change: `GET /api/v1/… | cross-repo | plan |
| Verify package integrity and optional publisher signatures before install | not started | An import of a hand-edited or corrupted bundle succeeds silently. Testable change: `import_… | opencompany | issue |
| Record the exact source version and provenance for every launched company… | seam only | After a restart there is no way to answer 'which template version is this company running?'… | opencompany | issue |
| Keep Operator changes in explicit overlay layers; local overlays are not si… | partial | Editing a company's policy or budget is either impossible without editing the version-contr… | opencompany | issue |
| Calculate upgrades as three-way diffs between the previous template, the ne… | not started | A template edit to `[policy]` or `[budget]` silently changes a running company's approval a… | cross-repo | plan |
| Support rollback to the previous effective configuration and provenance | not started | An operator who adopts a bad template change cannot revert. Testable change: retain the pre… | opencompany | issue |
| Export a portable company bundle with a clear choice of configuration-only… | partial | Every export leaks the ledger, event history, memory traces, and context blobs, so a compan… | opencompany | issue |
| Installing or upgrading never executes template content ; 'templates contai… | **shipped** | — | opencompany | open-question |
| Content-validation CI and lint rules: unique agent ids, every skill priced… | partial | A template with no `[policy]` table and no stated human role passes `opencompany check`. Te… | opencompany | issue |

### 08 — Company Commerce

`shipped 0` · `partial 3` · `seam only 6` · `not started 2` — [spec](08-company-commerce.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Publish a versioned service catalog with descriptions, inputs, outputs, ava… | seam only † | A catalog entry cannot declare `version`, `inputs`/`outputs` schema, or `availability`; add… | opencompany | issue |
| Public discovery is opt-in and reversible / Pause public intake without del… | partial | An Operator cannot turn discovery off from the console — only by editing the version-contro… | opencompany | issue |
| Inbound work passes authentication, pricing, policy, and capacity checks be… | partial † | — | opencompany | issue |
| Verify delivery before releasing payment where the payment rail supports it… | seam only | A counterparty gets priced work for a signature that moves no money. Make `a2a_task` call `… | opencompany | plan |
| Duplicate tasks or callbacks cannot cause duplicate settlement | not started | Reusing one x402 authorization across N distinct SIWX-signed requests yields N `x402.in` le… | opencompany | issue |
| Allow a company to hire external capability as a normal tool-like effect /… | seam only | A brain that emits an `a2a.engage` effect gets nothing — no code path reaches `economy.send… | opencompany | plan |
| The company cannot spend above its budget or signer grant / Authorize bound… | seam only † | `BudgetScope.remaining_usd` is supplied by whatever calls `pay` — and nothing does, so no l… | opencompany | plan |
| Represent an engagement with counterparties, scope, price, deadlines, deliv… | not started | There is no queryable object connecting a paid A2A task to its cycle, its approval, its del… | opencompany | plan |
| Track revenue, spend, margin, and counterparty history in Finances | seam only † | The `EffectGroup::Hire` approval branch's first-time-counterparty check is dead code: the f… | opencompany | issue |
| Degraded economy connectivity does not prevent private company operation /… | partial | Queued cards and tasks are silently lost on restart and are never retried even while the pr… | opencompany | issue |
| The Operator can inspect and export the complete commercial audit trail / c… | seam only | An Operator has no way to see the service catalog, the agent card, discoverability state, o… | cross-repo | plan |

### 09 — Continuous Company Review

`shipped 0` · `partial 0` · `seam only 2` · `not started 9` — [spec](09-continuous-company-review.md)

| Capability | Status | Gap | Owner | Size |
|---|---|---|---|---|
| Run a low-frequency review on a configurable schedule and explicit demand… | not started | No scheduled or on-demand code path produces a company review. Testable behavior change: a… | opencompany | plan |
| Read approval outcomes, denials, feedback, budget use, teammate activity, w… | seam only | No evidence-aggregation surface exists. Testable behavior change: an evidence reader that… | opencompany | plan |
| File typed proposals for roster, mandate, policy, charter, schedule, workfl… | not started | Nothing can file a proposal. Testable behavior change: a `ChangeProposal` type persisted th… | opencompany | plan |
| Validate proposals against hard runtime fences before showing them — normat… | not started | Two testable behavior changes, ordered: (a) `never_do` entries must actually compile to har… | opencompany | issue |
| Limit open proposals and suppress repeated denied or ignored suggestions… | not started | Testable behavior change: filing a proposal semantically equal to one denied within the sup… | opencompany | plan |
| Apply accepted changes through versioned overlay patches ; provenance layer… | seam only | The overlay cannot express any change other than adding a roster name — no policy, charter… | opencompany | plan |
| Revert an applied proposal without erasing its provenance ; Accepted change… | not started | Applying and reverting are both unrepresented. Testable behavior change: reverting an appli… | opencompany | plan |
| Concurrent configuration changes cause revalidation rather than blind apply… | not started | Concurrent writers silently clobber each other today, so revalidation rather than blind app… | opencompany | issue |
| Console surfacing: Approvals, Settings, and change-history console surfaces… | not started | An approved proposal would be invisible and un-actionable to the Operator. Testable behavio… | frontend | plan |
| Measure whether accepted changes improved the stated outcome and surface a… | not started | Attribution requires a decided model before it is codeable — which outcome metric attaches… | opencompany | open-question |
| Acceptance boundary: The review process has no effect-producing tools and I… | not started | The boundary is currently unenforced rather than enforced-and-passing. Testable behavior ch… | opencompany | issue |

## Cross-cutting invariant findings

Per `README.md`, work breaking one of the five invariants is a finding, not a plan.

| Invariant | Finding |
|---|---|
| No feature bypasses budgets or approvals | `budget_usd_daily()` has zero callers; a teammate capped at $5/day gets `Allow` on a $50 call (`src/harness/policy.rs:129-175`) |
| Operator remains accountable | Policy-denied effects leave no durable record — nothing appends to the journal after `Denied` (`src/runtime/cycle.rs:362`) |
| Operator remains accountable | Teammate removal is an unlogged `Vec::retain` (`src/server/ops/team.rs:117`) |
| Storage remains portable | `overlay_agents` has no round-trip case in the conformance suite (`src/store/conformance.rs:61`); MongoDB conformance silently no-ops without a URI (`src/store/mongodb.rs:1712`) |
| Manifest is root of trust | `never_do` hard-deny is a stub with a permanently empty list (`src/policy/gate.rs:211-212`) |

## Open questions

Per issue #21, gaps that cannot be stated as testable behavior changes belong
here rather than as speculative issues.

1. **Where does draft/Blueprint state live** — `CompanyStore` or a dedicated port?
   Unresolved at `01-guided-company-blueprints.md:69`. Either way it must go
   through a port and into the conformance suite, or invariant 4 breaks on arrival.
2. **Is `--features openhuman` the product, or is the default build the product?**
   Family 02's outcome is false by construction in the default build — teammates
   are echo brains (`src/runtime/builder.rs:690-712`). A positioning decision, not a bug.
3. **Multi-human or single-Operator?** `docs/spec/roadmap.md:128` states "Exactly
   one Operator per Company." ~3k lines of invite-only multi-user auth ship today
   (`src/server/users/`). One of these is wrong.
4. **Fleet-wide vs opt-in discovery.** `todo.txt` asks for tiny.place discovery
   "for all businesses created here"; family 08 says discovery is opt-in and
   reversible; the manifest default is `discoverable = false`.
5. **Is shared-single-DB tenancy an acceptable shipping mode?** Application-layer
   isolation only; a compromised container reaches every tenant's documents
   (`CLAUDE.md`, `src/store/mongodb.rs:14`).

## Orphan capabilities

A drift sweep found **13 substantial capabilities (~12k lines)** that no feature
family owns — feedback/scrub/triage, multi-user auth, DNS verification, inbound
and outbound email, OAuth connections, bundle export/import, and platform
multi-tenancy. Two carry contradictions (open questions 3 and 5 above).

Detail: [../../research/03-internal-audit.md](../../research/03-internal-audit.md#orphan-capabilities).

## Provenance

Generated 2026-07-20 from a 69-agent audit (868 tool calls, all against source).
Raw per-agent results are in the workflow journal; this table is the reconciled
output after verification. Regenerate by re-running the audit workflow and
re-reconciling — do not hand-edit rows without re-checking the cited source.
