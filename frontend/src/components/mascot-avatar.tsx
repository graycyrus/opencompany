// The animated Rive mascot: an alternate teammate face, live at exactly two
// hero surfaces (the agent profile sheet, the avatar picker). See
// `docs/issue/mascot-profile-avatar/` for the deep-dive this was planned from.
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

import { mascotSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * The mascot's own default colorway (`handColor`/`skinColor` in the Rive
 * file's ViewModel). v1 ships this for every teammate — see
 * `docs/issue/mascot-profile-avatar/state-mapping.md` for why per-tone
 * variation is a deliberate v1.5+ cut rather than something guessed at here.
 */
const HAND_COLOR: [number, number, number] = [0xb4, 0x90, 0x0b];
const SKIN_COLOR: [number, number, number] = [0xf7, 0xd1, 0x45];

export type MascotState = "idle" | "hover" | "replying";

/**
 * The Number-input value (`mascotAnimationNumber`) for each named state.
 *
 * State Machine 1 has a hard 4-slot budget (`glass1`-`glass4`); idle is the
 * file's own default. Confirmed empirically by loading the file and watching
 * each state play (`docs/issue/mascot-profile-avatar/open-questions.md` §1) —
 * do not renumber without watching the states again.
 */
const STATE_NUMBERS: Record<MascotState, number> = {
  idle: 1,
  hover: 2,
  replying: 3,
};

interface Props {
  /** Which of the file's states to play. Defaults to idle. */
  state?: MascotState;
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
export function MascotAvatar({ state = "idle", className, "data-testid": testId }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { rive, RiveComponent } = useRive({
    src: mascotSrc("animated"),
    artboard: "MascotProfileAnimations",
    stateMachine: "State Machine 1",
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

  // Colors are set once the instance is bound — the file's own defaults
  // already match these, but v1 sets them explicitly so a future default
  // change in the .riv asset doesn't silently change what ships.
  useEffect(() => {
    if (!vmi) return;
    setHandColor(...HAND_COLOR);
    setSkinColor(...SKIN_COLOR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmi]);

  useEffect(() => {
    if (!vmi) return;
    setAnimationNumber(reducedMotion ? STATE_NUMBERS.idle : STATE_NUMBERS[state]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmi, state, reducedMotion]);

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
