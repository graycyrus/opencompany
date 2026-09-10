// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPROVALS_COUNT_CAP,
  ApprovalsButton,
  approvalsCount,
  approvalsLabel,
} from "@/components/approvals-button";
import { OverviewButton, OVERVIEW_LABEL } from "@/components/overview-button";

/**
 * The two jumps in the title row's first group — and the signal that moved into
 * one of them.
 *
 * # What replaced what
 *
 * The approvals count was a `SidebarMenuBadge` on a sidebar row, plus a
 * `SidebarMenuDot` that existed *only* because that badge hides itself on the
 * 32px collapsed rail (issue #1018). Two elements for one number, the second of
 * them a workaround for the first disappearing.
 *
 * The title row does not collapse, so the disappearance cannot happen and both
 * are deleted. What must not be lost with them is the thing #1018 was actually
 * about: **the signal has to reach someone who is not reading a number.** For an
 * icon-only control the accessible name is the whole of what a screen reader
 * gets, so that is where the count and the word "approvals" both live — the same
 * sentence the dot's `aria-label` carried, verbatim.
 *
 * # What is pinned here, and what is not
 *
 * jsdom applies no Tailwind, so nothing about *visibility* can be computed —
 * the ladder's pixel behaviour is a browser measurement recorded in the PR.
 * What is pinned is behaviour a render can actually decide: the name, the
 * pluralisation, the zero state, the cap, and that the sidebar no longer draws
 * a second copy of the count.
 */

let container: HTMLDivElement;
let root: Root;

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

function renderApprovals(pending: number, extra: Record<string, unknown> = {}) {
  act(() => {
    root.render(createElement(ApprovalsButton, { pending, onNavigate: () => {}, ...extra }));
  });
  return container.querySelector("[data-testid=title-bar-approvals]") as HTMLElement;
}

function renderOverview(extra: Record<string, unknown> = {}) {
  act(() => {
    root.render(createElement(OverviewButton, { onNavigate: () => {}, ...extra }));
  });
  return container.querySelector("[data-testid=title-bar-overview]") as HTMLElement;
}

describe("the approvals jump", () => {
  it("names what is waiting and how many, in the sentence the rail dot carried", () => {
    // The dot's `aria-label` was `${pending} approvals need you`. That wording
    // is the whole of the signal for anyone who never sees the chip, so it is
    // kept word for word rather than re-written for a new home.
    expect(renderApprovals(19).getAttribute("aria-label")).toBe("19 approvals need you");
    expect(renderApprovals(19).getAttribute("title")).toBe("19 approvals need you");
  });

  it("says 'approval needs' for exactly one", () => {
    expect(approvalsLabel(1)).toBe("1 approval needs you");
    expect(renderApprovals(1).getAttribute("aria-label")).toBe("1 approval needs you");
  });

  it("is just a destination when nothing is waiting", () => {
    // "0 approvals need you" is a sentence about attention at the moment
    // nothing wants any. The glyph stays; the chip does not appear.
    const button = renderApprovals(0);
    expect(button.getAttribute("aria-label")).toBe("Approvals");
    expect(button.querySelector("[data-testid=title-bar-approvals-count]")).toBeNull();
    // Still on screen — the row's floor is approvals, autonomy and you, and an
    // empty queue is not a reason to remove the way to reach it.
    expect(button).not.toBeNull();
  });

  it("prints the count, and caps the digits without capping the fact", () => {
    expect(
      renderApprovals(7).querySelector("[data-testid=title-bar-approvals-count]")?.textContent,
    ).toBe("7");

    const over = APPROVALS_COUNT_CAP + 1;
    const button = renderApprovals(over);
    // Three digits do not fit a mark on the corner of a 32px control.
    expect(button.querySelector("[data-testid=title-bar-approvals-count]")?.textContent).toBe(
      `${APPROVALS_COUNT_CAP}+`,
    );
    // But the exact number still reaches a screen reader, and still reaches a
    // test through the closed control.
    expect(button.getAttribute("aria-label")).toBe(`${over} approvals need you`);
    expect(button.getAttribute("data-pending")).toBe(String(over));
    expect(approvalsCount(APPROVALS_COUNT_CAP)).toBe(String(APPROVALS_COUNT_CAP));
  });

  it("does not announce the count twice", () => {
    // The button already says "3 approvals need you". A chip that is also read
    // appends a bare "3" to that sentence.
    const chip = renderApprovals(3).querySelector(
      "[data-testid=title-bar-approvals-count]",
    ) as HTMLElement;
    expect(chip.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks itself as the page you are on, in more than a colour", () => {
    expect(renderApprovals(0, { active: true }).getAttribute("aria-current")).toBe("page");
    expect(renderApprovals(0).getAttribute("aria-current")).toBeNull();
  });

  it("navigates when pressed", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(createElement(ApprovalsButton, { pending: 2, onNavigate }));
    });
    act(() => {
      (container.querySelector("[data-testid=title-bar-approvals]") as HTMLElement).click();
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("the overview jump", () => {
  it("keeps its name reachable without printing it", () => {
    // A labelled button in a chrome band reads as content. The word goes, and
    // both of the channels that can still carry it do.
    const button = renderOverview();
    expect(button.getAttribute("aria-label")).toBe(OVERVIEW_LABEL);
    expect(button.getAttribute("title")).toBe(OVERVIEW_LABEL);
    expect(button.textContent).toBe("");
  });

  it("marks itself as the page you are on", () => {
    expect(renderOverview({ active: true }).getAttribute("aria-current")).toBe("page");
    expect(renderOverview().getAttribute("aria-current")).toBeNull();
  });

  it("navigates when pressed", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(createElement(OverviewButton, { onNavigate }));
    });
    act(() => {
      (container.querySelector("[data-testid=title-bar-overview]") as HTMLElement).click();
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("the sidebar carries the count again", () => {
  const shell = readFileSync(
    resolve(process.cwd(), "src/components/app-shell.tsx"),
    "utf8",
  );
  const sidebar = readFileSync(
    resolve(process.cwd(), "src/components/ui/sidebar.tsx"),
    "utf8",
  );
  const nav = readFileSync(
    resolve(process.cwd(), "src/components/sidebar-navigation.tsx"),
    "utf8",
  );

  it("renders the badge and the dot together, never one alone", () => {
    // The pair is the whole point (#1018): `SidebarMenuBadge` hides itself on
    // the icon rail, so a badge with no dot is a count that vanishes the moment
    // the sidebar collapses — and a collapsed rail showing nothing is
    // indistinguishable from all-clear. A dot with no badge is the mirror bug:
    // an attention mark that never says how many.
    expect(nav).toMatch(/<SidebarMenuBadge/);
    expect(nav).toMatch(/<SidebarMenuDot/);
  });

  it("keeps the dot primitive and its mirror rule together", () => {
    expect(sidebar).toMatch(/function SidebarMenuDot/);
    // The badge hides on the rail; the dot shows only there. Neither class is
    // decoration, and a change to one without the other reopens #1018.
    expect(sidebar).toContain("group-data-[collapsible=icon]:hidden");
    expect(sidebar).toContain("group-data-[collapsible=icon]:block");
  });

  it("feeds the sidebar the same single pending value", () => {
    // Never re-counted. `feed.status.pending_approvals` is the one source, and
    // the contract issue #932 pins is that there is exactly one — which is why
    // it is passed through rather than derived where it is drawn.
    expect(shell).toMatch(/<SidebarNavigation[^>]*pending=\{pending\}/);
    // And the title row no longer carries a second copy of it.
    expect(shell).not.toMatch(/<ApprovalsButton/);
  });
});
