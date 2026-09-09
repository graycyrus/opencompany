//! The company's own TinyHumans credential, over HTTP (issue #586): read whether
//! one is set and which identity brokered calls currently present, and set /
//! rotate / clear it.
//!
//! The credential itself is [`company_key`](crate::company::company_key); this
//! is its console plane. **Write-only**: the key goes in through the `key`
//! field, lands in the secret store, and is never echoed — the read shape
//! carries only a `configured` boolean plus the non-secret tier name.
//!
//! **Admin-only** on the write, for the same reason
//! [`ops::composio`](super::composio)'s token write is: this key is the identity
//! every one of the company's agents presents to every surface the platform
//! brokers, and it is the company's wallet — whoever sets it decides which
//! account those agents act through and which account pays. That is a decision
//! made *for* the company, not a member's own, and [`AdminScopedCompany`] is
//! what says so in the signature.
//!
//! A set / rotate / clear takes effect on the agents' **next cycle** with no
//! restart: every surface **wired to this credential** re-resolves through
//! [`company_key::resolve`](crate::company::company_key::resolve) and the roster
//! fingerprint moves with the key's value. That is Composio today; inference and
//! embeddings still resolve from the environment (#585), so "wired to it" is a
//! smaller set than "brokered" until that lands.

use axum::Json;
use axum::Router;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use axum::extract::State;

use crate::AppState;
use crate::company::company_key::{key_configured, resolve, store_key};
use crate::company::credentials::CredentialSource;
use crate::company::runtime::CompanyRuntime;
use crate::ports::types::CompanyEvent;
use crate::server::error::ApiError;
use crate::error::OpenCompanyError;
use crate::server::ops::{AdminScopedCompany, ScopedCompany, scoped};
use crate::server::users::token::OsTokens;

/// The reminder attached to every mutating response.
///
/// Names Composio rather than claiming "every brokered surface". The seam is
/// built so that any surface wired to it moves together, but Composio is the
/// only one wired **today** — inference and embeddings still resolve from the
/// environment (#585). Promising breadth the build does not have would be the
/// same overclaim this PR removed from the status route.
const SWITCH_NOTE: &str = "Agents present the new credential on their next cycle — no restart \
     needed. Composio picks it up at once, and any other surface wired to this credential moves \
     with it.";

/// What an admin most needs to understand before pasting: this key is the
/// company's wallet, and membership in the company is what grants access to it.
///
/// The last sentence is load-bearing. The Connections screen renders this card
/// next to the Inference one, both read "configured / not configured", and the
/// two keys are different in kind — pasting one into the other's field is the
/// exact mistake the `tinyhumans/key`-vs-`inference/key` split exists to
/// prevent. An admin will not have read that reasoning in the module docs, so
/// the card has to carry it. See [`company_key`](crate::company::company_key).
const CONSEQUENCE: &str = "This is the company's TinyHumans account key — the identity the platform presents when it \
     connects providers like Gmail or Slack on your behalf. Every member's agents act and spend \
     through it, and a provider connected with it belongs to the company rather than to the \
     person who connected it. Spend arrives as one account, so it cannot be attributed per \
     member. It is not the model-provider key on the Inference card: that one is whatever your \
     chosen provider issues (an OpenRouter key, or your own endpoint's), and the two are stored \
     separately on purpose.";

/// Said instead when nothing is configured and the instance carries no identity
/// either — the honest degraded state, rather than a picker that will fail.
const DEGRADED: &str = "No credential is set for this company and this instance carries no \
     platform identity, so providers cannot be connected or used. Set the company's TinyHumans \
     account key to enable them — not the model-provider key from the Inference card, which is a \
     different credential.";

/// Builds the company-credential route fragment.
pub fn router() -> Router<AppState> {
    scoped("/credential", get(get_status).put(set_key))
        .merge(scoped("/credential/link/start", post(start_link)))
        .merge(scoped("/credential/link/finish", post(finish_link)))
}

/// The company's credential status as the console renders it. **Never** carries
/// the key — only whether one is stored and which tier a brokered call presents.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatusDto {
    /// Whether this company has its **own** TinyHumans key stored. False does
    /// not mean no credential — see `source`.
    configured: bool,
    /// Which identity a brokered call presents right now: `company` (this
    /// company's own key), `attested` / `static` (this instance's platform
    /// identity), or `none`.
    source: CredentialSource,
    /// The consequence of setting this key, stated plainly, or the degraded
    /// state when nothing can be presented at all.
    notice: String,
    /// Whether this host can complete a one-click key grant against the hub.
    ///
    /// Reported alongside the status so the console can decide whether to offer
    /// the button without a second request. `false` on every host with no hub
    /// wired, which is where the paste field remains the only way in — so the
    /// console renders exactly what it renders today rather than a button that
    /// would 404.
    hub_link: bool,
}

