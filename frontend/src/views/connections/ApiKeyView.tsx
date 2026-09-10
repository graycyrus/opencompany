import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, ExternalLink, Loader2, Sparkles, Wallet } from "lucide-react";

import { me as fetchMe } from "@/api/auth";
import type { OpenCompanyClient } from "@/api/client";
import {
  getCompanyBilling,
  getCompanyCredential,
  type CompanyBilling,
  type CompanyCredentialStatus,
} from "@/api/credential";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CompanyCredentialCard } from "@/views/connections/CompanyCredentialCard";
import { ConnectTinyHumansButton } from "@/views/connections/ConnectTinyHumansButton";
import { HubAccountLinks } from "@/views/connections/HubAccountLinks";

interface Props {
  client: OpenCompanyClient;
  company: string | null;
}

/**
 * API Key — the one page about the account this company spends through.
 *
 * ## Why it is its own page rather than a card on Apps
 *
 * The key was reachable from two places and explained by neither. On
 * Connections → Apps it sat under a heading about third-party accounts, framed
 * as the thing that makes Gmail connectable; on Inference it appeared as one
 * option in a provider picker. Both are true and both are consequences. What
 * neither page could say, because neither is about it, is the plain thing: this
 * key is the company's account with TinyHumans, every teammate's thinking and
 * every connected app is billed to it, and when it runs out the company stops
 * working.
 *
 * A page whose subject is the account can say that once, show what is left on
 * it, and put the two actions — connect, top up — where somebody looking for
 * them would look.
 *
 * ## What it shows and what it refuses to
 *
 * Balance and plan, read through the host with the key it already holds
 * (`GET …/credential/billing`). Never the key itself: it is write-only on the
 * host and is not returned by any route, which is what makes "the console leaked
 * it" not a thing that can happen here.
 *
 * No checkout, either. Topping up and changing a plan move money and belong to
 * a person signed in to their own TinyHumans account — so those are links out,
 * to whichever hub this host is pointed at.
 */
export function ApiKeyView({ client, company }: Props) {
  // Resolved here rather than taken as a prop, the same way `OAuthView` does
  // it: the section is a dispatcher and has no user plane of its own, and a
  // page that asked its parent for authority would be trusting a value nothing
  // on this rail is responsible for keeping true.
  //
  // Courtesy, not enforcement — the host refuses a non-admin's write whatever
  // this says. What it prevents is offering somebody a credential field whose
  // submit could only ever 403.
  const [canManage, setCanManage] = useState(false);
  const [status, setStatus] = useState<CompanyCredentialStatus | null>(null);
  const [billing, setBilling] = useState<CompanyBilling | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [generation, setGeneration] = useState(0);

  // Discards a response whose company is no longer the one on screen — the same
  // guard the credential card keeps, and for the same reason: switching company
  // mid-flight would otherwise paint one company's balance under another's name.
  const wanted = useRef(company);
  wanted.current = company;

  const refresh = useCallback(async () => {
    setLoad("loading");
    const asked = company;
    try {
      // Together: the page draws one story out of both, and sequencing them
      // would show a connected company an empty wallet for a frame.
      const [credential, money] = await Promise.all([
        getCompanyCredential(client, company),
        getCompanyBilling(client, company).catch(
          (): CompanyBilling => ({ configured: false }),
        ),
      ]);
      if (wanted.current !== asked) return;
      setStatus(credential);
      setBilling(money);
      setLoad("ready");
    } catch {
      if (wanted.current !== asked) return;
      setLoad("error");
    }
  }, [client, company]);

  useEffect(() => {
    void refresh();
  }, [refresh, generation]);

  useEffect(() => {
    let live = true;
    void (async () => {
      let admin = false;
      try {
        admin = (await fetchMe(client, company)).role === "admin";
      } catch {
        // No user plane on this host, or not signed in — treat as non-admin.
      }
      if (live) setCanManage(admin);
    })();
    return () => {
      live = false;
    };
  }, [client, company]);

  const configured = status?.configured ?? false;
  const summary = billing?.summary;
  const money = typeof summary?.balanceUsd === "number" ? summary.balanceUsd : null;
  // Zero is a number worth showing, so the empty test is on `null`, never on
  // falsiness — `!money` would hide exactly the balance somebody needs to see.
  const lowOnFunds = money !== null && money <= 0;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-lg font-medium">API Key</h1>
        <p className="text-sm text-muted-foreground">
          The TinyHumans account this company acts and spends through.
        </p>
      </header>

      {/* The pitch, in the one place that is about the account rather than
          about something the account happens to unlock. Kept short and kept
          honest: what it buys, and what happens without it. */}
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-2 text-sm">
              <p>
                One key gives this company a model to think with and the accounts its agents
                act through — Gmail, Slack, GitHub and the rest — billed to a single
                TinyHumans account you top up.
              </p>
              <p className="text-muted-foreground">
                {configured
                  ? "This company has its own key. Every teammate's turns and every connected app are charged to the account it belongs to."
                  : "Until one is set, agents cannot think and no provider can be connected. Connecting takes a sign-in — nothing to copy."}
              </p>
            </div>
          </div>

          <ConnectTinyHumansButton
            client={client}
            company={company}
            available={status?.hubLink ?? false}
            canManage={canManage}
            configured={configured}
            onConnected={() => setGeneration((n) => n + 1)}
          />

          <HubAccountLinks account={status?.account} configured={configured} />
        </CardContent>
      </Card>

      {/* Balance and plan. Only once there is a key: a card reading "$0.00" for
          a company that has no account at all would be a made-up fact about a
          wallet that does not exist. */}
      {load === "loading" ? (
        <Skeleton className="h-28 rounded-xl" />
      ) : billing?.configured ? (
        <Card>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                <Wallet className="size-4" /> Balance
              </span>
              {summary?.manageUrl && (
                <a
                  className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                  href={summary.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage plan <ExternalLink className="size-3" />
                </a>
              )}
            </div>

            {billing.unavailable ? (
              // Deliberately not rendered as an empty wallet. "We could not ask"
              // and "there is nothing left" look the same on a card and call for
              // opposite actions.
              <p className="text-sm text-muted-foreground">
                The balance could not be read just now — {billing.unavailable}. The key is
                still set; this is what the hub said when asked.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    className={`text-2xl font-medium tabular-nums ${
                      lowOnFunds ? "text-status-blocked-text" : ""
                    }`}
                    data-testid="billing-balance"
                  >
                    {money === null ? "—" : `$${money.toFixed(2)}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    on the {summary?.plan ?? "free"} plan
                    {summary?.activeSubscription ? " (subscription active)" : ""}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground">
                  {lowOnFunds
                    ? "Agents stop thinking at zero. Top up to keep the company running."
                    : "Every teammate's turns and every connected app spend from this."}
                </p>
              </>
            )}

            {summary?.topUpUrl && (
              <a
                className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                href={summary.topUpUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="billing-top-up"
              >
                <CreditCard className="size-3" /> Top up balance{" "}
                <ExternalLink className="size-3" />
              </a>
            )}
          </CardContent>
        </Card>
      ) : load === "error" ? (
        <Card>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Couldn&apos;t read this company&apos;s key status. That is not the same as
              having none set — the host could not answer.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* The full credential control — paste, rotate, clear — under the pitch
          rather than instead of it. The card is the same one Apps renders, so
          the two pages cannot drift into different vocabularies for one key. */}
      <CompanyCredentialCard
        client={client}
        company={company}
        canManage={canManage}
        onChanged={() => setGeneration((n) => n + 1)}
        showConnect={false}
      />

      {load === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </section>
  );
}
