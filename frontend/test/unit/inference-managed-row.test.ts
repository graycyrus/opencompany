// The managed row must not claim availability it does not have.
//
// It used to carry a permanent `Always on` badge, ported from a design where the
// same company runs the managed backend — there it is true. Here the managed
// tier needs a credential and can resolve to nothing, and a row saying "always
// on" while agents cannot think is exactly the dishonesty the five-state
// cognition model exists to prevent.

import { describe, expect, it } from "vitest";

import { MANAGED_OPTION_SLUG, addOptions, offersManaged } from "@/inference/connect";
import { managedRow } from "@/inference/ProviderList";
import { MANAGED_NOT_SET_UP, MANAGED_NOT_SET_UP_ELSEWHERE } from "@/inference/routing";
import type { ManagedState } from "@/api/inference";

const managed = (source: ManagedState["source"]): ManagedState => ({
  source,
  configured: source !== "none",
  baseUrl: "https://api.tinyhumans.ai/openai/v1",
});

describe("what the managed row says", () => {
  it("never says 'always on'", () => {
    for (const source of ["provider_key", "company_account", "instance", "none"] as const) {
      const row = managedRow(source);
      expect(row.badge, source).not.toBe("Always on");
      expect(row.detail.toLowerCase(), source).not.toContain("always");
    }
  });

  it("keeps the two paying states apart", () => {
    // One bills the company's own account, the other bills whoever runs the
    // server, and that is the decision an operator is on this page to make.
    expect(managedRow("company_account").detail).not.toBe(managedRow("instance").detail);
    expect(managedRow("company_account").detail).toContain("company");
    expect(managedRow("instance").detail).toContain("server");
  });

  it("shows no badge at all when nothing resolves", () => {
    // A green tick nobody established is worse than no tick.
    expect(managedRow("none").badge).toBeNull();
    expect(managedRow("none").detail).toContain("cannot think");
  });

  it("shows no badge when the host did not say", () => {
    // "Unknown" is not "working".
    expect(managedRow(undefined).badge).toBeNull();
  });
});

describe("where managed is offered", () => {
  it("is listed when nothing resolves, like anything else not connected", () => {
    const options = addOptions([], managed("none"));
    expect(options.cloud[0]).toMatchObject({
      value: MANAGED_OPTION_SLUG,
      // The endpoint host, like every other cloud row.
      detail: "api.tinyhumans.ai",
    });
  });

  it("is still listed while the SERVER is paying, and that is the trade-off", () => {
    // On the plain "only what is not yet connected" rule this would disappear —
    // it resolves, so it is connected. That would take with it the only route
    // from *the server pays* to *we pay*, which is a decision an operator
    // actively wants to make.
    expect(offersManaged(managed("instance"))).toBe(true);
  });

  it("is hidden once the company's own credential answers", () => {
    // Steps 1-3 are the company's credential in one form or another, and there
    // is nothing left to upgrade to.
    expect(offersManaged(managed("provider_key"))).toBe(false);
    expect(offersManaged(managed("company_account"))).toBe(false);
  });

  it("is not offered when the host did not say", () => {
    // Offering a setup flow for a state nobody established would be a guess.
    expect(offersManaged(undefined)).toBe(false);
  });
});

describe("the line that says managed is not set up", () => {
  it("carries no navigation on the page that holds the action", () => {
    // The Providers tab has the button at the top of it. Telling an operator to
    // go to the tab they are looking at is a sentence that has stopped reading
    // its own surroundings.
    expect(MANAGED_NOT_SET_UP).not.toContain("tab");
    expect(MANAGED_NOT_SET_UP).toContain("not a fallback");
  });

  it("says where to go from a page that does not", () => {
    // On Routing the action is elsewhere, so naming it is the useful half.
    expect(MANAGED_NOT_SET_UP_ELSEWHERE).toContain(MANAGED_NOT_SET_UP);
    expect(MANAGED_NOT_SET_UP_ELSEWHERE).toContain("LLM Providers tab");
  });
});
