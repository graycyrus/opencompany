// The decisions the Account page makes, none of which needs React, a host or a
// browser to exercise.
//
// The organising rule is the inference rework's (`docs/modules/inference/
// architecture.md`): what the page *decides* — which tier answers, whether
// there is a key of this company's own to remove, what the balance line says —
// lives here with a unit test each, and what is left in the component is
// layout. A decision written inline in JSX can only be checked by mounting the
// page, and the ones below are exactly the ones that have been got wrong.

import type { CompanyBilling, CompanyCredentialStatus } from "@/api/credential";

/** The name the one row carries, and the two letters its mark is drawn from. */
export const ACCOUNT_LABEL = "TinyHumans";

/**
 * How much the page knows about the account right now.
 *
 * `error` is the host refusing to answer — a secret store it could not read —
 * and it is deliberately a value of its own rather than folded into "nothing is
 * set". See {@link accountShape}.
 */
export type AccountLoad = "loading" | "ready" | "error";

/**
 * What the account row is.
 *
 * Three, not two, and the third is the point. `company_key::resolve` propagates
 * a store read error rather than falling through to the instance identity,
 * because "we cannot read the store" and "no key is set" are different answers
 * that call for opposite actions — and a console that renders the first as the
 * second would tell an admin to set a key they have already set. The host went
 * to some trouble to keep them apart; the page has to spend a state on it.
 */
export type AccountShape = "unknown" | "empty" | "connected";

/**
 * Which of the three states the row is in.
 *
 * Keyed on `source`, which is what
 * [`resolve`](../../../../src/company/company_key.rs) returned — not on
 * `configured`, which is `key_configured` and answers the narrower question
 * "has this company pasted one". The two differ in exactly the case this page
 * exists to describe: a hosted tenant with no key of its own still has a
 * working identity, and a row built on `configured` would call that
 * "not configured" while the server's account quietly pays for every turn.
 */
export function accountShape(load: AccountLoad, status: CompanyCredentialStatus | null): AccountShape {
  if (load !== "ready" || status === null) return "unknown";
  return status.source === "none" ? "empty" : "connected";
}

/**
 * The one sub-line the account row shows: which tier actually answers.
 *
 * One fact, not three stacked — an operator is scanning for the row rather than
 * reading it. The two "working" states are kept apart because that is the
 * decision somebody is on this page to make: connecting the company's own
 * account moves the bill for every turn, and a row that says only "connected"
 * hides that it has not happened.
 */
export function accountSubline(load: AccountLoad, status: CompanyCredentialStatus | null): string {
  if (load !== "ready" || status === null) {
    return "The host could not say — this is not the same as having no key";
  }
  switch (status.source) {
    case "company":
      return "Billed to this company's TinyHumans account";
    case "attested":
    case "static":
      return "Billed to whoever runs this server";
    case "none":
      return "Nothing resolves — agents cannot think and no app can be connected";
    default:
      // An older or newer host naming a tier this build does not know. Saying
      // what the row *is* beats claiming a state nobody established.
      return "The account this company acts and spends through";
  }
}

/**
 * Whether there is a key of **this company's own** to take away.
 *
 * The instance's platform identity is not this row's to remove, and offering a
 * Remove that would clear nothing is the control-that-cannot-act the LLM page's
 * pass deleted a toggle over. Gated on the resolved tier rather than on
 * `configured` for the reason {@link accountShape} gives.
 */
export function canRemoveKey(status: CompanyCredentialStatus | null): boolean {
  return status?.source === "company";
}

/**
 * The single action the header card offers, or `null` for none.
 *
 * `connect` is the short path and wins wherever the host can complete a grant.
 * `key` is the paste dialog, which is the only route on a host with no hub
 * wired — so the slot holds whichever action is actually live rather than a
 * primary button that renders nothing and leaves a heading over empty space.
 */
export function headerAction(
  status: CompanyCredentialStatus | null,
  canManage: boolean,
): "connect" | "key" | null {
  if (!canManage) return null;
  return status?.hubLink === true ? "connect" : "key";
}

/** The balance row, once there is an account of this company's own to ask about. */
export interface BalanceLine {
  /** The figure as drawn, or `null` when the hub would not answer. */
  amount: string | null;
  /** The one sub-line: the plan, or why there are no figures. */
  detail: string;
  /** Whether the figure should read as a warning rather than a fact. */
  low: boolean;
}

/**
 * What the balance row says, or `null` for no row at all.
 *
 * No row unless the company has an account of its own: `$0.00` under a company
 * that never set a key would be a made-up fact about a wallet that does not
 * exist. The host keys `configured` here off `load` rather than `resolve` for
 * the same reason — the instance's balance is not this company's to show.
 *
 * `unavailable` is **not** a zero balance. They look identical on a row and
 * mean opposite things, one "top up" and one "try again", so the figure is
 * dropped rather than invented.
 */
export function balanceLine(billing: CompanyBilling | null): BalanceLine | null {
  if (billing?.configured !== true) return null;

  if (billing.unavailable !== undefined) {
    return {
      amount: null,
      detail: `The key is set; the hub said: ${billing.unavailable}`,
      low: false,
    };
  }

  const summary = billing.summary;
  // Zero is a number worth showing, so the empty test is on `null` and never on
  // falsiness — `!balanceUsd` would hide exactly the figure somebody needs.
  const usd = typeof summary?.balanceUsd === "number" ? summary.balanceUsd : null;
  return {
    amount: usd === null ? "—" : `$${usd.toFixed(2)}`,
    detail: `on the ${summary?.plan ?? "free"} plan${
      summary?.activeSubscription ? " · subscription active" : ""
    }`,
    low: usd !== null && usd <= 0,
  };
}
