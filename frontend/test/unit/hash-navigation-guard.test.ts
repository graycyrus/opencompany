// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useHashNavigationGuard, useHashView } from "@/hooks/use-hash-view";

/**
 * Codex review, PR #2054: a dirty `WorkflowCreateDialog` restores a changed
 * hash and raises a discard confirmation from its OWN `hashchange` listener —
 * but that listener necessarily mounts, and so registers, after the app
 * shell's own top-level `useHashView` router already has. On Back or a manual
 * hash edit, the shell's router read the NEW hash first and queued a route
 * change; React batched that together with the dialog's own confirmation
 * `setState`, and since the route change unmounted the dialog, the
 * confirmation's state died with it in the same commit that would have shown
 * it — an operator's draft could vanish with no confirmation ever rendered,
 * on exactly the path defect B-081 exists to protect.
 *
 * `useHashNavigationGuard` fixes this by letting a dirty form claim a
 * navigation before it happens (as soon as it becomes dirty, not inside a
 * `hashchange` listener), so every OTHER `useHashView` instance's own
 * listener — checked as the very first line, a plain synchronous module
 * counter rather than anything that waits for a render — sees the claim and
 * leaves its route alone. These specs drive that interaction directly,
 * without the full dialog: a `Router` probe stands in for the app shell's own
 * router, and a `Guard` probe claims (or releases) the navigation the same
 * way `WorkflowCreateDialog` does.
 */

const VIEWS = ["workflows", "settings"] as const;

let container: HTMLDivElement;
let root: Root;
let seenRoute: [string, string | null];

function Router() {
  const [view, sub] = useHashView<(typeof VIEWS)[number]>(VIEWS, "workflows");
  seenRoute = [view, sub];
  return null;
}

function Guard({ active }: { active: boolean }) {
  useHashNavigationGuard(active);
  return null;
}

async function renderRouterAndGuard(active: boolean) {
  await act(async () => {
    root.render(
      createElement("div", null, createElement(Router), createElement(Guard, { active })),
    );
  });
}

async function fireHashChange(hash: string) {
  window.location.hash = hash;
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "#/workflows");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useHashNavigationGuard blocking useHashView", () => {
  it("leaves the router's route alone while a guard is active", async () => {
    await renderRouterAndGuard(true);
    expect(seenRoute).toEqual(["workflows", null]);

    await fireHashChange("#/settings");

    // The hash itself moved (a real Back press or edit already did that,
    // outside this router's control) — what must NOT have moved is the
    // router's own read of it, which is what actually swaps the mounted view
    // and would have unmounted whatever is showing the discard confirmation.
    expect(seenRoute).toEqual(["workflows", null]);
  });

  it("resumes reacting once the guard releases", async () => {
    await renderRouterAndGuard(true);
    await fireHashChange("#/settings");
    expect(seenRoute).toEqual(["workflows", null]);

    // The guard lifts (the dialog closed, or the draft matched pristine
    // again) — a router mounted before or after the guard reacts to the next
    // navigation exactly as if the guard had never existed.
    await renderRouterAndGuard(false);
    await fireHashChange("#/settings");
    expect(seenRoute).toEqual(["settings", null]);
  });

  it("reacts normally with no guard mounted at all", async () => {
    await act(async () => {
      root.render(createElement(Router));
    });
    await fireHashChange("#/settings");
    expect(seenRoute).toEqual(["settings", null]);
  });

  it("un-claims on unmount, so a guard left mounted forever cannot wedge navigation", async () => {
    await renderRouterAndGuard(true);
    await act(async () => root.unmount());

    // Re-mount only the router — the guard component, and its claim, are gone.
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Router));
    });
    await fireHashChange("#/settings");
    expect(seenRoute).toEqual(["settings", null]);
  });
});
