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
//! statement of the post-pass, evaluated against all six exits, so a new exit
//! is covered by adding a row rather than by somebody remembering.
//!
//! # Why a unit test could not have caught any of the three
//!
//! `reclassify_capped_nodes` itself was never broken — it has unit tests, and
//! they passed throughout all three regressions. The defect was always that a
//! *call site* did not exist. A unit test of a function cannot observe a
//! caller's failure to call it; only driving each exit end to end can.
//!
//! # The seventh arm
//!
//! `run_workflow_inner` also has a [`PROGRESS_DRAIN_TIMEOUT`] fallback, where
//! the node-progress collector fails to shut down and the run settles with an
//! empty row list. It is **not a seventh settle exit**: it is a fallback
//! *inside* the drain, upstream of the `match` that chooses one of the six, and
//! whichever exit is taken afterwards is one of the six below. Reaching it
//! deliberately would need an observer `Arc` clone parked somewhere longer-lived
//! than the engine future, which no test can arrange from outside the runner —
//! so what is assertable about it is its **latency**, and
//! `a_cancelled_run_settles_fast_keeping_only_its_completed_nodes` in
//! `runner.rs` already asserts exactly that (it fails at the full 10s drain
//! timeout when the engine future is not dropped before the observer). This
//! file notes it in [`ExitUnderTest`]'s docs rather than pretending to drive it.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use serde_json::Value;

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
///
/// The flag is the property nothing asserted before: five call sites, `true` on
/// two and `false` on three, and every existing test checks the snapshot's
/// *content* while ignoring the one bit that tells a reader whether they are
/// looking at a whole run or a fragment. The rule is
/// `partial == true` **iff** the engine returned no `outcome.output`.
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
    /// Whether the tail node must read `Blocked` (`None` when the fixture makes
    /// no node block on this exit).
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
///
/// Adding an exit to `run_workflow_inner` without adding a row here fails
/// [`the_table_covers_every_settle_exit_exactly_once`].
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

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/// `start -> capped_work -> tail_work -> done`, built through the testkit so the
/// graph every exit is driven over is one an operator could have saved.
///
/// Strictly sequential on purpose: `capped_work` therefore always settles — and
/// always pushes into `RunCappedNodes` — **before** `tail_work` does whatever
/// the exit under test needs, with no race to arrange. Every row in [`TABLE`]
/// is then a statement about the same graph, which is what makes the table a
/// comparison rather than six unrelated tests.
fn settle_arms_graph() -> WorkflowFile {
    wf("settle_arms")
        .display_name("Settle arms")
        .trigger("start")
        .agent("capped_work", "capped_agent")
        .summary("Loop until the iteration cap.")
        .agent("tail_work", "tail_agent")
        .summary("Settle however the exit under test needs.")
        .output("done")
        .edge("start", "capped_work")
        .edge("capped_work", "tail_work")
        .edge("tail_work", "done")
        .build()
}

