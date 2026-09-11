import { EllipsisVertical, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Monogram } from "./AddProviderDialog";
import { categoryOf, endpointHost } from "./catalogue";
import { healthLabel } from "./classify";
import type { ManagedState } from "@/api/inference";
import type { Provider, ProviderHealth } from "./types";

/**
 * The one sub-line the managed row shows, given what its chain resolves to.
 *
 * It used to say **"Always on"**, inherited from a design where the same company
 * runs the managed backend. Here the managed tier needs a credential and can
 * resolve to nothing, so that badge was a claim of availability the row could
 * not back — the failure a five-state cognition model exists to prevent.
 *
 * The two "on" states that bill different accounts are kept apart, because that
 * is the decision the operator is on this page to make: connecting their own
 * account moves the bill for every turn, and a row that says only "on" hides
 * that it has not happened.
 */
export function managedRow(source: ManagedState["source"] | undefined): string {
  switch (source) {
    case "provider_key":
      return "Using the key saved for inference";
    case "company_account":
      return "Billed to this company's TinyHumans account";
    case "instance":
      return "Billed to whoever runs this server";
    case "none":
      return "No credential resolves — agents cannot think";
    // An older host did not say, and "unknown" is not "working" — so this says
    // what managed is rather than claiming a state nobody established.
    default:
      return "TinyHumans chooses a model for each task";
  }
}

/** The managed row's name. */
export const MANAGED_LABEL = "Managed";

/** The slug its credential and its health are keyed on. */
export const MANAGED_SLUG = "tinyhumans";

/**
 * The Connected list: what this company can reach a model through.
 *
 * One row per provider, and each row is **a mark, a name, one sub-line and a
 * control**. Nothing else. The page this replaces carried several paragraphs
 * explaining what bring-your-own-key meant, what Test cost and what Reset did;
 * almost all of it said what the control beside it already said.
 *
 * ## Managed is a badge, not a disabled toggle
 *
 * A locked switch reads as switchable-but-broken and invites a fight the
 * operator cannot win. A badge says the same thing and is honest about it.
 *
 * ## No decisions live here
 *
 * Which sub-line a row gets, what a health state is called, whether a category
 * carries a slug — all of it is a function in this file's pure neighbours or in
 * `rowSubline` below, each with a unit test. What is left is layout.
 */
export function ProviderList({
  providers,
  managed,
  canManage,
  busySlug,
  onToggle,
  onEdit,
  onTest,
  onRemove,
  onMakeDefault,
  onAdd,
  onManagedToggle,
  onManagedTest,
  onManagedReplaceKey,
  onManagedRemoveKey,
}: {
  providers: readonly Provider[];
  /** What the managed chain resolves to. `undefined` when the host did not say. */
  managed?: ManagedState;
  canManage: boolean;
  /** The slug currently mid-request, so its own controls settle rather than the whole list. */
  busySlug?: string | null;
  onToggle: (provider: Provider, enabled: boolean) => void;
  onEdit: (provider: Provider) => void;
  onTest: (provider: Provider) => void;
  onRemove: (provider: Provider) => void;
  onMakeDefault: (provider: Provider) => void;
  /**
   * The same action the header card's button performs, passed in rather than
   * reimplemented — one way to add a provider, not two that can drift.
   */
  onAdd: () => void;
  /** Switch managed in or out of routing — never its credential. */
  onManagedToggle: (enabled: boolean) => void;
  onManagedTest: () => void;
  /** Open the managed key dialog, to add or replace step 1 of its chain. */
  onManagedReplaceKey: () => void;
  /**
   * Clear the key stored **for this row**.
   *
   * It removes step 1 and nothing else. If the company account or the instance
   * identity still answer, managed stays on — and the row then says which,
   * rather than going blank or claiming to be off.
   */
  onManagedRemoveKey: () => void;
}) {
  // Nothing connected at all: no records, and no managed chain behind them. The
  // card would otherwise be a heading over blank space, which reads as a page
  // that failed to load rather than a company that has not started.
  if (providers.length === 0 && !managed?.configured) {
    return (
      <div
        className="flex flex-col items-start gap-3 px-4 py-6"
        data-testid="inference-providers-empty"
      >
        <p className="text-sm">
          <span className="font-medium">No providers connected yet.</span>{" "}
          <span className="text-muted-foreground">Connect one to get started.</span>
        </p>
        <Button type="button" disabled={!canManage} onClick={onAdd}>
          <Plus className="size-4" />
          Add a provider
        </Button>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border" data-testid="inference-providers">
      {/* Always first and always present. It is not in `providers` because it is
          not a record — it is the fallback every company has whether or not it
          has configured anything. */}
      {/* Present only when the chain actually resolves. **Not** keyed on a
          provider record existing: steps 3 and 4 answer from the company
          identity or the instance environment, neither of which is a record, so
          a hosted tenant has a working managed provider nobody ever added. When
          nothing resolves it is not a connected row — it is an entry in the add
          dialog's Cloud list, like anything else that is not connected. */}
      {managed?.configured && (
        <li className="flex items-center gap-3 px-4 py-3" data-testid="inference-provider-managed">
          <Monogram label={MANAGED_LABEL} />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-medium">{MANAGED_LABEL}</span>
            <span className="truncate text-xs text-muted-foreground">
              {managedRow(managed.source)}
            </span>
          </span>

          <Health slug={MANAGED_SLUG} health={managed.health} />

          {/* The full set of row controls, because every one of them means
              something here. The credential can be replaced or removed, the
              chain can be checked, and managed can be excluded from routing —
              which is a different statement from removing its key, and the one
              the toggle makes. */}
          <Switch
            checked={managed.enabled !== false}
            disabled={!canManage || busySlug === MANAGED_SLUG}
            aria-label="Managed enabled"
            data-testid="inference-provider-managed-toggle"
            onCheckedChange={(next) => onManagedToggle(next)}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!canManage || busySlug === MANAGED_SLUG}
                  aria-label="Managed actions"
                  data-testid="inference-provider-managed-menu"
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onManagedTest}>Test</DropdownMenuItem>
              <DropdownMenuItem onClick={onManagedReplaceKey}>
                {managed.source === "provider_key" ? "Replace key" : "Add a key"}
              </DropdownMenuItem>
              {/* Offered only when there is a key of this row's own to remove.
                  The company account and the instance identity are not this
                  row's to take away — and the copy says what actually happens,
                  which is a fall back rather than a switch-off. */}
              {managed.source === "provider_key" && (
                <DropdownMenuItem variant="destructive" onClick={onManagedRemoveKey}>
                  Remove key
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      )}

      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          canManage={canManage}
          busy={busySlug === provider.slug}
          onToggle={onToggle}
          onEdit={onEdit}
          onTest={onTest}
          onRemove={onRemove}
          onMakeDefault={onMakeDefault}
        />
      ))}
    </ul>
  );
}

