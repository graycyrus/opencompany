// The animated Rive mascot: an alternate teammate face, live at exactly the
// hero surfaces that mount it (the agent profile sheet, the agent detail
// page's header, the avatar picker). See `docs/issue/mascot-profile-avatar/`
// for the deep-dive this was planned from.
//
// Deliberately its own component rather than a `TeammateAvatar` variant: a
// `mascot:` reference resolves to no static image (`staticAvatarSrc` in
// `lib/avatar.ts`), so every other surface keeps drawing the tone tile with
// zero changes, and only a caller that explicitly wants the live canvas reaches
// for this.

import { useEffect, useState } from "react";
import {
  useRive,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
  useViewModelInstanceNumber,
} from "@rive-app/react-canvas";

import { hexToRgb, MASCOT_COLORWAYS, mascotSrc, type MascotColorway } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * The mascot's own default colorway (`handColor`/`skinColor` in the Rive
 * file's ViewModel) — `MASCOT_COLORWAYS[0]` (`"amber"`), matched to the
 * file's shipped default so a teammate with no chosen colorway renders
 * exactly as v1 always has.
 */
const DEFAULT_COLORWAY = MASCOT_COLORWAYS[0];

export type MascotState = "idle" | "hover" | "replying";

/**
 * The Number-input value (`mascotAnimationNumber`) for each named state, used
 * when no explicit `costume` is chosen.
 *
 * Confirmed live (canvas-pixel sampling, not just a round-tripped getter):
 * `1` renders the mascot in its cap; `2` swaps it to headphones. `replying`
 * (`3`) is wired the same way but its visual is unconfirmed as a *meaningful*
 * "replying" cue — it is simply the third costume in file order. See
 * `docs/issue/mascot-profile-avatar/open-questions.md` §1 for what has
 * actually been watched play.
 */
const STATE_NUMBERS: Record<MascotState, number> = {
  idle: 1,
  hover: 2,
  replying: 3,
};

interface Props {
  /**
   * Which of the file's states to play. Defaults to idle. Ignored once
   * {@link Props.costume} is set — a chosen costume is a fixed look, not an
   * idle/hover pair, so it overrides the state-driven swap entirely (see the
   * note at {@link Props.costume}).
   */
  state?: MascotState;
  /**
   * The chosen colorway name (`MASCOT_COLORWAYS` in `lib/avatar.ts`), or
   * `undefined` for the file's own default (`"amber"`). An unrecognised name
   * — stale client code against a host that has since widened the list, or
   * vice versa — falls back to the default rather than crashing the Rive
   * ViewModel write.
   */
  colorway?: MascotColorway | string;
  /**
   * The chosen costume number (`1..=MASCOT_COSTUME_COUNT`), or `undefined`
   * for the state-driven `idle`/`hover`/`replying` swap {@link STATE_NUMBERS}
   * already gives every mascot.
   *
   * Deliberately **overrides** the state swap rather than combining with it:
   * the two mechanisms share the same `mascotAnimationNumber` slot, and a
   * teammate whose operator picked "Sunglasses" should wear sunglasses on
   * hover too, not have that choice silently overridden back to "Headphones"
   * the moment a pointer passes over it. An agent with no chosen costume is
   * unaffected — it keeps the original idle/hover/replying feel.
   */
  costume?: number;
  className?: string;
  "data-testid"?: string;
}