/// A mutating response: the resulting status plus the switch reminder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationResponse {
    status: CredentialStatusDto,
    note: String,
}

/// Set-key body. `key` is write-only intake (never returned): a non-empty value
/// sets or rotates it, an explicit empty string clears it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetKey {
    key: String,
}

/// Resolves the credential status DTO for a company.
///
/// `source` is the company's **TinyHumans identity**, straight from
/// [`company_key::resolve`](crate::company::company_key::resolve): its own key,
/// else this instance's platform identity, else nothing.
///
/// That is deliberately **not** the same answer `GET …/composio` gives. The
/// Composio route prepends its BYO `composio/token` tier, so a company holding
/// both reads `company` here and `static` there — and both are correct, because
/// they answer different questions: this route reports whose identity the
/// company *has*, the Composio one reports what a Composio call *presents*.
/// Claiming parity between them would be wrong in exactly the case where the
/// distinction matters.
async fn effective_status(
    state: &AppState,
    runtime: &CompanyRuntime,
) -> Result<CredentialStatusDto, ApiError> {
    let secrets = runtime.secrets();
    let configured = key_configured(runtime.id(), secrets.as_ref())
        .await
        .map_err(ApiError)?;
    let env = crate::app::config::ProcessEnv;
    let source = resolve(
        runtime.id(),
        secrets.as_ref(),
        crate::company::TinyhumansTokenSource::from_env(&env).map(std::sync::Arc::new),
    )
    .await
    .map_err(ApiError)?
    .source();
    Ok(CredentialStatusDto {
        configured,
        source,
        notice: if source == CredentialSource::None {
            DEGRADED.to_string()
        } else {
            CONSEQUENCE.to_string()
        },
        hub_link: state.hub_identity().is_some(),
    })
}

/// `GET …/credential` — whether this company has its own key, and which identity
/// its brokered calls present.
async fn get_status(
    State(state): State<AppState>,
    company: ScopedCompany,
) -> Result<Json<CredentialStatusDto>, ApiError> {
    Ok(Json(
        effective_status(&state, company.runtime.as_ref()).await?,
    ))
}

/// `PUT …/credential` — set / rotate / clear the company's write-only TinyHumans
/// credential. **Admin-only** — see the module docs.
async fn set_key(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Json(body): Json<SetKey>,
) -> Result<Json<MutationResponse>, ApiError> {
    let runtime = company.runtime.as_ref();
    store_key(runtime.id(), runtime.secrets().as_ref(), &body.key)
        .await
        .map_err(ApiError)?;
    // The credential decides which account the backend resolves, so a change can
    // change which Composio catalog this company gets. Drop the cached one
    // rather than serving the previous account's answer for up to `CATALOG_TTL`.
    super::composio::evict_catalog_cache(runtime);
    // After the store, so the journal records a completed change. An empty value
    // is a clear, not a set — worth telling apart in an audit trail, since one
    // grants access and the other withdraws it.
    //
    // Namespaced `company_key_*` rather than reusing `ops::composio`'s
    // `credential_set` / `credential_cleared`. Both routes append
    // `ToolAccessChanged` to the same log, and with one shared vocabulary a
    // reader could not tell "the admin rotated the company's identity" from
    // "the admin swapped the Composio token" — two changes with different blast
    // radii. An audit line that cannot name what changed is most of the way to
    // not having one.
    let change = if body.key.trim().is_empty() {
        "company_key_cleared"
    } else {
        "company_key_set"
    };
    journal(&company, change).await?;
    Ok(Json(MutationResponse {
        status: effective_status(&state, runtime).await?,
        note: SWITCH_NOTE.to_string(),
    }))
}

/// The name the minted key carries in the person's TinyHumans account.
///
/// Names the company, so someone looking at a list of keys can tell which
/// instance each belongs to and revoke one without guessing.
fn key_name(company: &CompanyRuntime) -> String {
    format!("OpenCompany — {}", company.id())
}

/// What the console navigates to, and nothing else.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartLinkResponse {
    /// The hub URL to send the browser to, challenge already attached.
    authorize_url: String,
}

/// Finish body: the handle we minted, and the code the hub sent back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishLink {
    state: String,
    code: String,
}

