//! Starting a supervised workflow run, in one place (issue #395).
//!
//! Two things have to happen around every workflow run an entry point starts,
//! and neither is optional:
//!
//! 1. the run id is minted **through the [`RunSupervisor`]**, which registers
//!    its stop signal — that id is the address `POST …/workflows/runs/{id}/cancel`
//!    sends to, so a run started any other way is one an operator cannot stop;
//! 2. the outcome is journaled through
//!    [`record_run_finished`] on **both** arms, holding the
//!    [`RunGuard`](super::RunGuard) across the write, so a run that failed is
//!    recorded exactly as loudly as one that succeeded.
//!
//! That discipline lived inside the console run route's private
//! `spawn_workflow_run`. Issue #395 added a second entry point — resuming a
//! `requires_approval` node the operator signed off, which is a **new run** and
//! therefore owes the same two things — and a second copy of a rule this
//! specific is a rule that drifts. So it moves here, and every caller constructs
//! a [`WorkflowSpawn`] instead.
//!
//! # The cron scheduler too (issue #440)
//!
//! The cron [`WorkflowScheduler`](super::WorkflowScheduler) used to keep its own
//! spawn body, on the argument that its schedule *claim* and its per-delivery
//! log sweep would make this helper a union of two jobs. That argument was
//! wrong about where the seam is. The claim and the sweep are the scheduler's
//! and stay there — it takes the claim before starting, holds it across an
//! **awaited** [`spawn`](Self::spawn) handle, and folds the returned outcome
//! into its host-stdout summary. What it no longer keeps is a second copy of
//! the two rules above.
//!
//! The copies agreed at the time, and that is precisely what made them
//! dangerous: two identical implementations of a discipline mean a fix to
//! either one silently misses the other, with nothing failing to say so.
//!
//! Awaiting the handle is what makes that sharing work for a scheduled fire:
//! the outcome is journaled inside the task, so by the time the handle resolves
//! the record exists and the claim can be released.
//!
//! # Owned parts, not the runtime
//!
//! [`WorkflowSpawn`] holds four cloned handles rather than an
//! `Arc<CompanyRuntime>`. The spawned task genuinely needs nothing else, and
//! taking only what it needs is what lets the resume arm — which reaches this
//! from `perform_effect`, holding a bare `&CompanyRuntime` — start a run at all
//! without threading a self-referential `Arc` through the runtime.

use std::sync::Arc;

use serde_json::Value;
use tokio::task::JoinHandle;

use crate::Result;
use crate::company::WorkflowFile;
use crate::company::runtime::CompanyRuntime;
use crate::error::OpenCompanyError;
use crate::ports::types::CompanyId;
use crate::ports::{EventLog, WorkflowRun, WorkflowRunContext, WorkflowRunner};
use crate::runtime::workflow_outcome::record_run_finished;
use crate::runtime::{RunGuard, RunSupervisor};

/// The error stamped on a run whose **task** ended without recording its own
/// outcome (issue #1009).
///
/// Phrased as a host fact, like
/// [`INTERRUPTED_BY_RESTART`](crate::runtime::workflow_outcome::INTERRUPTED_BY_RESTART),
/// and deliberately distinct from it: "interrupted by a host restart" sends an
/// operator to the deployment, and this one did not happen at a restart. The
/// process is still up; one run's task unwound or was dropped, which is a
/// different thing to go looking at.
pub const RUN_TASK_LOST: &str = concat!(
    "this run's task ended without finishing — it panicked, or it was aborted — ",
    "so it never recorded its own outcome; the nodes recorded against it are the ",
    "ones that completed before it stopped"
);

/// Everything starting a supervised workflow run needs, and nothing else.
#[derive(Clone)]
pub struct WorkflowSpawn {
    company: CompanyId,
    events: Arc<dyn EventLog>,
    supervisor: RunSupervisor,
    runner: Arc<dyn WorkflowRunner>,
}

impl WorkflowSpawn {
    /// Reads the three shared handles off `runtime` and pairs them with the
    /// runner the caller already resolved.
    ///
    /// The runner is a parameter rather than read from
    /// [`CompanyRuntime::workflow_runner`] because the caller has to decide what
    /// its absence *means* — the console route distinguishes "this build has no
    /// workflow execution" from "this boot has none because inference was
    /// configured after start", and answers two different statuses. Swallowing
    /// that distinction into an `Option<Self>` here would push both callers back
    /// onto one unhelpful message.
    pub fn new(runtime: &CompanyRuntime, runner: Arc<dyn WorkflowRunner>) -> Self {
        Self {
            company: runtime.id().clone(),
            events: runtime.events().clone(),
            supervisor: runtime.run_supervisor().clone(),
            runner,
        }
    }

