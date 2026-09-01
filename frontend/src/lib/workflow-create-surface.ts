import type { CognitionPath } from "@/api/inference";
import { ApiError } from "@/api/types";

/**
 * Which of the two New-workflow dialogs is on screen.
 *
 * - `describe` — the copilot can draft, so the dialog is **one box**: a sentence
 *   and Create. Name, Workflow ID, Description, Nodes and Connections are not
 *   rendered at all, and neither is the validation that serves them. Create
 *   drafts, saves, and lands the operator on the canvas.
 * - `form` — the manual graph form, byte-for-byte what the dialog has always
 *   been. Edit mode is always this; so is a create on a company whose copilot
 *   cannot draft.
 */
export type CreateSurface = "describe" | "form";

/**
 * The **one** place the two dialogs are told apart.
 *
 * A pure function, exported and exhaustively tested, because the failure here is
 * silent in one direction: if the copilot is reachable and this answers `form`,
 * nothing breaks — the dialog just looks like it always did, and nobody notices
 * the redesign never shipped. A predicate spelled inline in the component would
 * be provable only by rendering it, and only for the cases somebody thought to
 * render.
 *
 * ## Why an unsettled cognition read means `describe`
 *
 * `cognition` is `null` both while `/inference` is in flight and on a host with
 * no such route (issue #753 leaves the copilot enabled in that case rather than
 * refusing to draft because we could not confirm). Both are answered `describe`,
 * biasing toward the new dialog, because the two directions fail very
 * differently:
 *
 * - Guessing `describe` on a company that turns out not to be able to draft is
 *   **self-correcting and loud**: Create calls the draft route, the host answers
 *   a capability gap, {@link draftCapabilityGap} catches it, and the form
 *   appears with the host's own message. One click, and the operator sees why.
 * - Guessing `form` on a company that *can* draft is **silent**: it looks
 *   exactly like the dialog did before this change, so nothing reports it.
 *
 * The cheap-and-recoverable wrong answer is the one to risk.
 */
export function createSurface(args: {
  /** Edit mode. An edit already has a graph, so there is nothing to draft. */
  editing: boolean;
  /** The company's cognition path; `null` while unread or on a host without the route. */
  cognition: CognitionPath | null;
  /**
   * The host's message from a draft attempt that hit a capability gap, from
   * {@link draftCapabilityGap}. `null` until one happens.
   */
  capabilityGap: string | null;
  /**
   * Whether a one-box create was **refused** by the host.
   *
   * The one that actually happens: the host mints a draft's id by slugging the
   * name and deduping against the workflows it has *saved*
   * (`safe_workflow_id`, `src/harness/built_in/workflow_build.rs`), but nothing
   * reserves it — so two similar descriptions drafted before either is created
   * mint the same id, and the second Create answers
   * `409 A workflow with id ... already exists. Pick a different id.` A dialog
   * with no id field has no way to obey that, so the refusal hands the operator
   * the full form loaded with the graph that was refused. The one-box dialog
   * never dead-ends.
   */
  writeRefused: boolean;
}): CreateSurface {
  if (args.editing) return "form";
  // Issue #753: `echo` is the offline brain — there is no model to draft with.
  if (args.cognition === "echo") return "form";
  if (args.capabilityGap !== null) return "form";
  if (args.writeRefused) return "form";
  return "describe";
}

/**
 * The three ways a build can answer "I cannot draft at all", as opposed to
 * "I drafted nothing useful".
 *
 * These are facts about the deployment, not about the description: `not_wired`
 * (404) is a build with no embedded brain, `inference_required` (409) a company
 * with no provider configured, `restart_required` (409) a provider configured
 * since the process booted. None of them is fixed by rewording the sentence, so
 * each one retires the one-box dialog for this open and hands the operator the
 * manual form instead of a Create button that cannot work.
 */
const CAPABILITY_CODES = new Set(["not_wired", "inference_required", "restart_required"]);

/**
 * Classifies a failed draft: the host's message when the copilot is
 * **unavailable**, `null` for every other failure.
 *
 * Keyed on the structured `code`, never the prose — the same rule the run
 * refusal banner follows, and for the same reason: a reworded host message must
 * not silently change which dialog an operator sees.
 *
 * A network blip, a 500 or a 400 answers `null` deliberately. Those say nothing
 * about whether this company can draft, and collapsing the dialog to the manual
 * form over a dropped connection would be a redesign undone by a flaky wifi.
 */
export function draftCapabilityGap(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (!CAPABILITY_CODES.has(err.code)) return null;
  return err.message;
}

/** Cap on a derived name, so a rambling sentence cannot become a 400-character title. */
const NAME_CAP = 60;

/**
 * A workflow name from the sentence the operator typed — the fallback for the
 * one path that has no copilot draft to take a name from.
 *
 * The copilot names its own drafts, so this is used only by "Create it anyway",
 * where the operator has overruled a decline and there is nothing but their
 * sentence to go on. It takes the **first clause** — up to the first sentence or
 * clause break — because that is where an English description says what the
 * thing is, and the rest says how.
 *
 * `"Every Monday, draft the digest and email it."` → `"Every Monday"`. Crude,
 * and deliberately so: the name is renameable on the canvas a second later, and
 * a name that reads like the operator's own words beats one invented for them.
 *
 * Returns `""` when the sentence has nothing usable — the caller must treat that
 * as "no name derived" and ask for one, never write an empty name. An empty name
 * also derives an empty id, and an empty id is the permanent join key nothing
 * can fix afterwards.
 */
export function nameFromDescription(description: string): string {
  const firstClause = description.split(/[.;\n,!?]/, 1)[0] ?? "";
  const collapsed = firstClause.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const capped =
    collapsed.length <= NAME_CAP ? collapsed : `${collapsed.slice(0, NAME_CAP).trimEnd()}…`;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
