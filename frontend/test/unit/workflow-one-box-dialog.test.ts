// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import { ApiError } from "@/api/types";
import type { WorkflowGraph } from "@/api/workflows";
import { WorkflowCreateDialog } from "@/views/WorkflowCreateDialog";

/**
 * The New-workflow dialog is two dialogs, and the wrong one fails silently.
 *
 * When the copilot can draft, the dialog is one description box and a Create
 * button: no Name, no Workflow ID, no Description, no Nodes, no Connections,
 * and none of the validation that serves them — including "Give the workflow an
 * id.", which used to fire on a dialog the operator had not finished reading.
 * When it cannot draft, the manual form is exactly what it always was, because
 * it is the only way such a company authors anything.
 *
 * `createSurface` is unit-tested exhaustively next door. What is proved HERE is
 * the wiring: that the branch actually reaches the DOM, in both directions.
 * Rendering the form on a company that CAN draft is the dangerous failure —
 * nothing about it looks wrong, it just looks like the version before this
 * change — so it is asserted directly rather than inferred from the helper.
 */

const SCOPE = "/api/v1/companies/acme";

/** The controls that must NOT exist on the one-box dialog. */
const NAME_INPUT = 'input[placeholder="e.g. Campaign pipeline"]';
const ID_INPUT = 'input[placeholder="e.g. campaign_pipeline"]';
const DESCRIPTION_BOX = 'textarea[placeholder="What does this workflow do?"]';

/** A drafted graph the host would answer with. */
const DRAFTED: WorkflowGraph = {
  id: "weekly-digest",
  name: "Weekly digest",
  description: "Every Monday, draft the digest and email it.",
  version: null,
  nodes: [
    { id: "start", kind: "trigger", name: "Start", schedule: "0 9 * * 1" },
    { id: "write", kind: "agent", name: "Draft it", agent: "writer" },
  ],
  edges: [{ from: "start", to: "write" }],
};

interface Stub {
  /** What `POST …/workflows/draft-from-description` answers, or throws. */
  draft?: () => Promise<unknown>;
  /** What `POST …/workflows` answers, or throws. */
  create?: (body: unknown) => Promise<unknown>;
  /** The company's cognition path. `"hosted"` is a company that can draft. */
  cognition?: string;
}

/**
 * Stubs the verbs the dialog reaches. The GETs other than `/inference` are
 * optional picker sources that each degrade on failure, so one rejection stands
 * in for "this host offers none of them".
 */
function stubClient(opts: Stub): OpenCompanyClient {
  return {
    scopeFor: () => SCOPE,
    listTeam: () => Promise.reject(new Error("not offered by this host")),
    get: (path: string) =>
      path.endsWith("/inference")
        ? Promise.resolve({ cognition: opts.cognition ?? "hosted" })
        : Promise.reject(new Error("not offered by this host")),
    post: (path: string, body?: unknown) => {
      if (path.endsWith("/workflows/draft-from-description")) {
        return (
          opts.draft?.() ??
          Promise.resolve({ automatable: true, summary: "a digest", workflow: DRAFTED })
        );
      }
      if (path.endsWith("/workflows/validate")) return Promise.resolve({ valid: true });
      if (path.endsWith("/workflows")) {
        return opts.create?.(body) ?? Promise.resolve(body as WorkflowGraph);
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    },
    put: () => Promise.reject(new Error("no put expected")),
  } as unknown as OpenCompanyClient;
}

let container: HTMLDivElement;
let root: Root;
let onOpenChange: ReturnType<typeof vi.fn>;
let onCreated: ReturnType<typeof vi.fn>;

function inDialog<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(`[data-slot="dialog-content"] ${selector}`);
}

function submitButton(): HTMLButtonElement {
  const el = inDialog<HTMLButtonElement>('[data-testid="workflow-dialog-submit"]');
  if (!el) throw new Error(`no submit button in:\n${document.body.innerHTML}`);
  return el;
}

function describeBox(): HTMLTextAreaElement | null {
  return inDialog<HTMLTextAreaElement>('[data-testid="workflow-describe-box"]');
}

