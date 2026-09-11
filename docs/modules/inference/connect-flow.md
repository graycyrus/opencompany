# Connecting a provider

The flow from "Add provider" to a working entry, and the failure handling that is
the actual substance of it.

## Why a modal

There are a dozen or so providers and a company connects one or two. Listing them
all inline spends the page on the ones nobody chose and buries the ones actually
configured. openhuman's own note on this is worth keeping:

> Custom is deliberately NOT a fourth select. It is one option, and a select over
> one option is a button wearing a costume.

## Three categories, because they ask three different questions

Copy is verbatim from openhuman; the full list of options is in
[`catalogue.md`](catalogue.md).

```
┌─ Add a provider ────────────────────────────────────────────┐
│                                                             │
│  Cloud                                                      │
│  Hosted models. You supply an API key.                      │
│  [ Choose a cloud provider…                             ▾]  │
│                                                             │
│  Local runtimes                                             │
│  Models running on this machine. You supply the endpoint.   │
│  [ Choose a local runtime…                              ▾]  │
│                                                             │
│  CLI logins                                                 │
│  Reuses a login another command line tool already holds.    │
│  [ Choose a CLI login…                                  ▾]  │
│                                                             │
│  ────────────────────────────────────────────────────────   │
│                             [ Add Custom Provider ]         │
└─────────────────────────────────────────────────────────────┘
```

openhuman's reasoning, which is why this is three selects and not one list:

> The categories are not three slices of one decision, they are three different
> questions: a cloud provider wants an API key, a local runtime wants an endpoint
> on this machine, a CLI login wants nothing because another tool already holds
> the credential. One flat list makes the user infer that from the group heading
> alone; a select per category has a label and a line of helper text to say it
> outright.

Row detail lines: cloud shows the endpoint's **host**; local shows `Runs on this
machine`; CLI shows `Uses a login another CLI already holds`.

Each list shows **only what is not yet connected** — the page behind the modal
shows the rest, and offering to add something twice is how you get two rows for
one provider. The select's value stays pinned empty: choosing an item starts a
connect flow and leaves nothing selected, because the connection state lives in
the page rather than the control.

On a server-side host the **CLI logins** category has no options. Render it
saying so rather than hiding it — the shape is then right if a delegated
credential ever becomes available, and an empty labelled group is more honest
than a missing one.

## The flow

```
  pick ──▶ type ──▶ write key ──▶ flush record ──▶ PROBE ──┬─▶ ok ──▶ saved
                                                            │
                                                            └─▶ classify
                                                                   │
                    ┌──────────────────────────────────────────────┤
                    ▼                                              ▼
              reason == auth                              anything else
                    │                                              │
        roll back record AND key                      KEEP the key, keep the
        reject: "Could not reach X"                   record, show an amber
                                                      advisory on the row
```

Ordering matters and is not arbitrary:

1. **Validate locally** what can be validated locally — URL scheme and shape for
   an endpoint the operator typed. Reject before any write.
2. **Derive the slug** from the label for a custom provider, and reject a
   collision or a reserved word *before* writing anything.
3. **Write the credential first**, then flush the record. The probe needs the key
   resolvable by slug, so the credential has to land first.
4. **Probe.** `GET {base_url}/models` — cheap, read-only, and the same call the
   model picker needs anyway.
5. **Roll back both stores on a destructive failure**, and log a rollback failure
   rather than swallowing it. A silently failed key-clear orphans a secret.

## The probe is classified, not boolean

This is the part worth copying most carefully, because the naive version destroys
valid credentials.

```
                   probe error text
                          │
                          ▼
        ┌───────────────────────────────────────┐
        │ 407 / proxy / cloudflare / bad gateway│──▶ unknown   (NON-destructive)
        └───────────────────────────────────────┘      ▲
                          │ no                         │  checked FIRST, on purpose
                          ▼                            │
        ┌───────────────────────────────────────┐      │
        │ 401, or 403 WITH credential wording   │──▶ auth      (destructive)
        └───────────────────────────────────────┘
                          │ no
                          ▼
        ┌───────────────────────────────────────┐
        │ "model not found" / unknown model     │──▶ model     (non-destructive)
        └───────────────────────────────────────┘      ▲
                          │ no                         │  BEFORE endpoint: the
                          ▼                            │  endpoint branch matches
        ┌───────────────────────────────────────┐      │  a bare "not found"
        │ 404 / not found / DNS / refused       │──▶ endpoint  (non-destructive)
        └───────────────────────────────────────┘
                          │ no
                          ▼
        ┌───────────────────────────────────────┐
        │ timeout / deadline                    │──▶ timeout   (non-destructive)
        └───────────────────────────────────────┘
                          │ no
                          ▼
                      unknown                    ──▶ unknown   (non-destructive)
