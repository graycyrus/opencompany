//! Issue #1963: the serde migration table for [`WorkflowRun`].
//!
//! `WorkflowRun` has nine fields and sixteen `#[serde(default)]` attributes
//! between it and the row types it carries. Every one of them is a promise that
//! a payload written before that field existed still loads — and the promise is
//! kept by an attribute nobody has to write, so breaking it is silent. The spec
//! puts it plainly: a missing `#[serde(default)]` here is *silent history loss,
//! not a compile error*.
//!
//! That matters because [`CompanyEvent::WorkflowRunFinished`] is **replayed at
//! boot**. A field added without its default does not fail the build, does not
//! fail a test that round-trips a freshly-constructed value, and does not fail
//! the first run after the deploy. It fails on the next boot, by dropping every
//! historical run event that predates it — quietly, as a shorter list.
//!
//! Before this file there was exactly one such test
//! (`blocked_node_test::a_pre_881_run_payload_still_deserializes`), covering two
//! of the nine fields. The shapes below were recovered from git history rather
//! than invented: `git log -S"pub <field>" -- src/ports/workflow_runner.rs`
//! names the commit that added each one, and the struct at that commit's parent
//! is the shape a payload written the day before carried. They came in strictly
//! additive declaration order, so each era is a prefix of the next.
//!
//! One issue in this file's remit has no era of its own. **#1008** changed what
//! the blocked arm *puts* in `output` — `Value::Null` before it, the upstream
//! capture after — without changing the field's shape, so it appears below as a
//! payload case rather than a field arrival. And **#1862** added `started_by`
//! to `WorkflowRunStarted`, a sibling event and not a `WorkflowRun` field; it is
//! already pinned by `ports::types`'
//! `a_pre_1862_run_started_line_still_replays_with_no_sender`, and duplicating
//! it here would be a second copy that drifts.

use serde_json::{Value, json};

use crate::ports::WorkflowRun;

/// One historical on-disk shape, named for the change it predates.
struct Era {
    /// What a reader of a failure needs first: which payload broke.
    label: &'static str,
    /// The commit that ended this era by adding the next field, so the next
    /// person can read the diff rather than trust this file.
    ended_by: &'static str,
    /// The payload as a `WorkflowRunFinished` of that era carried it.
    payload: Value,
}

/// Every shape a `WorkflowRun` has ever been journaled in, oldest first.
///
/// Each is a strict prefix of the one after it — that is not a simplification,
/// it is what the history shows: no field was ever removed, renamed or
/// reordered, and every addition landed at the end of the struct.
fn eras() -> Vec<Era> {
    let base = json!({
        "output": { "nodes": { "draft": { "items": [] } } },
        "pending_approvals": ["gate"]
    });
    let mut shapes = Vec::new();
    let mut current = base.clone();

    shapes.push(Era {
        label: "pre-#170 (before output-node delivery)",
        ended_by: "0728d9a2e added deliveries",
        payload: current.clone(),
    });

    extend(&mut current, "deliveries", json!([]));
    shapes.push(Era {
        label: "pre-#383 (before a run could be stopped)",
        ended_by: "3a4d1380d added cancelled",
        payload: current.clone(),
    });

    extend(&mut current, "cancelled", json!(false));
    shapes.push(Era {
        label: "pre-#542 (before per-node rows)",
        ended_by: "406626cbb added nodes",
        payload: current.clone(),
    });

    extend(&mut current, "nodes", json!([]));
    shapes.push(Era {
        label: "pre-#638 (before operator notices)",
        ended_by: "4d723c755 added notices",
        payload: current.clone(),
    });

    extend(&mut current, "notices", json!([]));
    shapes.push(Era {
        label: "pre-#661 (before board rows)",
        ended_by: "1c06157ca added board",
        payload: current.clone(),
    });

    extend(&mut current, "board", json!([]));
    shapes.push(Era {
        label: "pre-#881/#880 (before blocked nodes and approval receipts)",
        ended_by: "fa846eded added blocked_nodes and approvals",
        payload: current.clone(),
    });

    extend(&mut current, "blocked_nodes", json!([]));
    extend(&mut current, "approvals", json!([]));
    shapes.push(Era {
        label: "current",
        ended_by: "(head)",
        payload: current,
    });

    shapes
}

