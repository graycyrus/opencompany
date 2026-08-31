//! Issue #1963: what `retry` actually **does** at run time.
//!
//! # The gap
//!
//! Retry is the most commonly authored resilience knob in the vocabulary, and
//! until this file its only runtime assertion was a substring match:
//! `t2_unknown_slug_retries_then_continues_with_error_item` in `runner.rs`
//! checks that a run whose node carries `retry.max_attempts = 2` ends up with
//! `bogus_tool` somewhere in its output text. That sentence is true of a run
//! that attempted the node **once**. Nothing anywhere asserted an attempt
//! count.
//!
//! One layer down, `translate::retry_config` builds the engine's config object
//! and `error_retry_approval_land_as_engine_config_keys` proves the three keys
//! land on the compiled node with the right values. So the authoring contract
//! is pinned and the wire format is pinned, and between them sits the only
//! thing an author cares about — how many times the work is attempted, and how
//! long the engine waits in between — with no test at all.
//!
//! # Why a unit test cannot make these claims
//!
//! The retry loop lives in the **engine**
//! (`tinyflows::engine::build::activation`), not in this crate. Nothing in
//! OpenCompany counts attempts, so there is no host-side function to unit-test:
//! the attempt count is observable only by counting how many times the host's
//! own capability is re-entered during a real run. That is what the counting
//! double below does.
//!
//! # Why these tests use a real clock, and not `start_paused`
//!
//! `#[tokio::test(start_paused = true)]` would be the obvious way to assert a
//! backoff without sleeping, and it does not work here. The engine is
//! deliberately runtime-agnostic and waits on **`futures-timer`**
//! (`vendor/openhuman/vendor/tinyflows/Cargo.toml`, `futures-timer = "3"`;
//! `engine/build/backoff.rs::wait_slice` and the retry backoff in
//! `engine/build/activation.rs` both use `futures_timer::Delay`). A
//! `futures_timer::Delay` is armed against a global timer thread and wall-clock
//! time; tokio's paused clock does not govern it, so pausing time makes these
//! waits neither shorter nor deterministic. Worse, on a run that *does* arm a
//! tokio timer — the runner's `CANCEL_HARD_ABORT_GRACE` and
//! `PROGRESS_DRAIN_TIMEOUT` are `tokio::time::timeout`s — auto-advance would
//! fire those timeouts against a run that had not actually stalled.
//!
//! So the backoff assertions below are **lower bounds** wherever possible: a
//! loaded machine sleeps longer than asked, never shorter, so a lower bound
//! cannot go flaky under load. Exactly one upper bound exists — the
//! distinguishing half of
//! [`an_exponential_backoff_doubles_where_a_fixed_one_repeats`] — and it says so
//! in its own failure message.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::Result;
use crate::company::WorkflowFile;
use crate::error::OpenCompanyError;
use crate::ports::WorkflowRunContext;
use crate::ports::types::{CompanyId, WorkflowNodeStatus};

use super::runner::run_workflow_lane_aware;
use super::testkit::{assert_node_ran, assert_node_status, wf};

/// The base delay every backoff test configures. Large enough that the engine's
/// 25 ms backoff slicing and a turn's own overhead cannot be mistaken for it,
/// small enough that the whole file stays under two seconds of waiting.
const BASE_BACKOFF_MS: u64 = 250;

/// How much of the configured delay a gap must have spent before it counts as
/// having waited. Below 1.0 only to absorb timer granularity — the engine
/// chops a backoff into 25 ms slices, and the last one can round down.
const HONOURED: f64 = 0.9;

// ---------------------------------------------------------------------------
// The counting capability
// ---------------------------------------------------------------------------

/// Records when each attempt of the flaky node entered, and decides whether it
/// fails.
///
/// The `RecordingLane` pattern from `runner.rs` — a `RunTurn` that counts what
/// it was asked — plus the entry timestamp each attempt arrived at, which is
/// what turns "it retried" into "it waited this long before retrying".
struct CountingLane {
    /// One entry per attempt, in order.
    attempts: Mutex<Vec<Instant>>,
    /// Attempts strictly before this index return an error; from it on the turn
    /// succeeds. `usize::MAX` means the node never succeeds.
    succeed_from: usize,
}

impl CountingLane {
    fn new(succeed_from: usize) -> Arc<Self> {
        Arc::new(Self {
            attempts: Mutex::new(Vec::new()),
            succeed_from,
        })
    }

    /// Never succeeds, so every configured attempt is spent.
    fn always_failing() -> Arc<Self> {
        Self::new(usize::MAX)
    }

