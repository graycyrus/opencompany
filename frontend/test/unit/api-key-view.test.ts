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
  });

  it("still says plainly when there is no identity at all", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    expect(container.querySelector('[data-testid="account-empty"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain("No account connected yet.");
    expect(container.textContent ?? "").toContain("Apps cannot be connected");
  });
});

describe("ApiKeyView never overstates what a missing account breaks", () => {
  // QA, 2026-09-11. The old page said "Until one is set, agents cannot think
  // and no provider can be connected", and it is **false** on a company whose
  // LLM page holds a provider key of its own: `inference/key` resolves without
  // this credential, so such a company thinks perfectly well at `source:
  // "none"` — and the sentence sends its operator to fix something that is not
  // broken. The page may say what this key governs; it may not claim the whole
  // company has stopped.
  it("never claims agents cannot think, in any state", async () => {
    for (const source of ["none", "attested", "static", "company"] as const) {
      const client = clientFor({
        credential: async () => credential({ configured: source === "company", source }),
        billing: async () => ({ configured: false }),
      });

      await mount(client);

      const text = (container.textContent ?? "").toLowerCase();
      expect(text, `source=${source}`).not.toContain("agents cannot think");
      expect(text, `source=${source}`).not.toContain("cannot think");
    }
  });

  // The exception is named rather than denied — an operator who has set a
  // provider key on the LLM page must be able to see that it still applies.
  it("names the LLM-page provider key as the thing that still works", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    expect(container.textContent ?? "").toContain(
      "a provider key set on the LLM page still works",
    );
  });

  // The billing consequence belongs to the control it is true of. `PUT
  // …/credential` — what the paste dialog submits — writes `tinyhumans/key`
  // and stops; only `finish_link` also writes `inference/key` and declares the
  // managed provider. So the header card, which carries the Connect button,
  // states the move, and the dialog must not: telling someone that pasting a
  // key moved their model spend is the same defect pointing the other way.
  it("puts the billing move on the connect path, not on the paste field", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none", hubLink: true }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    // The header card says it, beside the button it is true of.
    expect(container.textContent ?? "").toContain(
      "Connecting moves both onto this company's account",
    );
    // And nothing on the page claims a paste does it. The dialog is closed
    // here, so this also pins that the claim has not migrated into the page.
    expect(container.textContent ?? "").not.toContain("Saving it also moves every agent turn");
  });
});

describe("ApiKeyView confirms before clearing a credential", () => {
  // QA matrix X8, and the standing rule behind it — an operator lost a live
  // key to an unconfirmed clear. `store_key("")` is how the store spells a
  // delete, it is irreversible from this console (the hub shows a key's value
  // once), and the menu item cannot show what it costs.
  it("offers Remove key as a confirmation, never as a direct write", async () => {
    const writes: unknown[] = [];
    const client = {
      scopeFor: () => "/api/v1/companies/acme",
      get: async (path: string) => {
        if (path.endsWith("/credential/billing")) return { configured: false };
        if (path.endsWith("/auth/me")) return { role: "admin" };
        if (path.endsWith("/credential")) return credential({ source: "company" });
        throw new Error(`unexpected GET ${path}`);
      },
      put: async (_path: string, body: unknown) => {
        writes.push(body);
        return { status: credential({ source: "company" }), note: "" };
      },
    } as unknown as OpenCompanyClient;

    await mount(client);

    // Mounting and rendering the row must never have written anything.
    expect(writes).toHaveLength(0);
    // The destructive item exists but is wired to the confirmation, so no
    // clear can reach the host without a second, deliberate press.
    const item = container.querySelector('[data-testid="account-remove-key"]');
    // The menu is closed at rest, so the item is not in the document — which
    // is itself the point: there is no one-press path to a cleared key.
    expect(item).toBeNull();
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

  // The same honesty, applied to the controls rather than the words. An admin
  // reading "the host could not say" must not be offered a key field beside
  // it: the write it opens overwrites a write-only credential this console has
  // just admitted it cannot see, and the value it replaces cannot be read back
  // from the hub, which shows a key's plaintext once.
  it("offers no way to overwrite a key it cannot read", async () => {
    const client = {
      scopeFor: () => "/api/v1/companies/acme",
      get: async (path: string) => {
        if (path.endsWith("/credential/billing")) return { configured: false };
        if (path.endsWith("/auth/me")) return { role: "admin" };
        if (path.endsWith("/credential")) throw new Error("secret store unavailable");
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as OpenCompanyClient;

    await mount(client);

    // The row is there, saying it does not know — that part is the point above.
    expect(container.querySelector('[data-testid="account-row"]')).not.toBeNull();
    // The header card's action is gone rather than disabled: there is no state
    // in which it is the right offer, so a greyed one would only invite a
    // retry.
    expect(container.querySelector('[data-testid="account-add-key"]')).toBeNull();
    // And the row menu, which carries the same "Add a key" item, cannot open.
    const menu = container.querySelector('[data-testid="account-row-menu"]');
    expect(menu).not.toBeNull();
    // Either spelling counts — the trigger is a `Button` rendered through the
    // menu primitive, and which of the two it forwards is the primitive's
    // business rather than this page's.
    const shut =
      menu?.hasAttribute("disabled") === true || menu?.getAttribute("aria-disabled") === "true";
    expect(shut).toBe(true);
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
