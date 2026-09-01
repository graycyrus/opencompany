// Part 1 of `settle_arms_test`: the fixture every row of the table is driven
// over. Textually included by the parent, which owns the imports.

// ---------------------------------------------------------------------------
// The graph
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

// ---------------------------------------------------------------------------
// The turn double
// ---------------------------------------------------------------------------

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
    Wedge { entered: Arc<tokio::sync::Notify> },
}

/// The turn double for [`settle_arms_graph`].
///
/// `capped_agent` always truncates at the iteration cap — `Ok` with
/// `hit_iteration_cap: true`, the exact signal `reclassify_capped_nodes`
/// reconciles — so every exit has a capped node upstream to make a claim about.
/// If that ever stopped being true the four rows asserting `Reclassified` would
/// fail loudly rather than pass vacuously: their node would report `Ok` and the
/// assertion demands `Error`.
struct SettleArmsTurn {
    tail: TailBehaviour,
}

impl SettleArmsTurn {
    async fn execute(&self, agent_id: &str) -> Result<crate::harness::TurnOutcome> {
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
                // `notify_one`, never `notify_waiters`: it stores a permit when
                // nobody is waiting yet. `notify_waiters` drops the signal on
                // the floor if the driver has not polled its future, and the
                // driver would then wait for a run that is itself waiting for
                // the driver — a deadlock that shows up as a hung suite rather
                // than a failed test.
                entered.notify_one();
                release.notified().await;
                Ok(plain_turn("released"))
            }
            TailBehaviour::Wedge { entered } => {
                entered.notify_one();
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
