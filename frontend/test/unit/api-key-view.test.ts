// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import type { CompanyCredentialStatus } from "@/api/credential";
import { ApiKeyView } from "@/views/connections/ApiKeyView";

let container: HTMLDivElement;
let root: Root;

function credential(overrides: Partial<CompanyCredentialStatus> = {}): CompanyCredentialStatus {
  return {
    configured: true,
    source: "company",
    notice: "notice",
    hubLink: false,
    ...overrides,
  };
}

/** A client whose `/auth/me` always answers as a non-admin, so the credential
 * card's own network calls stay quiet and out of scope for these tests. */
function clientFor(handlers: {
  credential: () => Promise<CompanyCredentialStatus>;
  billing: () => Promise<unknown>;
}): OpenCompanyClient {
  return {
    scopeFor: () => "/api/v1/companies/acme",
    get: async (path: string) => {
      if (path.endsWith("/credential/billing")) return handlers.billing();
      if (path.endsWith("/auth/me")) return { role: "member" };
      if (path.endsWith("/credential")) return handlers.credential();
      throw new Error(`unexpected GET ${path}`);
    },
  } as unknown as OpenCompanyClient;
}

async function mount(client: OpenCompanyClient) {
  await act(async () => {
    root.render(createElement(ApiKeyView, { client, company: "acme" }));
  });
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ApiKeyView billing failures stay distinguishable from no key", () => {
  // The regression this covers (CodeRabbit + Codex, PR #2216): the old catch
  // converted every billing rejection into `{ configured: false }`, so a
  // company that HAS a key saw the balance vanish entirely — the same outcome
  // as never having set one, even though `billing.unavailable` exists
  // precisely to say "the key is set, the hub just would not answer".
  it("keeps the balance row in its unavailable state when billing rejects but a key is configured", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: true, source: "company" }),
      billing: async () => {
        throw new Error("network blip");
      },
    });

    await mount(client);

    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="account-balance"]')).not.toBeNull();
    expect(text).toContain("Balance unknown");
    expect(text).toContain("The key is set");
    // Must NOT have fallen through to the empty state.
    expect(container.querySelector('[data-testid="account-empty"]')).toBeNull();
  });

  it("reports no account at all when billing rejects and nothing resolves", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => {
        throw new Error("network blip");
      },
    });

    await mount(client);

    // No balance row at all — nothing to be "unavailable" about.
    expect(container.querySelector('[data-testid="account-balance"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-empty"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain("No account connected yet.");
  });
});

describe("ApiKeyView describes a fallback platform identity honestly", () => {
  // Codex P2: a host with no company key but a live instance identity
  // (`attested` / `static`) already lets agents think and providers connect —
  // "agents cannot think and no app can be connected" is simply false there
  // and would send an operator to reconnect something that already works. The
  // row is keyed on what `resolve` returned, not on `configured`, which is
  // false in exactly this case.
  it("says the server's account is paying rather than that nothing is configured", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "attested" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    const subline = container.querySelector('[data-testid="account-row-subline"]');
    expect(subline?.textContent).toBe("Billed to whoever runs this server");
    expect(container.querySelector('[data-testid="account-empty"]')).toBeNull();
    expect(container.textContent ?? "").not.toContain("agents cannot think");
  });

  it("still warns plainly when there is truly no identity at all", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    expect(container.querySelector('[data-testid="account-empty"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain(
      "Agents cannot think and no app can be connected until one is.",
    );
  });
});

describe("ApiKeyView never renders an unreadable store as an empty one", () => {
  // `company_key::resolve` propagates a secret-store read error rather than
  // falling through to the instance identity, because a connection made under
  // a silently-borrowed identity belongs to the wrong account invisibly and
  // permanently. The console has to spend a state on that, or the distinction
  // the host paid for is thrown away at the last step.
  it("says the host could not answer, and offers no empty state", async () => {
    const client = clientFor({
      credential: async () => {
        throw new Error("secret store unavailable");
      },
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    const subline = container.querySelector('[data-testid="account-row-subline"]');
    expect(subline?.textContent).toContain("not the same as having no key");
    expect(container.querySelector('[data-testid="account-empty"]')).toBeNull();
    // And no balance under a row that has just said it does not know whose
    // account this is.
    expect(container.querySelector('[data-testid="account-balance"]')).toBeNull();
  });
});

describe("ApiKeyView offers no control that cannot act", () => {
  // The rule that removed a toggle from the Managed inference row. Remove key
  // clears `tinyhumans/key`, which a company on the instance's identity does
  // not have — so offering it would be a destructive control that changes
  // nothing.
  it("does not offer Remove key when the identity is the instance's", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "static" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    // The menu is closed, so this asserts on the page's rendered text: the
    // destructive item must not be reachable at all.
    expect(container.textContent ?? "").not.toContain("Remove key");
  });
});