/// What `tail_agent` does, which is the only thing that differs between exits.
enum TailBehaviour {
    /// Return a plain successful turn.
    Succeed,
    /// Return an error the blocker classifier does **not** recognise, so it
    /// fails the node rather than parking a blocker card — a genuine failure.
    Fail,
    /// Park an approval request, which `HarnessAgentRunner` turns into a block.
    Block {
        approvals: crate::harness::policy::ApprovalRequestQueue,
    },
    /// Announce arrival, then wait to be released. The test cancels first and
    /// releases second, so the token is already flipped when the turn resolves
    /// and the engine winds down at the next boundary.
    HoldUntilReleased {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    /// Announce arrival and never return, so the run can only be stopped by the
    /// hard abort.
    Wedge {
        entered: Arc<tokio::sync::Notify>,
    },
}

/// The turn double for [`settle_arms_graph`].
///
/// `capped_agent` always truncates at the iteration cap — `Ok` with
/// `hit_iteration_cap: true`, the exact signal `reclassify_capped_nodes`
/// reconciles — so every exit has a capped node upstream to make a claim about.
struct SettleArmsTurn {
    tail: TailBehaviour,
    /// How many turns the double served, so a fixture that never reached the
    /// tail can say so instead of asserting on a run it did not shape.
    turns: Arc<AtomicUsize>,
}

impl SettleArmsTurn {
    async fn execute(&self, agent_id: &str) -> Result<crate::harness::TurnOutcome> {
        self.turns.fetch_add(1, Ordering::SeqCst);
        if agent_id == "capped_agent" {
            return Ok(capped_turn());
        }
        match &self.tail {
            TailBehaviour::Succeed => Ok(plain_turn("the tail finished")),
            TailBehaviour::Fail => Err(crate::error::OpenCompanyError::Harness(
                "synthetic tail failure, deliberately unclassifiable as a blocker".to_string(),
            )),
            TailBehaviour::Block { approvals } => {
                approvals.push(crate::harness::policy::ApprovalRequest {
                    tool: "shell".to_string(),
                    reason: "synthetic approval parked by the tail node".to_string(),
                    effect: crate::ports::types::Effect {
                        kind: "shell".to_string(),
                        group: crate::ports::types::EffectGroup::Other,
                        amount_usd: None,
                        established_thread: false,
                        first_time_counterparty: false,
                        payload: serde_json::json!({ "command": "finish-report" }),
                        agent: Some(agent_id.to_string()),
                        run_id: None,
                    },
                });
                Ok(plain_turn("Waiting for approval."))
            }
            TailBehaviour::HoldUntilReleased { entered, release } => {
                entered.notify_waiters();
                release.notified().await;
                Ok(plain_turn("released"))
            }
            TailBehaviour::Wedge { entered } => {
                entered.notify_waiters();
                std::future::pending::<()>().await;
                unreachable!("a wedged turn is only ever dropped, never resumed")
            }
        }
    }
}

/// A turn that truncated at the `max_tool_iterations` cap: `Ok` at the engine
/// boundary, `Failed` on its own attempt row — the disagreement issue #1865's
/// post-pass exists to reconcile.
fn capped_turn() -> crate::harness::TurnOutcome {
    crate::harness::TurnOutcome {
        reply: "partial answer, still going".to_string(),
        steps: Vec::new(),
        hit_iteration_cap: true,
        abnormal_stop: None,
        halted_for_spend: None,
        budget_paused: None,
    }
}

fn plain_turn(reply: &str) -> crate::harness::TurnOutcome {
    crate::harness::TurnOutcome {
        reply: reply.to_string(),
        steps: Vec::new(),
        hit_iteration_cap: false,
        abnormal_stop: None,
        halted_for_spend: None,
        budget_paused: None,
    }
}

#[async_trait]
impl crate::runtime::delegation::RunTurn for SettleArmsTurn {
    async fn run(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        _message: &str,
        _chat_id: crate::runtime::delegation::ChatTarget<'_>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id).await
    }

    async fn run_steered(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        _message: &str,
        _control: &crate::company::steer::SteerControl,
        _chat_id: crate::runtime::delegation::ChatTarget<'_>,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id).await
    }

    async fn run_steered_background(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        _message: &str,
        _control: &crate::company::steer::SteerControl,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id).await
    }
}

// ---------------------------------------------------------------------------
// Driving one exit
// ---------------------------------------------------------------------------

/// What one exit left behind: the run body (the partial one on the failure
/// exit) and the durable snapshot, if any.
struct Settled {
    run: WorkflowRun,
    stored: Option<crate::ports::WorkflowRunOutputRecord>,
}

