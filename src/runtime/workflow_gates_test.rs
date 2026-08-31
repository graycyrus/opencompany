//! What [`WorkflowGateQueue`](super::WorkflowGateQueue) is holding, and for whom
//! (issue #978).
//!
//! # Why these are not covered by the run-level suites
//!
//! Every suite that exercises a parked workflow gate observes the *outcome* of
//! a release: a continuation ran, or it did not. This queue's job is one level
//! below that — which gate node each parked approval is deciding, and whether a
//! run is still waiting on anybody. Get it wrong and the continuation still
//! runs; it just runs into a node the operator already refused, parks a fresh
//! card, and the run that was supposed to settle multiplies instead. That is
//! the 3 → 6 → 12 → 24 amplification the module docs describe, and from outside
//! it looks like an ordinary approval round until the extra cards appear.
//!
//! The module had **no tests at all** before this. So the properties it exists
//! for — one batch per run, a denial recorded at park time so the continuation
//! neither re-runs nor re-asks, and a release that can only be taken once — are
//! written down here rather than inferred from behaviour further out.

use serde_json::json;

use super::WorkflowGateQueue;
use crate::ports::types::{ApprovalId, Effect, EffectGroup, Verdict};
use crate::runtime::workflow_resume::{WORKFLOW_APPROVE_KIND, gate_effect};

const TURN: &str = "acme:wf:run-1";

/// A parked gate card for `node`, exactly as `park_pending_gates` mints one.
fn gate(node: &str) -> Effect {
    gate_effect(
        "pipeline",
        node,
        &json!({ "request": "the quarterly spec" }),
        "run-1",
        &[],
        &[],
        None,
    )
}

fn id(raw: &str) -> ApprovalId {
    ApprovalId::new(raw)
}

/// A run's gates are counted as one batch, and the run is "armed" from the
/// first one.
///
/// `is_armed` is what the approve path forks on: a gate whose run is armed
/// defers to the batch release, and one that is not re-dispatches on the spot.
/// A queue that failed to arm would therefore take the pre-#978 path and
/// re-dispatch the whole run per approval — the amplification itself.
#[test]
fn a_runs_gates_are_counted_as_one_batch_and_arm_it() {
    let queue = WorkflowGateQueue::default();
    assert!(
        !queue.is_armed(TURN),
        "nothing is armed before a gate parks"
    );
    assert_eq!(queue.undecided(TURN), 0);

    queue.arm(TURN, &id("a1"), &gate("draft"));
    queue.arm(TURN, &id("a2"), &gate("publish"));

    assert!(queue.is_armed(TURN));
    assert_eq!(
        queue.undecided(TURN),
        2,
        "both gates are outstanding, so the run must not be released after the first verdict"
    );
}

/// An effect that is not a workflow gate never enters a batch.
///
/// The kind check is the only thing keeping an ordinary approval card — a
/// teammate's blocked tool call, a payment — out of a structure whose whole
/// contract is "these are the nodes of one run". A batch that admitted one
/// would release a continuation for a run that was never paused.
#[test]
fn an_effect_that_is_not_a_workflow_gate_is_never_armed() {
    let queue = WorkflowGateQueue::default();
    let not_a_gate = Effect {
        kind: "payment.send".to_string(),
        group: EffectGroup::Other,
        amount_usd: None,
        established_thread: false,
        first_time_counterparty: false,
        payload: json!({ "node_id": "draft" }),
        agent: None,
        run_id: None,
    };

    queue.arm(TURN, &id("a1"), &not_a_gate);

    assert!(
        !queue.is_armed(TURN),
        "a non-gate effect carrying a `node_id` must not be mistaken for a gate"
    );
}

/// A gate card whose payload names no node is not a batch member either.
///
/// `gate_node_id` filters an empty node id, and it has to: the node id is what a
/// continuation replays into, so a batch entry with a blank one would release a
/// run that then advances into nothing.
#[test]
fn a_gate_card_naming_no_node_is_not_armed() {
    let queue = WorkflowGateQueue::default();
    let blank = Effect {
        kind: WORKFLOW_APPROVE_KIND.to_string(),
        group: EffectGroup::Other,
        amount_usd: None,
        established_thread: false,
        first_time_counterparty: false,
        payload: json!({ "node_id": "   ", "workflow_id": "pipeline" }),
        agent: None,
        run_id: None,
    };

    queue.arm(TURN, &id("a1"), &blank);

    assert!(!queue.is_armed(TURN));
}

