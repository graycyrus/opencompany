//! Issue #1963: the **settle post-pass, asserted on every exit at once**.
//!
//! # Why this file exists rather than a fourth one-off fix
//!
//! [`run_workflow_inner`](super::runner) does not have one place where a run
//! settles. It has six reachable exits — a genuine failure, an only-blocked
//! halt, a hard abort, a clean node-boundary cancel, a dry run, and the normal
//! finish — and each one builds its own [`WorkflowRun`] from scratch. Every
//! exit is therefore free to forget a step of the post-pass, and three of them
//! did:
//!
//! | commit | exit that had forgotten `reclassify_capped_nodes` |
//! |---|---|
//! | `94c8e0507` | the failure / blocked `Err` arm |
//! | `1ca5b893a` | the clean node-boundary cancel arm |
//! | `a2210b594` | the budget-paused capped reading |
//!
//! Each fix arrived with a test pinning **its own** arm. Nothing asserted the
//! invariant across the set, so the fourth omission was only ever a matter of
//! which exit someone next added a field to. That is what this table is: one
//! statement of the post-pass, evaluated against all six exits, so a reviewer
//! comparing two exits reads two rows rather than two unrelated tests.
//!
//! # What the table does not do
//!
//! It cannot notice a **seventh** exit. Nothing here reads
//! `run_workflow_inner`'s source, so an exit added without a row is an exit
//! nothing drives — the same silence as before, one file further along. The
//! table's value is that adding the row is a two-line change and the six
//! expectations are stated side by side, not that anything will demand it.
//! Do not read [`TABLE`] as an enforced inventory.
//!
//! Deliberately absent for the same reason: a test asserting that `TABLE`
//! itself lists what it lists, or that the `partial` flags in `TABLE` follow
//! the rule the module docs state. Both were written first and both were
//! removed — they compare a constant in this file against another constant in
//! this file, so no change to `run_workflow_inner` can make either fail. Every
//! claim below is instead evaluated against a real run.
//!
//! # Why a unit test could not have caught any of the three
//!
//! `reclassify_capped_nodes` itself was never broken — it has unit tests, and
//! they passed throughout all three regressions. The defect was always that a
//! *call site* did not exist. A unit test of a function cannot observe a
//! caller's failure to call it; only driving each exit end to end can. That is
//! also why [`assert_settle_invariants`] drives the runner rather than calling
//! the post-pass helpers itself: a table that re-implemented the arms locally
//! and compared them to itself would pin nothing at all.
//!
//! # `persist_run_output`'s `partial` flag
//!
//! `persist_run_output` is reached from four call sites, `partial = true` on
//! two of them. The rule is `partial == true` **iff** the engine returned no
//! `outcome.output`, and no test asserted it before this file: the existing
//! ones all check the snapshot's *content* and ignore the one bit that tells a
//! reader whether they are looking at a whole run or a fragment. Each row below
//! states the flag its exit must write, and the assertion reads it back off the
//! durable record.
//!
//! # The seventh arm
//!
//! `run_workflow_inner` also has a `PROGRESS_DRAIN_TIMEOUT` fallback, where the
//! node-progress collector fails to shut down and the run settles with an empty
//! row list. It is **not a seventh settle exit**: it is a fallback *inside* the
//! drain, upstream of the `match` that chooses one of the six, and whichever
//! exit is taken afterwards is one of the six below. Reaching it deliberately
//! would need an observer `Arc` clone parked somewhere longer-lived than the
//! engine future, which no test can arrange from outside the runner — so what
//! is assertable about it is its **latency**, and
//! `a_cancelled_run_settles_fast_keeping_only_its_completed_nodes` in
//! `runner.rs` already asserts exactly that (it fails at the full 10s drain
//! timeout when the engine future is not dropped before the observer).

use std::sync::Arc;

use async_trait::async_trait;

use crate::Result;
use crate::company::WorkflowFile;
use crate::ports::run_output::WorkflowRunOutputStore;
use crate::ports::types::{CompanyId, WorkflowNodeStatus};
use crate::ports::{WorkflowRun, WorkflowRunContext};
use crate::store::FsOps;

use super::runner::run_workflow_lane_aware;
use super::testkit::{assert_node_ran, assert_node_skipped, assert_node_status, wf};

