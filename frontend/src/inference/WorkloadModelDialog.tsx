import { useEffect, useState } from "react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelField } from "./ModelField";
import { overrideIsSendable } from "./proxy-compat";
import { WORKLOAD_COPY, formatRef, parseRef, primaryLabel, routingTargets } from "./routing";
import type { Provider, ProviderRef, Workload } from "./types";

/** The sentinel values the provider select uses for the two slug-less choices. */
const UNSET = "__unset__";
const MANAGED = "__managed__";

/**
 * Choosing what one workload runs on.
 *
 * The **only** place in this surface that tests with a real completion rather
 * than a catalog listing, and correctly so: the add flow asks "is this
 * reachable", a routing row asks "will this model actually answer". Those are
 * different questions and a catalog listing cannot answer the second.
 *
 * The dialog carries the workload's recommendation hint, because it is the part
 * that makes this screen usable by someone who has never chosen a model before.
 * It is the first thing a rewrite drops as verbose; it is not verbose, it is the
 * feature — and it is *here*, on the row it applies to, rather than in a
 * paragraph above the table.
 *
 * The model is free text. A select sourced from the provider's catalog would
 * make the only correct value unreachable at an Azure endpoint, where the
 * request keys on a **deployment name** while `/models` publishes base model
 * ids — and a typed id is honoured verbatim at every endpoint anyway.
 */
export function WorkloadModelDialog({
  client,
  company,
  workload,
  providers,
  current,
  testing,
  testResult,
  onTest,
  onCancel,
  onApply,
}: {
  client: OpenCompanyClient;
  company: string | null;
  /** The workload being edited, or `null` when the dialog is closed. */
  workload: Workload | null;
  providers: readonly Provider[];
  current: ProviderRef;
  testing: boolean;
  /** What the last test said, if one has run. */
  testResult: string | null;
  onTest: (ref: ProviderRef) => void;
  onCancel: () => void;
  onApply: (ref: ProviderRef) => void;
}) {
  const [target, setTarget] = useState<string>(UNSET);
  const [model, setModel] = useState("");

  useEffect(() => {
    if (!workload) return;
    setTarget(
      current.kind === "cloud" ? current.providerSlug : current.kind === "managed" ? MANAGED : UNSET,
    );
    setModel(current.kind === "cloud" || current.kind === "local" ? (current.model ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workload]);

  if (!workload) return null;
  const copy = WORKLOAD_COPY[workload];
  const targets = routingTargets(providers);

  // The override is dropped here, at the one point that crosses the boundary,
  // rather than by clearing the input — so the operator can see what they typed
  // and why it will not be used.
  const sendableModel = overrideIsSendable(target, model) ? model.trim() : "";
  const ref: ProviderRef =
    target === UNSET
      ? { kind: "default" }
      : target === MANAGED
        ? { kind: "managed" }
        : parseRef(sendableModel ? `${target}:${sendableModel}` : target);

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="inference-workload-dialog">
        <DialogHeader>
          <DialogTitle>{copy.label}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <p className="text-xs text-muted-foreground">Recommended: {copy.hint}</p>

          <div className="grid gap-1.5">
            <Label htmlFor="inference-workload-provider">Provider</Label>
            <Select
              value={target}
              onValueChange={(v) => v && setTarget(String(v))}
            >
              <SelectTrigger id="inference-workload-provider" className="w-full">
                {/* The trigger renders the raw value unless told otherwise, and
                    these values are sentinels — `__unset__` is not a thing to
                    show an operator. The same trap `TaskEditDialog` documents
                    for a column id versus its label. */}
                <SelectValue>{() => targetLabel(target, providers)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {/* Unset and Managed are different states on purpose: one is an
                    absence and one is a choice. Collapsing them loses the
                    ability to say "this row is deliberately managed". */}
                <SelectItem value={UNSET}>{primaryLabel(providers)}</SelectItem>
                <SelectItem value={MANAGED}>Managed</SelectItem>
                {targets.map((p) => (
                  <SelectItem key={p.slug} value={p.slug}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {target !== UNSET && target !== MANAGED && (
            <ModelField
              client={client}
              company={company}
              slug={target}
              id="inference-workload-model"
              value={model}
              onChange={setModel}
            />
          )}

          {/* Judged on a SETTLED value, never on a keystroke: six of this
              rule's nine recorded regressions are about dropping a value while
              it was still being typed. It applies to the platform proxy alone —
              every other provider takes a typed id verbatim. */}
          {model.trim() && !overrideIsSendable(target, model) && (
            <p className="text-xs text-status-blocked-text" data-testid="inference-model-incompatible">
              The managed endpoint resolves tier names and its own
              <code className="px-1 font-mono">openrouter/author/model</code> form. This id would
              be rejected, so it will not be saved.
            </p>
          )}

          {testResult && (
            <p className="text-xs text-muted-foreground" data-testid="inference-workload-test">
              {testResult}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {/* The cost warning lives on the button it applies to, not above the
              fold: this sends one real completion and the provider may charge
              for it. */}
          <Button
            type="button"
            variant="outline"
            disabled={testing || ref.kind === "default" || ref.kind === "managed"}
            title="Sends one real completion. Your provider may charge for it."
            data-testid="inference-workload-test-button"
            onClick={() => onTest(ref)}
          >
            Test
          </Button>
          <Button
            type="button"
            data-testid="inference-workload-apply"
            onClick={() => onApply(ref)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the provider trigger reads for a chosen value.
 *
 * A function rather than an inline ternary because the two sentinels and the
 * slug lookup are three cases, and a select that shows `__unset__` to an
 * operator is the failure this exists to prevent.
 */
function targetLabel(target: string, providers: readonly Provider[]): string {
  if (target === UNSET) return primaryLabel(providers);
  if (target === MANAGED) return "Managed";
  return providers.find((p) => p.slug === target)?.label ?? target;
}

/** The route string a ref writes, exported so the tab can compare drafts. */
export const refToString = formatRef;