/**
 * `prefers-reduced-motion: reduce` holds the mascot on its idle frame.
 *
 * The same accessibility carve-out an animated GIF avatar already has to
 * consider (`docs/spec/runtime/avatars.md`) — "a moving face is more
 * recognisable" assumes the viewer can tolerate motion, which reduced-motion
 * says they can't. Duplicated locally rather than shared: three other
 * components in this codebase (`WorkingIndicator`, `ChatLiveReceipt`,
 * `RevealSelectedNode`) already each keep their own copy of this exact hook
 * rather than a shared one, so this follows the established convention.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mql) return;
    setReduced(mql.matches);
    const onChange = () => setReduced(mql.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);
  return reduced;
}

/**
 * The live animated mascot. Mount this instead of `TeammateAvatar` only at
 * the small number of hero surfaces that want it live — see
 * `docs/issue/mascot-profile-avatar/rendering-strategy.md` for which those
 * are and why every other avatar surface must not mount this.
 *
 * Callers should `lazy()`-load this module (mirroring the
 * `lazy(() => import(...).then((m) => ({ default: m.X })))` convention this
 * codebase already uses for `recharts`/`@xyflow/react`/`react-joyride`) rather
 * than importing `@rive-app/react-canvas` directly — this file is the
 * code-split boundary.
 */
export function MascotAvatar({
  state = "idle",
  colorway,
  costume,
  className,
  "data-testid": testId,
}: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { rive, RiveComponent } = useRive({
    src: mascotSrc("animated"),
    // The file has one *loadable* artboard, literally named "Artboard" —
    // `useRive({ artboard: "Mascot" })` throws "Invalid artboard name or no
    // default artboard", so `Mascot Instance` (seen in the object graph) is
    // a node inside `Artboard`, not a separately loadable artboard; there is
    // no nested artboard to route around. This omits `artboard` and lets the
    // runtime use its default.
    //
    // `Artboard` carries three state machines (`rive.stateMachineNames`):
    // `MascotProfileAnimations`, `animtionStatemachin`, and `State Machine
    // 1`. The Rive editor's Data panel shows `mascotAnimationNumber` bound
    // under `State Machine 1`, which is what an earlier pass loaded here —
    // the ViewModel write round-tripped through its own getter, but the
    // rendered artboard never moved (canvas-pixel sampling, byte-identical
    // across states). `MascotProfileAnimations` is the one that actually
    // drives the costume swap: loading *this* one instead, with the same
    // ViewModel writes below unchanged, visibly swaps the mascot's cap for
    // headphones on hover (confirmed both by pixel sampling and a
    // screenshot). Both machines can apparently read the same bound
    // ViewModel instance; only one of them acts on it. See
    // `docs/issue/mascot-profile-avatar/open-questions.md` §3.
    //
    // `autoBind: true` lets the runtime perform its own default
    // ViewModel-instance binding at load time, ahead of this component's own
    // manual `useViewModel`/`useViewModelInstance` calls below.
    stateMachine: "MascotProfileAnimations",
    autoBind: true,
    autoplay: !reducedMotion,
  });

  const viewModel = useViewModel(rive, { useDefault: true });
  const vmi = useViewModelInstance(viewModel, { useDefault: true, rive });

  const { setValue: setAnimationNumber } = useViewModelInstanceNumber(
    "mascotAnimationNumber",
    vmi,
  );
  const { setRgb: setHandColor } = useViewModelInstanceColor("handColor", vmi);
  const { setRgb: setSkinColor } = useViewModelInstanceColor("skinColor", vmi);

  // The chosen colorway, or the file's own default when unset or unrecognised.
  // Set whenever it changes — not just once — so a picker preview updates
  // live as an operator tries different swatches before saving.
  useEffect(() => {
    if (!vmi) return;
    const match = MASCOT_COLORWAYS.find((c) => c.name === colorway) ?? DEFAULT_COLORWAY;
    setHandColor(...hexToRgb(match.hand));
    setSkinColor(...hexToRgb(match.skin));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmi, colorway]);

  // The chosen costume overrides the idle/hover/replying swap entirely (see
  // the `costume` prop doc); otherwise the original state-driven number.
  useEffect(() => {
    if (!vmi) return;
    const number =
      costume ?? (reducedMotion ? STATE_NUMBERS.idle : STATE_NUMBERS[state]);
    setAnimationNumber(number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmi, state, reducedMotion, costume]);

  return (
    <div
      className={cn("overflow-hidden rounded-xl", className)}
      data-testid={testId}
      aria-hidden
    >
      <RiveComponent />
    </div>
  );
}