    fn count(&self) -> usize {
        self.attempts.lock().expect("attempt log").len()
    }

    /// The wall-clock gaps between consecutive attempts, in milliseconds.
    ///
    /// One shorter than the attempt count: the gap is what the engine waited
    /// *between* two attempts, which is what `backoff_ms` configures.
    fn gaps_ms(&self) -> Vec<u128> {
        let attempts = self.attempts.lock().expect("attempt log");
        attempts
            .windows(2)
            .map(|pair| pair[1].duration_since(pair[0]).as_millis())
            .collect()
    }
}

#[async_trait]
impl crate::runtime::delegation::RunTurn for CountingLane {
    async fn run(
        &self,
        _company: &CompanyId,
        _agent_id: &str,
        _message: &str,
        _chat_id: crate::runtime::delegation::ChatTarget<'_>,
    ) -> Result<crate::harness::TurnOutcome> {
        let index = {
            let mut attempts = self.attempts.lock().expect("attempt log");
            attempts.push(Instant::now());
            attempts.len() - 1
        };
        if index < self.succeed_from {
            // Deliberately unclassifiable as a blocker: `park_node_blocker`
            // only parks a message `classify_blocker_message` recognises, and a
            // parked blocker would turn this failure into a held-open node
            // rather than the retryable error the engine is supposed to see.
            return Err(OpenCompanyError::Harness(format!(
                "synthetic transient failure on attempt {}",
                index + 1
            )));
        }
        Ok(crate::harness::TurnOutcome {
            reply: format!("succeeded on attempt {}", index + 1),
            steps: Vec::new(),
            hit_iteration_cap: false,
            abnormal_stop: None,
            halted_for_spend: None,
            budget_paused: None,
        })
    }

    async fn run_steered(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        _control: &crate::company::steer::SteerControl,
        chat_id: crate::runtime::delegation::ChatTarget<'_>,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.run(company, agent_id, message, chat_id).await
    }

