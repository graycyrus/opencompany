import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound, Loader2 } from "lucide-react";

import type { OpenCompanyClient } from "@/api/client";
import { getComposioStatus } from "@/api/composio";
import { Button } from "@/components/ui/button";
import { withReadTimeout } from "@/lib/read-timeout";
import { COMPOSIO_MANAGED_HIDDEN } from "@/product-scope";

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
 *
 * **Two different sentences for two different reasons `integrationConnected`
 * reads false** (Codex review, PR #2046). `src/company/activation.rs` derives
 * that step from whether an active Composio CONNECTION exists — not from
 * whether a CREDENTIAL exists. A hosted founder can already have an
 * `attested`/`company`/`static` credential (`ComposioCredentialSource`,
 * `@/api/composio`) and simply not have connected a provider yet, which is an
 * ordinary, always-completable action — the exact opposite of the "self-hosted,
 * no lever at all" case the original copy and its waiver escape hatch were
 * written for. Telling that founder "this company needs a credential" and
 * offering to waive a step they can finish normally would both be wrong, so
 * this reads `getComposioStatus` the same way `OAuthView` does and branches on
 * `credentialSource !== "none"`.
 *
 * **The waiver needs its own "do we actually know" flag, separate from the
 * copy's `hasCredential`** (Codex review, PR #2046). `hasCredential` starts
 * `false` so the COPY defaults to the safe "no credential" reading while the
 * read is in flight or fails — but the waive button used to key off that same
 * boolean, which means it was VISIBLE for that entire window too. A durable
 * waiver clicked during it would permanently mark a step skipped that a
 * confirmed-slow `getComposioStatus` might have gone on to report as already
 * credentialed — exactly the "waive a step you could complete normally" harm
 * the credential-vs-connection fix above exists to prevent, just reached
 * through the timing instead of the verdict. `credentialConfirmed` is `true`
 * only once a read has actually SETTLED with an answer (never on failure —
 * unknown stays unknown, not "confirmed none"), and the waive button and its
 * footer both gate on it in addition to `!hasCredential`.
 *
 * **And the answer it was confirmed against can go stale** (Codex review, PR
 * #2046, round 3). Neither `client` nor `company` changes when a credential is
 * added, so a card left mounted while another tab pastes a Composio key keeps
 * offering a durable waiver for a step that has since become completable. The
 * waive click therefore re-reads before it persists anything — see [`waive`].
 */
/**
 * How long the waive-time credential re-read may hang before it is treated as
 * a failure (Codex review, PR #2046).
 *
 * `revalidating` disables the waive button while the re-read is out, and only
 * a settled promise re-enables it. `OpenCompanyClient` has no timeout anywhere
 * in its request path (`lib/read-timeout.ts`), so a request that is accepted
 * and never answered would leave the one control a credential-less founder
 * has disabled for the rest of the mount — the same trap this whole component
 * exists to remove, reached through a stalled read instead of a missing
 * escape. On timeout the failure branch runs: nothing is persisted, the
 * button is re-enabled, and the retry line explains why.
 */
const REVALIDATE_TIMEOUT_MS = 20000;

export function IntegrationStep({
  client,
  company,
  onOpenApps,
  onWaive,
}: {
  client: OpenCompanyClient;
  company: string | null;
  /** Leaves the gate for the real Apps page — see `OnboardingGate`'s `onLeave`. */
  onOpenApps: () => void;
  /** Records this step as answered as far as this build allows. */
  onWaive: () => void;
}) {
  // Defaults to "no credential" — the same copy this card always showed
  // before this read existed — so a still-loading or failed read costs one
  // extra "enter a credential" prompt rather than ever claiming a credential
  // exists when the read could not confirm one.
  const [hasCredential, setHasCredential] = useState(false);
  // Separate from `hasCredential` on purpose — see this component's own doc.
  // Only a SUCCESSFUL read flips this; a failure leaves it `false` right
  // alongside "still loading", so the durable waiver stays unreachable for
  // either until a read has actually confirmed there is nothing to connect.
  const [credentialConfirmed, setCredentialConfirmed] = useState(false);
  /** In flight: the re-read `waive` does before it persists anything. */
  const [revalidating, setRevalidating] = useState(false);
  /** That re-read failed, so the waiver was withheld and can be retried. */
  const [revalidateFailed, setRevalidateFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void getComposioStatus(client, company).then(
      (status) => {
        if (!live) return;
        setHasCredential(status.credentialSource !== "none");
        setCredentialConfirmed(true);
      },
      () => {
        /* transient failure — stay on the safe "no credential" default, and
         * leave `credentialConfirmed` false so the waiver stays withheld too */
      },
    );
    return () => {
      live = false;
    };
  }, [client, company]);

  /**
   * Re-reads the credential before persisting anything (Codex review, PR #2046).
   *
   * The mount effect above is the only other read, and its dependencies are
   * `client` and `company` — neither of which changes when a credential is
   * added. So a founder who opens Apps in a second tab, pastes a Composio key,
   * and comes back to this still-mounted card is offered a durable waiver for a
   * step that is now ordinarily completable, and one click marks it skipped for
   * good. That is the same harm `credentialConfirmed` closes at the other end of
   * the read's life — a waiver granted against an answer we do not actually
   * have — reached through staleness instead of through timing.
   *
   * So the click asks again rather than trusting a possibly-minutes-old answer,
   * and only calls `onWaive` if the credential is still genuinely `none`. If one
   * turned up meanwhile, the card flips to the has-credential copy instead,
   * which withdraws the waive button and points at Apps — the founder is told
   * the step became completable rather than having their click silently
   * dropped. A failed re-read persists nothing and says so: an unconfirmed
   * answer is not grounds for a durable waiver here either.
   */
  const waive = useCallback(() => {
    setRevalidating(true);
    setRevalidateFailed(false);
    void withReadTimeout(getComposioStatus(client, company), REVALIDATE_TIMEOUT_MS).then(
      (status) => {
        if (!mounted.current) return;
        setRevalidating(false);
        if (status.credentialSource !== "none") {
          setHasCredential(true);
          return;
        }
        onWaive();
      },
      () => {
        if (!mounted.current) return;
        setRevalidating(false);
        setRevalidateFailed(true);
      },
    );
  }, [client, company, onWaive]);

  return (
    <div className="space-y-4" data-testid="gate-integration-step">
      {hasCredential ? (
        <div className="space-y-2 text-sm text-muted-foreground" data-testid="gate-integration-has-credential">
          <p>
            Teammates reach Gmail, Slack and GitHub through a connected account. This
            company already has a credential to connect one with — Apps is where you pick
            a provider and connect it.
          </p>
          <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2">
            <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              This step needs an actual connected provider, not just a credential — open
              Apps and connect one to finish it.
            </span>
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Teammates reach Gmail, Slack and GitHub through a connected account. Before any
            provider can be connected, this company needs a credential to connect it with —{" "}
            {/* `COMPOSIO_MANAGED_HIDDEN` took the OpenHuman-managed route out of Apps
                (`OAuthView` hides `CompanyCredentialCard` behind the same flag), so
                naming a TinyHumans account key here sent the founder after a credential
                the page this card links to no longer accepts. Reading the flag rather
                than restating its current value keeps re-enabling that surface the
                single edit `product-scope.ts` promises it is. */}
            {COMPOSIO_MANAGED_HIDDEN
              ? "a Composio API key of your own."
              : "a TinyHumans account key, or a Composio token of your own."}
          </p>
          <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2">
            <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Self-hosted builds ship without one. Until a credential is entered, every
              provider stays unavailable — that is the build, not a fault in your setup.
            </span>
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onOpenApps} data-testid="gate-integration-open-apps">
          {hasCredential ? "Connect a provider in Apps" : "Enter a credential in Apps"}
          <ArrowRight className="size-4" />
        </Button>
        {/* A credential that exists is always a completable step — offering to
            waive it the way a build with no lever at all needs to would invite
            a founder who could just connect a provider to skip it instead.
            Gated on `credentialConfirmed` too (Codex review, PR #2046): while
            the read is still in flight or has failed, we do not yet KNOW
            which case this is, and a durable waiver clicked in that window
            would be as wrong as the credential-vs-connection mix-up this
            whole component exists to prevent. */}
        {!hasCredential && credentialConfirmed && (
          <Button variant="ghost" onClick={waive} disabled={revalidating} data-testid="gate-integration-waive">
            {revalidating && <Loader2 aria-hidden className="size-4 animate-spin" />}
            I don&apos;t have one — skip this step
          </Button>
        )}
      </div>

      {revalidateFailed && (
        <p className="text-xs text-destructive" role="status" data-testid="gate-integration-waive-failed">
          Couldn&apos;t check this company&apos;s credential just now, so nothing was skipped. Try
          again in a moment.
        </p>
      )}

      {!hasCredential && credentialConfirmed && (
        <p className="text-xs text-muted-foreground">
          Skipping is remembered for this company, so this step won&apos;t be asked again in a
          new tab. Connect an account later from Apps whenever you have a credential.
        </p>
      )}
    </div>
  );
}
