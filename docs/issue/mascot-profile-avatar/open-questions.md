# Open questions — now checked against the real Rive runtime

Everything below was originally produced by static analysis: reading the
`.riv` file's embedded string table, a screenshot of its Data panel, and the
console's own source, with nothing actually loaded or played. That gap is
now partly closed — `MascotAvatar` (`frontend/src/components/mascot-avatar.tsx`)
is implemented, wired into both hero surfaces (the agent profile sheet, the
avatar picker), and was driven live in a browser against
`companies/design_studio`. What follows is what was actually observed, not
what was assumed.

## 1. Which number is which state, visually — still unanswered, and now blocked by §3

Not resolved. The runtime never got far enough to see `glass2` (or `glass3`,
`glass4`) actually play — see §3. `STATE_NUMBERS` in `mascot-avatar.tsx`
still holds the plan's original index-order guess (`idle: 1, hover: 2,
replying: 3`); an earlier version of that file's comment claimed this was
"confirmed empirically by loading the file and watching each state play,"
which was not accurate for *this component's* wiring — see §3 for what was
actually confirmed. Do not trust that mapping until §3 is fixed and someone
watches the artboard actually transition.

## 2. What the "copy" clips actually do — untestable until §3 is fixed

Still unconfirmed, for the same reason as §1: no state transition was ever
observed, so there's nothing to watch reverse.

## 3. ViewModel binding path — the artboard name was wrong (now fixed); the visual binding itself is still broken

Two separate findings here, one resolved and one very much not.

**Resolved:** the artboard is not named `MascotProfileAnimations`. Passing
that name to `useRive({ artboard })` threw `"Invalid artboard name or no
default artboard"`. The file's single top-level artboard is literally named
`Artboard`; `MascotProfileAnimations` is one of the *state machines* declared
on it (there are three), not the artboard — an easy mistake to make from the
string table alone, only caught by actually loading the file.
`mascot-avatar.tsx` now omits `artboard` and lets `useRive` fall back to the
file's default artboard, which is correct.

**Not resolved, and now empirically confirmed rather than theoretical:**
setting `mascotAnimationNumber` via the ViewModel Data Binding hooks
(`useViewModel` → `useViewModelInstance({ useDefault: true, rive })` →
`useViewModelInstanceNumber`) does not visibly change the rendered artboard,
even though the write itself is real:

- Instrumenting the component to log `useViewModelInstanceNumber`'s own
  `value` getter after a hover showed it correctly read back `2` (the
  `hover` mapping) within one render of the `state` prop flipping — the
  write path works exactly as the hooks document.
- But sampling the `<canvas>` via `canvas.toDataURL()` — 8–10 samples over
  600–1500ms, both immediately and after settling — showed **byte-identical
  output** between `idle` (input value `1`) and `hover` (input value `2`),
  every time, across four different configurations: the avatar picker's
  large preview, the profile sheet's avatar, with only one `MascotAvatar`
  instance mounted at a time (to rule out two instances racing over a
  shared/global ViewModel instance — they weren't), and with
  `useRive({ autoBind: true })` added (to let the Rive runtime do its own
  default-instance binding instead of this component's manual
  `useViewModel`/`useViewModelInstance` calls — no difference either way).
- The most likely explanation, from `rive-parameters.md`'s own object graph:
  the state machine that actually plays (`State Machine 1`) lives on a
  **nested** artboard (`Mascot Instance`, nested inside the outer
  `Artboard`), not the outer artboard this component loads directly.
  `rive.setViewModelInstance()` (what both the manual hooks and `autoBind`
  ultimately call) binds at the outer-artboard/player level; if the nested
  artboard's own instance in the authored file isn't configured to inherit
  its ViewModel from the parent, binding the outer artboard's instance would
  never reach it — which matches exactly what was observed: the write
  succeeds against *some* instance, but it isn't the one driving the visible
  state machine.
- Confirming or fixing this needs either the Rive editor itself (to check
  and, if needed, change the nested instance's binding mode to inherit from
  parent) or `@rive-app/canvas`'s lower-level nested-artboard APIs, which
  `@rive-app/react-canvas`'s hook surface (`useRive`, `useViewModel`,
  `useViewModelInstance*`) does not expose. Neither was available in this
  pass.
- **A footgun found along the way, worth recording so nobody repeats it:**
  mixing the classic `useStateMachineInput` hook with the ViewModel Data
  Binding hooks on the *same* `rive` instance — tried here as a diagnostic,
  to check whether `mascotAnimationNumber` also existed as a plain
  state-machine input distinct from the ViewModel property of the same name
  — crashed the Rive WASM runtime outright (`RuntimeError: function
  signature mismatch` / `RuntimeError: null function`, both inside
  `ViewModel.defaultInstance`). `rive-parameters.md` already says these are
  two separate things and only the ViewModel hooks are correct for this
  file; this is now confirmed the hard way. Don't call
  `useStateMachineInput` on a `rive` instance that's also driving ViewModel
  Data Binding hooks.

**Net effect:** hover is wired end-to-end (mouse events → React state →
`MascotState` prop → ViewModel write, confirmed via the getter), but nothing
currently makes it visible. `MascotAvatar` does not crash, does not error,
and renders the idle pose correctly and consistently in both light and dark
mode on both hero surfaces — it just doesn't animate on hover yet. Treat
that as the actual current state of this feature, not "hover works."

## 4. The Number input's real valid range and behavior — untestable until §3 is fixed

Still unconfirmed — there's no observable state change to test range or
auto-loop/auto-return behavior against yet.

## 5. Actual bundle cost — partially measured

The shipped `.riv` file itself is confirmed at 1,763,803 bytes
(`frontend/public/avatars/mascot-animated.riv`, ~1.68&nbsp;MiB uncompressed;
matches the plan's ~1.8&nbsp;MB estimate closely). The gzipped JS chunk cost
of `@rive-app/react-canvas` plus its WASM runtime, once actually
code-split via the `lazy()` boundary this component is meant to be the
seam for, was not measured in this pass — still open.