/// Approving and refusing land in separate ledgers, in decision order, and the
/// batch is released only once every gate has a verdict.
///
/// The denial half is the reason this queue banks verdicts at all rather than
/// reading them back off the continuation queue: a refusal never reaches the
/// approve path, so a continuation that could not see it would replay into the
/// refused node and park a fresh card — an approval round that cleared two
/// gates and created one.
#[test]
fn approve_and_deny_are_banked_separately_so_a_refusal_is_never_replayed_into() {
    let queue = WorkflowGateQueue::default();
    queue.arm(TURN, &id("a1"), &gate("draft"));
    queue.arm(TURN, &id("a2"), &gate("publish"));
    queue.arm(TURN, &id("a3"), &gate("announce"));

    queue.decide(TURN, &id("a2"), Verdict::Deny);
    assert_eq!(queue.undecided(TURN), 2, "two gates still await a person");
    queue.decide(TURN, &id("a1"), Verdict::Approve);
    queue.decide(TURN, &id("a3"), Verdict::Approve);
    assert_eq!(queue.undecided(TURN), 0);

    let released = queue.release(TURN).expect("the batch releases");
    assert_eq!(
        released.approved,
        vec!["draft".to_string(), "announce".to_string()],
        "approvals are carried in decision order, not park order"
    );
    assert_eq!(
        released.denied,
        vec!["publish".to_string()],
        "a refused node must ride the release, or the continuation re-asks about it"
    );
}

/// One node gated by two cards appears in a ledger once.
///
/// A continuation reads these ledgers as "run these, skip those". A duplicate
/// is not merely untidy — it is the same node named twice to a replay that has
/// no reason to expect it.
#[test]
fn a_node_decided_twice_is_recorded_once() {
    let queue = WorkflowGateQueue::default();
    queue.arm(TURN, &id("a1"), &gate("publish"));
    queue.arm(TURN, &id("a2"), &gate("publish"));

    queue.decide(TURN, &id("a1"), Verdict::Approve);
    queue.decide(TURN, &id("a2"), Verdict::Approve);

    let released = queue.release(TURN).expect("the batch releases");
    assert_eq!(released.approved, vec!["publish".to_string()]);
}

/// A verdict on a turn this queue is not tracking, or on an id it never armed,
/// changes nothing.
///
/// Every approval in the host flows through the same `decide` call, and most of
/// them have nothing to do with a workflow run. This must therefore be a
/// no-op rather than an error or an entry: the caller is deciding something
/// else entirely.
#[test]
fn a_verdict_on_something_this_queue_never_armed_is_a_no_op() {
    let queue = WorkflowGateQueue::default();
    queue.arm(TURN, &id("a1"), &gate("draft"));

    queue.decide("some:other:turn", &id("a1"), Verdict::Approve);
    queue.decide(TURN, &id("never-armed"), Verdict::Deny);
    // And a second verdict on an id already banked.
    queue.decide(TURN, &id("a1"), Verdict::Approve);
    queue.decide(TURN, &id("a1"), Verdict::Deny);

    let released = queue.release(TURN).expect("the batch releases");
    assert_eq!(released.approved, vec!["draft".to_string()]);
    assert!(
        released.denied.is_empty(),
        "a repeat verdict must not re-file an already-decided node under the other outcome"
    );
}

/// A release takes the batch and drops it, so a second one finds nothing.
///
/// The module states this as an invariant enforced by the continuation queue's
/// counting under one lock — "this cannot be entered twice for one run". The
/// consequence of it not holding is a second continuation for a run that has
/// already resumed, which is the amplification again.
#[test]
fn a_batch_can_only_be_released_once() {
    let queue = WorkflowGateQueue::default();
    queue.arm(TURN, &id("a1"), &gate("draft"));
    queue.decide(TURN, &id("a1"), Verdict::Approve);

    assert!(queue.release(TURN).is_some());
    assert!(
        queue.release(TURN).is_none(),
        "the batch is gone after the release that consumed it"
    );
    assert!(!queue.is_armed(TURN));
    assert_eq!(queue.undecided(TURN), 0);
}

