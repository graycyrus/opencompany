import { EllipsisVertical } from "lucide-react";

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
import type { Provider } from "./types";

/**
 * What the managed row says about itself, given what its chain resolves to.
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
export function managedRow(source: ManagedState["source"] | undefined): {
  detail: string;
  badge: string | null;
} {
  switch (source) {
    case "provider_key":
      return { detail: "Using the key saved for inference", badge: "On" };
    case "company_account":
      return { detail: "Billed to this company's TinyHumans account", badge: "On" };
    case "instance":
      return { detail: "Billed to whoever runs this server", badge: "On" };
    case "none":
      return { detail: "No credential resolves — agents cannot think", badge: null };
    // An older host did not say. "Unknown" is not "working", so it gets no
    // badge either; the alternative is a green tick nobody established.
    default:
      return { detail: "TinyHumans chooses a model for each task", badge: null };
  }
}

/** The managed row's name. */
export const MANAGED_LABEL = "Managed";

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
}) {
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
              {managedRow(managed?.source).detail}
            </span>
          </span>
          {/* No toggle. Managed cannot be switched off, and a control that does
              nothing is worse than no control. */}
          {managedRow(managed?.source).badge && (
            <Badge
              variant="outline"
              className="border-status-done text-status-done-text"
              data-testid="inference-provider-managed-state"
            >
              {managedRow(managed?.source).badge}
            </Badge>
          )}
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

      <Health provider={provider} />

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
function Health({ provider }: { provider: Provider }) {
  if (!provider.health || provider.health.state === "ok") return null;
  return (
    <span
      className="truncate text-xs text-status-blocked-text"
      data-testid={`inference-provider-${provider.slug}-health`}
    >
      {healthLabel(provider.health.state)}
    </span>
  );
}