    async fn run_steered_background(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        _control: &crate::company::steer::SteerControl,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<crate::harness::TurnOutcome> {
        self.run(
            company,
            agent_id,
            message,
            crate::runtime::delegation::ChatTarget::default(),
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/// How a graph's flaky node is configured to retry.
struct RetryPolicy {
    max_attempts: Option<u32>,
    backoff: Option<(u64, &'static str)>,
}

impl RetryPolicy {
    fn attempts(max_attempts: u32) -> Self {
        Self {
            max_attempts: Some(max_attempts),
            backoff: None,
        }
    }

    /// No `[node.retry]` table at all — the authored default, which the engine
    /// reads as one attempt.
    fn unset() -> Self {
        Self {
            max_attempts: None,
            backoff: None,
        }
    }

    fn with_backoff(mut self, backoff_ms: u64, curve: &'static str) -> Self {
        self.backoff = Some((backoff_ms, curve));
        self
    }
}

/// `start -> flaky(agent) -> done`, built through the testkit so the retry
/// config under test is rendered to TOML and read back by the production
/// parser — the same path an operator's saved graph takes.
///
/// `on_error = "continue"` throughout, so the run settles rather than failing:
/// these tests are about how many times the work was attempted, and a run that
/// returned `Err` would make every assertion about the settled body harder to
/// read without changing what is being measured.
fn flaky_graph(policy: &RetryPolicy) -> WorkflowFile {
    let mut builder = wf("retrying")
        .display_name("Retrying")
        .trigger("start")
        .agent("flaky", "flaky_agent")
        .summary("Fail until the attempts run out.")
        .on_error("continue");
    if let Some(max_attempts) = policy.max_attempts {
        builder = builder.retry(max_attempts);
    }
    if let Some((backoff_ms, curve)) = policy.backoff {
        builder = builder.retry_backoff(backoff_ms, curve);
    }
    builder
        .output("done")
        .edge("start", "flaky")
        .edge("flaky", "done")
        .build()
}

/// Runs the flaky graph against `lane` and returns the settled run.
async fn run_flaky(policy: RetryPolicy, lane: Arc<CountingLane>) -> crate::ports::WorkflowRun {
    let dir = tempfile::tempdir().expect("tempdir");
    let (deps, _journal) =
        super::gated_tool_turn_test::deps("http://127.0.0.1:1/unused".to_string(), dir.path());
    run_workflow_lane_aware(
        lane,
        deps,
        &super::gated_tool_turn_test::record(),
        &flaky_graph(&policy),
        serde_json::json!({ "request": "go" }),
        &WorkflowRunContext::new(false),
    )
    .await
    .expect("`on_error = continue` settles the run rather than failing it")
}

// ---------------------------------------------------------------------------
// Attempt counts
// ---------------------------------------------------------------------------

/// Issue #1963. A node configured `retry.max_attempts = 3` whose work never
/// succeeds is attempted exactly three times — not two, and not four.
///
/// A unit test could not have caught a miscount: the loop that spends the
/// attempts is in the vendored engine, and the only thing on this side of the
/// seam that can see it is the host capability being re-entered. The pre-#1963
/// runtime assertion (`t2_unknown_slug_retries_then_continues_with_error_item`)
/// is a substring match on the run's output text and is satisfied by a run that
/// attempted the node once.
#[tokio::test]
async fn a_node_with_three_attempts_configured_is_attempted_exactly_three_times() {
    let lane = CountingLane::always_failing();
    let run = run_flaky(RetryPolicy::attempts(3), lane.clone()).await;

    assert_eq!(
        lane.count(),
        3,
        "the node's work was attempted {} times against `retry.max_attempts = 3`. An author sets \
         this expecting exactly that many tries at a flaky dependency; anything else is either \
         work silently skipped or an outside call made more times than sanctioned.",
        lane.count()
    );
    assert_node_status(&run, "flaky", WorkflowNodeStatus::Error);
    assert_node_ran(&run, "done");
}

/// Issue #1963. `max_attempts = 1` means the node is run **once** — the retry
/// machinery must not add a try of its own.
///
/// The boundary matters more than the interior: a fencepost in the engine's
/// `0..max_attempts` loop that spent `max_attempts + 1` tries would double every
/// unretried node's outward calls in the whole product, and nothing in this
/// repo would have noticed.
#[tokio::test]
async fn a_node_with_one_attempt_configured_is_never_retried() {
    let lane = CountingLane::always_failing();
    run_flaky(RetryPolicy::attempts(1), lane.clone()).await;

    assert_eq!(
        lane.count(),
        1,
        "`retry.max_attempts = 1` means try once. The node's work ran {} times, so a node an \
         author explicitly declined to retry is being retried anyway.",
        lane.count()
    );
}

/// Issue #1963. A node with no `[node.retry]` table at all is attempted once —
/// the engine's default, which is what the overwhelming majority of authored
/// nodes rely on without ever writing it down.
#[tokio::test]
async fn a_node_with_no_retry_policy_is_attempted_once() {
    let lane = CountingLane::always_failing();
    run_flaky(RetryPolicy::unset(), lane.clone()).await;

    assert_eq!(
        lane.count(),
        1,
        "a node with no retry policy was attempted {} times. Every graph in every bundle that \
         does not mention retry depends on this default.",
        lane.count()
    );
}

/// Issue #1963. Retry stops at the first success: a node that works on its
/// second attempt out of three is not attempted a third time, and settles `Ok`.
///
/// The claim a count alone cannot make — that the retry loop is `break`-on-`Ok`
/// rather than "run them all and keep the last" — which is the difference
/// between one outward call and three.
#[tokio::test]
async fn a_node_that_succeeds_on_its_second_attempt_is_not_attempted_a_third_time() {
    let lane = CountingLane::new(1);
    let run = run_flaky(RetryPolicy::attempts(3), lane.clone()).await;

    assert_eq!(
        lane.count(),
        2,
        "the node succeeded on attempt 2 of a possible 3 and was attempted {} times. A retry \
         loop that keeps going after a success repeats every side effect the successful attempt \
         already had.",
        lane.count()
    );
    assert_node_status(&run, "flaky", WorkflowNodeStatus::Ok);
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/// Issue #1963. `backoff_ms` is honoured: the engine waits at least the
/// configured delay between attempts.
///
/// Nothing asserted this at any layer. `translate` proves the key reaches the
/// compiled node's config, which is a statement about a JSON object — an engine
/// that read the key and then never slept would satisfy it exactly.
///
/// Lower bound only, deliberately: a loaded machine sleeps longer than asked
/// and never shorter, so this cannot go flaky under load. See the module docs
/// for why tokio's paused clock is not usable here.
#[tokio::test]
async fn a_fixed_backoff_waits_at_least_its_configured_delay_between_attempts() {
    let lane = CountingLane::always_failing();
    run_flaky(
        RetryPolicy::attempts(3).with_backoff(BASE_BACKOFF_MS, "fixed"),
        lane.clone(),
    )
    .await;

    let gaps = lane.gaps_ms();
    assert_eq!(
        gaps.len(),
        2,
        "three attempts leave two gaps to measure; got {gaps:?}"
    );
    let floor = (BASE_BACKOFF_MS as f64 * HONOURED) as u128;
    for (index, gap) in gaps.iter().enumerate() {
        assert!(
            *gap >= floor,
            "the wait before attempt {} was {gap}ms against a configured backoff_ms of \
             {BASE_BACKOFF_MS}. An author sets a backoff to stop hammering a dependency that is \
             already struggling; a retry that does not wait is three requests in a burst.",
            index + 2
        );
    }
}

/// Issue #1963. `backoff = "exponential"` grows the wait, where the default
/// `"fixed"` repeats it — the difference an author is choosing between, and the
/// one nothing distinguished.
///
/// Both halves are needed. Asserting only that the exponential curve's second
/// gap is long would pass on an engine that ignored the `backoff` key entirely
/// and doubled every backoff; asserting only that the fixed curve's is short
/// would pass on one that ignored the key and never grew anything.
///
/// **This test carries the file's only upper bound**, on the fixed curve's
/// second gap. A machine so loaded that a 250 ms sleep takes over 450 ms will
/// report it as a failure; that is the price of a distinguishing claim, and the
/// alternative — two lower bounds — distinguishes nothing.
#[tokio::test]
async fn an_exponential_backoff_doubles_where_a_fixed_one_repeats() {
    let exponential = CountingLane::always_failing();
    run_flaky(
        RetryPolicy::attempts(3).with_backoff(BASE_BACKOFF_MS, "exponential"),
        exponential.clone(),
    )
    .await;
    let exponential_gaps = exponential.gaps_ms();

    let fixed = CountingLane::always_failing();
    run_flaky(
        RetryPolicy::attempts(3).with_backoff(BASE_BACKOFF_MS, "fixed"),
        fixed.clone(),
    )
    .await;
    let fixed_gaps = fixed.gaps_ms();

    assert_eq!(exponential_gaps.len(), 2, "{exponential_gaps:?}");
    assert_eq!(fixed_gaps.len(), 2, "{fixed_gaps:?}");

    let one_delay = (BASE_BACKOFF_MS as f64 * HONOURED) as u128;
    let two_delays = (BASE_BACKOFF_MS as f64 * 2.0 * HONOURED) as u128;

    assert!(
        exponential_gaps[0] >= one_delay,
        "an exponential curve's FIRST wait is the base delay, and it was {}ms against \
         {BASE_BACKOFF_MS}ms: {exponential_gaps:?}",
        exponential_gaps[0]
    );
    assert!(
        exponential_gaps[1] >= two_delays,
        "an exponential curve's second wait must be twice the base ({}ms), and it was {}ms. The \
         `backoff = \"exponential\"` key reaches the engine's config — \
         `error_retry_approval_land_as_engine_config_keys` proves that — so this failing means \
         the engine is reading it and not growing the delay: {exponential_gaps:?}",
        two_delays,
        exponential_gaps[1]
    );
    assert!(
        fixed_gaps[1] < two_delays,
        "a FIXED curve's second wait was {}ms, at or past the {}ms an exponential curve would \
         have waited — so the two curves are indistinguishable and choosing between them is \
         meaningless. (This is the suite's only upper bound; on a machine loaded enough to \
         stretch a {BASE_BACKOFF_MS}ms sleep this far it is measuring the machine.) \
         exponential: {exponential_gaps:?}, fixed: {fixed_gaps:?}",
        fixed_gaps[1],
        two_delays
    );
}

/// Issue #1963. With no `backoff_ms` the retries are immediate — the engine
/// must not invent a default wait.
///
/// The complement of the two tests above, and the one that keeps them honest:
/// without it, an engine that slept a fixed 250 ms between every retry
/// regardless of config would pass
/// [`a_fixed_backoff_waits_at_least_its_configured_delay_between_attempts`]
/// exactly.
#[tokio::test]
async fn a_node_with_no_backoff_configured_retries_without_waiting() {
    let lane = CountingLane::always_failing();
    run_flaky(RetryPolicy::attempts(3), lane.clone()).await;

    let gaps = lane.gaps_ms();
    assert_eq!(gaps.len(), 2, "{gaps:?}");
    let ceiling = Duration::from_millis(BASE_BACKOFF_MS).as_millis();
    for (index, gap) in gaps.iter().enumerate() {
        assert!(
            *gap < ceiling,
            "the wait before attempt {} was {gap}ms with no backoff configured. An unconfigured \
             retry must not stall the run: this bound is {ceiling}ms, far above the microseconds \
             a re-entered stub costs and far below any plausible invented default.",
            index + 2
        );
    }
}