    /// Registers a run, spawns it, and returns its id alongside the task.
    ///
    /// `scheduled` says whether a cron started it, and rides both the run's
    /// `WorkflowRunStarted` and its `WorkflowRunFinished` — one parameter
    /// feeding both, so the pair can never disagree about what kind of run it
    /// was.
    ///
    /// The returned [`JoinHandle`] may be awaited (the console's synchronous
    /// mode, and the cron scheduler, which has to hold its overlap claim for
    /// the length of the run) or dropped (the console's detached mode, and the
    /// resume arm). Dropping it abandons the *waiting*, never the work: the
    /// run holds its guard, journals its outcome, and deregisters itself on
    /// every exit path including an unwind. Awaiting it therefore resolves only
    /// once the outcome is already durable — including the abnormal exits the
    /// watchdog in [`spawn_admitted`](Self::spawn_admitted) covers.
    ///
    /// `dry_run` (issue #542) makes this a **test run**: the flag is stamped
    /// onto the run's [`WorkflowRunContext`] (the supervisor still registers it,
    /// so a dry run stays cancellable and free), and the outcome journal write
    /// below is skipped on **both** arms — a test run leaves nothing durable, so
    /// [`record_run_finished`] must not write a `WorkflowRunFinished` for it any
    /// more than the runner writes a `WorkflowRunStarted`. Every entry point but
    /// the run route passes `false`; a scheduled or resumed run is always real.
    ///
    /// # Fallible before it spawns (issue #401)
    ///
    /// [`begin`](RunSupervisor::begin) admits the run against the company's
    /// concurrency ceiling *before* any task exists, so a company at its cap
    /// gets an `Err(WorkflowRunLimit)` here and **nothing is started** — no
    /// task, no `WorkflowRunStarted`, no run id. A dry run counts too: it drives
    /// the real engine and spends real inference, so it is registered like any
    /// other run and the flag is only stamped afterwards.
    pub fn spawn(
        self,
        workflow: WorkflowFile,
        input: Value,
        scheduled: bool,
        dry_run: bool,
    ) -> Result<(String, JoinHandle<Result<WorkflowRun>>)> {
        // Issue #371 mints the id above the runner so the error arm can still
        // correlate; issue #383 mints it HERE, through the supervisor, so the
        // same id is also an address an operator can send "stop" to.
        // Deliberately not a second identifier — the run id the console already
        // correlates SSE frames on IS the cancellation handle.
        //
        // Issue #401: `begin` is the concurrency choke point and is fallible —
        // over the cap it refuses here, before the `tokio::spawn` in
        // `spawn_admitted`, so a rejected run leaves nothing behind to journal
        // or reap.
        let (ctx, guard) = self.supervisor.begin(&workflow.id, scheduled)?;
        Ok(self.spawn_admitted(ctx, guard, workflow, input, dry_run))
    }

