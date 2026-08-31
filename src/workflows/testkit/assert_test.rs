//! The assertion vocabulary's own contract (issue #1963).
//!
//! # Why this is not paranoia
//!
//! An assertion helper that cannot fail is worse than no helper: it makes every
//! suite that calls it read as covered while checking nothing, and it does so
//! silently and forever. That is the same pathology
//! [`assert_no_null_bindings`](super::assert_no_null_bindings) exists to catch
//! one level up — a run that is green for nothing — so the vocabulary owes the
//! proof it demands. Each check below is pinned in **both** directions: it
//! passes on the shape it should accept, and panics on the shape it must
//! reject.
//!
//! The runs are deserialized rather than hand-constructed so that a field added
//! to [`WorkflowRun`](crate::ports::WorkflowRun) later does not have to be
//! spelled out here — every field but `output` and `pending_approvals` carries
//! `#[serde(default)]` precisely so an older payload still loads.

use serde_json::{Value, json};

use super::*;
use crate::ports::WorkflowRun;
use crate::ports::types::WorkflowNodeStatus;

/// A settled run with these node rows. `rows` are `{node_id, status,
/// elapsed_ms, diagnostics?}` objects, exactly as the runner serializes them.
fn run_with(rows: Value) -> WorkflowRun {
    serde_json::from_value(json!({
        "output": { "nodes": { "draft": { "items": [{ "json": { "text": "hello" } }] } } },
        "pending_approvals": [],
        "nodes": rows,
    }))
    .expect("the fixture run deserializes")
}

fn ok_row(node_id: &str) -> Value {
    json!({ "node_id": node_id, "status": "ok", "elapsed_ms": 1 })
}

/// A clean two-node run — the shape every positive case below reads.
fn clean_run() -> WorkflowRun {
    run_with(json!([ok_row("draft"), ok_row("done")]))
}

#[test]
fn assert_node_ran_accepts_a_node_that_has_a_row() {
    assert_node_ran(&clean_run(), "draft");
}

/// A node a `condition` routed past leaves no row at all, and the run is still
/// clean — the exact case the assertion exists for.
#[test]
#[should_panic(expected = "never ran")]
fn assert_node_ran_rejects_a_node_the_run_never_reached() {
    assert_node_ran(&clean_run(), "publish");
}

#[test]
fn assert_node_skipped_accepts_a_node_with_no_row() {
    assert_node_skipped(&clean_run(), "publish");
}

#[test]
#[should_panic(expected = "should have been closed")]
fn assert_node_skipped_rejects_a_node_that_ran() {
    assert_node_skipped(&clean_run(), "draft");
}

#[test]
fn assert_node_status_reads_each_of_the_three_readings() {
    let run = run_with(json!([
        ok_row("draft"),
        { "node_id": "publish", "status": "error", "elapsed_ms": 2 },
        { "node_id": "announce", "status": "blocked", "elapsed_ms": 3 },
    ]));

    assert_node_status(&run, "draft", WorkflowNodeStatus::Ok);
    assert_node_failed(&run, "publish");
    assert_node_blocked(&run, "announce");
}

/// The distinction issue #881 turns on: a node waiting on a person is neither
/// green nor failed, so asserting `Error` on a blocked node must fail rather
/// than pass on "not ok".
#[test]
#[should_panic(expected = "settled Blocked, not Error")]
fn assert_node_failed_does_not_accept_a_node_that_is_merely_blocked() {
    let run = run_with(json!([
        { "node_id": "announce", "status": "blocked", "elapsed_ms": 3 },
    ]));
    assert_node_failed(&run, "announce");
}

/// A status assertion about a node that never ran says *that*, rather than
/// reporting a mismatch against a row it invented.
#[test]
#[should_panic(expected = "has no row at all")]
fn assert_node_status_rejects_a_node_with_no_row_at_all() {
    assert_node_status(&clean_run(), "publish", WorkflowNodeStatus::Ok);
}

#[test]
fn a_run_with_no_diagnostics_has_no_null_bindings() {
    let run = clean_run();
    assert!(null_bindings(&run).is_empty());
    assert_no_null_bindings(&run);
}

/// The headline. Every node reports `ok`, nothing is pending, nothing was
/// stopped — and the run bound a field nothing produced. `assert_completed`
/// passes on this run; only the null-binding check does not.
#[test]
#[should_panic(expected = "green for nothing")]
fn assert_no_null_bindings_rejects_a_green_run_that_bound_nothing() {
    let run = run_with(json!([
        { "node_id": "draft", "status": "ok", "elapsed_ms": 1, "diagnostics": ["recipient"] },
    ]));
    assert_completed(&run);
    assert_no_null_bindings(&run);
}

/// Every broken binding is named, not just the first — a run that lost three
/// fields should not need three runs to find out.
#[test]
fn null_bindings_reports_every_miss_with_the_node_that_made_it() {
    let run = run_with(json!([
        { "node_id": "draft", "status": "ok", "elapsed_ms": 1, "diagnostics": ["recipient", "subject"] },
        { "node_id": "done", "status": "ok", "elapsed_ms": 1, "diagnostics": ["body"] },
    ]));

    assert_eq!(
        null_bindings(&run),
        vec![
            ("draft".to_string(), "recipient".to_string()),
            ("draft".to_string(), "subject".to_string()),
            ("done".to_string(), "body".to_string()),
        ]
    );
}

/// With the graph in hand, the failure names the node the broken binding was
/// reading from — which is where the author has to go to fix it.
#[test]
#[should_panic(expected = "reads from upstream node(s) [\"draft\"]")]
fn assert_no_null_bindings_over_names_the_upstream_node_it_read_from() {
    let file = wf("pipeline")
        .trigger("start")
        .agent("draft", "writer")
        .output("done")
        .edge("start", "draft")
        .edge("draft", "done")
        .build();
    let run = run_with(json!([
        { "node_id": "done", "status": "ok", "elapsed_ms": 1, "diagnostics": ["input"] },
    ]));

    assert_no_null_bindings_over(&run, &file);
}

#[test]
fn node_items_reads_the_engines_output_envelope() {
    let run = clean_run();
    let items = node_items(&run, "draft");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["json"]["text"], json!("hello"));
    assert!(
        node_items(&run, "publish").is_empty(),
        "a node that produced nothing reads as no items, not as a panic"
    );
}

#[test]
fn assert_completed_accepts_a_run_that_settled_on_its_own() {
    assert_completed(&clean_run());
}

/// A run parked on a person did not finish, however green its rows look.
#[test]
#[should_panic(expected = "parked awaiting a person")]
fn assert_completed_rejects_a_run_still_waiting_on_an_operator() {
    let run: WorkflowRun = serde_json::from_value(json!({
        "output": {},
        "pending_approvals": ["publish"],
        "nodes": [ok_row("draft")],
    }))
    .expect("the fixture run deserializes");

    assert_completed(&run);
}

/// A stopped run is not a failed one (issue #383) — but it is not a completed
/// one either, and `assert_completed` must say so rather than let a partial
/// output through.
#[test]
#[should_panic(expected = "stopped before it reached its terminal node")]
fn assert_completed_rejects_a_run_an_operator_stopped() {
    let run: WorkflowRun = serde_json::from_value(json!({
        "output": {},
        "pending_approvals": [],
        "cancelled": true,
        "nodes": [ok_row("draft")],
    }))
    .expect("the fixture run deserializes");

    assert_completed(&run);
}
