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
  // company that HAS a key saw the balance card vanish entirely — the same
  // outcome as never having set one, even though `billing.unavailable` exists
  // precisely to say "the key is set, the hub just would not answer".
  it("keeps the balance card in its unavailable state when billing rejects but a key is configured", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: true, source: "company" }),
      billing: async () => {
        throw new Error("network blip");
      },
    });

    await mount(client);

    const text = container.textContent ?? "";
    expect(text).toContain("balance could not be read");
    // Must NOT have fallen back to the pitch's "no key" copy.
    expect(text).not.toContain("Until one is set, agents cannot think");
  });

  it("reports no key at all when billing rejects and no credential is configured", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => {
        throw new Error("network blip");
      },
    });

    await mount(client);

    const text = container.textContent ?? "";
    // No balance card at all — nothing to be "unavailable" about.
    expect(text).not.toContain("balance could not be read");
    expect(text).toContain("Until one is set, agents cannot think");
  });
});

describe("ApiKeyView describes a fallback platform identity honestly", () => {
  // Codex P2: a host with no company key but a live instance identity
  // (`attested` / `static`) already lets agents think and providers connect —
  // the "agents cannot think and no provider can be connected" wording is
  // simply false there and would send an operator to reconnect something
  // that already works.
  it("does not claim agents cannot think when a fallback identity is active", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "attested" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    const text = container.textContent ?? "";
    expect(text).not.toContain("Until one is set, agents cannot think");
    expect(text).toContain("platform identity covers agents and connected providers");
  });

  it("still warns plainly when there is truly no identity at all", async () => {
    const client = clientFor({
      credential: async () => credential({ configured: false, source: "none" }),
      billing: async () => ({ configured: false }),
    });

    await mount(client);

    expect(container.textContent ?? "").toContain(
      "Until one is set, agents cannot think and no provider can be connected.",
    );
  });
});
