// Surfaces hidden while the product is scoped to one company per install.
//
// Every flag here hides a control; none of them changes a stored value or a
// server path. `ComposioMode::Managed`, the inference `managed` legacy alias
// and the hosts registry all still exist and still resolve exactly as before,
// so a company already on a hidden setting keeps working and re-enabling a
// surface is a single edit in this file.

/**
 * Hides the host roster, "Add a host" and "Manage hosts" in the switcher.
 *
 * Off. One console holding several hosts is the arrangement the connections
 * layer was built for, and it is not the same claim as "one company per
 * install": a host is *where* a company runs, so being able to point at
 * another one is how somebody moves off a laptop and onto a gateway at all.
 * Hiding it left the title row's company name as a plain `<div>` — the
 * nameplate branch — which is a control that looks like a control and opens
 * nothing.
 *
 * The browser keeps the half it can honour and loses the half it cannot: a
 * page can hold connections to any number of hosts, and cannot *start* one,
 * so `availableConnectors` still offers `local` and `ssh` only on the desktop
 * (`connections/types.ts`). Nothing here changes that split.
 */
export const HOSTS_HIDDEN = false;

/** Hides company switching, "All companies…" and "New company". */
export const COMPANY_SWITCHING_HIDDEN = true;

/** Hides the wizard's Advanced → Host group (bind address, workspace quotas). */
export const HOST_SETTINGS_HIDDEN = true;

/**
 * Hides the OpenHuman-managed Composio route, leaving BYOK the only choice.
 *
 * Still on. It used to gate the company-credential card as well, which made it
 * one flag doing two jobs: hiding a *Composio route* and hiding the *TinyHumans
 * key* surface. Those came apart when the key grant landed — the credential
 * card is now worth showing (one click, no paste) while the managed Composio
 * route is hidden for its own reasons, which this flag still names. The card
 * decides its own visibility from the host's answer instead; see
 * `CompanyCredentialCard`.
 */
export const COMPOSIO_MANAGED_HIDDEN = true;

/**
 * Hides the managed inference provider, leaving the operator to name one.
 *
 * Off for the same reason as {@link COMPOSIO_MANAGED_HIDDEN}: "Managed
 * (TinyHumans)" was hidden while choosing it meant going and minting a key by
 * hand, which made OpenRouter the honestly easier option. With the grant it is
 * one click, and it is the only option that also arms the company's connections
 * in the same step.
 */
export const INFERENCE_MANAGED_HIDDEN = false;
