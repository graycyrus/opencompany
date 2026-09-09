// @vitest-environment jsdom
//
// The Add-agent dialog collects three things and gets out of the way.
//
// # What it replaced, and why this file changed shape
//
// This used to pin that the dialog's Instructions box reached the host (issue
// #1776), over a dialog that collected name, role, description, persona, an
// inbox switch and a daily cap — with a copilot that would design all of it
// from one sentence (#1989) and a hand-over to the long form when that design
// was refused.
//
// The dialog asks for a name, a face and a post now. An agent is not finished
// at the moment it is created, and this dialog was the only place pretending
// otherwise: the description and the persona are written on the agent's own
// page, next to the copilot that drafts them and the record it is grounded in.
// So there is no Instructions box left to pin, and the contract worth pinning
// moved.
//
// # What is worth pinning instead
//
// Three things, each of which fails silently if it breaks:
//
//   1. **The dialog asks for exactly three things.** A regression that put the
//      long form back would look correct on screen — it did, for months — and
//      nothing would report it.
//   2. **The avatar is a second write.** `addTeamMember` takes no avatar, so a
//      chosen face has to be sent as its own `updateAgent` call against the id
//      the host answers with. Miss it and the agent is created wearing the
//      hashed mascot, which looks like a face nobody chose rather than a
//      dropped write.
//   3. **It lands on the agent's page.** The dialog collects three of the
//      fields an agent has; a create that stayed on the roster would leave the
//      rest unwritten with nothing pointing at where to write them.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import type { TeamMemberDto } from "@/api/types";

const toasts = vi.hoisted(() => ({
  base: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("sonner", () => {
  const toast = Object.assign(toasts.base, {
    success: toasts.success,
    error: toasts.error,
    warning: toasts.warning,
    info: toasts.info,
  });
  return { toast };
});

const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  fetchBoardColumns: vi.fn(),
  fetchMe: vi.fn(),
  listPeople: vi.fn(),
  getInferenceStatus: vi.fn(),
}));

vi.mock("@/api/tasks", () => ({ listTasks: api.listTasks }));
vi.mock("@/lib/board-columns", () => ({
  fetchBoardColumns: api.fetchBoardColumns,
  IN_FLIGHT_COLUMNS: ["planning", "in_progress"],
}));
vi.mock("@/api/auth", () => ({ me: api.fetchMe, listPeople: api.listPeople }));
vi.mock("@/api/inference", () => ({ getInferenceStatus: api.getInferenceStatus }));

const { TeamView } = await import("@/views/TeamView");

const ROSTER: TeamMemberDto[] = [
  { id: "maya", name: "Maya", role: "Research Lead", description: "Tracks competitors." },
];

let container: HTMLDivElement;
let root: Root;
let added: Array<Record<string, unknown>>;
let patched: Array<{ id: string; patch: Record<string, unknown> }>;

function fakeClient(): OpenCompanyClient {
  return {
    scopeFor: (company: string | null) => `/api/v1/${company ?? "company"}`,
    listTeam: async () => ROSTER,
    addTeamMember: async (input: Record<string, unknown>) => {
      added.push(input);
      return { id: "growth", name: "Growth", role: "Growth Marketer" } as TeamMemberDto;
    },
    // The avatar's own write, recorded separately because that is the point:
    // `addTeamMember` has no avatar field, so a face has to arrive here.
    updateAgent: async (id: string, patch: Record<string, unknown>) => {
      patched.push({ id, patch });
      return { id } as unknown as TeamMemberDto;
    },
  } as unknown as OpenCompanyClient;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  added = [];
  patched = [];
  vi.clearAllMocks();
  api.listTasks.mockResolvedValue([]);
  api.fetchBoardColumns.mockResolvedValue([]);
  api.fetchMe.mockResolvedValue({ id: "u1", role: "admin" });
  api.listPeople.mockResolvedValue([]);
  // Still mocked because the roster reads it, but it no longer decides which
  // dialog renders: there is only one dialog now, and it asks nothing a model
  // could draft.
  api.getInferenceStatus.mockResolvedValue({ cognition: "echo" });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function byText(tag: string, text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(tag)).find(
    (el) => el.textContent?.trim() === text,
  );
}

function click(el: HTMLElement | undefined | null) {
  if (!el) throw new Error("no such element");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Opens the dialog and flushes the roster's pending reads. */
async function openDialog() {
  click(byText("button", "Add agent"));
  await act(async () => {});
}

/** Types into a controlled input/textarea the way React sees it. */
function type(id: string, value: string) {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (!el) throw new Error(`no field #${id}`);
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("adding a agent (issue #1776)", () => {
  it("sends the persona the dialog collected", async () => {
    await act(async () => {
      root.render(
        createElement(TeamView, {
          client: fakeClient(),
          company: "acme",
          sub: null,
          onOpenAgent: vi.fn(),
          refreshKey: 0,
          onRunSetup: vi.fn(),
          onManageDesks: vi.fn(),
          onNavigateToDesk: vi.fn(),
        }),
      );
    });

    await openDialog();
    type("member-name", "Growth");
    type("member-role", "Growth Marketer");
    type("member-description", "Owns paid acquisition and reports on ROAS.");
    type(
      "member-instructions",
      "Confirm the budget before launching a campaign. Flag anything under 2x.",
    );

    // The footer's Add teammate — the dialog is open, so it is the last one.
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button")).filter(
      (el) => el.textContent?.trim() === "Add agent",
    );
    await act(async () => {
      buttons[buttons.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(added).toHaveLength(1);
    expect(added[0].instructions).toBe(
      "Confirm the budget before launching a campaign. Flag anything under 2x.",
    );
    expect(added[0].role).toBe("Growth Marketer");
  });

  /// At creation there is no blueprint to override, so an untouched box means
  /// "no persona" — not an empty one stored as an override.
  it("leaves the persona off the wire when the box was never filled in", async () => {
    await act(async () => {
      root.render(
        createElement(TeamView, {
          client: fakeClient(),
          company: "acme",
          sub: null,
          onOpenAgent: vi.fn(),
          refreshKey: 0,
          onRunSetup: vi.fn(),
          onManageDesks: vi.fn(),
          onNavigateToDesk: vi.fn(),
        }),
      );
    });

    await openDialog();
    type("member-name", "Growth");
    type("member-role", "Growth Marketer");

    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button")).filter(
      (el) => el.textContent?.trim() === "Add agent",
    );
    await act(async () => {
      buttons[buttons.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(added).toHaveLength(1);
    expect(added[0].instructions).toBeUndefined();
  });
});