/// Appends one field to a payload, keeping the eras honest about being
/// prefixes of each other.
fn extend(payload: &mut Value, field: &str, value: Value) {
    payload
        .as_object_mut()
        .expect("an era payload is always an object")
        .insert(field.to_string(), value);
}

/// Issue #1963: every shape a `WorkflowRun` was ever journaled in still
/// deserializes.
///
/// The table is the point. A single hand-written legacy payload — which is what
/// existed before this file — pins whichever era its author happened to
/// remember, and says nothing about the five between it and today. Adding a
/// field without `#[serde(default)]` breaks exactly the eras older than it,
/// which is every row above the one the author was thinking about.
///
/// A unit test on a constructed `WorkflowRun` cannot catch this: it serializes
/// and deserializes the *current* shape, which always round-trips no matter
/// what the defaults say.
#[test]
fn every_historical_run_payload_still_deserializes() {
    for era in eras() {
        let run: WorkflowRun = serde_json::from_value(era.payload.clone()).unwrap_or_else(|err| {
            panic!(
                "a {} payload no longer loads: {err}. A field added without \
                 #[serde(default)] breaks every era older than it; this era ran until {}. \
                 WorkflowRunFinished is replayed at boot, so the symptom is a company's run \
                 history getting shorter, not a red build.",
                era.label, era.ended_by
            )
        });
        assert_eq!(
            run.pending_approvals,
            vec!["gate".to_string()],
            "{}: what the payload did carry must survive the migration",
            era.label
        );
        assert_eq!(
            run.output["nodes"]["draft"]["items"],
            json!([]),
            "{}: and so must the engine output envelope",
            era.label
        );
    }
}

/// Issue #1963: every field a historical payload omits reads back at its
/// documented default, rather than at whatever a later field's absence happens
/// to produce.
///
/// "It deserializes" is only half the promise. A replayed pre-#383 run that
/// loaded with `cancelled: true` would put every run in a company's history
/// into the stopped-by-an-operator bucket, which is a worse outcome than the
/// parse failing. So the oldest shape is checked field by field.
#[test]
fn a_pre_170_payload_defaults_every_field_that_did_not_exist_yet() {
    let run: WorkflowRun = serde_json::from_value(json!({
        "output": Value::Null,
        "pending_approvals": []
    }))
    .expect("the oldest shape a WorkflowRun was ever written in must still load");

    assert!(run.deliveries.is_empty(), "#170: routed nothing");
    assert!(
        !run.cancelled,
        "#383: a run written before the stop button existed was never stopped — \
         defaulting this true would file every historical run as operator-stopped"
    );
    assert!(run.nodes.is_empty(), "#542: no per-node rows were recorded");
    assert!(
        run.notices.is_empty(),
        "#638: nothing was said to the operator"
    );
    assert!(run.board.is_empty(), "#661: no card was opened");
    assert!(
        run.blocked_nodes.is_empty(),
        "#881: nobody was waiting on a human"
    );
    assert!(run.approvals.is_empty(), "#880: nothing was parked");
}

/// Issue #1963 (#1008): the blocked arm used to journal `"output": null`, on
/// the argument that an engine `Err` has no final state. It now threads the
/// upstream capture through instead. The old payloads are still on disk and
/// still replay, and a null output must stay null rather than being coerced
/// into an empty envelope that would read as "this node produced nothing".
#[test]
fn a_pre_1008_blocked_payload_keeps_its_null_output_rather_than_gaining_an_envelope() {
    let run: WorkflowRun = serde_json::from_value(json!({
        "output": Value::Null,
        "pending_approvals": ["spec"],
        "deliveries": [],
        "cancelled": false,
        "nodes": [{ "node_id": "spec", "status": "blocked", "elapsed_ms": 12 }],
        "notices": [],
        "board": [],
        "blocked_nodes": [{ "nodeId": "spec", "tools": ["publish_artifact"] }]
    }))
    .expect("a pre-#1008 blocked run must still replay");

    assert_eq!(
        run.output,
        Value::Null,
        "a run that recorded no output must not be read as one that recorded an empty one"
    );
    assert_eq!(run.blocked_nodes.len(), 1);
}