/// `POST …/credential/link/start` — begin a one-click key grant.
///
/// **Admin-only**, the same authority [`set_key`] needs and for the same reason:
/// what comes back is the company's identity and its wallet. That the key is
/// minted rather than pasted changes who types it, not what it does.
async fn start_link(
    State(state): State<AppState>,
    company: AdminScopedCompany,
) -> Result<Json<StartLinkResponse>, ApiError> {
    let runtime = company.runtime.as_ref();
    // No exchange means nothing could redeem the code that came back, so the
    // flow cannot complete. Refusing here rather than at `finish` is the
    // difference between a console that never offers the button and one that
    // sends an admin through Google to fail on return.
    if state.hub_identity().is_none() {
        return Err(ApiError(OpenCompanyError::NotFound(
            "this host is not part of a TinyHumans ecosystem".to_string(),
        )));
    }

    let started = state
        .hub_links()
        .start(&OsTokens, &runtime.id().to_string());

    // Where the hub returns to. `key=link` is this console's own marker, kept
    // distinct from the `key=auth` the hub appends on a sign-in so the two
    // return legs can never be mistaken for each other in `App.tsx`.
    let origin = state.config().host_base_url();
    let callback_url = format!(
        "{}/?company={}&key=link&state={}",
        origin.trim_end_matches('/'),
        runtime.id(),
        started.state,
    );

    Ok(Json(StartLinkResponse {
        authorize_url: crate::server::hub_identity::key_grant_url(
            &state.config().api_url,
            &callback_url,
            &started.challenge,
            &key_name(runtime),
        ),
    }))
}

/// `POST …/credential/link/finish` — redeem the code and store what comes back.
///
/// One key lands in **two** places: `tinyhumans/key`, the company's identity for
/// everything the platform brokers, and `inference/key` on the `managed`
/// provider, so the same grant that connects the company also gives its agents
/// something to think with. That is the whole point of the flow — an admin who
/// had to run it twice, once per page, would be back to two errands.
async fn finish_link(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Json(body): Json<FinishLink>,
) -> Result<Json<MutationResponse>, ApiError> {
    let runtime = company.runtime.as_ref();

    let Some(exchange) = state.hub_identity().cloned() else {
        return Err(ApiError(OpenCompanyError::NotFound(
            "this host is not part of a TinyHumans ecosystem".to_string(),
        )));
    };

    // Single-use, and bound to the company it was started for. An expired or
    // replayed handle is indistinguishable from one that never existed, which
    // is the right amount to say: the remedy is the same either way.
    let Some(link) = state
        .hub_links()
        .take(&body.state, &runtime.id().to_string())
    else {
        return Err(ApiError(OpenCompanyError::InvalidRequest(
            "that connection attempt has expired — start it again".to_string(),
        )));
    };

    let key = exchange
        .redeem_key_grant(&body.code, &link.verifier)
        .await
        .map_err(ApiError)?;

    // Stored before anything else can fail. The hub emits the plaintext exactly
    // once and cannot reissue it, so a key dropped here is a key nobody can
    // recover — the person would have to run the whole flow again, and the one
    // they just minted would linger in their account doing nothing.
    store_key(runtime.id(), runtime.secrets().as_ref(), &key)
        .await
        .map_err(ApiError)?;
    crate::company::inference::store_key(runtime.id(), runtime.secrets().as_ref(), &key)
        .await
        .map_err(ApiError)?;
    // The key alone does not arm inference: with no runtime declaration the
    // status route reports the platform default and `keyConfigured: false`, so
    // an operator would see a company that is connected but still cannot think.
    // Declaring `managed` is what makes the stored key the one its turns are
    // billed to — the same provider the Inference page's TinyHumans option sets.
    crate::company::inference::save_runtime_config(
        runtime.id(),
        runtime.secrets().as_ref(),
        &crate::company::inference::RuntimeInference {
            provider: "managed".to_string(),
            base_url: None,
            models: Default::default(),
        },
    )
    .await
    .map_err(ApiError)?;

    super::composio::evict_catalog_cache(runtime);
    journal(&company, "company_key_set").await?;

    Ok(Json(MutationResponse {
        status: effective_status(&state, runtime).await?,
        note: SWITCH_NOTE.to_string(),
    }))
}

/// Records who changed the company's credential (issue #403's discipline).
///
/// Propagates a journal failure rather than swallowing it, mirroring
/// [`ops::composio`](super::composio): the point of this record is that a change
/// to what the company's agents act through is never invisible, and an audit
/// line that quietly fails to be written is the one failure mode that would
/// defeat it.
async fn journal(company: &AdminScopedCompany, change: &str) -> Result<(), ApiError> {
    company
        .runtime
        .events()
        .append(
            company.id(),
            CompanyEvent::ToolAccessChanged {
                change: change.to_string(),
                toolkit: None,
                by: Some(company.actor()),
            },
        )
        .await
        .map_err(ApiError)?;
    Ok(())
}

#[cfg(test)]
mod test;