    /// Spawns a run whose slot the caller has **already** admitted through
    /// [`RunSupervisor::begin`], threading in the resulting `(ctx, guard)`.
    ///
    /// [`spawn`](Self::spawn) is `begin` + this. The split exists for the cron
    /// [`WorkflowScheduler`](super::WorkflowScheduler) (issue #661): it must
    /// order admission *before* its durable minute-claim, so that a company at
    /// its in-flight cap never claims (and durably burns) a minute it cannot
    /// run. It therefore calls `begin` itself, on the tick thread, holds the
    /// guard across `claim_fire`, and only then hands the admitted `(ctx, guard)`
    /// here to start the run — with the guard already counting against the cap,
    /// so a same-tick sibling schedule sees an exact count rather than a stale
    /// one. Every other caller uses [`spawn`](Self::spawn) and never sees the
    /// guard.
    ///
    /// Infallible: the fallible step is `begin`, which the caller has already
    /// passed. `scheduled` for the journal is read off the admitted `ctx`, so it
    /// cannot disagree with what `begin` registered.
    ///
    /// `dry_run` (issue #542) is stamped on the admitted context here rather than
    /// at `begin`, so the supervisor is untouched — a dry run registers and
    /// cancels exactly like a real one.
    ///
    /// # The watchdog (issue #1009)
    ///
    /// Two tasks, not one. The inner task runs the graph and journals its own
    /// outcome exactly as before; the returned handle belongs to an **outer
    /// watchdog** that awaits it and covers the one exit the inner task cannot
    /// cover for itself — the one where it never gets to run its own code.
    ///
    /// A panicking run task unwinds past its `record_run_finished`, so it
    /// journals nothing; an aborted one is dropped at its next await point, so
    /// it journals nothing either. Either way the run's
    /// `WorkflowRunStarted` stands alone in the journal forever, which
    /// `GET …/workflows/runs` folds as `running: true` until the *next process*
    /// sweeps it — a hang that outlives the run by however long the host stays
    /// up. `run_supervisor`'s module docs called this out as a known gap; the
    /// watchdog is what closes it, by journaling [`RUN_TASK_LOST`] for a run
    /// whose task did not come back.
    ///
    /// The [`RunGuard`] moves into the **watchdog**, not the run task. It has to:
    /// the supervisor entry is what proves the run is still alive to the read
    /// side's liveness cross-check, and dropping it while the finish is still
    /// unwritten would open a window in which the run reads dead and its finish
    /// has not landed — two writers racing to settle one run. Held out here, the
    /// entry disappears only after *whichever* of the two paths journaled.
    ///
    /// A panic is **re-raised** rather than absorbed, so every existing
    /// `Err(JoinError)` arm (the console's synchronous run route, the cron
    /// scheduler) fires exactly as it did before — the watchdog adds a durable
    /// record, it does not change what a caller sees.
    pub(crate) fn spawn_admitted(
        self,
        mut ctx: WorkflowRunContext,
        guard: RunGuard,
        workflow: WorkflowFile,
        input: Value,
        dry_run: bool,
    ) -> (String, JoinHandle<Result<WorkflowRun>>) {
        let scheduled = ctx.scheduled;
        ctx.dry_run = dry_run;
        let run_id = ctx.run_id.clone();
        // The watchdog's own copies of what journaling a finish needs. Taken
        // before `self` and `workflow` move into the run task below, and
        // deliberately no more than these: the watchdog never runs a graph, so
        // it has no use for the runner.
        let events = self.events.clone();
        let company = self.company.clone();
        let workflow_id = workflow.id.clone();
        let watched_run_id = run_id.clone();
        let run = tokio::spawn(async move {
            let result = self.runner.run(&self.company, &workflow, input, &ctx).await;
            // Issue #542: a dry run journals NOTHING. The runner already skipped
            // the started + per-node rows; skipping the finish here keeps the
            // pair honest, so a test run leaves no `WorkflowRunFinished` for the
            // history to fold and no boot sweep to adopt. The settled result is
            // the whole record, and it still flows back to the awaiting caller.
            if !dry_run {
                // Issue #228: journaled on BOTH arms. The caller may well have
                // closed the tab; the record is what is still there tomorrow.
                let outcome = match result.as_ref() {
                    Ok(run) => Ok(run),
                    Err(err) => Err(err.to_string()),
                };
                match outcome {
                    Ok(run) => {
                        record_run_finished(
                            &self.events,
                            &self.company,
                            &workflow.id,
                            scheduled,
                            &ctx.run_id,
                            Ok(run),
                        )
                        .await;
                    }
                    Err(err) => {
                        record_run_finished(
                            &self.events,
                            &self.company,
                            &workflow.id,
                            scheduled,
                            &ctx.run_id,
                            Err(err.as_str()),
                        )
                        .await;
                    }
                }
            }
            result
        });

        // Issue #1009: the watchdog. It owns the run task's handle, so nothing
        // else can be waiting on it, and it is the only thing that can tell the
        // difference between "the run returned" and "the run's task went away".
        let handle = tokio::spawn(async move {
            // Held here rather than inside the run task, and across the journal
            // write below: the supervisor entry is the read side's proof that
            // this run is still alive, so it must not vanish while the run's
            // finish is still unwritten. The window in which a cancel is
            // accepted still matches the window in which it can do anything —
            // it now simply extends past the abnormal exits too.
            let _guard = guard;
            match run.await {
                // The run task ran its own code to completion, which means it
                // already journaled its own outcome (or deliberately did not,
                // for a dry run). Nothing owed.
                Ok(result) => result,
                Err(join) => {
                    // Issue #542 again: a dry run journals NOTHING, and that
                    // holds when it blows up too. There is no started row for a
                    // finish to pair with.
                    if !dry_run {
                        record_run_finished(
                            &events,
                            &company,
                            &workflow_id,
                            scheduled,
                            &watched_run_id,
                            Err(RUN_TASK_LOST),
                        )
                        .await;
                    }
                    if join.is_panic() {
                        // Re-raised, not absorbed: the callers that await this
                        // handle already have an `Err(JoinError)` arm and it is
                        // the right one — the run's outcome is unknown, not
                        // failed. The only thing that changed is that the
                        // journal now says so as well.
                        std::panic::resume_unwind(join.into_panic());
                    }
                    // Cancelled rather than panicked. Nothing in this crate
                    // aborts a run task — only the watchdog holds the handle —
                    // so this is the runtime shutting the task down. Reported
                    // as the same "outcome unknown" the run route's own
                    // `JoinError` arm reports, so the two agree.
                    Err(OpenCompanyError::BackgroundTask(format!(
                        "the workflow run task for {watched_run_id} was cancelled before it finished"
                    )))
                }
            }
        });
        (run_id, handle)
    }
}
