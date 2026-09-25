# Open questions — needs the real Rive runtime

Everything in this repo's `docs/issue/mascot-profile-avatar/` was produced by
static analysis: reading the `.riv` file's embedded string table, a
screenshot of its Data panel, and the console's own source. Nothing has
actually been loaded and played yet. Before or during implementation, these
need the real runtime (`@rive-app/react-canvas`, or the Rive editor itself)
to answer — none of them block writing the grammar/rendering-strategy code
in [`avatar-grammar.md`](avatar-grammar.md) and
[`rendering-strategy.md`](rendering-strategy.md), but all of them block
correctly wiring [`state-mapping.md`](state-mapping.md)'s state-to-number
mapping.

## 1. Which number is which state, visually

`mascotAnimationNumber` selects between `glass1`–`glass4` (default `1`).
Load the file, scrub the input 1→4, and note what each one actually shows —
naming alone ("glass1", "glass2"...) doesn't say whether these are different
poses, different accessory states, or something else entirely. Decide
idle/hover/(replying) assignment from what's actually seen, not from index
order.

## 2. What the "copy" clips actually do

Each `glassN animation` has a `glassN animation copy` sibling. The working
assumption in [`rive-parameters.md`](rive-parameters.md) is that these are
the reverse/exit transition back toward idle — standard for a
Number-input-driven state machine — but this is inferred from naming, not
observed. Confirm whether the runtime handles these automatically (i.e.
setting the input back to `1` just plays the right exit clip on its own) or
whether calling code needs to do anything explicit.

## 3. ViewModel binding path

Confirm whether `useRive`/`useViewModelInstance` (or whichever hook
`@rive-app/react-canvas` exposes for Data Binding) should target the
artboard `MascotProfileAnimations` or the nested `Mascot Instance` directly.
The ViewModel screenshot came from the Rive editor's own Data panel, which
doesn't disambiguate which artboard a `useRive({ artboard })` call needs to
name to actually reach it at runtime.

## 4. The Number input's real valid range and behavior

Is it strictly `1`–`4`, or `0`–`3`? What happens if code sets it outside
that range — clamped, ignored, or undefined behavior? Does entering a state
auto-loop, auto-return to idle after the clip finishes, or hold until the
input changes again? This affects whether `MascotAvatar` needs to actively
reset the input after a hover ends, or whether the state machine's own
transitions handle it.

## 5. Actual bundle cost, measured

The ~1.8&nbsp;MB `.riv` file plus the Rive WASM runtime is an estimate of
what ships; measure the real gzipped chunk size once `@rive-app/react-canvas`
is actually added and `MascotAvatar` is lazy-loaded, to confirm the
lazy-loading plan in [`rendering-strategy.md`](rendering-strategy.md) is
sufficient on its own or whether the asset itself also needs attention
(e.g. confirming the Rive WASM binary is fetched from a CDN vs. bundled,
depending on which `@rive-app/react-canvas` build is used).
