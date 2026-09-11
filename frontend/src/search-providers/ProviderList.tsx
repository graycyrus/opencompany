import { EllipsisVertical, Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Monogram } from "./AddProviderDialog";
import { COPY } from "./catalogue";
import { healthLabel, testOutcome } from "./classify";
import type { TestState } from "./classify";
import { MANAGED_LABEL, MANAGED_SLUG, controlsFor, isEmpty, managedIsOn, managedSubline, rowSubline } from "./resolve";
import type { ProbeClass, SearchProvider } from "./types";

/**
 * Check this provider, and say so in place.
 *
 * **On the row, not in the overflow menu**, because the answer belongs to the
 * row: with two providers connected, a result rendered under the card says
 * nothing about which one was tested.
 *
 * Gated on `canManage` here where the LLM page's is not, because this host's
 * search probe is `AdminScopedCompany`: the check spends the company's money —
 * no search provider publishes a free credential validator — and for a
 * self-hosted provider it fetches an operator-supplied address. The console must
 * not offer more than the host allows any more than it should offer less.
 *
 * The result is in an `aria-live` region. It clears itself after ten seconds,
 * and a result that disappears is invisible to a screen reader unless it is
 * announced when it arrives.
 */
function TestControl({
  label,
  slug,
  state,
  free,
  disabled,
  onTest,
}: {
  label: string;
  slug: string;
  state: TestState;
  /** Whether checking this provider costs a real search. */
  free: boolean;
  disabled: boolean;
  onTest: () => void;
}) {
  const outcome = testOutcome(state);
  return (
    <>
      <span
        aria-live="polite"
        className={cn(
          // `sr-only` rather than `hidden`: the result must still be announced
          // on a narrow screen, it just must not take a column there.
          "sr-only text-xs sm:not-sr-only sm:max-w-32 sm:truncate",
          outcome?.tone === "ok" && "text-status-done-text",
          outcome?.tone === "error" && "text-status-blocked-text",
        )}
        data-testid={`search-provider-${slug}-test-result`}
      >
        {outcome?.message ?? ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled || state.kind === "testing"}
        aria-label={`Test ${label}`}
        title={free ? `Test ${label}.` : `Test ${label}. ${COPY.checkCosts}`}
        data-testid={`search-provider-${slug}-test`}
        onClick={onTest}
      >
        <RefreshCw className={cn("size-4", state.kind === "testing" && "animate-spin")} />
      </Button>
    </>
  );
}

/**
 * The Connected list: where this company's teammates search.
 *
 * One row per provider, and each row is **a mark, a name, one sub-line and a
 * control**. Nothing else. The page this replaces opened with four paragraphs
 * explaining what bring-your-own-key meant, what Test cost and what Remove key
 * did — every one of them describing a control that was visible while it was
 * being read.
 *
 * ## Managed is a badge, not a disabled toggle
 *
 * A locked switch reads as switchable-but-broken and invites a fight the
 * operator cannot win. Managed search is what the absence of everything else
 * means, so there is nothing to switch.
 *
 * ## No decisions live here
 *
 * Which sub-line a row gets, which controls it offers, what a probe class is
 * called — all of it is a function in `resolve.ts` or `classify.ts` with a unit
 * test. What is left is layout.
 */