/** Sets a controlled textarea the way a keystroke would. */
function typeDescription(value: string) {
  const box = describeBox();
  expect(box, "the one-box dialog should have a description box").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(box, value);
  box!.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The visible label text of every section heading and control label. */
function dialogText(): string {
  return document.querySelector('[data-slot="dialog-content"]')?.textContent ?? "";
}

async function open(client: OpenCompanyClient) {
  await act(async () => {
    root.render(
      createElement(WorkflowCreateDialog, {
        open: true,
        onOpenChange,
        onCreated,
        client,
        company: "acme",
      }),
    );
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  Element.prototype.scrollIntoView = vi.fn();
  onOpenChange = vi.fn();
  onCreated = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the New-workflow dialog when the copilot can draft", () => {
  it("is one description box — no Name, ID, Description, Nodes or Connections", async () => {
    await open(stubClient({ cognition: "hosted" }));

    expect(describeBox(), "the description box is the whole dialog").toBeTruthy();
    expect(inDialog(NAME_INPUT), "Name must not render").toBeNull();
    expect(inDialog(ID_INPUT), "Workflow ID must not render").toBeNull();
    expect(inDialog(DESCRIPTION_BOX), "the second Description box must not render").toBeNull();
    // The section headings, not just their controls: a heading with no rows
    // under it is the same clutter the redesign removes.
    expect(dialogText()).not.toContain("Nodes");
    expect(dialogText()).not.toContain("Connections");
    expect(dialogText()).not.toContain("Add node");
    expect(dialogText()).not.toContain("Add edge");
    // …and the separate "Draft it" button is gone with the two-step it served.
    expect(inDialog('[data-testid="workflow-copilot-draft"]')).toBeNull();
  });

  it("never raises the id complaint on a dialog that asks for no id", async () => {
    await open(stubClient({ cognition: "hosted" }));

    // Create with an empty box does nothing at all — the button is dead rather
    // than answering with a rule about a field nobody was shown.
    expect(submitButton().disabled, "Create is dead with an empty box").toBe(true);
    await act(async () => {
      submitButton().click();
    });
    expect(dialogText()).not.toContain("Give the workflow an id.");
    expect(inDialog('[data-testid="create-error"]')).toBeNull();
  });

  it("drafts, saves, and hands the canvas the graph and the host's notes", async () => {
    const posted: unknown[] = [];
    await open(
      stubClient({
        cognition: "hosted",
        draft: () =>
          Promise.resolve({
            automatable: true,
            summary: "a weekly digest",
            workflow: DRAFTED,
            notes: ["Matched “the writer” to teammate `writer`.", "   "],
          }),
        create: (body) => {
          posted.push(body);
          return Promise.resolve({ ...(body as WorkflowGraph), version: "v1" });
        },
      }),
    );

    await act(async () => {
      typeDescription("Every Monday, draft the digest and email it.");
    });
    await act(async () => {
      submitButton().click();
    });

    // One write, of the host's own drafted graph — not a round trip through
    // form state the dialog is no longer rendering.
    expect(posted).toHaveLength(1);
    expect((posted[0] as WorkflowGraph).id).toBe("weekly-digest");
    expect((posted[0] as WorkflowGraph).nodes).toHaveLength(2);
    // The canvas is where review happens now, so it is handed both the saved
    // graph and the corrections the host made on the way to it — blank notes
    // dropped, because an empty bullet is not a correction.
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.calls[0]![0].version).toBe("v1");
    expect(onCreated.mock.calls[0]![1]).toEqual([
      "Matched “the writer” to teammate `writer`.",
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a decline as advice, with a way past it", async () => {
    const posted: unknown[] = [];
    await open(
      stubClient({
        cognition: "hosted",
        draft: () =>
          Promise.resolve({
            automatable: false,
            reason: "This is a one-off — just do it once rather than building it.",
          }),
        create: (body) => {
          posted.push(body);
          return Promise.resolve(body as WorkflowGraph);
        },
      }),
    );

    await act(async () => {
      typeDescription("Email Priya the Q3 numbers, once.");
    });
    await act(async () => {
      submitButton().click();
    });

    // The reason is shown, and nothing was written.
    const declined = inDialog('[data-testid="workflow-draft-declined"]');
    expect(declined, "a decline must be shown, not swallowed").toBeTruthy();
    expect(declined!.textContent).toContain("This is a one-off");
    expect(posted, "a decline writes nothing on its own").toHaveLength(0);

    // …and the operator who disagrees is not blocked. The reason is advice.
    const anyway = inDialog<HTMLButtonElement>('[data-testid="workflow-create-anyway"]');
    expect(anyway, "a decline must offer a way past it").toBeTruthy();
    await act(async () => {
      anyway!.click();
    });
    expect(posted, "Create it anyway must actually create").toHaveLength(1);
    const graph = posted[0] as WorkflowGraph;
    // Named and described from the operator's own sentence, with the same
    // single trigger the blank form has always started from.
    expect(graph.name).toBe("Email Priya the Q3 numbers");
    expect(graph.id).toBe("email-priya-the-q3-numbers");
    expect(graph.description).toBe("Email Priya the Q3 numbers, once.");
    expect(graph.nodes.map((n) => n.kind)).toEqual(["trigger"]);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("hands over the fields when the host refuses the minted id", async () => {
    // The refusal that actually happens: the host mints ids by deduping against
    // SAVED workflows only, so two similar descriptions drafted before either
    // is created mint the same id — and the second Create is told to pick a
    // different one, by a dialog with no id field.
    await open(
      stubClient({
        cognition: "hosted",
        create: () =>
          Promise.reject(
            new ApiError(
              409,
              "conflict",
              "A workflow with id `weekly-digest` already exists. Pick a different id.",
            ),
          ),
      }),
    );

    await act(async () => {
      typeDescription("Every Monday, draft the digest and email it.");
    });
    await act(async () => {
      submitButton().click();
    });

    // The fields come back, carrying the graph that was refused, so the
    // instruction in the message is one the operator can actually follow.
    expect(inDialog(ID_INPUT), "the id field must come back").toBeTruthy();
    expect(inDialog<HTMLInputElement>(ID_INPUT)!.value).toBe("weekly-digest");
    expect(inDialog<HTMLInputElement>(NAME_INPUT)!.value).toBe("Weekly digest");
    expect(dialogText()).toContain("Nodes");
    expect(inDialog('[data-testid="create-error"]')!.textContent).toContain(
      "Pick a different id",
    );
    expect(onCreated, "a refused write creates nothing").not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("hands over the fields when the build turns out to have no copilot", async () => {
    await open(
      stubClient({
        cognition: "hosted",
        draft: () =>
          Promise.reject(new ApiError(404, "not_wired", "This build has no copilot wired.")),
      }),
    );

    await act(async () => {
      typeDescription("Every Monday, draft the digest.");
    });
    await act(async () => {
      submitButton().click();
    });

    expect(inDialog(NAME_INPUT), "the manual form is the fallback").toBeTruthy();
    expect(inDialog(ID_INPUT)).toBeTruthy();
    expect(dialogText()).toContain("This build has no copilot wired.");
  });
});

describe("the New-workflow dialog when the copilot cannot draft", () => {
  it("renders the manual form and today's notice, unchanged", async () => {
    await open(stubClient({ cognition: "echo" }));

    // Every field the one-box dialog removes is here, because this is the only
    // way a company with no model configured authors anything.
    expect(inDialog(NAME_INPUT), "Name").toBeTruthy();
    expect(inDialog(ID_INPUT), "Workflow ID").toBeTruthy();
    expect(inDialog(DESCRIPTION_BOX), "Description").toBeTruthy();
    expect(dialogText()).toContain("Nodes");
    expect(dialogText()).toContain("Add node");
    expect(dialogText()).toContain("Connections");
    expect(dialogText()).toContain("Add edge");
    // Today's notice, word for word.
    expect(dialogText()).toContain(
      "This company has no model configured, so the copilot can't draft yet — " +
        "set one in Settings → Inference, or build the graph by hand below.",
    );
    // …and today's disabled composer, not the one-box one.
    const draftIt = inDialog<HTMLButtonElement>('[data-testid="workflow-copilot-draft"]');
    expect(draftIt, "the Draft it button stays on this path").toBeTruthy();
    expect(draftIt!.disabled).toBe(true);
    expect(describeBox(), "the one-box control must not render here").toBeNull();
  });

  it("still refuses a create with no id, from the field that asks for one", async () => {
    await open(stubClient({ cognition: "echo" }));

    await act(async () => {
      submitButton().click();
    });
    // The complaint the one-box dialog must never raise is exactly right here:
    // there is an id field on screen, empty, and it is what Create needs.
    expect(inDialog('[data-testid="create-error"]')!.textContent).toContain(
      "Give the workflow an id.",
    );
  });
});