/// How long the hard-abort exit is given to come back after the operator's stop.
///
/// Generous on purpose: it must exceed the runner's own `CANCEL_HARD_ABORT_GRACE`
/// plus a loaded machine's drain, and it exists only so a wedged fixture fails
/// the test instead of hanging the suite.
const HARD_ABORT_CEILING: std::time::Duration = std::time::Duration::from_secs(30);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/// One of `run_workflow_inner`'s six reachable settle exits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitUnderTest {
    /// `Some(Err)` where the containment check finds a real failure: the run
    /// returns `Err(WorkflowRunFailed)` carrying a partial run.
    GenuineFailure,
    /// `Some(Err)` where every errored row belongs to a node the host blocked:
    /// the run returns `Ok(blocked_run(..))`.
    OnlyBlocked,
    /// `None` — the engine future was dropped past `CANCEL_HARD_ABORT_GRACE`
    /// because the node could not reach a boundary. `cancelled_run()`.
    HardAbort,
    /// `outcome.cancelled` — the engine saw the flipped token and wound down at
    /// a node boundary, so there IS an outcome and the rows are meaningful.
    CleanCancel,
    /// `ctx.dry_run` — the graph is walked over stubbed effectful capabilities.
    DryRun,
    /// The ordinary finish at the bottom of the function.
    Normal,
}

/// What the capped-node reconciliation must have done on an exit.
///
/// Three arms rather than a `bool`, because two exits skip
/// `reclassify_capped_nodes` **deliberately** and a table that could not say so
/// would either fail on them or — far worse — tolerate both behaviours and
/// therefore assert nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CappedReading {
    /// The capped node has a row and it reads `Error`.
    Reclassified,
    /// The exit returns **no rows at all**, so there is nothing to reclassify.
    /// `cancelled_run()` deliberately empties `nodes`: a hard-aborted run
    /// reports no result, and "how far did it get" is answered by the journal.
    /// Skipping the post-pass here is correct, and this row says so out loud.
    NoRowsAtAll,
    /// Nothing can be capped on this exit **by construction**. A dry run wires
    /// `DryRunAgent`, which runs no turn, so no turn can truncate at the
    /// iteration cap and `RunCappedNodes` is necessarily empty. The skip is
    /// correct; what must hold is that the capped node's row reads `Ok`, not
    /// that a reclassification quietly ran on an empty set.
    NothingCanBeCapped,
}

/// Whether `persist_run_output` ran on an exit, and with which `partial` flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersistedAs {
    /// Called with `partial = true` — the arm has no `outcome.output` and falls
    /// back to the progress observer's accumulated capture.
    Partial,
    /// Called with `partial = false` — the arm carries the engine's canonical
    /// output map.
    Complete,
    /// Never called. A hard abort has no outcome to persist; a dry run writes
    /// nothing durable at all.
    NotCalled,
}

/// The whole post-pass, as one row per exit.
struct ExitExpectation {
    exit: ExitUnderTest,
    /// What the capped upstream node's row must read.
    capped: CappedReading,
    /// Whether the durable snapshot was written, and with which flag.
    persist: PersistedAs,
    /// The status the tail node must settle with, or `None` on the two exits
    /// where the stop lands before it settles at all.
    tail_status: Option<WorkflowNodeStatus>,
    /// Whether `run.cancelled` must be set.
    cancelled: bool,
    /// Whether the approval receipts the run's nodes filed must survive onto
    /// `run.approvals` — the `approvals.take()` half of the post-pass.
    keeps_approval_receipts: bool,
    /// Whether the run must name the blocked node on `blocked_nodes` — the
    /// `blocks.take()` half.
    keeps_blocked_nodes: bool,
}

/// The six exits and the single post-pass they must all perform.
const TABLE: &[ExitExpectation] = &[
    ExitExpectation {
        exit: ExitUnderTest::GenuineFailure,
        capped: CappedReading::Reclassified,
        persist: PersistedAs::Partial,
        tail_status: Some(WorkflowNodeStatus::Error),
        cancelled: false,
        keeps_approval_receipts: false,
        keeps_blocked_nodes: false,
    },
    ExitExpectation {
        exit: ExitUnderTest::OnlyBlocked,
        capped: CappedReading::Reclassified,
        persist: PersistedAs::Partial,
        tail_status: Some(WorkflowNodeStatus::Blocked),
        cancelled: false,
        keeps_approval_receipts: true,
        keeps_blocked_nodes: true,
    },
    ExitExpectation {
        exit: ExitUnderTest::HardAbort,
        capped: CappedReading::NoRowsAtAll,
        persist: PersistedAs::NotCalled,
        tail_status: None,
        cancelled: true,
        keeps_approval_receipts: false,
        keeps_blocked_nodes: false,
    },
    ExitExpectation {
        exit: ExitUnderTest::CleanCancel,
        capped: CappedReading::Reclassified,
        persist: PersistedAs::Complete,
        tail_status: None,
        cancelled: true,
        keeps_approval_receipts: false,
        keeps_blocked_nodes: false,
    },
    ExitExpectation {
        exit: ExitUnderTest::DryRun,
        capped: CappedReading::NothingCanBeCapped,
        persist: PersistedAs::NotCalled,
        tail_status: Some(WorkflowNodeStatus::Ok),
        cancelled: false,
        keeps_approval_receipts: false,
        keeps_blocked_nodes: false,
    },
    ExitExpectation {
        exit: ExitUnderTest::Normal,
        capped: CappedReading::Reclassified,
        persist: PersistedAs::Complete,
        tail_status: Some(WorkflowNodeStatus::Ok),
        cancelled: false,
        keeps_approval_receipts: false,
        keeps_blocked_nodes: false,
    },
];

