// The proxy-compatibility rule, as a rule rather than as a rendered form.
//
// It used to be reachable only through the single-provider form, where thirty
// tests drove a select, a text input and a Save button to reach nine assertions
// about one predicate. The form is retired; the rule lives in
// `@/inference/proxy-compat`, and this is what those tests protect, said
// directly.
//
// **Issue #2303 inverted the accepted shapes.** The managed endpoint is now the
// backend's direct OpenRouter proxy: it takes a bare `<author>/<model>` slug and
// rejects the two shapes the curated `/openai/v1` surface accepted — a bare tier
// name and `openrouter/<author>/<model>`. The recorded instances below (issue
// #1838 and its follow-ups) still name why the check is a whitelist, counts
// segments and trims first; their expected values follow the new endpoint.

import { describe, expect, it } from "vitest";

import {
  PROXIED_SLUG,
  isProxyCompatible,
  overrideIsSendable,
  stripProxyIncompatible,
} from "@/inference/proxy-compat";

describe("the one shape the managed OpenRouter proxy accepts", () => {
  it("accepts a bare OpenRouter slug", () => {
    for (const slug of [
      "anthropic/claude-sonnet-5",
      "qwen/qwen3.8-max",
      "meta-llama/llama-3-8b:free",
      // Two segments, and a real OpenRouter slug — not a passthrough spelling.
      "openrouter/auto",
    ]) {
      expect(isProxyCompatible(slug), slug).toBe(true);
    }
  });

  it("rejects a bare tier name, which the proxy does not resolve (#2303)", () => {
    // The curated surface read a tier as "let the platform resolve it". The
    // proxy rejects it, and the host no longer substitutes a model for one.
    for (const tier of ["chat-v1", "reasoning-v1", "agentic-v1", "vision-v1"]) {
      expect(isProxyCompatible(tier), tier).toBe(false);
    }
  });

  it("rejects the curated surface's three-segment passthrough spelling (#2303)", () => {
    expect(isProxyCompatible("openrouter/anthropic/claude-sonnet-5")).toBe(false);
  });

  it("rejects a bare unnamespaced id typed out of direct-path habit (ninth instance)", () => {
    // A whitelist, not a blacklist: an earlier version let every slashless
    // string through, and `gpt-4o` rode straight through Save to a request that
    // failed instead of being dropped the way the warning promised.
    for (const typed of ["gpt-4o", "llama3", "claude"]) {
      expect(isProxyCompatible(typed), typed).toBe(false);
    }
  });

  it("counts the segments and requires both halves (fifth instance)", () => {
    // Counting is what tells the shapes apart; an empty half is not an
    // author/model pair the proxy can route.
    expect(isProxyCompatible("anthropic/")).toBe(false);
    expect(isProxyCompatible("/claude-sonnet-5")).toBe(false);
    expect(isProxyCompatible("anthropic//claude-sonnet-5")).toBe(false);
    expect(isProxyCompatible("anthropic/claude sonnet 5")).toBe(false);
  });

  it("trims before any shape check (seventh instance)", () => {
    // A pasted value keeps its whitespace until a later pass; untrimmed, a good
    // value was silently dropped.
    expect(isProxyCompatible(" anthropic/claude-sonnet-5 ")).toBe(true);
    expect(isProxyCompatible("  chat-v1  ")).toBe(false);
  });

  it("is shape-based, not catalog-membership-based (third and fourth instances)", () => {
    // Membership only answers once a catalog has loaded; a shape gives every
    // caller the same answer with no network read — which is why this test
    // needs no catalog at all.
    expect(isProxyCompatible("vendor/not-in-any-snapshot-yet")).toBe(true);
  });
});

describe("stripping a whole tier map", () => {
  it("is the one place a kept value is trimmed (seventh instance)", () => {
    // Remove Key sends its carried models straight to the wire with no trim
    // pass of its own, so a kept id has to come out of here normalized.
    expect(stripProxyIncompatible({ "chat-v1": " anthropic/claude-sonnet-5 " })).toEqual({
      "chat-v1": "anthropic/claude-sonnet-5",
    });
  });

  it("drops the incompatible entries and keeps the rest", () => {
    expect(
      stripProxyIncompatible({
        "chat-v1": "anthropic/claude-sonnet-5",
        "reasoning-v1": "openrouter/anthropic/claude-opus-5",
        "agentic-v1": "agentic-v1",
        "vision-v1": "",
      }),
    ).toEqual({
      "chat-v1": "anthropic/claude-sonnet-5",
    });
  });

  it("is one implementation, so the rule cannot drift between call sites", () => {
    const map = { "chat-v1": "chat-v1" };
    expect(stripProxyIncompatible(map)).toEqual({});
    expect(isProxyCompatible("chat-v1")).toBe(false);
  });
});

describe("which provider the rule applies to", () => {
  it("applies to the platform's managed endpoint and to nothing else", () => {
    // A tenant's own OpenRouter account, a custom endpoint or a local runtime
    // takes whatever id the operator types, verbatim.
    expect(overrideIsSendable(PROXIED_SLUG, "anthropic/claude-sonnet-5")).toBe(true);
    expect(overrideIsSendable(PROXIED_SLUG, "chat-v1")).toBe(false);
    expect(overrideIsSendable(PROXIED_SLUG, "openrouter/anthropic/claude-sonnet-5")).toBe(false);
    expect(overrideIsSendable("openrouter", "chat-v1")).toBe(true);
    expect(overrideIsSendable("acme", "gpt-4o")).toBe(true);
  });

  it("treats an empty override as sendable everywhere", () => {
    // Empty means "no override". On Managed the host then fails the turn
    // closed and says to choose a model, rather than guessing one.
    expect(overrideIsSendable(PROXIED_SLUG, "")).toBe(true);
    expect(overrideIsSendable(PROXIED_SLUG, "   ")).toBe(true);
  });

  it("judges a settled value, which is why a half-typed id is not the point (sixth instance)", () => {
    // Six of the nine instances are about stripping mid-keystroke. The
    // predicate is asked on save, so only the finished value is judged.
    expect(overrideIsSendable(PROXIED_SLUG, "anthropic/claude-sonnet-5")).toBe(true);
  });
});
