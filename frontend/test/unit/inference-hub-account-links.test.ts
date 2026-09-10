// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import type { CompanyCredentialStatus } from "@/api/credential";
import type { InferenceStatus } from "@/api/inference";
import { InferenceSection } from "@/views/connections/InferenceSection";

let container: HTMLDivElement;
let root: Root;

const ACCOUNT = { manageKeysUrl: "https://hub.example/keys", topUpUrl: "https://hub.example/topup" };

function status(provider: string, keyConfigured: boolean): InferenceStatus {
  return {
    provider,
    slug: provider,
    baseUrl: "https://openrouter.ai/api/v1",
    models: {},
    defaultTierModels: {},
    source: "runtime",
    keyConfigured,
    cognition: "harness",
    usageMetering: "perTurn",
    restartRequired: false,
    harnessReachable: true,
    canRebuildInPlace: true,
  };
}

function credential(configured: boolean): CompanyCredentialStatus {
  return {
    configured,
    source: configured ? "company" : "attested",
    notice: "notice",
    hubLink: false,
    account: ACCOUNT,
  };
}

function clientFor(inference: InferenceStatus, cred: CompanyCredentialStatus): OpenCompanyClient {
  return {
    scopeFor: () => "/api/v1/companies/acme",
    get: async (path: string) => {
      if (path.endsWith("/credential")) return cred;
      if (path.endsWith("/inference/models")) return { models: [], tierDefaults: {} };
      return inference;
    },
  } as unknown as OpenCompanyClient;
}

async function mount(client: OpenCompanyClient) {
  await act(async () => {
    root.render(createElement(InferenceSection, { client, company: "acme", canManage: true }));
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

// CodeRabbit, PR #2216: `status.keyConfigured` only says an inference key
// exists, which under `managed` (a legacy alias for `openrouter`) can be a raw
// OpenRouter key the operator pasted directly — that key bills OpenRouter, not
// the TinyHumans account `HubAccountLinks` always points at. The links must
// read `credential.configured` and must not appear at all once the saved
// config no longer rides the platform proxy.
describe("HubAccountLinks under the managed/openrouter tier", () => {
  it("hides the TinyHumans account links once a raw OpenRouter key is saved directly", async () => {
    const client = clientFor(status("openrouter", true), credential(false));
    await mount(client);
    expect(container.querySelector('[data-testid="hub-manage-keys"]')).toBeNull();
    expect(container.querySelector('[data-testid="hub-top-up"]')).toBeNull();
  });

  it("shows the links, keyed off the TinyHumans credential, while the saved config rides the proxy", async () => {
    const client = clientFor(status("managed", false), credential(true));
    await mount(client);
    expect(container.querySelector('[data-testid="hub-manage-keys"]')).not.toBeNull();
    // credential.configured is true here even though the inference key is
    // not — this is the bug: keying off `status.keyConfigured` would have
    // rendered the "not yet configured" copy for an account that in fact has
    // a TinyHumans key.
    expect(container.textContent ?? "").toContain("Your agents spend this account's balance");
  });
});