/// Issue #1963: the row types nested inside a run carry their own defaults, and
/// they are the easier half to forget — the outer struct is what a reviewer
/// looks at when a field is added.
///
/// Three of them at once, because a payload only exercises a nested default if
/// the outer field is populated: a pre-#1014 node row (no `diagnostics`), a
/// pre-#1143 blocked node (no `stranded`, and no `approval_ids`/`unparkable`
/// either), and a delivery row written before `reason` was a closed set.
#[test]
fn the_row_types_nested_in_a_run_default_their_own_later_fields() {
    let run: WorkflowRun = serde_json::from_value(json!({
        "output": Value::Null,
        "pending_approvals": [],
        "deliveries": [{
            "node": "report",
            "kind": "email",
            "status": "sent",
            "detail": "sent to the owner"
        }],
        "cancelled": false,
        "nodes": [{ "node_id": "draft", "status": "ok", "elapsed_ms": 41 }],
        "notices": [],
        "board": [{ "action": "spawned", "taskId": "task-3" }],
        "blocked_nodes": [{ "nodeId": "spec", "tools": ["publish_artifact"] }],
        "approvals": [{ "outcome": "parked" }]
    }))
    .expect("a run whose nested rows predate their own later fields must still load");

    assert!(
        run.nodes[0].diagnostics.is_empty(),
        "#1014: a row written before diagnostics existed has no broken wiring to report"
    );
    assert_eq!(
        run.deliveries[0].reason,
        crate::ports::DeliveryReason::Unspecified,
        "a delivery row written before the closed set existed reads as Unspecified, \
         not as one of the real reasons"
    );
    assert_eq!(
        run.blocked_nodes[0].stranded, 0,
        "#1143: stranded is computed on the read and never journaled, so a stored \
         row always reads zero"
    );
    assert_eq!(
        run.blocked_nodes[0].unparkable, 0,
        "and an absent count is zero, never a guess from the survivors"
    );
    assert!(run.blocked_nodes[0].approval_ids.is_empty());
    assert!(
        run.board[0].title.is_none(),
        "a board row's optional fields stay absent rather than becoming empty strings"
    );
    assert!(run.approvals[0].node_id.is_none());
    assert!(run.approvals[0].tool.is_none());
}

/// A fully-populated run, with every field carrying something a default would
/// not produce — so a round-trip that silently dropped one is visible.
fn a_run_with_nothing_left_at_its_default() -> WorkflowRun {
    WorkflowRun {
        output: json!({ "run": { "id": "run-1" }, "nodes": { "draft": { "items": [1] } } }),
        pending_approvals: vec!["gate".to_string(), "spec".to_string()],
        deliveries: vec![crate::ports::DeliveryReport {
            node: "report".to_string(),
            kind: "email".to_string(),
            target: Some("owner@example.test".to_string()),
            status: crate::ports::DeliveryStatus::Sent,
            detail: "sent to the owner".to_string(),
            reason: crate::ports::DeliveryReason::OwnerEmailed,
        }],
        cancelled: true,
        nodes: vec![crate::ports::WorkflowRunNodeRow {
            node_id: "draft".to_string(),
            status: crate::ports::types::WorkflowNodeStatus::Blocked,
            elapsed_ms: 41,
            diagnostics: vec!["node.draft.config.body".to_string()],
        }],
        notices: vec!["A notice.".to_string()],
        board: vec![crate::ports::WorkflowRunBoardRow {
            action: crate::ports::WorkflowBoardAction::Spawned,
            task_id: Some("task-3".to_string()),
            title: Some("Draft the spec".to_string()),
            assignee: Some("editor".to_string()),
        }],
        blocked_nodes: vec![crate::ports::WorkflowBlockedNode {
            node_id: "spec".to_string(),
            tools: vec!["publish_artifact".to_string()],
            approval_ids: vec!["appr-1".to_string()],
            unparkable: 2,
            stranded: 0,
        }],
        approvals: vec![crate::ports::WorkflowRunApprovalRow {
            node_id: Some("spec".to_string()),
            tool: Some("publish_artifact".to_string()),
            outcome: crate::ports::WorkflowApprovalOutcome::Parked,
            approval_id: Some("appr-1".to_string()),
        }],
    }
}

