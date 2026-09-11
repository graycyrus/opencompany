import { useState } from "react";
import { Plus } from "lucide-react";

import { ApiError } from "@/api/types";
import type { ProbeClass } from "./types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionUnreachable } from "@/views/connections/SectionUnreachable";
import { AddProviderDialog } from "./AddProviderDialog";
import { ProviderConnectDialog } from "./ProviderConnectDialog";
import type { ConnectDraft } from "./ProviderConnectDialog";
import { ProviderList } from "./ProviderList";
import { MANAGED_FALLBACK_NOTE } from "./routing";
import type { InferenceActions, InferenceState } from "./use-inference";
import type { Provider } from "./types";

/**
 * LLM Providers: what this company can reach a model through, and how to add one.
 *
 * Two cards and one line. The page this replaces opened with four paragraphs —
 * what bring-your-own-key means, what Test costs, what Reset does, what Remove
 * key does — above a form. Every one of them explained a control that was
 * visible while they were being read.
 *
 * What survives the cut is what an operator cannot infer from the control
 * itself: the restart notice, because a save that has landed and is not yet in
 * effect looks exactly like one that is, and the cost warning on a real
 * completion, which lives on the button it applies to rather than above the fold.
 */
export function ProvidersTab({
  state,
  actions,
  canManage,
}: {
  state: InferenceState;
  actions: InferenceActions;
  canManage: boolean;
}) {
  /** Which option the connect dialog is open on, if any. */
  const [connecting, setConnecting] = useState<string | null>(null);
  /** The provider the connect dialog is editing, if it is editing one. */
  const [editing, setEditing] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the last failure was a **probe** failure.
   *
   * Gated on the class rather than on a boolean, and cleared on every attempt:
   * a slug collision or a failed key write must not offer to skip verification,
   * because neither is evidence that the endpoint is fine.
   */
  const [probeFailure, setProbeFailure] = useState<ProbeClass | null>(null);

  if (state.load === "unavailable") return null;
  if (state.load === "loading") return <Skeleton className="h-64 rounded-xl" />;
  if (state.load === "error") {
    return <SectionUnreachable label="Couldn't read this company's model providers" />;
  }

  const closeConnect = () => {
    setConnecting(null);
    setEditing(null);
    setError(null);
    setProbeFailure(null);
  };

  async function submitConnect(draft: ConnectDraft) {
    setBusy(true);
    // Cleared on every retry, so an attempt that fails for an unrelated reason
    // does not still offer to skip verification.
    setError(null);
    setProbeFailure(null);
    try {
      if (editing) {
        await actions.edit(editing.slug, {
          label: draft.label,
          baseUrl: draft.baseUrl,
          key: draft.key,
        });
      } else {
        const result = await actions.add(draft);
        // A non-destructive probe failure saved the row and kept the key. The
        // dialog closes on it, because the save succeeded — the advisory is the
        // page's note, not an error in a form that is still open.
        if (result.probe && !result.probe.ok && result.probe.class) {
          setProbeFailure(result.probe.class);
        }
      }
      closeConnect();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
      // The host refuses an add on exactly one probe class, and it is the only
      // refusal that unlocks "add anyway".
      if (err instanceof ApiError && err.message.includes("rejected the credential")) {
        setProbeFailure("auth");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {state.status?.restartRequired && (
        <RestartNotice
          canRestart={canManage && state.status.canRebuildInPlace}
          onRestart={() => void actions.restart()}
        />
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <h2 className="text-sm font-medium">LLM Providers</h2>
            <p className="text-xs text-muted-foreground">
              Add and configure language model providers.
            </p>
          </div>
          <Button
            type="button"
            disabled={!canManage}
            data-testid="inference-add-open"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-4" />
            Add a provider
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="px-0">
          <h3 className="px-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Connected
          </h3>
          <ProviderList
            providers={state.providers}
            canManage={canManage}
            busySlug={state.busySlug}
            onToggle={(p, enabled) => void actions.setEnabled(p.slug, enabled)}
            onEdit={(p) => {
              setEditing(p);
              setConnecting(p.kind);
            }}
            onTest={(p) => void actions.test(p.slug)}
            onRemove={(p) => void actions.remove(p.slug)}
          />
        </CardContent>
      </Card>

      {/* Outside the card, because it is about the whole page rather than about
          the list: managed stands behind every row in it. */}
      <p className="text-xs text-muted-foreground">{MANAGED_FALLBACK_NOTE}</p>

      {state.note && (
        <p className="text-xs text-muted-foreground" data-testid="inference-note">
          {state.note}
        </p>
      )}

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        providers={state.providers}
        onChoose={(option) => {
          setAdding(false);
          setEditing(null);
          setConnecting(option);
        }}
      />
      <ProviderConnectDialog
        optionSlug={connecting}
        providers={state.providers}
        busy={busy}
        error={error}
        offerAddAnyway={probeFailure !== null}
        onCancel={closeConnect}
        onSubmit={(draft) => void submitConnect(draft)}
      />
    </div>
  );
}

/**
 * The one explanation that survives the deletion pass.
 *
 * A saved configuration that has landed and is not yet in effect looks exactly
 * like one that is — there is no control on the page whose appearance differs —
 * so this is the case where prose is carrying information rather than repeating
 * a button. Which brain a company runs is chosen when its runtime is built, so a
 * company that started with no model keeps echoing however the config changes
 * underneath it.
 *
 * The button appears only where the host said it can actually rebuild. Naming a
 * remedy and handing over a control that cannot perform it is worse than naming
 * the remedy alone.
 */
function RestartNotice({
  canRestart,
  onRestart,
}: {
  canRestart: boolean;
  onRestart: () => void;
}) {
  return (
    <Card data-testid="inference-restart-required">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          This company booted without a model, so agents are still on the offline brain. Its
          runtime has to be rebuilt before the saved configuration takes effect.
        </p>
        {canRestart && (
          <Button type="button" variant="outline" onClick={onRestart}>
            Restart now
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