/// The one row describing `exit`.
///
/// Looked up rather than indexed by position, so reordering [`TABLE`] cannot
/// silently re-point a test at another exit — the failure mode the old
/// positional `TABLE[3]` calls needed a guard test of their own to survive.
fn row(exit: ExitUnderTest) -> &'static ExitExpectation {
    let mut matches = TABLE.iter().filter(|row| row.exit == exit);
    let found = matches
        .next()
        .unwrap_or_else(|| panic!("no TABLE row describes the {exit:?} exit"));
    assert!(
        matches.next().is_none(),
        "TABLE describes the {exit:?} exit more than once, so the two rows can disagree and only \
         the first would ever be checked"
    );
    found
}

// Split for the repo's 500-line ceiling; both halves are part of this module.
include!("settle_arms_test/settle_arms_test_part_01_tests.rs");
include!("settle_arms_test/settle_arms_test_part_02_tests.rs");

// ---------------------------------------------------------------------------
// One test per exit
// ---------------------------------------------------------------------------

/// Issue #1963. The `Some(Err)` exit where the containment check finds a real
/// failure. `94c8e0507` is the commit that had to add the capped
/// reclassification here after it shipped without one.
///
/// A unit test could not have caught that: `reclassify_capped_nodes` was
/// correct and tested throughout — what was missing was a *call* to it on this
/// exit, and a function's tests cannot observe a caller that never calls it.
#[tokio::test]
async fn a_genuine_failure_settles_with_a_partial_snapshot_and_its_capped_nodes_reclassified() {
    assert_settle_invariants(ExitUnderTest::GenuineFailure).await;
}

/// Issue #1963. The `Some(Err)` exit the containment check relabels as a block,
/// which is the exit the DEFAULT `on_error = "stop"` takes when an agent node's
/// deliverable is parked.
///
/// Not reachable from a unit test at all: whether this exit is taken is decided
/// by `only_blocked_nodes_errored` reading rows the progress observer collected
/// during a real engine run, so the classification only exists end to end.
#[tokio::test]
async fn an_only_blocked_halt_settles_ok_keeping_its_receipts_and_its_partial_snapshot() {
    assert_settle_invariants(ExitUnderTest::OnlyBlocked).await;
}

/// Issue #1963. The `None` exit: the node could not reach a boundary, so the
/// engine future was dropped past `CANCEL_HARD_ABORT_GRACE`.
///
/// This exit **deliberately** skips the capped reclassification and the durable
/// persist, and the table says so rather than leaving either unasserted — a
/// table that tolerated both readings here would catch nothing on the four
/// exits where the skip would be a bug.
///
/// A unit test cannot reach it: it exists only when a `tokio::select!` between
/// a stop signal and an engine future times the future out, which requires a
/// real wedged turn.
#[tokio::test]
async fn a_hard_abort_settles_cancelled_with_no_rows_and_persists_nothing() {
    assert_settle_invariants(ExitUnderTest::HardAbort).await;
}

/// Issue #1963. The clean node-boundary cancel — a third early return with its
/// own `nodes`, which is why `1ca5b893a` had to add the capped reclassification
/// here separately from the one `94c8e0507` added to the `Err` arm.
///
/// Unlike the hard abort it HAS a real outcome, so it persists with
/// `partial = false`. That pairing — cancelled, but complete — is the one a
/// reader is most likely to get backwards, and it is asserted here rather than
/// inferred.
#[tokio::test]
async fn a_clean_cancel_settles_with_a_complete_snapshot_and_its_capped_nodes_reclassified() {
    assert_settle_invariants(ExitUnderTest::CleanCancel).await;
}

/// Issue #1963. The dry-run exit, which skips the capped reclassification
/// **correctly**: `DryRunAgent` runs no turn, so no turn can truncate at the
/// iteration cap and `RunCappedNodes` is empty by construction.
///
/// Stated as `NothingCanBeCapped` rather than omitted, because the difference
/// between "the skip is safe here" and "the skip is a bug here" is the entire
/// content of this table, and an unasserted exit is indistinguishable from a
/// forgotten one.
#[tokio::test]
async fn a_dry_run_settles_without_reclassifying_its_capped_nodes_and_persists_nothing() {
    assert_settle_invariants(ExitUnderTest::DryRun).await;
}

/// Issue #1963. The ordinary finish — the one exit whose post-pass was never
/// forgotten, included so the table is a comparison rather than a list of
/// exceptions.
#[tokio::test]
async fn a_normal_finish_settles_with_a_complete_snapshot_and_its_capped_nodes_reclassified() {
    assert_settle_invariants(ExitUnderTest::Normal).await;
}