/// Issue #1963: a full round-trip loses nothing.
///
/// The counterpart to the table above, and the half that catches the opposite
/// mistake: a `skip_serializing_if` predicate that is wrong for a populated
/// value drops a real field on the way out, and the payload then loads
/// perfectly at its default — so the migration tests above all still pass while
/// the data is gone.
///
/// Compared as JSON because `WorkflowRun` has no `PartialEq`, which is also why
/// this had no test.
#[test]
fn a_fully_populated_run_survives_a_round_trip_unchanged() {
    let wire = serde_json::to_value(a_run_with_nothing_left_at_its_default())
        .expect("a run always serializes");
    let back: WorkflowRun =
        serde_json::from_value(wire.clone()).expect("and always deserializes again");
    let again = serde_json::to_value(&back).expect("as does the value that came back");

    assert_eq!(
        wire, again,
        "a field that survives serialization but not the read back is history \
         loss the migration table cannot see: it would load at its default and \
         look fine"
    );
}

/// Issue #1963: a default-valued run serializes to the pre-#880 wire form
/// exactly, so a reader written before `approvals` existed still parses what a
/// current writer emits.
///
/// This is the `skip_serializing_if` half of the contract, and the direction
/// the migration table cannot check: the table proves old payloads load in a
/// new reader, and this proves new payloads load in an old one. Both matter
/// during a rollout, when the two are running side by side against one
/// `events.jsonl`.
#[test]
fn a_default_valued_run_still_serializes_as_the_pre_880_wire_form() {
    let run = WorkflowRun {
        output: Value::Null,
        pending_approvals: Vec::new(),
        deliveries: Vec::new(),
        cancelled: false,
        nodes: Vec::new(),
        notices: Vec::new(),
        board: Vec::new(),
        blocked_nodes: Vec::new(),
        approvals: Vec::new(),
    };

    let wire = serde_json::to_value(&run).expect("a run always serializes");
    let keys: Vec<&str> = wire
        .as_object()
        .expect("a run serializes as an object")
        .keys()
        .map(String::as_str)
        .collect();

    assert_eq!(
        keys,
        vec![
            "output",
            "pending_approvals",
            "deliveries",
            "cancelled",
            "nodes",
            "notices",
            "board",
            "blocked_nodes"
        ],
        "a run that parked nothing must emit no `approvals` key at all — the \
         skip_serializing_if #880 added so already-persisted lines stayed \
         byte-for-byte what they were"
    );
}

/// Issue #1963: a run that *did* park writes the key, so the skip above is a
/// property of the value rather than of the field.
///
/// Without this the assertion above would pass against a build that never
/// serialized `approvals` at all, which is silent loss of the receipts #880
/// exists to keep.
#[test]
fn a_run_that_parked_an_approval_does_emit_the_receipts() {
    let wire = serde_json::to_value(a_run_with_nothing_left_at_its_default())
        .expect("a run always serializes");

    assert_eq!(
        wire["approvals"][0]["approvalId"],
        json!("appr-1"),
        "the receipt is the whole of #880 — it must be on the wire when there is one"
    );
    assert_eq!(
        wire["blocked_nodes"][0]["unparkable"],
        json!(2),
        "and a non-zero unparkable count is the loud case, never skipped"
    );
}
