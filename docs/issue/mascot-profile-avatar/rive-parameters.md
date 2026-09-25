# The `.riv` file's structure

Two files were supplied: `mascotprofile.riv` and `mascotprofile.rev`.

**Only `.riv` is real.** It opens with the `RIVE` magic header Rive's runtime
requires. `.rev` has no such header and shares the same embedded string
table (artboard/state-machine/ViewModel names) — it reads as a Rive editor
scratch or autosave artifact, not something any runtime loads. It is not
part of this plan and should not be shipped.

Everything below was read from the binary's embedded string table (the
format stores object names as UTF-8) and cross-checked against a screenshot
of the file open in the Rive editor's Data panel. No runtime has actually
played the file yet — see [`open-questions.md`](open-questions.md) for what
that leaves unconfirmed.

## Object graph

```
Artboard: MascotProfileAnimations
  └─ Mascot Instance   (nested artboard "Mascot")
       └─ State Machine 1
            Number input: mascotAnimationNumber (default 1)
            Animations: glass1 animation / glass1 animation copy
                        glass2 animation / glass2 animation copy
                        glass3 animation / glass3 animation copy
                        glass4 animation / glass4 animation copy
```

The `copy` suffix on each animation is almost certainly the reverse/exit
clip back toward idle — a standard Rive authoring pattern for a state
machine where a Number input selects one of several named states, each with
an entry transition and a return transition — but this is inferred from
naming, not observed. See open questions.

## The ViewModel (Data Binding)

Confirmed directly from the Rive editor (not just the string table): a
ViewModel named `Mascot` with three bindable properties.

| Property | Type | Default |
|---|---|---|
| `handColor` | Color | `#B4900B` |
| `skinColor` | Color | `#F7D145` |
| `mascotAnimationNumber` (shown truncated as `mascotA…` in the editor) | Number | `1` |

This is Rive's newer Data Binding system, separate from — and in addition
to — the plain State Machine input of the same name found in the string
table. In the React runtime (`@rive-app/react-canvas`) these are set via a
`ViewModelInstance`'s `.color("handColor")` / `.number("mascotA…")` setters,
not the older `useStateMachineInput` hook, which only reaches inputs
declared directly on the state machine rather than a bound ViewModel.

## The hard budget: 4 states

The Number input selects between exactly four states (`glass1`–`glass4`).
Nothing about the current design leaves room for a fifth without going back
into the Rive editor and authoring one. Any state-mapping plan (see
[`state-mapping.md`](state-mapping.md)) has to fit inside idle + 3 spares,
or extending the file itself becomes part of the work.

## Where the asset lives once this ships

Avatars are served as static files under `frontend/public/avatars/` — the
eleven `tiny:` mascots are `blob-<flavour>.webp` there today, and nothing
about them is embedded into the Rust binary. `mascotprofile.riv` should land
the same way, e.g. `frontend/public/avatars/mascot.riv`, loaded client-side
by the Rive runtime. No changes to the embedding/build pipeline
(`docs/spec/runtime/globals.md`'s "embedded at build time" concept is about
`companies/_globals/`, unrelated to avatar assets) are needed for this.
