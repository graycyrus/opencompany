# Routing

How a request finds a model, once a company can hold more than one provider.

## The chain today, and where the new layer goes

```
  agent.tier              abstract tier            InferenceDecl          wire model
  (per agent)             (the workload)           (the ONE provider)     (what is sent)
      │                        │                         │                     │
      ├── orchestrator ──▶ agentic-v1 ──┐                │                     │
      ├── reasoning ─────▶ reasoning-v1 ├──▶ resolve_effective ──▶ model_for_tier ──▶ ▶
      └── (default) ─────▶ chat-v1 ─────┘    runtime>manifest>env    (+ vocabulary)
```

The new layer is **between the tier and the provider**, not replacing either:

```
  agent.tier ──▶ abstract tier ──▶ ROUTE ──▶ provider (by slug) ──▶ model_for_tier ──▶ ▶
                                     ▲
                                     │  new: a per-tier entry naming a provider
                                     │  unset = the company's primary
```

This is one layer deeper than openhuman's `role → provider → model`, because
OpenCompany's tier is an abstraction over *workloads* and its wire model is
decided from the endpoint's published vocabulary at request time. Both of those
are worth keeping, so the route slots above them rather than through them.

## The routing table

One entry per abstract tier. Four tiers, four entries, each independent:

```
┌─ Routing ───────────────────────────────────────────────────────────┐
│                                                                     │
│   chat-v1        [ Primary (OpenRouter)          ▾]  [ auto      ▾] │
│   reasoning-v1   [ Acme gateway                  ▾]  [ gpt-5     ▾] │
│   agentic-v1     [ Primary (OpenRouter)          ▾]  [ auto      ▾] │
│   vision-v1      [ Primary (OpenRouter)          ▾]  [ auto      ▾] │
│                                                                     │
│   "auto" = let the endpoint's vocabulary decide (see current-state)  │
└─────────────────────────────────────────────────────────────────────┘
```

Stored as the existing string grammar, extended with an optional provider prefix:

```
  "<model>"                  ← primary provider, explicit model   (today's shape)
  "<slug>:<model>"           ← named provider, explicit model
  "<slug>:"                  ← named provider, vocabulary decides the model
  ""                         ← primary provider, vocabulary decides   (today's default)
```

A string, not a foreign key, for the same reasons openhuman gives: it is
hand-editable, greppable, diffable, and it survives in a TOML manifest where a
join does not.

## The rule that matters most

**No tier inherits another tier's route.**

openhuman shipped the opposite and had to undo it. Their note:

> Setting only `coding_provider` used to move `chat` and `reasoning` onto that
> key too — ordinary conversations silently billed to the user's own account,
> with no settings field saying so.

An unset tier resolves to the company's **primary provider**, never to a sibling
tier's configured provider. "Resolves to primary" and "borrows from a sibling"
are different things, and only the first is predictable from the screen.

## Failure

Today: one endpoint, one attempt, one same-endpoint retry for the empty-response
class. A 401, 429, 500 or timeout ends the turn.

The rework **does not add cross-provider failover**, and that is a deliberate
decision rather than an omission. The reason is a real constraint, not caution:

```
  turn budget ────────────────────────────────────────▶ 2–3s (triage timeout)
       │
       ├─ resolve provider        secret reads
       ├─ discover vocabulary     budgeted catalog read, cached
       └─ chat/completions        the actual request
                                        │
         a failover here would need ────┴──▶ resolve provider #2
                                             discover vocabulary #2
                                             chat/completions #2
                                             ... inside the SAME budget
```

Either the secondary is resolved eagerly — N× the secret reads and N cache
entries per company per hour, for a path that is almost never taken — or it is
resolved lazily and blows a budget the caller already set.

So failure stays a first-class *reported* state rather than a silently-papered
one, which is the house position everywhere else in this codebase:

- A **401** invalidates the cached credential and surfaces. With per-provider
  slots, the message can finally name the provider whose key was rejected —
  today it has to explain in a paragraph that the stored key may belong to a
  vendor you are no longer using.
- A **4xx unknown-model** is rewritten into repair advice naming the table to
  edit. With routes, it can also name the *tier* whose entry is wrong.
- A **disabled or deleted** provider must not strand a route pointing at it. See
  below.

If failover is wanted later, it belongs as an explicit per-tier secondary with
its provider resolved eagerly at save time — not as an implicit chain.

## Removing a provider must scrub its routes

Deleting a provider that a tier points at leaves a route naming a slug that no
longer resolves. openhuman handles this in two independent places, and both are
worth copying:

1. **At the point of removal**, in the writer — reset any tier pinned to that
   provider back to primary.
2. **At load**, as a reconciliation — because the UI path can be bypassed by a
   manifest edit or an older build, and an unresolvable route hard-errors that
   tier's inference rather than falling back.

Two mechanisms for one invariant, because the first can be skipped.

The same applies to **disabling**: a disabled provider is not a routing target.
Today there is no disabled state at all — the only way to stop using a provider
is to delete it, losing its endpoint and its routes with it.

## Fail closed on ambiguity

When a config expresses an intent the system cannot satisfy, error with
instructions rather than silently falling back to something that bills
differently. OpenCompany already does this in one place — a half-migrated BYOK
config yields a sentinel and an actionable message rather than quietly routing
through the managed backend.

Extend the same discipline to routes: a tier naming a slug that does not exist is
an error naming the tier, the slug, and the configured slugs — not a silent
demotion to primary. A silent demotion is how spend moves without anyone
deciding it.

## What stays exactly as it is

- **Per-request re-resolution.** `TenantProvider` bakes no config; a console
  change lands on the next turn with no rebuild. A routing table built at startup
  would lose this and turn every change into `restartRequired`.
- **Vocabulary discovery**, per provider. Each entry gets its own
  `TierVocabulary`, classified from its own catalog. The per-tier substitution
  bitmask is unchanged.
- **An operator override wins in every vocabulary.** A typed model id is honoured
  verbatim whatever the endpoint publishes.
- **`agent.tier` semantics.** A tier names a workload, never a model. That is
  what lets an agent keep its tier while moving between harnesses.
- **Internal passes stay on `chat-v1`.** Planning, triage, title, selector,
  workflow build, profile draft and roster build are hardcoded there today. The
  route table gives them a provider without giving each one a knob — which is the
  right amount of new surface.
