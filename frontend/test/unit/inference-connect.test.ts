// The connect flow's decisions, exercised as functions rather than through a
// rendered dialog.
//
// Everything here is a branch the add flow makes before any request is sent:
// what each category offers, what it asks for, and whether a typed name may be
// used. If one of these is ever reachable only by opening a modal and clicking,
// it has been put in the wrong place.

import { describe, expect, it } from "vitest";

import {
  addOptions,
  checkSlug,
  credentialAsk,
  customProviderReady,
  isConnected,
  normalizeEndpoint,
  slugErrorCopy,
  slugify,
} from "@/inference/connect";
import { CLOUD_PROVIDERS } from "@/inference/catalogue";
import type { Provider } from "@/inference/types";

function provider(slug: string, kind = slug): Provider {
  return {
    id: `prv_${slug}`,
    slug,
    label: slug,
    kind,
    baseUrl: `https://${slug}.example/v1`,
    models: {},
    enabled: true,
    keyConfigured: true,
  };
}

describe("what the add dialog offers", () => {
  it("lists only what is not yet connected", () => {
    // Offering to add something twice is how you get two rows for one provider.
    const options = addOptions([provider("groq")]);
    expect(options.cloud.some((o) => o.value === "groq")).toBe(false);
    expect(options.cloud.some((o) => o.value === "openai")).toBe(true);
    expect(options.cloud).toHaveLength(CLOUD_PROVIDERS.length - 1);
  });

  it("hides Codex once OpenAI is connected, because its login IS an OpenAI key", () => {
    // The trap: keying the already-connected check on the literal `codex` never
    // matches, so the dialog would offer it forever however many times it was
    // connected.
    const options = addOptions([provider("openai")]);
    expect(options.cli.some((o) => o.value === "codex")).toBe(false);
    expect(options.cli.some((o) => o.value === "claude-code")).toBe(true);
    expect(isConnected([provider("openai")], "codex")).toBe(true);
  });

  it("gives each category the detail line its question implies", () => {
    const options = addOptions([]);
    expect(options.cloud.find((o) => o.value === "openai")?.detail).toBe("api.openai.com");
    expect(options.cloud.find((o) => o.value === "anthropic")?.detail).toBe("api.anthropic.com");
    expect(options.local[0]?.detail).toBe("Runs on this machine");
    expect(options.cli[0]?.detail).toBe("Uses a login another CLI already holds");
  });
});

describe("what each category asks for", () => {
  it("asks a cloud provider for a key and never for an endpoint", () => {
    // The endpoint is a preset. The paths in that table — /openai/v1,
    // /v1beta/openai, /api/paas/v4 — are not something to retype.
    const ask = credentialAsk("openai");
    expect(ask).toMatchObject({ needsKey: true, needsEndpoint: false, keyPlaceholder: "sk-..." });
  });

  it("asks a local runtime for an endpoint and not a key", () => {
    const ask = credentialAsk("ollama");
    expect(ask).toMatchObject({ needsKey: false, needsEndpoint: true });
    expect(ask.defaultEndpoint).toBe("http://localhost:11434");
  });

  it("asks omlx for both, because it is the one local runtime that wants both", () => {
    expect(credentialAsk("omlx")).toMatchObject({ needsKey: true, needsEndpoint: true });
  });

  it("asks a CLI login for nothing", () => {
    // Another tool already holds the credential.
    expect(credentialAsk("claude-code")).toMatchObject({
      needsKey: false,
      needsEndpoint: false,
    });
  });

  it("asks a custom provider for both", () => {
    expect(credentialAsk("custom")).toMatchObject({ needsKey: true, needsEndpoint: true });
  });
});

describe("the slug, which is derived and never typed", () => {
  it("falls out of the name", () => {
    expect(slugify("Acme Gateway")).toBe("acme-gateway");
    expect(slugify("  My Provider!! ")).toBe("my-provider");
    expect(slugify("Z.AI 2")).toBe("z-ai-2");
  });

  it("names the three ways it can fail, because they need three sentences", () => {
    expect(checkSlug([], "")).toBe("empty");
    expect(checkSlug([provider("acme")], "acme")).toBe("taken");
    // A typed name may not shadow something we ship: a routing entry saying
    // `groq` would then mean two things.
    expect(checkSlug([], "groq")).toBe("reserved");
    expect(checkSlug([], "acme")).toBeNull();
  });

  it("says what to do about each", () => {
    expect(slugErrorCopy("empty")).toBe("Enter a provider name to generate a slug.");
    expect(slugErrorCopy("taken")).toContain("already has a provider");
    expect(slugErrorCopy("reserved")).toContain("built-in");
  });
});

describe("the endpoint an operator types", () => {
  it("gains the /v1 an OpenAI surface lives at when a bare origin is given", () => {
    expect(normalizeEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("  http://localhost:11434/ ")).toBe("http://localhost:11434/v1");
  });

  it("leaves a path exactly as typed, because appending is not guessing", () => {
    expect(normalizeEndpoint("https://acme.example/api/gateway")).toBe(
      "https://acme.example/api/gateway",
    );
  });

  it("refuses anything that is not http or https", () => {
    for (const bad of ["file:///etc/passwd", "ftp://acme.example/v1", "localhost:11434", "", "http://"]) {
      expect(normalizeEndpoint(bad)).toBeNull();
    }
  });
});

describe("the custom-provider dialog's Add button", () => {
  it("stays disabled until both the name and the URL are usable", () => {
    expect(customProviderReady([], { label: "", baseUrl: "https://acme.example/v1" })).toBe(false);
    expect(customProviderReady([], { label: "Acme", baseUrl: "" })).toBe(false);
    expect(customProviderReady([], { label: "Groq", baseUrl: "https://acme.example/v1" })).toBe(
      false,
    );
    expect(customProviderReady([], { label: "Acme", baseUrl: "https://acme.example/v1" })).toBe(
      true,
    );
  });
});
