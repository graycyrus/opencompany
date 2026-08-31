// ── issue #1963: direct units for the blocked-run constructor ───────────────
//
// The third part of the `include!`d suite (see `pure_units_part_01_tests.rs`).
// `blocked_run` is the settle arm that turns an engine `Err` into an `Ok` run,
// and each of its emptied fields is a claim the doc comment makes in prose and
// nothing asserted.

/// One blocked node, with the shape the drain actually produces.
fn blocked_node(node_id: &str, approval_ids: &[&str]) -> crate::ports::WorkflowBlockedNode {
    crate::ports::WorkflowBlockedNode {
        node_id: node_id.to_string(),
        tools: vec!["publish_artifact".to_string()],
        approval_ids: approval_ids.iter().map(|id| id.to_string()).collect(),
        unparkable: 0,
        stranded: 0,
    }
}

/// Issue #1963 (issue #881): a blocked run settles `Ok`, with no `cancelled`
/// flag and no deliveries, and lists every blocked node as something the run is
/// waiting on.
///
/// The three together are one claim: a node waiting for a human is neither a
/// failure nor a stop, and a run that halted short must not mail anybody a
/// report of work it did not finish. A driven blocked-run test asserts about
/// the node's own status; nothing asserted that `deliveries` is empty *by
/// construction* rather than because the fixture's graph routed nothing.
#[test]
fn a_blocked_run_settles_uncancelled_with_no_deliveries_and_every_block_pending() {
    let run = blocked_run(BlockedRun {
        nodes: vec![
            node_row("fetch", WorkflowNodeStatus::Ok),
            node_row("spec", WorkflowNodeStatus::Error),
        ],
        blocked: vec![blocked_node("spec", &["appr-1"])],
        notices: crate::workflows::caps::RunNotices::default(),
        board: Vec::new(),
        approvals: Vec::new(),
        output: serde_json::json!({ "fetch": { "items": [] } }),
    });

    assert!(
        !run.cancelled,
        "a blocked run is not a stopped one — the console's three terminal \
         wordings stay distinguishable only if this stays false"
    );
    assert!(
        run.deliveries.is_empty(),
        "deliver_outputs is deliberately not reached: {:?}",
        run.deliveries
    );
    assert_eq!(
        run.pending_approvals,
        vec!["spec".to_string()],
        "the blocked node is what the run is waiting on"
    );
    assert_eq!(
        run.nodes[1].status,
        WorkflowNodeStatus::Blocked,
        "and its row agrees, rather than keeping the engine's Error"
    );
    assert_eq!(
        run.nodes[0].status,
        WorkflowNodeStatus::Ok,
        "while the node that finished before the block keeps its result"
    );
}

/// Issue #1963 (issue #1008): the upstream capture is threaded through, not
/// emptied.
///
/// `output` used to be `Value::Null` here, on the argument that the engine
/// returned an error rather than a final state. Everything upstream of the
/// block had in fact run to completion, so the run inspector said "no output
/// for this node" about a node that had just written a draft. The caller
/// removes the blocked nodes' own entries before handing the map in — so
/// "the blocked node produced nothing" stays literally true — and this pins
/// that `blocked_run` neither re-empties the map nor re-adds the block.
#[test]
fn a_blocked_run_reports_what_the_nodes_upstream_of_the_block_produced() {
    let run = blocked_run(BlockedRun {
        nodes: vec![node_row("spec", WorkflowNodeStatus::Error)],
        blocked: vec![blocked_node("spec", &["appr-1"])],
        notices: crate::workflows::caps::RunNotices::default(),
        board: Vec::new(),
        approvals: Vec::new(),
        output: serde_json::json!({
            "fetch": { "items": [{ "json": { "text": "the draft" } }] }
        }),
    });

    assert_eq!(
        run.output["fetch"]["items"][0]["json"]["text"],
        serde_json::json!("the draft"),
        "the work the run did before it blocked is still the run's to report"
    );
    assert!(
        run.output.get("spec").is_none(),
        "and the blocked node itself stays absent: {}",
        run.output
    );
}

/// Issue #1963 (issues #661 / #880): `board` and `approvals` are threaded in
/// rather than emptied, for the reason the sibling `cancelled_run` spells out —
/// a card is durable the moment it is written, and zeroing the rows would leave
/// cards on the operator's board and Approvals page that no run admits to
/// opening.
#[test]
fn a_blocked_run_keeps_the_receipts_for_cards_its_nodes_already_opened() {
    let run = blocked_run(BlockedRun {
        nodes: vec![node_row("spec", WorkflowNodeStatus::Error)],
        blocked: vec![blocked_node("spec", &["appr-1"])],
        notices: crate::workflows::caps::RunNotices::default(),
        board: vec![crate::ports::WorkflowRunBoardRow {
            action: crate::ports::WorkflowBoardAction::Spawned,
            task_id: Some("task-7".to_string()),
            title: Some("Draft the spec".to_string()),
            assignee: None,
        }],
        approvals: vec![crate::ports::WorkflowRunApprovalRow {
            node_id: Some("spec".to_string()),
            tool: Some("publish_artifact".to_string()),
            outcome: crate::ports::WorkflowApprovalOutcome::Parked,
            approval_id: Some("appr-1".to_string()),
        }],
        output: Value::Null,
    });

    assert_eq!(
        run.board.len(),
        1,
        "a card that is already on the board needs a run that admits to it"
    );
    assert_eq!(
        run.approvals.len(),
        1,
        "and so does a card that is already on the Approvals page"
    );
    assert_eq!(
        run.blocked_nodes.len(),
        1,
        "the structural blocked row rides out alongside them"
    );
}

/// Issue #1963: the block's sentence is appended to whatever the nodes already
/// raised, in blocked order, and never replaces them.
///
/// A node can overflow the approval cap (issue #638) and then block, so both
/// notices are owed. Ordering matters to the reader: the notices collected
/// during the run describe what happened, and the block's sentence describes
/// why the run stopped.
#[test]
fn the_blocks_sentence_is_appended_after_the_notices_the_nodes_already_raised() {
    let notices = crate::workflows::caps::RunNotices::default();
    notices.push("An earlier notice from a node.".to_string());

    let run = blocked_run(BlockedRun {
        nodes: vec![
            node_row("spec", WorkflowNodeStatus::Error),
            node_row("review", WorkflowNodeStatus::Error),
        ],
        blocked: vec![
            blocked_node("spec", &["appr-1"]),
            blocked_node("review", &[]),
        ],
        notices,
        board: Vec::new(),
        approvals: Vec::new(),
        output: Value::Null,
    });

    assert_eq!(
        run.notices.len(),
        3,
        "one pre-existing notice plus one sentence per blocked node: {:?}",
        run.notices
    );
    assert_eq!(
        run.notices[0], "An earlier notice from a node.",
        "what the nodes raised comes first"
    );
    assert!(
        run.notices[1].contains("\"spec\"") && run.notices[2].contains("\"review\""),
        "and the block sentences follow in blocked order: {:?}",
        run.notices
    );
    assert_eq!(
        run.pending_approvals,
        vec!["spec".to_string(), "review".to_string()],
        "both blocked nodes are waited on, in the same order"
    );
}
