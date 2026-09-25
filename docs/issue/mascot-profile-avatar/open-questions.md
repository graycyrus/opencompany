# Open questions — now checked against the real Rive runtime

Everything below was originally produced by static analysis: reading the
`.riv` file's embedded string table, a screenshot of its Data panel, and the
console's own source, with nothing actually loaded or played. That gap is
now closed — `MascotAvatar` (`frontend/src/components/mascot-avatar.tsx`)
is implemented, wired into both hero surfaces (the agent profile sheet, the
avatar picker), and was driven live in a browser against
`companies/design_studio`, including the hover transition that was
previously unconfirmed (see §3). What follows is what was actually observed,
not what was assumed.

## 1. Which number is which state, visually — resolved for the states this component uses

Confirmed by canvas-pixel sampling and a screenshot, not just a round-tripped
getter: `mascotAnimationNumber = 1` renders the mascot wearing its cap
(idle); `= 2` swaps it to headphones (hover). `replying = 3` is wired the
same way but its visual has not been screenshotted — the artboard has nine
costume animations total (`cap`, `headband`, `headphone`, `face mask`,
`cardboard mask`, and four numbered `glass` variants, per
`rive.animationNames`), so `STATE_NUMBERS` in `mascot-avatar.tsx` is a
deliberate v1 subset of three, not the file's full range. Whether `3` is a
sensible "replying" visual, and what `4`-`9`+ look like, is unconfirmed and
not blocking — nothing in this PR calls those numbers.

## 2. What the "copy" clips actually do — still unconfirmed, no longer blocked

Now testable (§3 is fixed) but not yet tested: nobody has watched a
transition play in reverse (mascot → idle) to confirm the `copy`-suffixed
clips are the return/exit transitions their naming implies. Low priority —
the forward transition (the part hover actually needs) is confirmed working.

## 3. ViewModel binding path — resolved: wrong state machine, not a nested-artboard problem

The original diagnosis (a nested artboard whose ViewModel binding doesn't
inherit from its parent) was investigated and ruled out, then replaced with
the actual cause once the runtime was introspected directly instead of
inferred from the string table:

- `useRive({ artboard: "Mascot" })` — trying to load the suspected nested
  artboard directly, sidestepping any nesting/inheritance issue entirely —
  throws `"Invalid artboard name or no default artboard"`, the same error
  `MascotProfileAnimations` throws when passed as an `artboard` name. There
  is no separately loadable `Mascot` artboard; `Mascot Instance` is a node
  inside the file's one real artboard (`Artboard`), not a nested artboard
  with its own binding scope.
- Instrumenting the component to log `rive.stateMachineNames` and
  `rive.animationNames` directly (rather than trusting the string table or
  an editor screenshot) showed `Artboard` carries **three** state machines —
  `MascotProfileAnimations`, `animtionStatemachin`, `State Machine 1` — and
  **all 21 animations**, including every `glass1`-`glass4` variant, `cap`,
  `headband`, `headphone`, `face mask`, `cardboard mask`, and their
  dance/jump variants. Nothing about this artboard is nested; everything
  relevant lives at the top level this component already loads.
- The earlier pass loaded `State Machine 1` — the machine the Rive editor's
  Data panel shows `mascotAnimationNumber` bound under — and confirmed the
  ViewModel write round-tripped through its own getter, but the rendered
  artboard never moved (canvas-pixel sampling, byte-identical across
  states, across four configurations, with and without `autoBind: true`).
  Switching the loaded state machine to **`MascotProfileAnimations`**
  instead — same ViewModel writes, unchanged — **fixed it**: hover now
  visibly swaps the mascot's cap for headphones, confirmed by canvas-pixel
  diffing and a screenshot, on both hero surfaces, in both light and dark
  mode. `mascot-avatar.tsx` now loads `MascotProfileAnimations`.
  `State Machine 1` apparently can still bind and read the same ViewModel
  instance (the write never errored or warned) — it just doesn't act on it
  visually. Unconfirmed what `State Machine 1` and `animtionStatemachin` are
  actually for; possibly leftover/unused, possibly gating something outside
  the costume layer. Not investigated further since it isn't blocking.
- **Classic (non-data-bound) state-machine inputs do not exist on this
  file.** `rive.stateMachineInputs(name)` was checked for all three state
  machines and returned an empty array for each, including the one
  currently instanced — `mascotAnimationNumber` exists *only* as a
  ViewModel Data Binding property, not additionally as a classic SMI input
  as `rive-parameters.md` originally guessed from the string table alone.
  `Rive.setNumberStateAtPath()` (the classic path-addressed input setter,
  a plausible-looking way to reach a nested state machine's input by name)
  was tried and correctly failed with "Could not access an input with
  name... at path" — there is no such classic input to find, at any path.
  The ViewModel Data Binding hooks were the right tool the whole time; the
  bug was only ever which state machine was loaded.
- **A footgun found along the way, worth recording so nobody repeats it:**
  calling `rive.stateMachineInputs()` (classic SMI introspection) on a
  `rive` instance that also has the ViewModel Data Binding hooks
  (`useViewModel`/`useViewModelInstance`) active crashed the Rive WASM
  runtime outright (`RuntimeError: null function`, inside
  `ViewModel.defaultInstance`) — the same failure mode as mixing the
  `useStateMachineInput` hook with ViewModel hooks, previously found and
  documented here. It reproduces even from a read-only introspection call,
  not just a write. Diagnosing which state machine has which classic inputs
  therefore has to happen in a build of the component with the ViewModel
  hooks temporarily removed entirely, never alongside them.

**Net effect:** hover works end-to-end and is visible — mouse events → React
state → `MascotState` prop → ViewModel write → the loaded state machine
advancing the artboard. Confirmed on both hero surfaces, both themes, by
canvas-pixel sampling and screenshots, not just a round-tripped getter.

## 4. The Number input's real valid range and behavior — partially confirmed

`1` and `2` are confirmed to render distinct, correct costumes (§1). `3`
("replying") is written the same way but its visual is unconfirmed.
Auto-loop/auto-return behavior between costumes (whether leaving `hover`
plays a `copy` reverse clip back to idle, or jump-cuts) was not directly
observed — see §2.

## 5. Actual bundle cost — partially measured

The shipped `.riv` file itself is confirmed at 1,763,803 bytes
(`frontend/public/avatars/mascot-animated.riv`, ~1.68&nbsp;MiB uncompressed;
matches the plan's ~1.8&nbsp;MB estimate closely). The gzipped JS chunk cost
of `@rive-app/react-canvas` plus its WASM runtime, once actually
code-split via the `lazy()` boundary this component is meant to be the
seam for, was not measured in this pass — still open.