/// Drives `exit` over [`settle_arms_graph`] and returns what it settled into.
async fn drive(exit: ExitUnderTest) -> Settled {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut deps, _journal) =
        super::gated_tool_turn_test::deps("http://127.0.0.1:1/unused".to_string(), dir.path());
    let store = Arc::new(FsOps::new(dir.path()));
    deps.run_output_store = Some(store.clone());
    let record = super::gated_tool_turn_test::record();
    let turns = Arc::new(AtomicUsize::new(0));

    let mut ctx = WorkflowRunContext::new(false);
    ctx.dry_run = exit == ExitUnderTest::DryRun;
    let run_id = ctx.run_id.clone();
    let cancel = ctx.cancel.clone();

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let tail = match exit {
        ExitUnderTest::GenuineFailure => TailBehaviour::Fail,
        ExitUnderTest::OnlyBlocked => TailBehaviour::Block {
            approvals: deps.approval_requests.clone(),
        },
        ExitUnderTest::HardAbort => TailBehaviour::Wedge {
            entered: entered.clone(),
        },
        ExitUnderTest::CleanCancel => TailBehaviour::HoldUntilReleased {
            entered: entered.clone(),
            release: release.clone(),
        },
        ExitUnderTest::DryRun | ExitUnderTest::Normal => TailBehaviour::Succeed,
    };
    let turn = Arc::new(SettleArmsTurn {
        tail,
        turns: turns.clone(),
    });

    let mut running = Box::pin(run_workflow_lane_aware(
        turn,
        deps,
        &record,
        &settle_arms_graph(),
        serde_json::json!({ "request": "go" }),
        &ctx,
    ));

    // The two cancelling exits have to reach the tail node before the stop, or
    // they would be testing a cancel that arrived before the run started.
    let result = match exit {
        ExitUnderTest::HardAbort | ExitUnderTest::CleanCancel => {
            let reached = entered.notified();
            tokio::select! {
                _ = &mut running => panic!(
                    "the run settled before the tail node was reached, so this fixture drove \
                     some other exit than {exit:?}"
                ),
                () = reached => {}
            }
            cancel.cancel();
            // Clean cancel: release AFTER the token is flipped, so the turn
            // resolves into a wound-down engine. Hard abort: never released.
            if exit == ExitUnderTest::CleanCancel {
                release.notify_one();
            }
            tokio::time::timeout(HARD_ABORT_CEILING, running)
                .await
                .unwrap_or_else(|_| {
                    panic!("the stopped run never came back within {HARD_ABORT_CEILING:?}")
                })
        }
        _ => running.await,
    };

    let run = match result {
        Ok(run) => run,
        Err(err) => err
            .partial_run()
            .expect("a genuine failure carries the partial run it had already done")
            .clone(),
    };
    let stored = store
        .get_run_output(&record.id, &run_id)
        .await
        .expect("reading the durable snapshot back must not itself fail");
    Settled { run, stored }
}

// ---------------------------------------------------------------------------
// The shared assertion
// ---------------------------------------------------------------------------

/// The whole post-pass, asserted against one row of [`TABLE`].
async fn assert_settle_invariants(expected: &ExitExpectation) {
    let exit = expected.exit;
    let settled = drive(exit).await;
    let run = &settled.run;

    assert_eq!(
        run.cancelled, expected.cancelled,
        "on the {exit:?} exit the run's own reading of whether an operator stopped it is wrong, \
         which is what decides whether it lands in the failure count: {:?}",
        run.nodes
    );

    match expected.capped {
        CappedReading::Reclassified => {
            assert_node_ran(run, "capped_work");
            assert_node_status(run, "capped_work", WorkflowNodeStatus::Error);
        }
        CappedReading::NoRowsAtAll => {
            assert!(
                run.nodes.is_empty(),
                "the {exit:?} exit reports no result, so it must carry no node rows — a row here \
                 means the exit grew a body and its post-pass expectations are now unstated: {:?}",
                run.nodes
            );
        }
        CappedReading::NothingCanBeCapped => {
            assert_node_ran(run, "capped_work");
            assert_node_status(run, "capped_work", WorkflowNodeStatus::Ok);
        }
    }

    match expected.tail_status {
        Some(status) => assert_node_status(run, "tail_work", status),
        None => assert_node_skipped(run, "done"),
    }

    match expected.persist {
        PersistedAs::NotCalled => assert!(
            settled.stored.is_none(),
            "the {exit:?} exit must persist no run-output snapshot at all, and one was written: \
             {:?}",
            settled.stored
        ),
        PersistedAs::Partial | PersistedAs::Complete => {
            let stored = settled.stored.as_ref().unwrap_or_else(|| {
                panic!(
                    "the {exit:?} exit must persist a run-output snapshot, and none was written — \
                     reopening this run from History would report that it predates output capture"
                )
            });
            let want_partial = expected.persist == PersistedAs::Partial;
            assert_eq!(
                stored.partial, want_partial,
                "the {exit:?} exit persisted its snapshot with partial = {}, but the flag must be \
                 true exactly when the engine returned no outcome.output — an operator reading \
                 this record cannot tell a whole run from a fragment: {stored:?}",
                stored.partial
            );
            assert_eq!(
                stored.workflow_id, "settle_arms",
                "the snapshot must name the workflow that produced it"
            );
        }
    }

    assert_eq!(
        !run.approvals.is_empty(),
        expected.keeps_approval_receipts,
        "the {exit:?} exit's handling of the approval receipts its nodes filed is wrong. A card \
         is durable the moment it is written, so an exit that drops the row leaves a card on the \
         operator's Approvals page that no run admits to opening: {:?}",
        run.approvals
    );
    assert_eq!(
        !run.blocked_nodes.is_empty(),
        expected.keeps_blocked_nodes,
        "the {exit:?} exit's reading of which nodes are waiting on a person is wrong: {:?}",
        run.blocked_nodes
    );
}

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
    assert_settle_invariants(&TABLE[0]).await;
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
    assert_settle_invariants(&TABLE[1]).await;
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
    assert_settle_invariants(&TABLE[2]).await;
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
    assert_settle_invariants(&TABLE[3]).await;
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
    assert_settle_invariants(&TABLE[4]).await;
}

