// Surfaces hidden while the product is scoped to one company per install.
//
// Every flag here hides a control; none of them changes a stored value or a
// server path. `ComposioMode::Managed`, the inference `managed` legacy alias
// and the hosts registry all still exist and still resolve exactly as before,
// so a company already on a hidden setting keeps working and re-enabling a
// surface is a single edit in this file.

/** Hides the host roster, "Add a host" and "Manage hosts" in the switcher. */
export const HOSTS_HIDDEN = true;

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
