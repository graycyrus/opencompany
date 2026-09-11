import { describe, expect, it } from "vitest";

import type { CompanyBilling, CompanyCredentialStatus } from "@/api/credential";
import {
  accountShape,
  accountSubline,
  balanceLine,
  canRemoveKey,
  headerAction,
} from "@/views/connections/account";

function status(overrides: Partial<CompanyCredentialStatus> = {}): CompanyCredentialStatus {
  return {
    configured: true,
    source: "company",
    notice: "notice",
    hubLink: false,
    ...overrides,
  };
}

describe("accountShape keeps an unreadable store apart from an empty one", () => {
  it("is connected whenever anything resolves", () => {
    expect(accountShape("ready", status({ source: "company" }))).toBe("connected");
    expect(accountShape("ready", status({ configured: false, source: "attested" }))).toBe(
      "connected",
    );
    expect(accountShape("ready", status({ configured: false, source: "static" }))).toBe(
      "connected",
    );
  });

  it("is empty only when the chain resolves to nothing", () => {
    expect(accountShape("ready", status({ configured: false, source: "none" }))).toBe("empty");
  });

  // The trap the whole page is built around. `company_key::resolve` propagates
  // a store read error rather than falling through, because a connection made
  // under a silently-borrowed identity belongs to the wrong account invisibly
  // and permanently. A console that folded that into "empty" would throw the
  // distinction away at the last step and send an admin to set a key they may
  // already have set.
  it("is unknown — never empty — when the host could not answer", () => {
    expect(accountShape("error", null)).toBe("unknown");
    // Even holding a status from a previous good read: the load says the
    // current answer is not known, and that outranks a stale one.
    expect(accountShape("error", status({ source: "company" }))).toBe("unknown");
  });
});

describe("accountSubline says which tier actually answers", () => {
  it("names the company's own account", () => {
    expect(accountSubline("ready", status({ source: "company" }))).toContain(
      "this company's TinyHumans account",
    );
  });

  // The hosted case. `configured` is false here and a row built on it would
  // read "not configured" while the server's account pays for every turn.
  it("names the server's account for both fallback identities", () => {
    for (const source of ["attested", "static"] as const) {
      expect(accountSubline("ready", status({ configured: false, source }))).toBe(
        "Billed to whoever runs this server",
      );
    }
  });

  it("says plainly when nothing resolves", () => {
    const line = accountSubline("ready", status({ configured: false, source: "none" }));
    expect(line).toContain("agents cannot think");
  });

  it("does not claim there is no key when the host could not answer", () => {
    const line = accountSubline("error", null);
    expect(line).toContain("not the same as having no key");
    expect(line).not.toContain("Nothing resolves");
  });

  it("falls back to what the row is when a host names an unknown tier", () => {
    const unknown = status({ source: "something-new" as CompanyCredentialStatus["source"] });
    expect(accountSubline("ready", unknown)).toBe(
      "The account this company acts and spends through",
    );
  });
});

describe("canRemoveKey offers Remove only where it would remove something", () => {
  it("is true for the company's own key", () => {
    expect(canRemoveKey(status({ source: "company" }))).toBe(true);
  });

  // The instance's identity is not this row's to take away, and a Remove that
  // clears nothing is the control-that-cannot-act the LLM page's pass deleted
  // a toggle over.
  it("is false for a fallback identity, for nothing, and for an unknown state", () => {
    expect(canRemoveKey(status({ configured: false, source: "attested" }))).toBe(false);
    expect(canRemoveKey(status({ configured: false, source: "static" }))).toBe(false);
    expect(canRemoveKey(status({ configured: false, source: "none" }))).toBe(false);
    expect(canRemoveKey(null)).toBe(false);
  });
});

describe("headerAction holds whichever action is live", () => {
  it("offers nothing to a member", () => {
    expect(headerAction(status({ hubLink: true }), false)).toBeNull();
    expect(headerAction(status({ hubLink: false }), false)).toBeNull();
  });

  it("prefers the grant where the host has a hub", () => {
    expect(headerAction(status({ hubLink: true }), true)).toBe("connect");
  });

  // Without this the header card on a self-hosted instance is a heading over
  // empty space: `ConnectTinyHumansButton` renders null with no hub wired.
  it("falls back to the paste dialog where it does not", () => {
    expect(headerAction(status({ hubLink: false }), true)).toBe("key");
    expect(headerAction(status({ hubLink: undefined }), true)).toBe("key");
    expect(headerAction(null, true)).toBe("key");
  });
});

describe("balanceLine", () => {
  function billing(overrides: Partial<CompanyBilling> = {}): CompanyBilling {
    return { configured: true, ...overrides };
  }

  it("renders no row for a company with no account of its own", () => {
    expect(balanceLine(null)).toBeNull();
    expect(balanceLine(billing({ configured: false }))).toBeNull();
  });

  it("shows the figure and the plan", () => {
    const line = balanceLine(
      billing({ summary: { balanceUsd: 12.5, plan: "pro", activeSubscription: true } }),
    );
    expect(line?.amount).toBe("$12.50");
    expect(line?.detail).toBe("on the pro plan · subscription active");
    expect(line?.low).toBe(false);
  });

  // `!balanceUsd` would hide exactly the figure somebody needs to see, and a
  // zero balance is the state the page exists to make loud.
  it("shows zero rather than hiding it, and marks it low", () => {
    const line = balanceLine(
      billing({ summary: { balanceUsd: 0, plan: "free", activeSubscription: false } }),
    );
    expect(line?.amount).toBe("$0.00");
    expect(line?.low).toBe(true);
  });

  // "We could not ask" and "there is nothing left" look identical on a row and
  // call for opposite actions, so the figure is dropped rather than invented.
  it("does not render an unanswered hub as a zero balance", () => {
    const line = balanceLine(billing({ unavailable: "the hub timed out" }));
    expect(line?.amount).toBeNull();
    expect(line?.low).toBe(false);
    expect(line?.detail).toContain("the hub timed out");
    expect(line?.detail).toContain("The key is set");
  });
});
