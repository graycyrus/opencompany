import { useEffect, useState } from "react";

import type { OpenCompanyClient } from "@/api/client";
import { listProviderModels } from "@/api/inference";
import type { ProviderCatalog } from "@/api/inference";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The select's item for "no override — send the tier and let it resolve". */
const TIER_DEFAULT = "__tier_default__";

/**
 * Choosing a model id for one provider.
 *
 * **A catalog select with a free-text escape hatch**, not one or the other. The
 * catalog is what makes this usable — an operator who has to know a vendor's id
 * scheme by heart is being asked the wrong question — and the escape hatch is
 * what keeps it correct.
 *
 * ## Why the escape hatch is always reachable, not only on failure
 *
 * Azure routes on a **deployment name** while `/models` publishes **base model
 * ids**, so at an Azure endpoint the only correct value is one the catalog will
 * never contain. The host flags those endpoints and this defaults to text there;
 * everywhere else the catalog is the default and the toggle is one click away,
 * because a catalog can be stale or incomplete anywhere.
 *
 * ## The three honest states of a catalog read
 *
 * Loading says so rather than showing an empty list that fills in underneath a
 * click. A failed or empty read falls back to text **and says why** — an empty
 * select reads as "this provider has no models", which nobody established. A
 * successful read is a select.
 *
 * ## Blank stays meaningful
 *
 * Empty is not "unset the field", it is *send the tier and let the endpoint
 * resolve it* — which is how `TierVocabulary` passthrough works and is the right
 * answer at a tier-native endpoint. So it is an item in the list with its own
 * label, never an absence.
 *
 * ## Nothing typed is ever discarded
 *
 * The catalog arrives asynchronously and the field starts as text. When the list
 * lands it becomes a select **only if nothing has been typed** — upgrading a
 * field out from under someone mid-keystroke is the same class of bug as
 * stripping a value mid-keystroke, which this module's neighbour has nine
 * recorded instances of.
 */
export function ModelField({
  client,
  company,
  slug,
  id,
  value,
  disabled,
  onChange,
}: {
  client: OpenCompanyClient;
  company: string | null;
  /** The provider whose catalog to read, or `null` for none (no provider chosen). */
  slug: string | null;
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  /** Whether the operator asked for the text field explicitly. */
  const [typed, setTyped] = useState(false);

  useEffect(() => {
    setCatalog(null);
    setTyped(false);
    if (!slug) return;
    let live = true;
    setLoading(true);
    listProviderModels(client, company, slug)
      .then((next) => live && setCatalog(next))
      // A read that fails entirely is the same state as one that answered with
      // nothing usable: fall back to text and say so.
      .catch(() => live && setCatalog(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, company, slug]);

  const listed = catalog?.models ?? [];
  // A value already typed wins over an upgrade: the field never changes shape
  // under a value the operator put in it.
  const offersSelect =
    !typed && !catalog?.freeTextOnly && listed.length > 0 && (!value || listed.includes(value));

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Model id</Label>
      {offersSelect ? (
        <Select
          value={value || TIER_DEFAULT}
          disabled={disabled}
          onValueChange={(next) => onChange(next === TIER_DEFAULT ? "" : String(next ?? ""))}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue>
              {() => (value ? value : "Send the tier — let the endpoint resolve it")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* Blank is a real state, so it is an item with a label rather than
                an absence the operator has to guess at. */}
            <SelectItem value={TIER_DEFAULT}>
              Send the tier — let the endpoint resolve it
            </SelectItem>
            {listed.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder="Leave blank to send the tier"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      <ModelFieldNote
        loading={loading}
        catalog={catalog}
        offersSelect={offersSelect}
        onUseCatalog={() => setTyped(false)}
        onUseText={() => setTyped(true)}
      />
    </div>
  );
}

/**
 * The one line under the field, which says whichever of four things is true.
 *
 * Split out because "which sentence" is a four-branch decision and the field
 * above should read as layout.
 */
function ModelFieldNote({
  loading,
  catalog,
  offersSelect,
  onUseCatalog,
  onUseText,
}: {
  loading: boolean;
  catalog: ProviderCatalog | null;
  offersSelect: boolean;
  onUseCatalog: () => void;
  onUseText: () => void;
}) {
  if (loading) {
    return <p className="text-xs text-muted-foreground">Reading this provider&apos;s models…</p>;
  }
  if (catalog?.freeTextOnly) {
    return (
      <p className="text-xs text-muted-foreground">
        This endpoint routes on a deployment name, which its model list does not publish — type
        the name you gave the deployment.
      </p>
    );
  }
  if (offersSelect) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto justify-self-start p-0 text-xs"
        data-testid="inference-model-enter-id"
        onClick={onUseText}
      >
        Enter a model id instead
      </Button>
    );
  }
  if (catalog && catalog.models.length > 0) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto justify-self-start p-0 text-xs"
        data-testid="inference-model-use-catalog"
        onClick={onUseCatalog}
      >
        Choose from this provider&apos;s models instead
      </Button>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="inference-model-no-catalog">
      {catalog?.error ?? "This provider publishes no model list, so type an id."}
    </p>
  );
}
