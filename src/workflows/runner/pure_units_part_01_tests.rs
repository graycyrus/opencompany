// ── issue #1963: direct units for the settle-path reclassification ──────────
//
// Included into `runner::tests` by `include!`, so `node_row` and everything
// `use super::*` already pulled in is in scope here. Split out because
// `runner.rs` is the largest file in the crate and a suite appended to its
// test module disappears into it.
//
// Every function below was reachable only through a whole driven run before
// this file existed: the settle path is where the host's readings — blocked,
// capped, errored, cancelled — are applied to the engine's own account of what
// happened, and a driven run can only ever exercise one arm at a time.

/// Issue #1963: `reclassify_blocked` runs once per settle arm today, but three
/// call sites reach it (`blocked_run`, and the two arms of `run_workflow_inner`)
/// and nothing structurally stops a fourth from folding two of them together.
///
/// A driven run could not have caught a non-idempotent relabel: each arm calls
/// it exactly once, so the second application never happens in a test that
/// starts from a graph. Pinned directly instead.
#[test]
fn reclassify_blocked_changes_nothing_when_it_runs_a_second_time() {
    let blocked = vec![crate::ports::WorkflowBlockedNode {
        node_id: "spec".to_string(),
        tools: vec!["publish_artifact".to_string()],
        approval_ids: vec!["appr-1".to_string()],
        unparkable: 0,
        stranded: 0,
    }];
    let mut nodes = vec![
        node_row("fetch", WorkflowNodeStatus::Ok),
        node_row("spec", WorkflowNodeStatus::Error),
    ];
    let mut pending = Vec::new();

    reclassify_blocked(&mut nodes, &mut pending, &blocked);
    let nodes_after_one = nodes.clone();
    let pending_after_one = pending.clone();

    reclassify_blocked(&mut nodes, &mut pending, &blocked);

    assert_eq!(
        nodes, nodes_after_one,
        "a second pass must not move a row that is already Blocked"
    );
    assert_eq!(
        pending, pending_after_one,
        "a second pass must not list the same node twice — the console renders \
         every entry as a node name, so a duplicate reads as two waits"
    );
}

/// Issue #1963 (issue #881's union contract): the engine's own gate list and
/// the host's blocked list are unioned into one `pending_approvals`, and a run
/// can populate both. The engine pauses a `requires_approval` `tool_call` node
/// and the host blocks an agent node — but nothing forbids the same id
/// reaching both lists, and a duplicate would render as two separate waits on
/// one node.
///
/// Unreachable from a driven run: producing an id on both lists at once needs a
/// graph where one node is simultaneously an engine gate and a host-blocked
/// agent turn, which the node kinds do not allow.
#[test]
fn a_node_already_on_pending_approvals_is_not_listed_a_second_time() {
    let blocked = vec![crate::ports::WorkflowBlockedNode {
        node_id: "gate".to_string(),
        tools: vec!["send_email".to_string()],
        approval_ids: Vec::new(),
        unparkable: 1,
        stranded: 0,
    }];
    let mut nodes = vec![node_row("gate", WorkflowNodeStatus::Error)];
    let mut pending = vec!["gate".to_string()];

    reclassify_blocked(&mut nodes, &mut pending, &blocked);

    assert_eq!(
        pending,
        vec!["gate".to_string()],
        "the blocked ids are unioned into pending_approvals, not appended to it"
    );
}

/// Issue #1963: a blocked node that never produced a row at all still has to
/// reach `pending_approvals`.
///
/// `nodes` is fed by the progress observer, which records a node when its
/// execution *finishes*. A node whose turn was refused before it could report —
/// and a hard-abort drain that lost the frame — leaves no row, and the loop
/// that relabels rows would then silently drop the node from the operator's
/// list. The two halves of `reclassify_blocked` are separate loops precisely
/// so this cannot happen, and that separation is what this pins.
///
/// A driven run cannot reach it: every path that produces a
/// `WorkflowBlockedNode` also produces the node's row, so the case only exists
/// as a shape the function must survive.
#[test]
fn a_blocked_node_absent_from_nodes_still_reaches_pending_approvals() {
    let blocked = vec![crate::ports::WorkflowBlockedNode {
        node_id: "never_reported".to_string(),
        tools: vec!["publish_artifact".to_string()],
        approval_ids: vec!["appr-9".to_string()],
        unparkable: 0,
        stranded: 0,
    }];
    let mut nodes = vec![node_row("fetch", WorkflowNodeStatus::Ok)];
    let mut pending = Vec::new();

    reclassify_blocked(&mut nodes, &mut pending, &blocked);

    assert_eq!(
        pending,
        vec!["never_reported".to_string()],
        "a blocked node with no row must still be something the run says it is \
         waiting on — otherwise the approval card has no run that admits to it"
    );
    assert_eq!(
        nodes[0].status,
        WorkflowNodeStatus::Ok,
        "and the rows that do exist are left alone"
    );
}

