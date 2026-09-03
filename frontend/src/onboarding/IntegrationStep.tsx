import { ArrowRight, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Step 2 of the first-run gate, built for the card it is drawn in (bug B-001).
 *
 * **Not `OAuthView`.** The gate used to embed that route-level view whole, on
 * the reasoning that reusing the console's own flow could never drift from the
 * page the sidebar reaches. The reasoning was sound and the result was not: a
 * full connections page inside a checklist card renders eight provider tiles
 * that all read "not available here", a disabled "connect by slug" box, and two
 * bare password fields — a screen whose every control is dead, with no sentence
 * anywhere saying what the founder is supposed to do about it. Reuse is only
 * free when both callers can give the component what it assumes, and a
 * height-constrained card cannot give a route-level view a route.
 *
 * So this is the card-sized thing instead: name what the step wants, say
 * plainly what has to exist before any provider can be connected, point at the
 * page where that is entered — and, because a founder on a build with no
 * credential path has no way to satisfy it at all, offer an honest way past it
 * that is remembered (see [`markGateStepWaived`] for why that has to be durable
 * rather than session-scoped).
 */
export function IntegrationStep({
  onOpenApps,
  onWaive,
}: {
  /** Leaves the gate for the real Apps page — see `OnboardingGate`'s `onLeave`. */
  onOpenApps: () => void;
  /** Records this step as answered as far as this build allows. */
  onWaive: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="gate-integration-step">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Teammates reach Gmail, Slack and GitHub through a connected account. Before any
          provider can be connected, this company needs a credential to connect it with — a
          TinyHumans account key, or a Composio token of your own.
        </p>
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Self-hosted builds ship without one. Until a credential is entered, every
            provider stays unavailable — that is the build, not a fault in your setup.
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onOpenApps} data-testid="gate-integration-open-apps">
          Enter a credential in Apps
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" onClick={onWaive} data-testid="gate-integration-waive">
          I don&apos;t have one — skip this step
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Skipping is remembered for this company, so this step won&apos;t be asked again in a
        new tab. Connect an account later from Apps whenever you have a credential.
      </p>
    </div>
  );
}
