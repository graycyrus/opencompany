# Architecture Facts

Non-obvious properties of the current codebase, each verified by opening the
source. They are recorded here because designs keep being built on the opposite
assumption — a first design pass produced twelve proposals, and **every one of
the five that got adversarially reviewed was found unsound**, mostly on these
two facts.

Read this before designing anything that touches tools, grants, or stored
configuration.

## Fact 1 — There are two tool paths, and they do not meet

### Path A: the cycle/brain path

`ToolCall` is `{ tool, args }` — **no agent identity**:

```rust
// src/ports/types.rs:517-522
pub struct ToolCall {
    pub tool: String,
    pub args: serde_json::Value,
}
```

Dispatched through `ToolProvider` (`src/runtime/tools.rs`). Note what is actually
in the catalog today: `StubToolProvider::catalog` returns `Ok(Vec::new())`
unconditionally (`src/runtime/tools.rs:53-56`), and `BuiltinToolProvider` adds
only the `feedback` spec (`src/feedback/tool.rs:21-30`).

### Path B: the harness path — where agents will actually get tools

```rust
// src/harness/build.rs:88
let tools: Vec<Box<dyn Tool>> = Vec::new();
```

handed to openhuman's `AgentBuilder` at `src/harness/build.rs:112`.

`AgentBuilder` accepts `tools`, `visible_tool_names`, and `tool_policy`
**per builder instance**
(`vendor/openhuman/src/openhuman/agent/harness/session/types.rs:327`). The `Tool`
trait is at `vendor/openhuman/src/openhuman/tools/traits.rs:257-269`, and
sandboxed implementations already exist over an `Arc<SecurityPolicy>` in
`vendor/openhuman/src/openhuman/tools/impl/filesystem/`.

`src/harness/` references `ToolCall`/`ToolProvider` **only inside test modules**
(`brain.rs:118,129`).

### Why this matters

Per-agent least privilege belongs in **path B**, threaded into `build_agent` and
enforced by per-instance tool vectors. `AgentBuilder` taking a tool vector per
instance is exactly the seam that makes it possible.

A design that instead threads agent identity through `ToolCall` fixes the path
where agents do not get tools. A rejected design did this; review traced it and
found:

- There is exactly one `CycleHostImpl` construction site (`src/runtime/cycle.rs:94`).
- Both brain transports build `ToolCall` from a frame with no agent field
  (`src/brain/hosted.rs:147`, `src/brain/sidecar/mod.rs:150`).
- So every invocation would be `agent: None` and take the fail-closed
  intersection — **regressing a shipped fixture**. `companies/signals_opportunity_studio/company.toml`
  grants `allow = ["web.*", "docs.*"]` with two agents holding `docs.*`; a naive
  roster-wide intersection drops it.

Gotcha when wiring the sandboxed tools: `ListFilesTool`'s registered name is
`"list"`, not `list_files`
(`vendor/openhuman/src/openhuman/tools/impl/filesystem/list_files.rs:29`).

## Fact 2 — Every runtime rebuild overwrites the stored manifest

```rust
// src/runtime/builder.rs:733
manifest: self.manifest.clone(),
```

`src/runtime/builder.rs:717-739` re-saves `CompanyRecord` from the **build-time**
manifest, preserving only `lifecycle`, `ledger`, and `overlay_agents` from the
loaded record. The in-source comment says so explicitly — this is *why*
`overlay_agents` exists as a sibling field rather than living in the manifest.

Additionally, the live objects are constructed **once** from that build-time
manifest:

| Object | Constructed at |
|---|---|
| `ManifestApprovalGate` | `src/runtime/builder.rs:751` |
| tool grants | `src/runtime/builder.rs:520` |
| channels | `src/runtime/builder.rs:622` |
| discoverability | `src/runtime/builder.rs:761` |

### Why this matters

Any design storing configuration changes **in** `CompanyRecord.manifest` is
silently erased at the next rebuild — while its audit records survive. That is an
invariant-2 violation strictly worse than losing both, because the trail then
claims a change that is not in effect.