/// Two runs parked at the same time stay apart.
///
/// The queue is keyed by turn precisely so that a busy company approving one
/// run's gate does not release another's. Nothing else in the release path
/// re-checks this.
#[test]
fn two_runs_parked_at_once_do_not_release_each_other() {
    let queue = WorkflowGateQueue::default();
    let other = "acme:wf:run-2";
    queue.arm(TURN, &id("a1"), &gate("draft"));
    queue.arm(other, &id("b1"), &gate("draft"));

    queue.decide(TURN, &id("a1"), Verdict::Approve);
    queue.release(TURN).expect("the first run releases");

    assert!(
        queue.is_armed(other),
        "the second run is still waiting on its own operator"
    );
    assert_eq!(queue.undecided(other), 1);
}

/// The batch keeps the **first** gate's effect as its representative.
///
/// Siblings agree by construction on everything a continuation reads — the
/// trigger input and the run-level delivery/performed ledgers — so keeping one
/// is what stops a fanned-out run from holding N copies of its trigger input.
/// The one thing that differs per gate is the node id, which is exactly what
/// the ledgers carry separately; if a later arm replaced the representative,
/// nothing would break loudly and the saving would silently be undone.
#[test]
fn the_batch_keeps_one_representative_effect_rather_than_one_per_gate() {
    let queue = WorkflowGateQueue::default();
    queue.arm(TURN, &id("a1"), &gate("draft"));
    queue.arm(TURN, &id("a2"), &gate("publish"));
    queue.decide(TURN, &id("a1"), Verdict::Approve);
    queue.decide(TURN, &id("a2"), Verdict::Approve);

    let released = queue.release(TURN).expect("the batch releases");
    assert_eq!(
        released
            .effect
            .payload
            .get("node_id")
            .and_then(|v| v.as_str()),
        Some("draft"),
        "the first gate through sets the representative effect and later ones do not replace it"
    );
}

/// `rearm` replaces a turn's batch rather than adding to it.
///
/// Boot loads the journal and `recover` can be driven again, so this runs more
/// than once against the same still-parked gates. If it accumulated, a run
/// would come back blocked on twice as many decisions as there are cards and
/// could never be released at all.
#[test]
fn rearming_twice_leaves_a_run_blocked_on_the_gates_it_is_actually_blocked_on() {
    let queue = WorkflowGateQueue::default();
    let draft = gate("draft");
    let publish = gate("publish");
    let parked = || {
        vec![
            (TURN.to_string(), id("a1"), &draft),
            (TURN.to_string(), id("a2"), &publish),
        ]
    };

    queue.rearm(parked());
    queue.rearm(parked());

    assert_eq!(
        queue.undecided(TURN),
        2,
        "a second replay of the same journal must not double the outstanding count"
    );
}

/// A rehydrate drops the verdicts this process had banked.
///
/// Stated in the module docs as the honest reading rather than a defect: the
/// journal records that an approval resolved without recording what it was
/// gating, so a replay can only know which gates are *still* parked. Pinned
/// here so a future change that starts preserving them is a deliberate one.
#[test]
fn a_rehydrate_forgets_verdicts_banked_before_it() {
    let queue = WorkflowGateQueue::default();
    let draft = gate("draft");
    queue.arm(TURN, &id("a1"), &draft);
    queue.arm(TURN, &id("a2"), &gate("publish"));
    queue.decide(TURN, &id("a1"), Verdict::Approve);

    queue.rearm(vec![(TURN.to_string(), id("a2"), &draft)]);

    assert_eq!(
        queue.undecided(TURN),
        1,
        "the rebuilt batch knows only the gate the journal still had parked"
    );
    queue.decide(TURN, &id("a2"), Verdict::Approve);
    let released = queue.release(TURN).expect("the rebuilt batch releases");
    assert_eq!(
        released.approved,
        vec!["draft".to_string()],
        "only the gate the journal still had parked is in the ledger"
    );
}
