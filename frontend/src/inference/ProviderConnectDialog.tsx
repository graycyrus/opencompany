import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MANAGED_OPTION_SLUG,
  checkSlug,
  credentialAsk,
  customProviderReady,
  normalizeEndpoint,
  slugErrorCopy,
  slugify,
} from "./connect";
import type { Provider } from "./types";

/** What connecting one provider sends. */
export interface ConnectDraft {
  kind: string;
  label?: string;
  baseUrl?: string;
  key?: string;
  addAnyway?: boolean;
}

/**
 * The fields a chosen provider needs, and nothing else.
 *
 * One dialog for all four shapes rather than four dialogs, because they differ
 * only in which fields are present and [`credentialAsk`](./connect.ts) already
 * answers that. Four components would be four places for the submit path — and
 * the submit path is where the credential is, which is the last thing worth
 * having four copies of.
 *
 * ## The custom shape is this one plus a name
 *
 * A custom provider adds a **Name**, and the slug falls out of it rather than
 * being typed. The preview line under the field is not decoration: the slug is
 * what a routing entry will say, so the operator should see it before they
 * commit to it rather than meet it later in a routing row.
 *
 * The slug is checked for empty, in-use and reserved **before the Add button is
 * enabled**, which is the console half of the same check the host performs
 * before it writes anything. Neither is redundant: this one is so the operator
 * is not told no after a round trip, and the host's is because a console is not
 * a security boundary.
 *
 * ## Add anyway
 *
 * Offered only once a probe has failed in a way that would otherwise reject the
 * add — never after a slug collision or a failed key write, because neither is
 * evidence that the endpoint is fine. It is cleared on every retry, so an
 * attempt that fails for an unrelated reason does not still offer to skip
 * verification.
 */