export function ProviderList({
  providers,
  inBuild,
  managedConfigured,
  managedDailyCallCap,
  canManage,
  busySlug,
  health,
  onAdd,
  onToggle,
  onTest,
  onReplaceKey,
  onRemoveKey,
  onEditEndpoint,
  onMakeDefault,
  onRemove,
  testState,
}: {
  providers: readonly SearchProvider[];
  inBuild: boolean;
  managedConfigured: boolean;
  managedDailyCallCap: number;
  canManage: boolean;
  /** The slug currently mid-request, so its own controls settle rather than the whole list. */
  busySlug?: string | null;
  /** The last probe class learnt for a slug, if any. */
  health: (slug: string) => ProbeClass | undefined;
  onAdd: () => void;
  onToggle: (provider: SearchProvider, enabled: boolean) => void;
  onTest: (provider: SearchProvider) => void;
  onReplaceKey: (provider: SearchProvider) => void;
  onRemoveKey: (provider: SearchProvider) => void;
  onEditEndpoint: (provider: SearchProvider) => void;
  onMakeDefault: (provider: SearchProvider) => void;
  onRemove: (provider: SearchProvider) => void;
  testState: (slug: string) => TestState;
}) {
  const managedOn = managedIsOn(inBuild, managedConfigured);

  // Nothing at all: no records, and no managed surface behind them. The card
  // would otherwise be a heading over blank space, which reads as a page that
  // failed to load rather than a company that has not started.
  if (isEmpty(providers, managedOn)) {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6" data-testid="search-providers-empty">
        <p className="text-sm">
          <span className="font-medium">No search providers connected.</span>{" "}
          <span className="text-muted-foreground">
            {managedSubline(inBuild, managedConfigured, managedDailyCallCap)}.
          </span>
        </p>
        <Button type="button" disabled={!canManage} onClick={onAdd}>
          <Plus className="size-4" />
          Add a provider
        </Button>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border" data-testid="search-providers">
      {/* Always first. It is not in `providers` because it is not a record — it
          is the fallback every company has whether or not it configured
          anything. It is rendered whatever it resolves to, and says which,
          rather than carrying a permanent "Always on" badge: managed search is
          always the FALLBACK, which is a different claim from always WORKING. */}
      <li className="flex items-center gap-3 px-4 py-3" data-testid="search-provider-managed">
        <Monogram label={MANAGED_LABEL} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-sm font-medium">{MANAGED_LABEL}</span>
          <span className="truncate text-xs text-muted-foreground">
            {managedSubline(inBuild, managedConfigured, managedDailyCallCap)}
          </span>
        </span>
        {managedOn && (
          <Badge variant="secondary" data-testid="search-provider-managed-on">
            On
          </Badge>
        )}
      </li>

      {providers.map((provider) => (
        <ProviderRow
          key={provider.slug}
          provider={provider}
          canManage={canManage}
          busy={busySlug === provider.slug}
          health={health(provider.slug)}
          onToggle={onToggle}
          onTest={onTest}
          onReplaceKey={onReplaceKey}
          onRemoveKey={onRemoveKey}
          onEditEndpoint={onEditEndpoint}
          onMakeDefault={onMakeDefault}
          onRemove={onRemove}
          testState={testState}
        />
      ))}
    </ul>
  );
}

function ProviderRow({
  provider,
  canManage,
  busy,
  health,
  onToggle,
  onTest,
  onReplaceKey,
  onRemoveKey,
  onEditEndpoint,
  onMakeDefault,
  onRemove,
  testState,
}: {
  provider: SearchProvider;
  canManage: boolean;
  busy: boolean;
  health?: ProbeClass;
  onToggle: (provider: SearchProvider, enabled: boolean) => void;
  onTest: (provider: SearchProvider) => void;
  onReplaceKey: (provider: SearchProvider) => void;
  onRemoveKey: (provider: SearchProvider) => void;
  onEditEndpoint: (provider: SearchProvider) => void;
  onMakeDefault: (provider: SearchProvider) => void;
  onRemove: (provider: SearchProvider) => void;
  testState: (slug: string) => TestState;
}) {
  const controls = controlsFor(provider);
  const offers = (control: string) => controls.includes(control as never);

  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid={`search-provider-${provider.slug}`}>
      <Monogram label={provider.label} />
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-sm font-medium">{provider.label}</span>
        <span className="truncate text-xs text-muted-foreground">{rowSubline(provider)}</span>
      </span>

      {/* A word, not a sentence. What it means — that this is the one the
          teammates actually search through — is the card's single sub-line,
          said once rather than on every row. */}
      {provider.isDefault && (
        <Badge variant="secondary" data-testid={`search-provider-${provider.slug}-default`}>
          Default
        </Badge>
      )}

      {/* Silent when nothing has been learnt AND when it is fine. A column where
          every healthy row says "ok" spends itself saying nothing and makes the
          one row that is not healthy harder to find. */}
      {health && (
        <span
          className="truncate text-xs text-status-blocked-text"
          data-testid={`search-provider-${provider.slug}-health`}
        >
          {healthLabel(health)}
        </span>
      )}

      <TestControl
        label={provider.label}
        slug={provider.slug}
        state={testState(provider.slug)}
        free={!provider.takesKey}
        disabled={!canManage || busy}
        onTest={() => onTest(provider)}
      />

      <Switch
        checked={provider.enabled}
        disabled={!canManage || busy}
        aria-label={`${provider.label} enabled`}
        data-testid={`search-provider-${provider.slug}-toggle`}
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
              data-testid={`search-provider-${provider.slug}-menu`}
            >
              <EllipsisVertical className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {offers("replace-key") && (
            <DropdownMenuItem onClick={() => onReplaceKey(provider)}>Replace key</DropdownMenuItem>
          )}
          {offers("edit-endpoint") && (
            <DropdownMenuItem onClick={() => onEditEndpoint(provider)}>
              Change address
            </DropdownMenuItem>
          )}
          {offers("make-default") && (
            <DropdownMenuItem onClick={() => onMakeDefault(provider)}>Set as default</DropdownMenuItem>
          )}
          {/* Offered only where there is a key to remove. SearXNG has an address
              and no account, so this never appears on its row. */}
          {offers("remove-key") && (
            <DropdownMenuItem variant="destructive" onClick={() => onRemoveKey(provider)}>
              Remove key
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

export { MANAGED_SLUG };
