import { useState } from "react";

import type { OpenCompanyClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelField } from "./ModelField";
import { MANAGED_SLUG } from "./ProviderList";
import { overrideIsSendable } from "./proxy-compat";

/**
 * Choose or change the model Managed sends (issue #2303).
 *
 * The same picker a routing row uses — `ModelField`, reading Managed's own
 * catalog through `…/providers/tinyhumans/models` with whatever its chain
 * presents — so choosing Managed's model is the act choosing any provider's is.
 *
 * Save stays disabled until the value is one the managed endpoint can take: a
 * bare OpenRouter id, never a workload name. A blank is not "let the endpoint
 * resolve it" here, because the managed endpoint resolves nothing — clearing
 * the model is what Remove key does, together with the key it was chosen for.
 *
 * The caller keys this per open, so `model` seeds once at mount from `current`.
 */
export function ManagedModelDialog({
  open,
  client,
  company,
  current,
  busy,
  error,
  onCancel,
  onSave,
}: {
  open: boolean;
  client: OpenCompanyClient;
  company: string | null;
  /** The model already chosen, if any. */
  current?: string;
  busy: boolean;
  /** What went wrong last time, if anything. */
  error: string | null;
  onCancel: () => void;
  onSave: (model: string) => void;
}) {
  const [model, setModel] = useState(() => current ?? "");
  const trimmed = model.trim();
  const sendable = trimmed.length > 0 && overrideIsSendable(MANAGED_SLUG, trimmed);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="inference-managed-model-dialog">
        <DialogHeader>
          <DialogTitle>Managed model</DialogTitle>
          <DialogDescription>
            Every workload on Managed sends this model. The list is Managed&apos;s own catalog.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <ModelField
            client={client}
            company={company}
            slug={open ? MANAGED_SLUG : null}
            id="inference-managed-model"
            value={model}
            disabled={busy}
            onChange={setModel}
          />
          {/* Judged on the settled value, never on a keystroke — the same rule
              the routing dialog follows for this provider. */}
          {trimmed && !overrideIsSendable(MANAGED_SLUG, trimmed) && (
            <p className="text-xs text-status-blocked-text" data-testid="inference-managed-model-invalid">
              Managed takes an OpenRouter model id in its
              <code className="px-1 font-mono">author/model</code> form, like
              <code className="px-1 font-mono">openai/gpt-4o-mini</code>, not a workload name.
            </p>
          )}
          <p
            aria-live="polite"
            className="text-sm text-status-blocked-text empty:hidden"
            data-testid="inference-managed-model-error"
          >
            {error ?? ""}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !sendable}
            data-testid="inference-managed-model-save"
            onClick={() => onSave(trimmed)}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