/// Issue #1963: the relabel is one-directional. An `Error` row for a blocked
/// node becomes `Blocked`; nothing here ever writes `Error`.
///
/// That direction is the whole of issue #881 — the engine's `Error` is honest
/// (the capability did return an error) but it is not a failure, and journaling
/// it as one puts every blocked run in the failure count. Reversing it would
/// restore exactly the bug #881 removed, and no driven run would notice,
/// because a blocked run's assertions are about `blocked_nodes` and
/// `pending_approvals` rather than about the row's own status.
#[test]
fn an_error_row_for_a_blocked_node_becomes_blocked_and_never_the_reverse() {
    let blocked = vec![
        crate::ports::WorkflowBlockedNode {
            node_id: "errored".to_string(),
            tools: vec!["publish_artifact".to_string()],
            approval_ids: Vec::new(),
            unparkable: 0,
            stranded: 0,
        },
        crate::ports::WorkflowBlockedNode {
            node_id: "finished_ok".to_string(),
            tools: vec!["send_email".to_string()],
            approval_ids: Vec::new(),
            unparkable: 0,
            stranded: 0,
        },
    ];
    let mut nodes = vec![
        node_row("errored", WorkflowNodeStatus::Error),
        node_row("finished_ok", WorkflowNodeStatus::Ok),
        node_row("bystander", WorkflowNodeStatus::Error),
    ];
    let mut pending = Vec::new();

    reclassify_blocked(&mut nodes, &mut pending, &blocked);

    assert_eq!(
        nodes[0].status,
        WorkflowNodeStatus::Blocked,
        "the engine's Error for a parked node is the report #881 relabels"
    );
    assert_eq!(
        nodes[1].status,
        WorkflowNodeStatus::Blocked,
        "a blocked node's row is Blocked whatever the engine said about it"
    );
    assert_eq!(
        nodes[2].status,
        WorkflowNodeStatus::Error,
        "a node nobody blocked keeps its genuine failure — hiding a real error \
         behind \"waiting on approval\" is the lie #881 exists to remove"
    );
    assert!(
        !nodes
            .iter()
            .any(|row| row.node_id == "bystander" && row.status == WorkflowNodeStatus::Blocked),
        "and nothing here may invent a block for an unblocked node"
    );
}

/// Issue #1963: an empty blocked list is a no-op, including on
/// `pending_approvals`. The common case by a wide margin — nearly every run
/// blocks on nobody — and the early return is what keeps a clean run's engine
/// gate list untouched.
#[test]
fn reclassify_blocked_leaves_the_engines_own_gate_list_alone_when_nothing_blocked() {
    let mut nodes = vec![
        node_row("fetch", WorkflowNodeStatus::Ok),
        node_row("review", WorkflowNodeStatus::Error),
    ];
    let before = nodes.clone();
    let mut pending = vec!["engine_gate".to_string()];

    reclassify_blocked(&mut nodes, &mut pending, &[]);

    assert_eq!(nodes, before, "no block, no relabel");
    assert_eq!(
        pending,
        vec!["engine_gate".to_string()],
        "the engine's own paused-gate list survives untouched"
    );
}

/// Issue #1963: `only_blocked_nodes_errored` MUST be read before
/// `reclassify_capped_nodes` runs, and reordering them turns an ordinary
/// blocked run into a reported failure.
///
/// The design comment at the call site says so in prose; nothing asserted it.
/// `only_blocked_nodes_errored` decides whether every errored row belongs to a
/// blocked node, and `reclassify_capped_nodes` *creates* `Error` rows out of
/// `Ok` ones. Run the relabel first and the capped node's fresh `Error` is a
/// row no `WorkflowBlockedNode` covers, so the containment check fails and the
/// run reports a genuine failure it did not have.
///
/// No driven run reaches this: it needs one node blocked on an approval *and* a
/// sibling truncated at `max_tool_iterations` in the same run, which is two
/// independent rare paths that no fixture drives together. This test builds the
/// state both orders would see and shows they disagree.
#[test]
fn the_blocked_containment_check_must_be_read_before_the_capped_relabel() {
    let blocked = vec![crate::ports::WorkflowBlockedNode {
        node_id: "spec".to_string(),
        tools: vec!["publish_artifact".to_string()],
        approval_ids: vec!["appr-1".to_string()],
        unparkable: 0,
        stranded: 0,
    }];
    let capped = vec!["summarize".to_string()];
    // What the settle arm actually receives: the blocked node reported `Error`
    // (its capability returned one, which is how the branch halted under the
    // default `on_error = "stop"`), and the capped node reported `Ok` because
    // the engine saw a completed turn.
    let engine_rows = vec![
        node_row("spec", WorkflowNodeStatus::Error),
        node_row("summarize", WorkflowNodeStatus::Ok),
    ];

    // The order the code keeps.
    let as_written = only_blocked_nodes_errored(&engine_rows, &blocked);
    assert!(
        as_written,
        "read before the capped relabel, every errored row belongs to a blocked \
         node — so this run is a block, not a failure"
    );

    // The order a reorder would produce.
    let mut reordered = engine_rows.clone();
    reclassify_capped_nodes(&mut reordered, &capped);
    let after_reorder = only_blocked_nodes_errored(&reordered, &blocked);

    assert!(
        !after_reorder,
        "the capped relabel adds an Error row no blocked node covers, so reading \
         the check afterwards is what makes the two orders disagree — if this \
         ever holds, the assertion below has stopped proving anything"
    );
    assert_ne!(
        as_written, after_reorder,
        "reordering these two must change the run's verdict — a capped node \
         beside a blocked one would be reported as a genuine failure"
    );
}
