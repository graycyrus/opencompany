//! The assertion vocabulary — see the [module docs](super) for where it came
//! from and which assertion is load-bearing.

use serde_json::Value;

use crate::company::WorkflowFile;
use crate::ports::WorkflowRun;
use crate::ports::types::WorkflowNodeStatus;

/// Panic unless `node_id` executed.
///
/// Worth asserting explicitly: a node a `condition` routed past leaves no row
/// at all, and a graph half of which never ran still settles into a clean
/// outcome.
pub(crate) fn assert_node_ran(run: &WorkflowRun, node_id: &str) {
    assert!(
        run.nodes.iter().any(|n| n.node_id == node_id),
        "node `{node_id}` never ran, so whatever it was supposed to do did not happen — the run \
         being clean says nothing about it; nodes that did run: {:?}",
        ran_ids(run)
    );
}

/// Panic if `node_id` executed.
pub(crate) fn assert_node_skipped(run: &WorkflowRun, node_id: &str) {
    assert!(
        !run.nodes.iter().any(|n| n.node_id == node_id),
        "node `{node_id}` ran when the branch reaching it should have been closed; nodes that \
         ran: {:?}",
        ran_ids(run)
    );
}

/// Panic unless `node_id` finished with `status`.
pub(crate) fn assert_node_status(run: &WorkflowRun, node_id: &str, status: WorkflowNodeStatus) {
    let row = run
        .nodes
        .iter()
        .find(|n| n.node_id == node_id)
        .unwrap_or_else(|| {
            panic!(
                "node `{node_id}` has no row at all, so it cannot be {status:?} — it never ran; \
                 nodes that did: {:?}",
                ran_ids(run)
            )
        });
    assert_eq!(
        row.status, status,
        "node `{node_id}` settled {:?}, not {status:?} — the run's reading of what happened to \
         that node is wrong, which is what an operator sees",
        row.status
    );
}

/// Panic unless `node_id` failed.
pub(crate) fn assert_node_failed(run: &WorkflowRun, node_id: &str) {
    assert_node_status(run, node_id, WorkflowNodeStatus::Error);
}

/// Panic unless `node_id` stopped for a human (issue #881) rather than
/// succeeding or failing.
pub(crate) fn assert_node_blocked(run: &WorkflowRun, node_id: &str) {
    assert_node_status(run, node_id, WorkflowNodeStatus::Blocked);
}

/// Every `=`-binding this run resolved to nothing, as `(node id, config path)`.
///
/// The host's view of the engine's `NullResolution` list: `tinyflows` records
/// the config **location** of each miss, the runner lifts it onto
/// `WorkflowRunNodeRow::diagnostics` (issue #1014), and this reads it back.
pub(crate) fn null_bindings(run: &WorkflowRun) -> Vec<(String, String)> {
    run.nodes
        .iter()
        .flat_map(|node| {
            node.diagnostics
                .iter()
                .map(move |path| (node.node_id.clone(), path.clone()))
        })
        .collect()
}

/// Panic if any `=`-binding resolved to nothing.
///
/// **The check a green run hides.** A binding that resolved to `null` is not an
/// error to the engine: the node ran, the field was empty, the workflow did
/// nothing, and the run reports a clean outcome. Every other assertion in this
/// file passes on that run.
pub(crate) fn assert_no_null_bindings(run: &WorkflowRun) {
    assert_nulls_empty(&null_bindings(run), |node, path| format!("  {node}.{path}"));
}

/// [`assert_no_null_bindings`], naming the **upstream node** each broken
/// binding was reading from.
///
/// Two functions rather than one because the run alone cannot answer the second
/// half: a diagnostic carries the config path and deliberately nothing else
/// (paths only, never a resolved value — issue #1014), so *who the node was
/// reading from* is a fact about the graph, not about the run. A caller holding
/// the [`WorkflowFile`] gets the better message; one holding only the run still
/// gets the check.
pub(crate) fn assert_no_null_bindings_over(run: &WorkflowRun, file: &WorkflowFile) {
    assert_nulls_empty(&null_bindings(run), |node, path| {
        let upstream: Vec<&str> = file
            .edges
            .iter()
            .filter(|edge| edge.to == node)
            .map(|edge| edge.from.as_str())
            .collect();
        if upstream.is_empty() {
            format!("  {node}.{path} (nothing upstream feeds it — it reads the trigger input)")
        } else {
            format!("  {node}.{path} (reads from upstream node(s) {upstream:?})")
        }
    });
}

/// The items `node_id` emitted, read off the engine's
/// `{ "nodes": { "<id>": { "items": [ … ] } } }` envelope.
pub(crate) fn node_items(run: &WorkflowRun, node_id: &str) -> Vec<Value> {
    run.output
        .get("nodes")
        .and_then(|nodes| nodes.get(node_id))
        .and_then(|node| node.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Panic unless the run finished with no node failing, nothing pending, and
/// nobody having stopped it.
pub(crate) fn assert_completed(run: &WorkflowRun) {
    let unsettled: Vec<(&str, WorkflowNodeStatus)> = run
        .nodes
        .iter()
        .filter(|n| n.status != WorkflowNodeStatus::Ok)
        .map(|n| (n.node_id.as_str(), n.status))
        .collect();
    assert!(
        unsettled.is_empty(),
        "expected a clean run, but these nodes did not settle `ok`: {unsettled:?}"
    );
    assert!(
        run.pending_approvals.is_empty(),
        "the run parked awaiting a person on {:?}, so it did not finish on its own",
        run.pending_approvals
    );
    assert!(
        !run.cancelled,
        "the run was stopped before it reached its terminal node, so its output is partial"
    );
}

/// The shared body of the two null-binding assertions: same failure, same
/// sentence, only the per-binding line differs.
fn assert_nulls_empty(nulls: &[(String, String)], line: impl Fn(&str, &str) -> String) {
    assert!(
        nulls.is_empty(),
        "these bindings resolved to null, so the nodes below ran on empty input and the run is \
         green for nothing:\n{}",
        nulls
            .iter()
            .map(|(node, path)| line(node, path))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn ran_ids(run: &WorkflowRun) -> Vec<&str> {
    run.nodes.iter().map(|n| n.node_id.as_str()).collect()
}
