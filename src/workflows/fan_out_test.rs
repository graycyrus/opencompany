//! Issue #1963: what a **fan-out and its join** do at run level.
//!
//! # The gap
//!
//! `caps::upstream` has good order-independence tests, and they are all at the
//! **fold** level: they hand `allocate_fairly` two sources in both orders and
//! check the allocation matches. What no test asserts is the thing that
//! actually varies in production — whether the *run* hands the fold its
//! predecessors in a stable order in the first place.
//!
//! That distinction is the whole risk. Two parallel agent nodes finish in
//! whatever order their providers answer in, and if the folded turn is built in
//! completion order then the text a join node is sent differs between two runs
//! of the same graph over the same data. Every downstream assertion an author
//! writes — and every assertion a *test* writes — then becomes
//! flaky-or-wrong-but-green, which is the failure mode
//! [`caps::upstream`](super::caps::upstream)'s own module docs open with: four
//! of seven runs of the same graph succeeded and the only variable was content.
//!
//! # Why a unit test cannot make these claims
//!
//! A unit test of the fold chooses the predecessor order itself, so it can
//! never observe the run choosing a different one. The order only exists once
//! two nodes have really raced.
//!
//! # The three joins
//!
//! Beyond ordering, three fan-in shapes had no run-level coverage at all: a
//! `merge` whose predecessors disagree about whether they succeeded, a
//! `split_out` over an empty list (the fan-out of nothing), and a diamond whose
//! two arms both stop for a person at once.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use crate::Result;
use crate::company::WorkflowFile;
use crate::error::OpenCompanyError;
use crate::ports::WorkflowRunContext;
use crate::ports::types::{CompanyId, WorkflowNodeStatus};

use super::runner::run_workflow_lane_aware;
use super::testkit::{
    assert_no_null_bindings_over, assert_node_ran, assert_node_skipped, assert_node_status,
    node_items, wf,
};

// ---------------------------------------------------------------------------
// The turn double
// ---------------------------------------------------------------------------

/// What one agent in a fan-out does.
#[derive(Clone)]
enum ArmBehaviour {
    /// Wait, then reply. The wait is what makes two arms finish in a
    /// controllable order.
    ReplyAfter {
        delay: Duration,
        reply: &'static str,
    },
    /// Fail with a message the blocker classifier does not recognise, so the
    /// node errors rather than being held open for a person.
    Fail,
    /// Park an approval request, which `HarnessAgentRunner` turns into a block.
    Park,
}