And an "applied" configuration change is **inert until a restart**, since the gate
and grants were built once.

Config-change designs must use a sibling field or a dedicated port — exactly as
`overlay_agents` does — **and** state how the live runtime picks the change up.
`docs/spec/agentic/proposals.md:70-72` already specifies applied proposals as a
provenance *layer*, not a manifest rewrite.

Related type mismatch to watch: `Agent` (`src/company/types.rs:104-122`) has
`id, role, description, tier, tools, budget_usd_daily` and **no** `name`;
`OverlayAgent` (`src/ports/types.rs:669-680`) has `name` and none of
tier/tools/budget. A config-op vocabulary cannot round-trip between them without
resolving this.

## Fact 3 — The harness is feature-gated out of CI

```rust
// src/lib.rs:16
#[cfg(feature = "openhuman")] pub mod harness;
```

`Cargo.toml` has `default = []`. `.github/workflows/ci.yml:50` is bare
`cargo test`. `Dockerfile:19-21` defaults `FEATURES` empty.

**Nothing in `src/harness/` runs in CI today** — including any fix proposed there.
A design whose core change lives in the harness must ship CI coverage as part of
itself, and must not claim existing coverage.

## Fact 5 — Tool approval never reaches OpenCompany

**The most consequential finding of the design pass, and it inverts a dependency.**

`ToolPolicyDecision::RequireApproval` does not park anything. At
`vendor/openhuman/src/openhuman/tinyagents/middleware.rs:1423-1462` it is converted
into a `PolicyDenial::ApprovalRequired` string handed back to **the model** as a
tool-result error, and recorded only in openhuman's **in-process**
`tool_registry::denials`.

It never reaches `ApprovalGate::park`. It is never journaled. No operator ever
sees it. It does not hang — it silently disappears.

### Why this reorders the roadmap

Every shipped fixture runs `mode = "supervised"`. So naively attaching a write
tool to a harness agent ships a capability that is **permanently and silently
denied on every real company** — while simultaneously converting the known
unlogged-denial gap (`src/runtime/cycle.rs:362`) from a zero-occurrence defect
into the routine outcome of the flagship feature.

Two independent designs treated `require_approval` as a policy *win* that tools
would unblock. The dependency runs the other way: **the denial sink must exist
before tools do.**

This is why read-only tools (`file_read`, `list`) are separable and safe to ship
first, while mutation needs an approval bridge built ahead of it.

### The generalizable form

The differentiation thesis is *enforcement on an owned runtime*. OpenCompany owns
the policy vocabulary but not yet the enforcement bridge. Every capability that
crosses into openhuman needs its **return path** audited before it is called
shipped — the same way `budget_usd_daily()` has an accessor and zero callers,
`RequireApproval` has a decision and no destination.

### Related sandbox trap

`SecurityPolicy::from_config`
(`vendor/openhuman/src/openhuman/security/policy/enforcement.rs:74-140`)
re-injects `~/OpenHuman/projects` and `/tmp/openhuman` as ReadWrite **after**
reading the config, and `path_checks.rs:70` lets trusted roots defeat
`workspace_only`. A per-agent policy must call `trusted_roots.clear()` *after*
construction, or every company agent gets read-write access to the operator's
home directory.

Test the escape at the right layer: `../escape.txt` is caught by a string check at
`path_checks.rs:241` **before** any sandbox logic runs, so it passes even with
trusted roots left in. Use an absolute path (`/etc/passwd`) or an out-pointing
symlink instead.

## Fact 4 — GraphQL already has a single-company alias

```rust
// src/server/graphql/mod.rs:83-99
async fn company(&self, ctx, id: Option<ID>)   // None => registry().sole()
```

A rejected design invented a `resolveCompanyId()` helper around a blocker that
does not exist, and prescribed `query($id: ID!)` — which **fails validation** in
single-company mode, because the console has no non-null id to bind
(`frontend/src/api/client.ts:30,35,85`). The document must use `$id: ID`.