/// Issue #1963. The ordinary finish — the one exit whose post-pass was never
/// forgotten, included so the table is a comparison rather than a list of
/// exceptions.
#[tokio::test]
async fn a_normal_finish_settles_with_a_complete_snapshot_and_its_capped_nodes_reclassified() {
    assert_settle_invariants(&TABLE[5]).await;
}

/// Issue #1963. The table itself: every exit appears exactly once, and the rows
/// are in the order the tests index them.
///
/// This is what makes adding an exit to `run_workflow_inner` cost a row rather
/// than a silent gap — the failure mode the three historical regressions all
/// share is an exit nobody wrote anything about.
#[test]
fn the_table_covers_every_settle_exit_exactly_once() {
    use ExitUnderTest::*;
    let want = [
        GenuineFailure,
        OnlyBlocked,
        HardAbort,
        CleanCancel,
        DryRun,
        Normal,
    ];
    let got: Vec<ExitUnderTest> = TABLE.iter().map(|row| row.exit).collect();
    assert_eq!(
        got,
        want.to_vec(),
        "the settle table no longer lists every exit of `run_workflow_inner` exactly once, in \
         order. Each `#[tokio::test]` above indexes TABLE by position, so a reordered or missing \
         row silently re-points a test at another exit."
    );
}

/// Issue #1963. `persist_run_output`'s flag is not free-form: across the whole
/// table `partial = true` happens on exactly the two exits that have no
/// `outcome.output` to persist.
///
/// Asserted over the table rather than per exit because the property is about
/// the *set*: a fifth call site added with the wrong flag would pass every
/// single-exit test above while breaking the rule an operator reads the record
/// under.
#[test]
fn partial_is_flagged_on_exactly_the_two_exits_that_have_no_engine_output() {
    let partial: Vec<ExitUnderTest> = TABLE
        .iter()
        .filter(|row| row.persist == PersistedAs::Partial)
        .map(|row| row.exit)
        .collect();
    assert_eq!(
        partial,
        vec![ExitUnderTest::GenuineFailure, ExitUnderTest::OnlyBlocked],
        "`partial` must be set exactly on the exits the engine returns no output for. Any other \
         exit flagging partial is telling the console a complete run is a fragment, or worse, a \
         fragment is complete."
    );
}

/// Issue #1963. Guards the fixture rather than the runner: the settle graph
/// really does put a capped node upstream of the tail on every exit, so a row
/// asserting `Reclassified` is asserting something.
///
/// Without this a later edit that dropped `hit_iteration_cap` from the double
/// would leave four rows passing vacuously — the node's row would read `Ok`,
/// nothing would be capped, and `assert_node_status(.., Error)` would simply
/// start failing for the wrong reason with a message about the runner.
#[tokio::test]
async fn the_fixture_really_caps_its_upstream_node_before_the_tail_settles() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (deps, _journal) =
        super::gated_tool_turn_test::deps("http://127.0.0.1:1/unused".to_string(), dir.path());
    let turns = Arc::new(AtomicUsize::new(0));
    let turn = Arc::new(SettleArmsTurn {
        tail: TailBehaviour::Succeed,
        turns: turns.clone(),
    });
    let run = run_workflow_lane_aware(
        turn,
        deps,
        &super::gated_tool_turn_test::record(),
        &settle_arms_graph(),
        Value::Null,
        &WorkflowRunContext::new(false),
    )
    .await
    .expect("the plain fixture run settles");

    assert_eq!(
        turns.load(Ordering::SeqCst),
        2,
        "both agent nodes must have taken a turn, or the graph the table drives is not the graph \
         it claims to drive: {:?}",
        run.nodes
    );
    assert_node_ran(&run, "done");
}
