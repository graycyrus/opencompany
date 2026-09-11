import { Check, CircleAlert, Minus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { categoryOf, rowDetail } from "./catalogue";
import { healthLabel } from "./classify";
import type { Provider } from "./types";

/**
 * The Connected list: what this company can reach a model through.
 *
 * Read-only for now, deliberately. The single form below it is still the way to
 * change anything, so this stage runs two surfaces at once on purpose — the list
 * says what is connected, the form still changes it. Adding a second provider,
 * and with it the per-row controls, is the stage after this one.
 *
 * Even at one row this says more than the form ever did. The form calls itself a
 * "switch to" form in its own comments, and that was accurate: there was no list
 * of what is connected, because at most one thing ever was.
 *
 * ## No decisions live here
 *
 * Every branch this renders — which detail line a category gets, what a health
 * state is called — is a function in `catalogue.ts` or `classify.ts` with a unit
 * test of its own. What is left is layout, which is why there is nothing in this
 * file that deserves a test a screenshot would not answer better.
 */
export function ProviderList({ providers }: { providers: readonly Provider[] }) {
  if (providers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="inference-providers-empty">
        Nothing connected yet. This company is on the managed brain.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="inference-providers">
      {providers.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} />
      ))}
    </ul>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const category = categoryOf(provider.kind);
  const detail = rowDetail(category, provider.baseUrl);

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
      data-testid={`inference-provider-${provider.slug}`}
    >
      {/*
        A dot rather than a switch: this stage cannot change the state, and a
        control that does nothing is worse than no control. The switch arrives
        with the stage that can honour it.
      */}
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          provider.enabled ? "bg-status-done" : "bg-status-idle",
        )}
      />
      <span className="min-w-0 font-medium">{provider.label}</span>
      {/* Cloud rows show the endpoint's host, not the whole URL: the path is
          noise at a glance and the host is what an operator recognises. */}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>
      <span className="text-xs text-muted-foreground">
        {provider.keyConfigured ? "•••• configured" : "no key"}
      </span>
      <ProviderHealth provider={provider} />
      <Badge
        variant="outline"
        className="ms-auto"
        data-testid={`inference-provider-${provider.slug}-state`}
      >
        {provider.enabled ? "on" : "off"}
      </Badge>
    </li>
  );
}

/**
 * What was last learnt about reaching this provider.
 *
 * Absent when nothing has been learnt yet, which is honest: a row that has never
 * been probed is not a row that is working. The alternative — a green tick by
 * default — is the state the design being ported is in, where a provider whose
 * key was revoked an hour ago looks identical to one that works.
 *
 * A failure is amber, not red. The provider is saved and its credential is
 * stored; what is in question is reachability, and colouring that as an error
 * would be a lie about what happened.
 */
function ProviderHealth({ provider }: { provider: Provider }) {
  if (!provider.health) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" /> not checked
      </span>
    );
  }
  if (provider.health.state === "ok") {
    return (
      <span className="flex items-center gap-1 text-xs text-status-done-text">
        <Check className="size-3" /> ok
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-status-blocked-text">
      <CircleAlert className="size-3" /> {healthLabel(provider.health.state)}
    </span>
  );
}
