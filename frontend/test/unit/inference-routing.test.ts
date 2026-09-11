import { describe, expect, it } from "vitest";

import { categoryOf } from "@/inference/catalogue";
import {
  ADVANCED_INTRO,
  MODE_COPY,
  WORKLOADS,
  WORKLOAD_COPY,
  WORKLOAD_TIER,
  applyToEveryWorkload,
  formatRef,
  inferRoutingMode,
  orphanedRoutes,
  parseRef,
  refSignature,
  routingTargets,
  rowValue,
  scrubOnRemove,
} from "@/inference/routing";
import type { Provider, RoutingMap } from "@/inference/types";

/**
 * Manage Routing, as decisions.
 *
 * Every case here is a branch that would otherwise only be reachable through a
 * rendered screen. They are the rules the Rust resolver holds for the turn path,
 * asserted on the side that has to draw a row before any request is made.
 */

function provider(slug: string, kind: string, enabled = true): Provider {
  return {
    id: `prv_${slug}`,
    slug,
    label: slug,
    kind,
    baseUrl: `https://${slug}.example/v1`,
    models: {},
    enabled,
    keyConfigured: true,
  };
}

describe("the rows the routing screen ships", () => {
  it("has one row per tier the runtime actually has", () => {
    expect(WORKLOADS).toEqual(["chat", "reasoning", "agentic", "vision"]);
    const tiers = WORKLOADS.map((w) => WORKLOAD_TIER[w]);
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it("has no coding row, because it would write the agentic tier twice", () => {
    // Two editable rows over one tier means setting one silently changes the
    // other — the inheritance bug in a different hat.
    expect(WORKLOADS).not.toContain("coding");
    expect(WORKLOAD_COPY.agentic.description).toContain("coding");
  });

  it("keeps the recommendation hint on every row", () => {
    // The hints are what make this screen usable by someone who has never
    // chosen a model. They are the first thing a rewrite would drop.
    for (const workload of WORKLOADS) {
      expect(WORKLOAD_COPY[workload].hint.length).toBeGreaterThan(40);
      expect(WORKLOAD_COPY[workload].label).toBeTruthy();
      expect(WORKLOAD_COPY[workload].description).toBeTruthy();
    }
  });

  it("names this product in the managed description, not the one the copy came from", () => {
    expect(MODE_COPY.managed.description).toContain("TinyHumans");
    expect(MODE_COPY.managed.description).not.toContain("OpenHuman");
    expect(ADVANCED_INTRO).toContain("Managed");
  });
});

describe("the hand-editable route grammar", () => {
  it("round-trips through a person", () => {
    const cases = ["", "managed", "acme", "acme:gpt-5", "local:llama3.1", "claude-code:opus"];
    for (const raw of cases) {
      expect(formatRef(parseRef(raw))).toBe(raw === "default" ? "" : raw);
    }
  });

  it("reads an empty value as unset rather than as a parse failure", () => {
    // Deleting the text is how an operator says "nothing here".
    expect(parseRef("")).toEqual({ kind: "default" });
    expect(parseRef("   ")).toEqual({ kind: "default" });
    expect(parseRef("default")).toEqual({ kind: "default" });
  });

  it("reads a trailing colon as a slug with no model", () => {
    expect(parseRef("acme:")).toEqual({ kind: "cloud", providerSlug: "acme", model: undefined });
  });

  it("gives two refs that mean the same thing the same signature", () => {
    // Structural equality would say no for an absent versus undefined model.
    expect(refSignature({ kind: "cloud", providerSlug: "acme" })).toBe(
      refSignature({ kind: "cloud", providerSlug: "acme", model: undefined }),
    );
    expect(refSignature({ kind: "default" })).toBe("default");
  });
});

describe("inferring the routing mode", () => {
  it("calls a company that has chosen nothing managed", () => {
    expect(inferRoutingMode({})).toBe("managed");
    expect(inferRoutingMode({ chat: { kind: "managed" }, vision: { kind: "default" } })).toBe(
      "managed",
    );
  });

  it("calls one provider and model on every row own", () => {
    expect(inferRoutingMode(applyToEveryWorkload("acme", "gpt-5"))).toBe("own");
  });

  it("calls a single differing row advanced", () => {
    const mixed: RoutingMap = {
      ...applyToEveryWorkload("acme", "gpt-5"),
      vision: { kind: "cloud", providerSlug: "acme", model: "vision" },
    };
    expect(inferRoutingMode(mixed)).toBe("advanced");
  });

  it("calls a partly-set map advanced, because an unset row is not the same", () => {
    expect(inferRoutingMode({ chat: { kind: "cloud", providerSlug: "acme" } })).toBe("advanced");
  });

  it("is a function of the routes and nothing else", () => {
    // There is no mode field, so nothing can disagree with the four routes.
    const map = applyToEveryWorkload("acme", "gpt-5");
    expect(inferRoutingMode(map)).toBe(inferRoutingMode({ ...map }));
  });
});

describe("scrubbing the routes a removal orphans", () => {
  it("matches a cloud provider precisely by slug", () => {
    const routing: RoutingMap = {
      chat: { kind: "cloud", providerSlug: "acme", model: "gpt-5" },
      reasoning: { kind: "cloud", providerSlug: "openrouter", model: "big" },
    };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("acme", "openai_compatible"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
    expect(next.reasoning).toEqual({ kind: "cloud", providerSlug: "openrouter", model: "big" });
  });

  it("scrubs a CLI login's slug-less routes", () => {
    // Without this, disconnecting Claude Code left workloads pinned to
    // `claude-code:<model>`, which the resolver still honours — so chats kept
    // using the CLI after the provider was removed.
    const routing: RoutingMap = { chat: { kind: "claudeCode", model: "opus" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("claude-code", "claude-code"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
  });

  it("leaves a local route alone while another local runtime remains", () => {
    const routing: RoutingMap = { chat: { kind: "local", model: "llama3.1" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("ollama", "ollama"),
      [provider("lmstudio", "lmstudio")],
      categoryOf,
    );
    expect(reset).toEqual([]);
    expect(next.chat).toEqual({ kind: "local", model: "llama3.1" });
  });

  it("scrubs a local route once no local runtime remains", () => {
    // And before this rule existed the local case was silently a no-op.
    const routing: RoutingMap = { chat: { kind: "local", model: "llama3.1" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("ollama", "ollama"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
  });

  it("never touches a managed or unset row", () => {
    const routing: RoutingMap = { chat: { kind: "managed" }, vision: { kind: "default" } };
    const { reset } = scrubOnRemove(
      routing,
      provider("acme", "openai_compatible"),
      [],
      categoryOf,
    );
    expect(reset).toEqual([]);
  });
});

describe("the second mechanism behind the same invariant", () => {
  it("catches a route edited in outside the UI", () => {
    // The UI path can be bypassed by a config edit or an older build, so an
    // unresolvable route has to be reported at load rather than mid-turn.
    const routing: RoutingMap = {
      chat: { kind: "cloud", providerSlug: "ghost", model: "gpt-5" },
      reasoning: { kind: "cloud", providerSlug: "acme" },
    };
    expect(orphanedRoutes(routing, [provider("acme", "openai_compatible")])).toEqual([
      { workload: "chat", slug: "ghost" },
    ]);
  });
});

describe("what a row offers and reads", () => {
  it("says Choose Model when nothing is set and Change Model when something is", () => {
    expect(rowValue({ kind: "default" }, [])).toEqual({
      value: "No model selected",
      action: "Choose Model",
    });
    expect(rowValue({ kind: "managed" }, []).action).toBe("Change Model");
  });

  it("names the provider by its label, not its slug", () => {
    const acme = { ...provider("acme", "openai_compatible"), label: "Acme gateway" };
    expect(rowValue({ kind: "cloud", providerSlug: "acme", model: "gpt-5" }, [acme]).value).toBe(
      "Acme gateway · gpt-5",
    );
  });

  it("falls back to the slug for a provider it cannot find", () => {
    expect(rowValue({ kind: "cloud", providerSlug: "ghost" }, []).value).toBe("ghost");
  });

  it("does not offer a disabled provider as a routing target", () => {
    const providers = [provider("openrouter", "openrouter"), provider("acme", "openai_compatible", false)];
    expect(routingTargets(providers).map((p) => p.slug)).toEqual(["openrouter"]);
  });
});
