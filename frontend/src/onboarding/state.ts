// Session-local "skip for now" state for the onboarding gate (issue #1844).
//
// Deliberately `sessionStorage`, not `localStorage`. The gate's own latch —
// `ActivationStatus.isActivated` on the host — is what makes a *completed*
// funnel never reappear; this flag only ever suppresses an *unfinished* one,
// and only for the tab that clicked "skip for now". A hard lock behind a
// broken Composio connect is worse than the blank app the gate replaces (the
// issue's own words), so skipping must always be reachable — but it must also
// re-prompt, or the gate this issue adds would be exactly as toothless as the
// cosmetic tour it demotes. `sessionStorage` buys both for free: it survives
// in-tab navigation (so a reload mid-session does not re-trap someone who just
// skipped) and disappears on the next fresh tab/window, which is the
// "re-prompts" the issue asks for without a second host round trip to track it.

import { type LocalScope, scopedKey } from "@/connections/types";

// Plain `scopedKey`, not `scopedKeyAdoptingLegacy`: this flag has no
// pre-connection predecessor to adopt — the funnel it gates did not exist
// before connections did — so there is nothing to migrate.
const KEY = (scope: LocalScope): string => scopedKey("oc-onboarding-gate-skip", scope);

/** Records that the operator dismissed the gate without finishing it. */
export function markGateSkipped(scope: LocalScope): void {
  try {
    sessionStorage.setItem(KEY(scope), String(Date.now()));
  } catch {
    /* private mode / quota — the gate simply re-offers on the next check */
  }
}

/** Whether the gate was skipped earlier in this tab's session. */
export function gateSkippedThisSession(scope: LocalScope): boolean {
  try {
    return sessionStorage.getItem(KEY(scope)) !== null;
  } catch {
    return false;
  }
}

/**
 * Clears the skip marker — called the moment the funnel actually completes, so
 * a stale marker from an earlier abandoned attempt cannot outlive it (it
 * cannot matter once `isActivated` is `true`, but leaving it set is still a
 * leak worth cleaning up rather than reasoning about later).
 */
export function clearGateSkipped(scope: LocalScope): void {
  try {
    sessionStorage.removeItem(KEY(scope));
  } catch {
    /* nothing to clear */
  }
}

// ---------------------------------------------------------------------------
// Durable per-step waivers (bugs B-001 / B-020).
//
// `localStorage`, deliberately NOT the `sessionStorage` the skip marker above
// uses, and the difference is the whole point of this half of the module.
//
// "Skip for now" is a statement about *this moment* — "not now, ask me again" —
// so re-prompting in a fresh tab is the correct behaviour and the comment at
// the top of this file defends it properly.
//
// A waiver is a statement about *this company on this build*: "there is no
// credential I can give you, and there will not be one when I open a new tab."
// `integration_connected` (`src/company/activation.rs`) only ever reads true
// when the build compiled the `composio` feature AND the manifest grants the
// namespace AND a live connection exists. A self-hosted founder on a build with
// no credential path can satisfy the other two steps and never this one — so
// the session-scoped skip re-trapped them in the same unfinishable checklist on
// every new window, forever. That is B-020: two individually-defensible
// decisions (a session-scoped skip, a strict completion condition) that are only
// wrong together.
//
// The fix is not to loosen the completion condition — the host is right that no
// connection means no connection — but to let the founder record, durably, that
// they have answered this step as far as this build allows. The operator's own
// words for the rule: "once this step has passed it should never come back."
// A waiver is what "passed" means for a step whose precondition is out of the
// founder's reach.
//
// Scoped per company by the same `scopedKey` the skip marker uses, so waiving
// the step on one company never speaks for another.

const WAIVED_KEY = (scope: LocalScope): string => scopedKey("oc-onboarding-gate-waived", scope);

/** The gate's three step ids, as `OnboardingGate` names them. */
export type GateStepId = "name" | "integration" | "workflow";

/**
 * Reads the durably-waived step ids for this company.
 *
 * Tolerates anything in the slot — a hand-edited value, a half-written entry,
 * a shape from a future version — by returning nothing rather than throwing
 * into a render. The cost of a misread is one extra prompt; the cost of a
 * throw is the blank app this whole gate exists to replace.
 */
export function waivedGateSteps(scope: LocalScope): GateStepId[] {
  try {
    const raw = localStorage.getItem(WAIVED_KEY(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is GateStepId => v === "name" || v === "integration" || v === "workflow",
    );
  } catch {
    return [];
  }
}

/** Records that the founder answered `step` as far as this build allows. */
export function markGateStepWaived(scope: LocalScope, step: GateStepId): void {
  try {
    const next = Array.from(new Set([...waivedGateSteps(scope), step]));
    localStorage.setItem(WAIVED_KEY(scope), JSON.stringify(next));
  } catch {
    /* private mode / quota — the gate re-offers, same as a failed skip write */
  }
}

/**
 * Drops every waiver — called once the funnel genuinely completes, for the same
 * housekeeping reason [`clearGateSkipped`] exists: a waiver cannot matter once
 * `isActivated` is true, and a stale one left behind would silently speak for a
 * *later* incomplete funnel (a company whose connection is later revoked)
 * without the founder ever having answered that one.
 */
export function clearGateStepWaivers(scope: LocalScope): void {
  try {
    localStorage.removeItem(WAIVED_KEY(scope));
  } catch {
    /* nothing to clear */
  }
}
