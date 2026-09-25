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
 * Confirmed live (canvas-pixel sampling, not just a round-tripped getter):
 * `1` renders the mascot in its cap; `2` swaps it to headphones. The
 * artboard has a wider costume set than `idle`/`hover`/`replying` need
 * (cap, headband, headphone, face mask, cardboard mask, and four numbered
 * "glass" variants — 9 items total, per `rive.animationNames`), so this
 * mapping is a deliberate v1 subset, not the file's full range. See
 * `docs/issue/mascot-profile-avatar/open-questions.md` §3 for how the
 * write path was confirmed to actually drive the visible artboard, and why
 * it didn't for a while.
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