/**
 * The one sub-line a row gets.
 *
 * One fact, chosen by what the row is: a keyed provider is identified by the
 * fact that it holds a key, a local runtime by where it runs, a CLI login by
 * whose credential it borrows, and a keyless cloud endpoint by its host. Three
 * facts stacked would be a table, and an operator is scanning for the row rather
 * than reading it.
 */
export function rowSubline(provider: Provider): string {
  const category = categoryOf(provider.kind);
  if (category === "local") return "Runs on this machine";
  if (category === "cli") return "Uses a login another CLI already holds";
  if (provider.keyConfigured) return "•••• configured";
  return endpointHost(provider.baseUrl) || "no key";
}

function ProviderRow({
  provider,
  canManage,
  busy,
  onToggle,
  onEdit,
  onTest,
  onRemove,
  onMakeDefault,
}: {
  provider: Provider;
  canManage: boolean;
  busy: boolean;
  onToggle: (provider: Provider, enabled: boolean) => void;
  onEdit: (provider: Provider) => void;
  onTest: (provider: Provider) => void;
  onRemove: (provider: Provider) => void;
  onMakeDefault: (provider: Provider) => void;
}) {
  return (
    <li
      className="flex items-center gap-3 px-4 py-3"
      data-testid={`inference-provider-${provider.slug}`}
    >
      <Monogram label={provider.label} slug={provider.slug} />
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-sm font-medium">{provider.label}</span>
        <span className="truncate text-xs text-muted-foreground">{rowSubline(provider)}</span>
      </span>

      {/* A word, not a sentence. What a default is, is not something this page
          has to explain — where unrouted work goes is the only thing an
          operator needs to be able to see, and moving it is a menu item. */}
      {provider.isDefault && (
        <Badge variant="secondary" data-testid={`inference-provider-${provider.slug}-default`}>
          Default
        </Badge>
      )}

      <Health slug={provider.slug} health={provider.health} />

      <Switch
        checked={provider.enabled}
        disabled={!canManage || busy}
        aria-label={`${provider.label} enabled`}
        data-testid={`inference-provider-${provider.slug}-toggle`}
        onCheckedChange={(next) => onToggle(provider, next)}
      />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={!canManage || busy}
              aria-label={`${provider.label} actions`}
              data-testid={`inference-provider-${provider.slug}-menu`}
            >
              <EllipsisVertical className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEdit(provider)}>Edit</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTest(provider)}>Test</DropdownMenuItem>
          {/* Offered only where it would change something: a provider that is
              already the default, or one that is switched off and so cannot be
              a routing target at all. */}
          {!provider.isDefault && provider.enabled && (
            <DropdownMenuItem onClick={() => onMakeDefault(provider)}>
              Make default
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => onRemove(provider)}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * What was last learnt about reaching this provider.
 *
 * **Silent when nothing has been learnt**, which is honest: a row that has never
 * been checked is not a row that is working, and a green tick by default is the
 * state the design this is ported from is in — where a provider whose key was
 * revoked an hour ago looks identical to one that works.
 *
 * Silent when it is `ok`, too, and that is the deletion pass applied to a status
 * column: a list where every healthy row says "ok" spends a column saying
 * nothing, and the one row that is not healthy is harder to find for it.
 */
function Health({ slug, health }: { slug: string; health?: ProviderHealth }) {
  if (!health || health.state === "ok") return null;
  return (
    <span
      className="truncate text-xs text-status-blocked-text"
      data-testid={`inference-provider-${slug}-health`}
    >
      {healthLabel(health.state)}
    </span>
  );
}