Also: GraphQL auth failures return **HTTP 200** with an errors array
(`src/server/graphql/mod.rs:125-131`), while `client.ts` fires `onUnauthorized`
only on `status === 401`. The 401 hook is *not* inherited by routing GraphQL
through `client.post`.

## Smaller traps, verified

- `TurnUsage` is `Copy` (`src/harness/cost.rs:36-37`). Adding a `String` field
  breaks the derive and every by-value use.
- `model_for_tier` emits **four** tiers, not three — `reasoning-v1`, `agentic-v1`,
  `vision-v1`, `chat-v1` (`src/harness/build.rs:36-44`) — and
  `OPENCOMPANY_INFERENCE_MODEL` (`src/harness/provider.rs:52-54`) is an arbitrary
  operator string, so any built-in price table is unclosable by construction.
- `open_storage` returns `Ok(None)` for `StorageKind::Fs`
  (`src/store/select.rs:144-153`) — and fs is the default backend. A CLI that
  assumes it gets handles back will find none on the default path.
- `CompanyRuntime` has no `pub usage` field; `usage` arrives bundled in
  `OpsStores` (`src/company/runtime.rs:39-56`, populated at
  `src/runtime/builder.rs:539-547`).
- `CompanyEvent` is a `tag = "kind"` enum with **no** `#[serde(other)]`
  (`src/ports/types.rs:213-215`). A new variant is unreadable by an older binary —
  a forward-compatibility hazard for any design adding event kinds.
- Both `add_member` (`src/server/ops/team.rs:74-97`) and removal
  (`team.rs:117`, an unlogged `Vec::retain`) write no `EventLog` record.
- `InboxView` derives its entire inbox list from `lib/inbox.ts`
  (`frontend/src/views/InboxView.tsx:16,18,30-32`), so gutting that module while
  migrating `TeamView` regresses a second surface.
- **There is no `GET .../team` route at all.** `client.listTeam` GETs
  `${scope}/team` (`frontend/src/api/client.ts:182-184`) while the router
  registers only post/delete/put (`src/server/ops/team.rs:29-31`). The 404 is not
  an edge case — it is every page load, so `starterTeam()`'s fabricated roster is
  what operators *always* see.
- **`CycleRequest.roster` has zero consumers.** Populated at
  `src/runtime/cycle.rs:70-78` (`src/ports/types.rs:492-493`) and read by nothing —
  `src/brain/echo.rs:117` and the hosted/sidecar tests ignore it. Any design that
  "enforces" something by filtering that field is a no-op, and a test asserting on
  it passes while proving nothing.
- **`desks()` builds desks only from `manifest.group_chats`**
  (`src/server/graphql/company.rs:225-241`). There is no synthetic "General" desk,
  so today `OperatorMessage`s match zero desks (`company.rs:315-318`).
- **One bad line fails an entire log read.** `src/store/fs.rs:95` is
  `serde_json::from_str(line)?` inside `read_jsonl`, and `FsOps::record` calls
  `read_jsonl` on *every* write for retention compaction
  (`src/store/fs_ops.rs:472`). Combined with the missing `#[serde(other)]` above,
  a new enum variant written by a newer binary bricks chat history, `/a2a`, and
  export after a rollback.
- `ListFilesTool`'s registered name is `"list"`, not `list_files`
  (`vendor/openhuman/src/openhuman/tools/impl/filesystem/list_files.rs:29`);
  `file_read.rs:25` and `file_write.rs:24` match their type names.
- `classify_group` (`src/harness/policy.rs:201-217`) maps any tool name containing
  `"file"` to `EffectGroup::Sign` — so a file write would be presented to the
  operator as a *signing* effect.

## Provenance

Facts 1–4 were verified directly against source on 2026-07-20. The smaller traps
come from an adversarial design review that opened each cited file; they are
recorded here rather than re-derived because each one invalidated a plausible
design.