/// Routes each agent id to its behaviour and records the turn text every node
/// was sent.
///
/// The recorded message is the load-bearing part: what a join node is *asked*
/// is the only place a predecessor ordering is observable from outside the
/// engine.
struct FanOutLane {
    arms: Vec<(&'static str, ArmBehaviour)>,
    approvals: crate::harness::policy::ApprovalRequestQueue,
    /// `(agent id, the turn text it was sent)`, in the order the turns started.
    seen: Mutex<Vec<(String, String)>>,
}

impl FanOutLane {
    fn new(
        arms: Vec<(&'static str, ArmBehaviour)>,
        approvals: crate::harness::policy::ApprovalRequestQueue,
    ) -> Arc<Self> {
        Arc::new(Self {
            arms,
            approvals,
            seen: Mutex::new(Vec::new()),
        })
    }

    /// The turn text `agent_id` was sent, or `None` if it never ran.
    fn turn_text(&self, agent_id: &str) -> Option<String> {
        self.seen
            .lock()
            .expect("turn log")
            .iter()
            .find(|(id, _)| id == agent_id)
            .map(|(_, text)| text.clone())
    }

    async fn execute(&self, agent_id: &str, message: &str) -> Result<crate::harness::TurnOutcome> {
        self.seen
            .lock()
            .expect("turn log")
            .push((agent_id.to_string(), message.to_string()));
        let behaviour = self
            .arms
            .iter()
            .find(|(id, _)| *id == agent_id)
            .map(|(_, behaviour)| behaviour.clone())
            .unwrap_or(ArmBehaviour::ReplyAfter {
                delay: Duration::ZERO,
                reply: "acknowledged",
            });
        match behaviour {
            ArmBehaviour::ReplyAfter { delay, reply } => {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(plain_turn(reply))
            }
            ArmBehaviour::Fail => Err(OpenCompanyError::Harness(format!(
                "synthetic failure in fan-out arm `{agent_id}`"
            ))),
            ArmBehaviour::Park => {
                self.approvals.push(crate::harness::policy::ApprovalRequest {
                    tool: "shell".to_string(),
                    reason: format!("synthetic approval parked by `{agent_id}`"),
                    effect: crate::ports::types::Effect {
                        kind: "shell".to_string(),
                        group: crate::ports::types::EffectGroup::Other,
                        amount_usd: None,
                        established_thread: false,
                        first_time_counterparty: false,
                        payload: json!({ "command": "ship-it" }),
                        agent: Some(agent_id.to_string()),
                        run_id: None,
                    },
                });
                Ok(plain_turn("Waiting for approval."))
            }
        }
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
impl crate::runtime::delegation::RunTurn for FanOutLane {
    async fn run(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        message: &str,
        _chat_id: crate::runtime::delegation::ChatTarget<'_>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id, message).await
    }

    async fn run_steered(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        message: &str,
        _control: &crate::company::steer::SteerControl,
        _chat_id: crate::runtime::delegation::ChatTarget<'_>,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id, message).await
    }

    async fn run_steered_background(
        &self,
        _company: &CompanyId,
        agent_id: &str,
        message: &str,
        _control: &crate::company::steer::SteerControl,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.execute(agent_id, message).await
    }
}

// ---------------------------------------------------------------------------
// Running one graph
// ---------------------------------------------------------------------------

/// Runs `graph` against `arms`, returning the settled run (or its error) and
/// the lane that recorded every turn.
async fn run_fan_out(
    graph: &WorkflowFile,
    arms: Vec<(&'static str, ArmBehaviour)>,
    input: serde_json::Value,
) -> (Result<crate::ports::WorkflowRun>, Arc<FanOutLane>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let (deps, _journal) =
        super::gated_tool_turn_test::deps("http://127.0.0.1:1/unused".to_string(), dir.path());
    let lane = FanOutLane::new(arms, deps.approval_requests.clone());
    let run = run_workflow_lane_aware(
        lane.clone(),
        deps,
        &super::gated_tool_turn_test::record(),
        graph,
        input,
        &WorkflowRunContext::new(false),
    )
    .await;
    (run, lane)
}

// ---------------------------------------------------------------------------
// 1. Predecessor order in the folded turn
// ---------------------------------------------------------------------------

/// `start` fans out to `left` and `right`, both of which feed `join`.
///
/// `join_first` is the arm whose `-> join` edge is declared **first**, which is
/// the only thing that varies between the two graphs the ordering test drives.
fn diamond_graph(join_kind: DiamondJoin, join_first: Arm) -> WorkflowFile {
    let builder = wf("diamond")
        .display_name("Diamond")
        .trigger("start")
        .agent("left", "left_agent")
        .summary("The left arm.")
        .agent("right", "right_agent")
        .summary("The right arm.");
    let builder = match join_kind {
        DiamondJoin::Agent => builder.agent("join", "join_agent").summary("Fold both arms."),
        DiamondJoin::Merge => builder.merge("join"),
    };
    let builder = builder
        .output("done")
        .edge("start", "left")
        .edge("start", "right");
    let builder = match join_first {
        Arm::Left => builder.edge("left", "join").edge("right", "join"),
        Arm::Right => builder.edge("right", "join").edge("left", "join"),
    };
    builder.edge("join", "done").build()
}

/// One arm of the diamond.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arm {
    Left,
    Right,
}

impl Arm {
    /// The reply that arm's agent gives, and therefore the text to look for in
    /// the join's folded turn.
    fn finding(self) -> &'static str {
        match self {
            Arm::Left => "the left arm's finding",
            Arm::Right => "the right arm's finding",
        }
    }

    fn other(self) -> Arm {
        match self {
            Arm::Left => Arm::Right,
            Arm::Right => Arm::Left,
        }
    }
}

/// Which node kind sits at the bottom of the diamond.
#[derive(Clone, Copy)]
enum DiamondJoin {
    /// An `agent`, so the fold's output is observable as the turn text.
    Agent,
    /// A `merge`, the vocabulary's explicit fan-in.
    Merge,
}

/// Issue #1963. **The keystone.** The order a join node's predecessors appear
/// in its folded turn is the order the graph declares their edges — never the
/// order the two arms happened to finish in.
///
/// # Why the claim is directional
///
/// The first version of this test asserted only that four runs composed the
/// *same* text, alternating which arm won the race. That claim is true, but it
/// is true by construction and no realistic change to the engine or the host
/// can falsify it: `collect_input` walks a node's incoming **edges**, which are
/// a static property of the compiled graph, so there is no path by which a
/// completion order could reach the fold at all. A test that cannot fail is not
/// coverage, however good its failure message reads.
///
/// So this asserts the stronger, falsifiable thing: `left`'s finding appears
/// **before** `right`'s exactly when the `left -> join` edge is declared first,
/// and after it when the edges are declared the other way round. Reversing the
/// order predecessors are rendered in — in the engine's `collect_input` or in
/// the host's `render_upstream_input` — turns one of the two halves red.
///
/// Three separate orderings are pulled apart by that, and only the edge order
/// survives:
///
/// | candidate ordering | ruled out by |
/// |---|---|
/// | completion order | the delays are swapped between rounds and the text does not move |
/// | node-id order (`left` < `right`) | the second graph declares `right -> join` first and gets `right` first |
/// | edge declaration order | — the one that holds |
///
/// # Why a unit test cannot make this claim
///
/// `caps::upstream`'s own order tests hand the fold its sources in a chosen
/// order and check the allocation is stable. They can never observe the *run*
/// choosing an order, because in a unit test there is no run and nothing races.
///
/// If this ever fails, note what it means before treating it as a test bug: the
/// same graph over the same inputs sends the model different text on different
/// days, so every downstream assertion — an author's and a test's alike —
/// becomes true-on-some-runs. That is precisely the coin-flip failure
/// `caps::upstream` exists to end, one layer up from where it was fixed.
#[tokio::test]
async fn a_joins_folded_turn_follows_the_graphs_edge_order_not_the_race() {
    for declared_first in [Arm::Left, Arm::Right] {
        let graph = diamond_graph(DiamondJoin::Agent, declared_first);
        let slow = Duration::from_millis(80);
        let mut texts: Vec<String> = Vec::new();

        // Four runs, alternating which arm wins the race, so an ordering that
        // followed the stopwatch would disagree with itself between rounds.
        for round in 0..4 {
            let left_first = round % 2 == 0;
            let (run, lane) = run_fan_out(
                &graph,
                vec![
                    (
                        "left_agent",
                        ArmBehaviour::ReplyAfter {
                            delay: if left_first { Duration::ZERO } else { slow },
                            reply: Arm::Left.finding(),
                        },
                    ),
                    (
                        "right_agent",
                        ArmBehaviour::ReplyAfter {
                            delay: if left_first { slow } else { Duration::ZERO },
                            reply: Arm::Right.finding(),
                        },
                    ),
                ],
                json!({ "request": "compare both arms" }),
            )
            .await;
            let run = run.expect("a clean diamond settles");
            assert_node_ran(&run, "join");
            assert_no_null_bindings_over(&run, &graph);

            let text = lane
                .turn_text("join_agent")
                .expect("the join node's turn must have been composed and sent");
            let first = text.find(declared_first.finding()).unwrap_or_else(|| panic!(
                "the fold dropped the `{declared_first:?}` arm entirely, so this run is not a \
                 fan-in at all: {text}"
            ));
            let second = text.find(declared_first.other().finding()).unwrap_or_else(|| panic!(
                "the fold dropped the `{:?}` arm entirely, so this run is not a fan-in at all: \
                 {text}",
                declared_first.other()
            ));
            assert!(
                first < second,
                "with `{declared_first:?} -> join` declared first, the join was sent the \
                 `{:?}` arm's finding ahead of it (round {round}, {} finished first). A join's \
                 turn must be composed in the order the graph declares its edges: an author who \
                 reorders the two paragraphs by editing the workflow gets nothing, and the same \
                 graph over the same data sends the model different text on different days.\n\
                 {text}",
                declared_first.other(),
                if left_first { "left" } else { "right" }
            );
            texts.push(text);
        }

        let first = &texts[0];
        for (round, text) in texts.iter().enumerate().skip(1) {
            assert_eq!(
                text, first,
                "with `{declared_first:?} -> join` declared first, run {round} composed the \
                 join's turn differently from run 0, and the only thing that differed between \
                 them is which arm finished first.\nrun 0: {first}\nrun {round}: {text}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 2. A merge whose predecessors disagree
// ---------------------------------------------------------------------------

/// Issue #1963. A `merge` with one failed and one succeeded predecessor still
/// runs, and carries the surviving arm's work forward.
///
/// The shape every "gather from N sources, then act" graph has, and the one
/// nothing covered: what a fan-in does when the sources disagree about whether
/// they worked. A merge that refused to run would throw the good arm's work
/// away over an unrelated failure; one that ran but carried nothing would be
/// worse still, since the run reads green.
///
/// Not a unit-testable question: whether the merge is reached at all is decided
/// by the engine's `on_error` handling of a *different* node, several
/// super-steps earlier.
#[tokio::test]
async fn a_merge_runs_and_keeps_the_good_arm_when_its_sibling_failed() {
    let graph = wf("merge_disagree")
        .display_name("Merge disagree")
        .trigger("start")
        .agent("good", "good_agent")
        .summary("Produce something usable.")
        .agent("bad", "bad_agent")
        .summary("Fail.")
        .on_error("continue")
        .merge("join")
        .output("done")
        .edge("start", "good")
        .edge("start", "bad")
        .edge("good", "join")
        .edge("bad", "join")
        .edge("join", "done")
        .build();

    let (run, _lane) = run_fan_out(
        &graph,
        vec![
            (
                "good_agent",
                ArmBehaviour::ReplyAfter {
                    delay: Duration::ZERO,
                    reply: "the usable finding",
                },
            ),
            ("bad_agent", ArmBehaviour::Fail),
        ],
        json!({ "request": "gather" }),
    )
    .await;
    let run = run.expect("`on_error = continue` on the failing arm settles the run");

    assert_node_status(&run, "bad", WorkflowNodeStatus::Error);
    assert_node_status(&run, "good", WorkflowNodeStatus::Ok);
    assert_node_ran(&run, "join");
    assert_node_ran(&run, "done");

    let merged = node_items(&run, "join");
    assert!(
        !merged.is_empty(),
        "the merge ran but emitted nothing, so the good arm's work was silently dropped at the \
         fan-in while the run still reads as having reached its output node: {}",
        run.output
    );
    assert!(
        merged.iter().any(|item| item
            .to_string()
            .contains("the usable finding")),
        "the merge must carry the surviving arm's work forward — a fan-in that drops it turns \
         one arm's failure into total data loss: {merged:?}"
    );
}

// ---------------------------------------------------------------------------
// 3. split_out over an empty array
// ---------------------------------------------------------------------------

/// The graph the two empty-fan-out tests below share:
/// `start -> fan(split_out) -> worker(agent) -> done`.
///
/// A real `agent` sits between the fan and the output deliberately. The first
/// version of this fixture ended at `done` and asserted that the output node
/// had been sent no turn — which an output node never is, in any graph, so the
/// assertion could not fail for any reason. `worker` is an agent the turn
/// double records, so "nobody downstream was given work" becomes a claim about
/// the run instead of a claim about the vocabulary.
fn empty_fan_out_graph() -> WorkflowFile {
    wf("split_empty")
        .display_name("Split empty")
        .trigger("start")
        .split_out("fan", "items")
        .agent("worker", "worker_agent")
        .summary("Work one split item.")
        .output("done")
        .edge("start", "fan")
        .edge("fan", "worker")
        .edge("worker", "done")
        .build()
}

/// Issue #1963. `split_out` over an empty list emits no items and invents none.
///
/// The degenerate case of the vocabulary's fan-out node, and the one a real
/// graph meets constantly — "split the search results" on the day the search
/// returned none. The failure worth guarding is not a crash: it is a
/// `split_out` that emits one item carrying the empty list, which a downstream
/// node then treats as a real result.
///
/// A unit test of the node would choose its own input. `split_out_tests.rs`'s
/// `empty_array_emits_no_items` hands the executor an array directly; this
/// drives the value from the trigger payload through the authored `=`-binding,
/// which is where a graph an operator saved actually gets its list from.
#[tokio::test]
async fn a_split_out_over_an_empty_list_emits_no_items_and_invents_none() {
    let graph = empty_fan_out_graph();
    let (run, _lane) = run_fan_out(&graph, Vec::new(), json!({ "items": [] })).await;
    let run = run.expect("splitting an empty list is not an error");

    assert_node_ran(&run, "fan");
    let items = node_items(&run, "fan");
    assert!(
        items.is_empty(),
        "`split_out` over an empty list emitted {} item(s). Any item here is a fan-out over \
         nothing that a downstream node will treat as real work: {items:?}",
        items.len()
    );
    assert_no_null_bindings_over(&run, &graph);
}

/// Issue #1963, and the defect it found: **the agent below an empty fan-out is
/// given a turn anyway**. Tracked as issue #1971; `#[ignore]`d until that is
/// decided, because fixing it is a change to run semantics and not this PR's to
/// make.
///
/// What happens today, verbatim from the run this test drives: `fan` emits zero
/// items, and `worker` is nevertheless activated and sent its authored summary
/// with no upstream section at all. The model answers, the answer becomes the
/// node's output, it travels to `done`, and the run settles green. So a
/// workflow whose search returned nothing still pays for a model call and
/// reports a result for it — and the result is whatever the model says when
/// asked to work on an empty desk.
///
/// It is engine-level behaviour rather than an accident here: tinyflows routes
/// on edges rather than on item counts, so a node that emitted nothing still
/// activates its successors with an empty input list. That is a defensible rule
/// for a `merge` or an `output`; for an `agent` it is a paid call with nothing
/// to work on. Which of the two the vocabulary wants is the decision #1971 asks
/// for.
///
/// No unit test could have found it. `split_out_tests.rs` already proves the
/// executor emits nothing, and that test passes; what nothing observed was what
/// the *run* does next.
#[tokio::test]
#[ignore = "issue #1971: an empty split_out still activates the agent below it"]
async fn a_split_out_over_an_empty_list_gives_the_node_below_it_no_work() {
    let graph = empty_fan_out_graph();
    let (run, lane) = run_fan_out(&graph, Vec::new(), json!({ "items": [] })).await;
    let run = run.expect("splitting an empty list is not an error");

    assert!(
        lane.turn_text("worker_agent").is_none(),
        "the agent below an empty fan-out was given a turn, so a workflow that found nothing \
         still paid a model to work on it and reported a green run for the result.\n\
         sent: {:?}\nrows: {:?}\noutput: {}",
        lane.turn_text("worker_agent"),
        run.nodes,
        run.output
    );
}

// ---------------------------------------------------------------------------
// 4. A diamond whose arms both park a gate
// ---------------------------------------------------------------------------

/// Issue #1963. When both arms of a diamond stop for a person, the run reports
/// **both** — and the join below them never runs.
///
/// The composition nothing covered. `blocked_node_test` proves a single blocked
/// node halts its branch; this asks what happens when two branches block in the
/// same super-step, which is where a `blocks.take()` that assumed one entry, or
/// a containment check that only inspected the first errored row, would show
/// up. Reporting one of two blockers is the worse failure: the operator
/// approves it, the run re-dispatches, and stops again on a blocker nobody
/// mentioned.
///
/// Unreachable from a unit test: which nodes are blocked is decided by
/// `only_blocked_nodes_errored` over rows two concurrent agent turns produced.
#[tokio::test]
async fn a_diamond_whose_arms_both_park_reports_both_and_never_reaches_its_join() {
    let graph = diamond_graph(DiamondJoin::Merge, Arm::Left);

    let (run, _lane) = run_fan_out(
        &graph,
        vec![
            ("left_agent", ArmBehaviour::Park),
            ("right_agent", ArmBehaviour::Park),
        ],
        json!({ "request": "ship both" }),
    )
    .await;
    let run = run.expect(
        "a run stopped because two nodes are waiting on an operator did not fail — it settles",
    );

    let blocked: Vec<&str> = run
        .blocked_nodes
        .iter()
        .map(|node| node.node_id.as_str())
        .collect();
    assert!(
        blocked.contains(&"left") && blocked.contains(&"right"),
        "both arms parked an approval and the run named {blocked:?}. An operator who is shown \
         one of two blockers approves it, watches the run stop again on a blocker nobody \
         mentioned, and has no way to tell how many more are coming."
    );
    assert_node_status(&run, "left", WorkflowNodeStatus::Blocked);
    assert_node_status(&run, "right", WorkflowNodeStatus::Blocked);
    assert_node_skipped(&run, "join");
    assert_node_skipped(&run, "done");
    assert_eq!(
        run.approvals.len(),
        2,
        "each parked arm files its own approval receipt; the run carries {:?}",
        run.approvals
    );
}
