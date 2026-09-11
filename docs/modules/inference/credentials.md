# Credential resolution

Which credential a call presents, and why the answer differs per surface today.

This is the design decision the provider rework depends on: `inference/key`
cannot mean two things at once, and today it does.

## What is stored

Three per-company slots in the `SecretStore`, plus one per-process identity from
the environment. All four are write-only over HTTP — no route returns any value,
and each has a test pinning that.

| Slot | Set by | Means |
|---|---|---|
| `composio/token` | `PUT {scope}/composio/token`, admin | a Composio credential this company pasted |
| `tinyhumans/key` | `PUT {scope}/credential` or the link flow, admin | **this company's TinyHumans account** — an identity |
| `inference/key` | `PUT {scope}/inference`, the setup wizard, the link flow | whatever the declared provider wants — a vendor credential |
| env | the deployer, once per process | `TINYHUMANS_TOKEN_FILE` (a path, rotated in place) or `TINYHUMANS_API_KEY` (a value) |

The manifest can only ever *name* a slot (`[inference].api_key_secret`), never
hold a value, and validation rejects a value there that looks like a pasted
credential.

## How resolution works today

```
COMPOSIO                                  INFERENCE
  composio/token                            inference/config + inference/key
        │ absent                                  │ absent
        ▼                                         ▼
  company_key::resolve                      manifest [inference]
     ├─ tinyhumans/key      ← consulted          │ absent
     └─ instance identity                        ▼
        │ absent                            EnvDefault
        ▼                                     ├─ OPENCOMPANY_INFERENCE_KEY
  Credential::None → no tools                 └─ instance identity
                                                 │ absent
                                                 ▼
                                            None → echo brain
```

**`tinyhumans/key` is never read by inference.** `src/company/inference.rs`
contains no reference to `company_key` — verified by grep, not assumed. There is
no path by which a company key set in the console reaches a chat completion.

### Three consequences

**Billing splits silently.** A company that sets its own TinyHumans key moves
its *app connections* onto its own account and leaves *every agent turn* on
whoever runs the server. Nothing on screen says so, and thinking is the expensive
half.

**The one place the slots meet is a copy, not a resolution.**
`POST {scope}/credential/link/finish` writes the hub-minted key into
`tinyhumans/key` **and** into `inference/key`. So it looks like one key serving
both — but rotating the account key afterwards through the normal route does not
update the inference copy, which keeps presenting the old value until somebody
replaces it separately.

**That copy also misroutes.** `link/finish` stores the key with
`provider: "managed"`. On resolve, `normalize_provider("managed")` yields
`"openrouter"` *before* `is_managed_choice` is consulted, so with a key present
both managed branches are skipped and the endpoint resolves to
`https://openrouter.ai/api/v1`. A `th_…` key is then presented as a bearer to
OpenRouter. The handler's own comment claims declaring `managed` is "what makes
the stored key the one its turns are billed to"; the code does not do that.

## The target

One identity, two surfaces, an optional vendor override above each — and a
provider check that stops an identity reaching a vendor it means nothing to.

```
INFERENCE
  1. the provider entry's own credential        ← a vendor key (OpenRouter, BYOK…)
  2. if that provider IS the managed/TinyHumans one:
        tinyhumans/key                          ← this company's account
        else the instance identity
  3. nothing → agents cannot think, and the banner says which

COMPOSIO
  1. composio/token                             ← a pasted Composio credential
  2. tinyhumans/key                             ← this company's account
  3. the instance identity
  4. nothing → no app tools
```

### The provider check is the whole safety property

Without it this model hands a TinyHumans key to OpenRouter — which is exactly
the `link/finish` bug above, generalised. With it:

- provider **is** TinyHumans/managed → the account key is the right credential
  for that endpoint, so use it
- provider is **any other vendor** → the account key is meaningless to them, so
  never send it; require a vendor credential or fail closed

Composio needs no equivalent check because Composio is always brokered through
TinyHumans: there is only ever one vendor at the other end.

State it as a rule: **an identity flows to a surface only when the vendor at the
other end is the identity's own vendor.**

### Why `inference/key` must stop meaning two things

Today that one slot holds either "my OpenRouter key" (a vendor credential) or
"my TinyHumans key, used for inference" (an identity). Those have different
lifecycles — a vendor key is replaced when you change vendor; an identity is
rotated and should propagate everywhere it is used. One slot cannot serve both,
which is why the copy exists and why the copy goes stale.

**A slot should be keyed by what the credential *is*, not by which feature
consumes it.** That is the same modelling error the provider list fixes one level
down: one slot per company overwritten on switch, versus one slot per provider.

## What this resolves

**The stranded-key problem disappears without being handled.** Today, setting a
key and then switching provider leaves a credential for the wrong vendor in the
only slot there is, and the first turn fails with a 401 the host explains in a
paragraph:

> A key is stored against the provider selected when it was saved, so a key for
> another vendor fails here even while this card reports one is set.

When an error message compensates for a modelling gap, the model is wrong. With
the credential living **on the provider entry**, switching provider switches
which credential is in play. Nothing is stranded, because nothing was ever shared
between two providers. The paragraph can be deleted rather than reworded.

**And three bugs stop being reachable:**

- rotation staleness — there is no copy to go stale
- the `managed` → `openrouter` misroute — nothing stores an identity in a vendor
  slot, so normalisation has nothing to misroute
- the silent billing split — one account key moves both surfaces, which is what
  an operator expects

## What stays as it is

- **Write-only, structurally.** No `Serialize` on anything holding a credential,
  private field, redacting `Debug`, boolean on the DTO, and the leak test
  asserting on field values across every route.
- **Obtained per request, never captured at boot.** What makes a rotating
  projected token work at all.
- **Fail closed on an unreadable store.** An unreadable store means *we do not
  know who this company is*; treating that as "no key" would attribute a
  connection to the instance's account rather than the company's, invisibly and
  permanently. Availability-degrade and identity-degrade are different decisions
  and only the first is safe to make silently.
- **One resolution seam per identity**, so a rotation reaches every surface in
  the same cycle rather than one at a time.

## Known gaps this design does not address

Named so they are not mistaken for solved:

- **Secrets are stored in plaintext.** `src/store/fs.rs` says so: "Encryption-at-
  rest is a documented follow-up; Phase 1 stores plaintext."
- **The `SecretStore` port has no delete** — `get` and `set` only. Clearing is a
  write of the empty string, so "never set" and "deliberately cleared" are
  indistinguishable and deletion cannot be proven.
- **No audit trail.** Nothing records who set or rotated a credential, or when.
- **No least privilege.** One TinyHumans key is login *and* Composio *and*
  inference; it cannot be scoped down, so a leak is total. Capability-scoped
  tokens are the eventual answer and are out of scope here.