export function ProviderConnectDialog({
  optionSlug,
  providers,
  editing,
  busy,
  error,
  offerAddAnyway,
  onCancel,
  onSubmit,
}: {
  /** The chosen option, or `null` when the dialog is closed. */
  optionSlug: string | null;
  providers: readonly Provider[];
  /**
   * The row this dialog is editing, or `null` when it is adding one.
   *
   * Carries the two things an edit must not invent: the stored label and the
   * stored endpoint. It is also what excludes the row from its own slug
   * collision check.
   */
  editing?: Provider | null;
  busy: boolean;
  /** What went wrong last time, if anything. */
  error: string | null;
  /** Whether the last failure was a probe failure, which is the only one that unlocks "add anyway". */
  offerAddAnyway: boolean;
  onCancel: () => void;
  onSubmit: (draft: ConnectDraft) => void;
}) {
  const open = optionSlug !== null;
  const ask = credentialAsk(optionSlug ?? "custom");
  const custom = optionSlug === "custom";
  const managed = optionSlug === MANAGED_OPTION_SLUG;

  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");

  // Seed from the chosen option each time the dialog opens on a new one — or,
  // in edit mode, from the row being edited.
  //
  // **A conventional endpoint is a starting point for an ADD and a wrong answer
  // for an edit.** Seeding a local runtime's catalogue default over a stored
  // one turned "Edit endpoint" into one click that relocated an Ollama at
  // `http://10.0.0.5:11435` back to `localhost` without saying so, and the two
  // local runtimes that ship no default (LM Studio, OMLX) opened blank with the
  // button disabled until the operator retyped a URL from memory.
  useEffect(() => {
    if (!open) return;
    setLabel(editing?.label ?? "");
    setBaseUrl(editing?.baseUrl ?? ask.defaultEndpoint ?? "");
    setKey("");
    // `optionSlug` is the identity of "which dialog is this"; `ask` is derived
    // from it, so it is not a second dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionSlug, open, editing?.slug]);

  // The row being edited is not its own collision. Its slug is already taken —
  // by it — and `edit` is keyed on the stored slug rather than on this one, so
  // including it made a custom provider's own name read as "taken" and left
  // both buttons disabled. Rotating its key meant inventing a name it would
  // never actually be given.
  const rivals = editing ? providers.filter((p) => p.slug !== editing.slug) : providers;

  const slug = slugify(label);
  const slugError = custom ? checkSlug(rivals, slug) : null;
  const endpointOk = !ask.needsEndpoint || normalizeEndpoint(baseUrl) !== null;
  const ready = custom
    ? customProviderReady(rivals, { label, baseUrl })
    : endpointOk && (!ask.needsKey || key.trim().length > 0);

  const submit = (addAnyway: boolean) =>
    onSubmit({
      kind: optionSlug ?? "custom",
      label: custom ? label.trim() : undefined,
      baseUrl: ask.needsEndpoint ? (normalizeEndpoint(baseUrl) ?? baseUrl.trim()) : undefined,
      key: ask.needsKey ? key.trim() : undefined,
      addAnyway,
    });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="inference-connect-provider">
        <DialogHeader>
          <DialogTitle>{ask.title}</DialogTitle>
          {/* Where the key goes, said plainly, or nothing. The reference this
              layout is ported from renders a duplicated interpolation here; a
              broken string is not a detail to reproduce faithfully. */}
          {ask.needsKey ? (
            <DialogDescription>
              The key is stored on this company and never shown again.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="grid gap-4">
          {custom && (
            <div className="grid gap-1.5">
              <Label htmlFor="inference-connect-name">Name</Label>
              <Input
                id="inference-connect-name"
                value={label}
                placeholder="My Provider"
                autoComplete="off"
                onChange={(e) => setLabel(e.target.value)}
              />
              {/* The slug is what a routing entry will say, so the operator
                  sees it before they commit to it rather than meeting it later
                  in a routing row. */}
              <p
                className="font-mono text-xs text-muted-foreground"
                data-testid="inference-slug-preview"
              >
                Slug: {slug || "None"}
              </p>
              {slugError && (
                <p className="text-xs text-status-blocked-text" data-testid="inference-slug-error">
                  {slugErrorCopy(slugError)}
                </p>
              )}
            </div>
          )}

          {ask.needsEndpoint && (
            <div className="grid gap-1.5">
              <Label htmlFor="inference-connect-url">
                {custom ? "OpenAI URL" : "Endpoint"}
              </Label>
              <Input
                id="inference-connect-url"
                aria-describedby={error ? "inference-connect-error" : undefined}
                value={baseUrl}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {baseUrl.trim() && !endpointOk && (
                <p className="text-xs text-status-blocked-text">
                  That must be an http or https address.
                </p>
              )}
            </div>
          )}

          {ask.needsKey && (
            <div className="grid gap-1.5">
              <Label htmlFor="inference-connect-key">API Key</Label>
              <Input
                id="inference-connect-key"
                aria-describedby={error ? "inference-connect-error" : undefined}
                type="password"
                value={key}
                placeholder={ask.keyPlaceholder ?? "sk-..."}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
          )}

          {/* Managed has two ways in, and only one of them is a key. The other
              writes the company's TinyHumans **account**, which is a different
              credential with a different lifecycle — it is rotated, and it moves
              every brokered surface at once, not just this one. It already has a
              home on Connections → Account, and a second form for one credential
              is how two surfaces come to disagree about whether a company has
              it. So this links there rather than duplicating it. */}
          {managed && (
            <div className="grid gap-1.5 rounded-md border border-border px-3 py-2">
              <p className="text-sm font-medium">Or connect your TinyHumans account</p>
              <p className="text-xs text-muted-foreground">
                One account key pays for thinking and for app connections, and rotating it
                reaches both. Set it up on Connections → Account.
              </p>
              <a
                className="text-xs font-medium underline underline-offset-4"
                href="#/connections/api-key"
                data-testid="inference-managed-account-link"
                onClick={onCancel}
              >
                Go to Account
              </a>
            </div>
          )}

          {!ask.needsKey && !ask.needsEndpoint && (
            <p className="text-sm text-muted-foreground">
              Nothing to enter — another command line tool already holds this credential.
            </p>
          )}

          {/* Always present, never mounted with its text: a live region that
              appears at the same moment as its content is frequently missed by
              the announcement, and this one is the reason the operator is still
              looking at this dialog. */}
          <p
            aria-live="polite"
            id="inference-connect-error"
            className="text-sm text-status-blocked-text empty:hidden"
            data-testid="inference-connect-error"
          >
            {error ?? ""}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          {/* Gated on a typed probe failure, never on a boolean: a slug
              collision or a failed key write must not unlock it, because
              neither is evidence that the endpoint is fine. */}
          {offerAddAnyway && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !ready}
              data-testid="inference-add-anyway"
              onClick={() => submit(true)}
            >
              Add anyway
            </Button>
          )}
          {/* Says what it is doing. The probe is a network round trip and a
              button that only greys out reads as a click that did not land —
              which is how a Connect gets pressed twice. */}
          <Button
            type="button"
            disabled={busy || !ready}
            data-testid="inference-connect-submit"
            onClick={() => submit(false)}
          >
            {busy ? "Testing…" : custom ? "Add Provider" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