```

**Only `auth` deletes the key.** Everything else keeps it and shows an advisory,
because the key is plausibly fine and the connection is not.

Two branch-ordering rules that exist because of real bugs:

- **The proxy branch runs first.** Otherwise the word "authentication" inside
  `407 Proxy Authentication Required` matches the auth branch, and a corporate
  proxy deletes a valid key. A WAF's bare `403 Forbidden` has the same shape.
  This is why a 403 counts as `auth` only when it co-occurs with credential
  wording, and why the digit tests use word boundaries — so `401`/`403` do not
  match inside an id like `1403`.
- **`model` precedes `endpoint`.** The endpoint branch matches a bare "not
  found", which would otherwise claim every provider that phrases a missing model
  as "model not found" and send the operator off to check their base URL instead
  of their model id.

### Classification is separate from copy

Decide the class in one function; render the sentence in another. That keeps the
decision unit-testable without a translator, and keeps strings where they belong.

**The `unknown` branch must not interpolate the upstream string.** It can echo
request material — headers, key fragments — and it lands in a screenshot-able
banner. Put the raw text in a detail/console channel, not in the copy.

## Testing a draft, and the SSRF question

Today `POST {scope}/inference/test` probes the **saved** config. A list where you
add-then-test needs to probe a **draft** — an endpoint and key that are not
stored yet.

That route already exists for first-run: `POST /api/v1/setup/inference/test`
takes a key, uses it, and discards it, under a comment saying testing a credential
and committing to it are separate acts.

Generalising it to company scope creates an authenticated "send a request to an
arbitrary URL with an arbitrary key" primitive. **That is an SSRF-shaped
question and the plan answers it explicitly rather than inheriting it:**

- Require `AdminScopedCompany` — this is a company-deciding action.
- Restrict the scheme to `http`/`https`.
- Refuse link-local and cloud metadata addresses (`169.254.0.0/16` and friends)
  outright; a company's model endpoint is never there.
- Allow loopback only where the local-runtime category is offered at all, since
  that is exactly what Ollama needs — and make that an explicit allowance rather
  than a hole.
- Do not follow redirects to a host that fails the above.
- Cap body size and time; discard the body except for classification.

## What the operator sees on failure

| Class | Key | Row | Copy |
|---|---|---|---|
| `auth` | deleted | not created | "Could not reach *X*: the provider rejected the credential." |
| `endpoint` | kept | created, advisory | "Saved, but nothing answered at *host*." |
| `model` | kept | created, advisory | "Saved. The endpoint did not recognise that model id." |
| `quota` | kept | created, advisory | "Saved. The account is out of credit." |
| `timeout` | kept | created, advisory | "Saved, but *host* did not answer in time." |
| `unknown` | kept | created, advisory | "Saved, but the check did not complete." |

The advisory is amber and dismissible, keyed by slug. The save succeeded; only
reachability is in question. Colouring it as an error would be a lie about what
happened.

## Add without verifying

A provider that does not serve an OpenAI-shaped `{base}/models` listing is still
usable for inference. Blocking creation on the probe leaves those operators with
no way to reach the model field at all.

So offer "add anyway" — but gate it on a **typed probe-failure error**, never a
boolean. Only a probe failure unlocks it; a slug collision or a key-write failure
must not. And clear it on every retry, so an attempt that fails for an unrelated
reason does not still offer to skip verification.
