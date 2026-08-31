//! Build a workflow graph for a test, and say what a run of it must show.
//!
//! # Why a builder and not another `const` TOML string
//!
//! Every graph fixture in this module's suites is an inline `const` TOML string
//! rewritten per test — around forty of them, each a near-copy of its
//! neighbour. That works for a handful of cases and collapses at a hundred: the
//! interesting difference between two graphs (one node carries
//! `requires_approval`) is buried in thirty lines of identical scaffolding, and
//! a property test wanting a hundred shapes cannot be written at all.
//!
//! [`wf`] builds the same graph in a line per node. What it must NOT do is
//! shortcut the authoring contract: it renders real on-disk TOML through the
//! production `render_workflow` and feeds it to the production
//! [`parse_workflow`](crate::company::parse_workflow), so a graph a test builds
//! is a graph an operator could have saved. A builder that constructed
//! [`WorkflowFile`](crate::company::WorkflowFile) directly would silently
//! accept shapes the parser refuses, and every test written on it would be
//! testing a graph that cannot exist.
//!
//! ```ignore
//! let file = wf("pipeline")
//!     .trigger("start")
//!     .agent("draft", "writer")
//!     .tool_call("publish", "publish_artifact")
//!     .requires_approval()
//!     .output("done")
//!     .to_owner()
//!     .edge("start", "draft")
//!     .edge("draft", "publish")
//!     .edge("publish", "done")
//!     .build();
//! ```
//!
//! # The assertions
//!
//! Ported from `tinyflows`' own testkit
//! (`vendor/openhuman/vendor/tinyflows/src/testkit/harness.rs`) and re-expressed
//! against the **host** run shape, [`WorkflowRun`](crate::ports::WorkflowRun),
//! because that is what this adapter produces. The engine's trace is not
//! visible from here; what is visible is `run.nodes` — one row per node that
//! finished, carrying its status and the engine's null-binding diagnostics.
//!
//! [`assert_no_null_bindings`] is the one that earns its place. A binding that
//! resolved to `null` is not an engine error: the node ran, the field was
//! empty, the workflow did nothing, and the run is green. `runner.rs` already
//! carries a one-off `AGENT_NULL_BINDING` fixture proving the diagnostic
//! reaches the run; this generalises the reading so any test can make the
//! claim.
//!
//! Split across two files only for the repo's 500-line ceiling: [`graph`] is
//! the builder, [`assert`] the vocabulary, each with its own `*_test.rs`
//! sibling. Callers use `testkit::…` for both halves.

mod assert;
mod assert_test;
mod graph;
mod graph_test;

pub(crate) use assert::{
    assert_completed, assert_no_null_bindings, assert_no_null_bindings_over, assert_node_blocked,
    assert_node_failed, assert_node_ran, assert_node_skipped, assert_node_status, node_items,
    null_bindings,
};
pub(crate) use graph::{WorkflowBuilder, wf};
