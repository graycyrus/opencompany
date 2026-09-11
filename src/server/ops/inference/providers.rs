//! Writing the provider list: add, edit, delete, enable/disable, the draft
//! probe, and the routing table.
//!
//! Handlers only. Every branch worth a test is in a pure module beside this one
//! — [`catalogue`] decides what a kind's endpoint and auth style are,
//! [`store`](crate::company::inference::store) decides where a record and its
//! credential live, [`probe`] classifies a failure and answers where a probe may
//! point, and [`resolve`] answers what a removal orphans. What is left here is
//! extraction, ordering and DTO mapping.
//!
//! ## Authority
//!
//! **`AdminScopedCompany` on every route here except one.** The axis is "does
//! this decide something for the company", not read-versus-write: adding a
//! provider decides where the company's turns go and whose account pays for
//! them. The draft probe is on the same footing for a different reason —
//! generalising "send a request to this URL with this key" to company scope
//! creates an authenticated outbound-request primitive, and an SSRF guard is the
//! second line of defence behind an authority check, not a substitute for one.
//!
//! The exception is [`test_provider`], which re-asks a question the company has
//! already answered: it names no destination and no credential of its own, so it
//! is `ScopedCompany`, exactly like the `POST …/inference/test` it mirrors.
//!
//! ## The add flow's ordering, which is not arbitrary
//!
//! ```text
//!   validate ──▶ slug ──▶ write key ──▶ flush record ──▶ PROBE ──┬─▶ ok
//!                                                                 │
//!                                                     auth ◀──────┴──▶ anything else
//!                                                       │                  │
//!                                        roll back record AND key    KEEP both,
//!                                        reject                      amber advisory
//! ```
//!
//! 1. **Validate locally what can be validated locally.** A typed endpoint's
//!    scheme and shape are knowable without a network, so they are rejected
//!    before anything is written.
//! 2. **Derive and check the slug before any write.** A collision found after
//!    the credential has landed means a credential sitting in a slot nothing
//!    owns.
//! 3. **Credential first, then the record.** The probe reads the key by slug, so
//!    it has to be there before the record it belongs to is flushed.
//! 4. **Probe**, and classify rather than reduce to a boolean.
//! 5. **Roll back both stores only on the destructive class**, and log a
//!    rollback failure loudly rather than swallowing it. A silently failed
//!    key-clear orphans a secret, which is an incident shape rather than
//!    untidiness.

use std::collections::BTreeMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::company::inference::{catalogue, probe, resolve, store};
use crate::company::runtime::CompanyRuntime;
use crate::error::OpenCompanyError;
use crate::server::error::ApiError;
use crate::server::ops::{AdminScopedCompany, scoped};

use super::{InferenceStatusDto, effective_status};

/// The provider write plane.
pub(super) fn router() -> Router<AppState> {
    scoped("/inference/providers", post(add_provider))
        .merge(scoped(
            "/inference/providers/{slug}",
            put(edit_provider).delete(delete_provider),
        ))
        .merge(scoped(
            "/inference/providers/{slug}/enabled",
            post(set_enabled),
        ))
        // Deliberately **not** under `/inference/providers/…`: a draft has no
        // slug yet, and a literal segment sharing a prefix with a `{slug}`
        // capture is a routing ambiguity waiting to be resolved the wrong way by
        // whichever router version is in play.
        .merge(scoped("/inference/probe", post(probe_draft)))
        // `ScopedCompany`, not admin — the only route here that is. It probes a
        // provider **as already stored**, naming no destination and no
        // credential of its own, which is the same footing as the existing
        // `POST …/inference/test`. The axis is "does this decide something for
        // the company", and re-asking a question the company already answered
        // decides nothing.
        .merge(scoped(
            "/inference/providers/{slug}/test",
            post(test_provider),
        ))
        .merge(scoped("/inference/routes", get(get_routes).put(put_routes)))
}

// ---- wire shapes ------------------------------------------------------------

/// What the add dialog sends.
///
/// **No `Serialize`.** This carries a credential, so it travels one way only.
/// The type system is the mechanism: a shape that cannot be serialized cannot
/// be put in a response body by a later edit that reaches for a convenience
/// derive.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddProvider {
    /// The catalogue slug chosen, the CLI option slug, or `custom`.
    kind: String,
    /// The operator's name for a custom provider. Ignored for a catalogue
    /// entry, whose label is the catalogue's.
    #[serde(default)]
    label: Option<String>,
    /// The endpoint, for a local runtime or a custom provider. A cloud
    /// provider's comes from the preset and anything sent here is ignored —
    /// the paths in that table are too varied to be derived or overridden by
    /// accident.
    #[serde(default)]
    base_url: Option<String>,
    /// The outbound credential. Write-only intake: no route returns it.
    #[serde(default)]
    key: Option<String>,
    /// Add despite a probe failure that would otherwise be destructive.
    ///
    /// The "add anyway" escape hatch, and it exists because a provider that does
    /// not serve an OpenAI-shaped `{base}/models` listing is still perfectly
    /// usable for inference — blocking creation on the probe would leave those
    /// operators unable to reach the model field at all.
    ///
    /// The console only offers it after a **typed probe failure**, never after a
    /// slug collision or a failed key write, and clears it on every retry.
    #[serde(default)]
    add_anyway: bool,
}

/// What the edit dialog sends. Same credential rule as [`AddProvider`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditProvider {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    /// Abstract tier → concrete model id. Omit to leave unchanged.
    #[serde(default)]
    models: Option<BTreeMap<String, String>>,
    /// Omit to leave the credential unchanged; send `""` to clear it.
    #[serde(default)]
    key: Option<String>,
}

/// The enable/disable body.
#[derive(Debug, Deserialize)]
struct SetEnabled {
    enabled: bool,
}

/// A draft probe: an endpoint and a key that are **not stored**.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDraft {
    base_url: String,
    #[serde(default)]
    key: Option<String>,
    /// The kind, so the credential is presented the way that kind expects.
    #[serde(default)]
    kind: Option<String>,
}

/// The routing table on the way in.
#[derive(Debug, Deserialize)]
struct PutRoutes {
    /// Tier → route string. A tier mapped to `""` is unset.
    routes: BTreeMap<String, String>,
}

/// What a probe produced, for the console to render.
///
/// **Never carries the raw upstream string.** That text can echo request
/// material — headers, fragments of a key — and it lands in a banner someone
/// screenshots into a ticket. It goes to this host's log instead.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResultDto {
    ok: bool,
    /// The failure class, absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    class: Option<String>,
    /// One sentence, chosen by [`probe::describe`].
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// How many models the endpoint published. Zero is not a failure: plenty of
    /// endpoints serve inference and publish no catalog.
    model_count: usize,
}

/// Every provider write answers with the whole status, so the console never has
/// to reconcile a partial update against what it already had.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMutation {
    status: InferenceStatusDto,
    note: String,
    /// The probe's verdict, when one was run.
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<ProbeResultDto>,
    /// Tiers whose route this change moved or parked, so the console can say
    /// which rows changed rather than leaving the operator to notice.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    affected_tiers: Vec<String>,
}

// ---- add --------------------------------------------------------------------

/// `POST …/inference/providers` — connect a provider.
async fn add_provider(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Json(body): Json<AddProvider>,
) -> Result<Json<ProviderMutation>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let kind = body.kind.trim().to_string();

    // Step 1 and 2: everything knowable without a network, before any write.
    let plan = plan_add(&kind, body.label.as_deref(), body.base_url.as_deref())?;
    let existing = store::list_providers(runtime.id(), secrets)
        .await
        .map_err(ApiError)?;
    // The catalogue check applies to a *typed* name only. Adding the catalogue's
    // own `groq` entry should take the slug `groq` — that is the same provider,
    // not a collision.
    if plan.custom {
        store::check_slug(&existing, &plan.slug)
            .map_err(|e| ApiError(OpenCompanyError::InvalidRequest(e.to_string())))?;
    } else if existing.iter().any(|p| p.slug == plan.slug) {
        return Err(ApiError(OpenCompanyError::InvalidRequest(format!(
            "{} is already connected. Edit the existing row rather than adding a second one.",
            plan.label
        ))));
    }

    // Step 3: the credential first. The probe resolves the key by slug, so it
    // has to land before the record does.
    let key = body.key.map(|k| k.trim().to_string()).unwrap_or_default();
    if !key.is_empty() {
        secrets
            .set(
                runtime.id(),
                &store::provider_key_key(&plan.slug),
                crate::ports::types::SecretValue(key.clone()),
            )
            .await
            .map_err(ApiError)?;
    }

    // Step 4: flush the record.
    let provider = store::put_provider(
        runtime.id(),
        secrets,
        store::ProviderDraft {
            slug: plan.slug.clone(),
            label: plan.label.clone(),
            kind: plan.kind.clone(),
            base_url: plan.base_url.clone(),
            models: BTreeMap::new(),
            // New providers arrive on. Adding something and then having to
            // switch it on is a second step for a decision already made.
            enabled: true,
        },
    )
    .await
    .map_err(ApiError)?;
    // The credential just changed for this company, and the catalog cache key is
    // made of non-secret ids on purpose — so a rotation would otherwise keep
    // answering from the previous credential's read for the rest of its TTL.
    crate::server::inference_models::evict_company_catalogs(runtime.id().as_ref());

    // Step 5: probe — but only when there is something for the probe to learn.
    //
    // A kind that expects a credential and was given none has nothing to verify:
    // the endpoint can only answer 401, which classifies as `auth`, which is the
    // one destructive class — so a keyless add would reject itself over a key the
    // operator has not typed yet. "Not checked" is the honest state for that row
    // and is exactly what the health column already renders.
    let auth = catalogue::auth_style_for(&plan.kind);
    let credential = (!key.is_empty()).then_some(key.as_str());
    let worth_probing = plan.probes && (auth == catalogue::AuthStyle::None || credential.is_some());
    let outcome = if worth_probing {
        Some(
            probe::probe_models(
                &provider.base_url,
                credential,
                auth,
                probe::default_policy(),
            )
            .await,
        )
    } else {
        None
    };

    let (probe_dto, note) = match outcome {
        None => (None, format!("{} is connected.", provider.label)),
        Some(Ok(models)) => {
            record_health(runtime, &provider.slug, "ok").await;
            (
                Some(ProbeResultDto {
                    ok: true,
                    class: None,
                    message: None,
                    model_count: models.len(),
                }),
                format!("{} is connected and answering.", provider.label),
            )
        }
        Some(Err(failure)) => {
            // The raw text goes here and nowhere else.
            tracing::info!(
                company = %runtime.id(),
                provider = %provider.slug,
                class = failure.class.as_str(),
                detail = %failure.raw,
                "inference provider probe failed",
            );
            if failure.class.destroys_credential() && !body.add_anyway {
                roll_back_add(runtime, &provider).await;
                return Err(ApiError(OpenCompanyError::InvalidRequest(probe::describe(
                    failure.class,
                    &provider.label,
                ))));
            }
            record_health(runtime, &provider.slug, failure.class.as_str()).await;
            let message = probe::describe(failure.class, &advisory_subject(&provider));
            (
                Some(ProbeResultDto {
                    ok: false,
                    class: Some(failure.class.as_str().to_string()),
                    message: Some(message.clone()),
                    model_count: 0,
                }),
                message,
            )
        }
    };

    Ok(Json(ProviderMutation {
        status: effective_status(&state, runtime).await?,
        note,
        probe: probe_dto,
        affected_tiers: Vec::new(),
    }))
}

/// What a kind implies, decided before anything is written.
struct AddPlan {
    slug: String,
    label: String,
    kind: String,
    base_url: String,
    /// Whether this kind is a typed name that may shadow a built-in.
    custom: bool,
    /// Whether connecting it runs the probe.
    probes: bool,
}

/// Resolves a kind, a typed label and a typed endpoint into a plan.
///
/// The three categories ask three different questions, and this is where that
/// shows: a cloud provider's endpoint comes from the preset and its label from
/// the catalogue; a local runtime's endpoint is the thing being chosen and is
/// normalised and scheme-checked here; a CLI login supplies neither and skips
/// the probe because there is nothing to present.
fn plan_add(kind: &str, label: Option<&str>, base_url: Option<&str>) -> Result<AddPlan, ApiError> {
    let invalid = |msg: String| ApiError(OpenCompanyError::InvalidRequest(msg));

    if let Some(cloud) = catalogue::cloud_provider(kind) {
        return Ok(AddPlan {
            slug: cloud.slug.to_string(),
            label: cloud.label.to_string(),
            kind: cloud.slug.to_string(),
            base_url: cloud.endpoint.to_string(),
            custom: false,
            probes: true,
        });
    }
    if let Some(local) = catalogue::local_runtime(kind) {
        let typed = base_url
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .or_else(|| local.default_endpoint.map(str::to_string))
            .ok_or_else(|| {
                invalid(format!(
                    "{} needs the endpoint it is listening on.",
                    local.label
                ))
            })?;
        let base_url = catalogue::normalize_local_endpoint(&typed).ok_or_else(|| {
            invalid("A local runtime endpoint must be an http or https address.".to_string())
        })?;
        return Ok(AddPlan {
            slug: local.slug.to_string(),
            label: local.label.to_string(),
            kind: local.slug.to_string(),
            base_url,
            custom: false,
            probes: true,
        });
    }
    if let Some(cli) = catalogue::cli_login(kind) {
        // Reachable only if a delegated credential ever becomes available here.
        // On a server-side host the category is empty and the console says so,
        // but refusing in the handler is the honest answer rather than storing a
        // row for a login nothing holds.
        return Err(invalid(format!(
            "{} is a credential held by a command-line tool on someone's own machine. \
             This host cannot reach one.",
            cli.label
        )));
    }
    if kind != "custom" {
        return Err(invalid(format!(
            "`{kind}` is not a provider this host knows."
        )));
    }

    // Custom: three fields, and the slug is derived from the name rather than
    // typed. An operator names the thing; the address falls out. Asking for both
    // invites them to disagree, and the one that appears in a routing entry
    // would then be the one they never chose.
    let label = label.map(str::trim).unwrap_or("").to_string();
    let slug = store::slugify(&label);
    if slug.is_empty() {
        return Err(invalid(store::SlugError::Empty.to_string()));
    }
    let typed = base_url
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| invalid("A custom provider needs an OpenAI-compatible URL.".to_string()))?;
    let base_url = catalogue::normalize_local_endpoint(typed)
        .ok_or_else(|| invalid("That endpoint must be an http or https address.".to_string()))?;
    Ok(AddPlan {
        slug,
        label,
        kind: "custom".to_string(),
        base_url,
        custom: true,
        probes: true,
    })
}

/// What an advisory names when it names something.
///
/// The endpoint's host for the classes that are about reachability, because
/// "nothing answered at api.acme.dev" is actionable in a way that "nothing
/// answered at Acme gateway" is not.
fn advisory_subject(provider: &store::Provider) -> String {
    catalogue::endpoint_host(&provider.base_url).unwrap_or_else(|| provider.label.clone())
}

/// Undoes an add whose probe rejected the credential.
///
/// Both stores, and a failure in either is **logged loudly** rather than
/// swallowed: a record left behind is visible and the operator can remove it,
/// but an orphaned credential is invisible, and re-adding that slug would
/// silently reuse it.
async fn roll_back_add(runtime: &CompanyRuntime, provider: &store::Provider) {
    let secrets = runtime.secrets().as_ref();
    // `delete_provider` clears the credential itself, and clears it *first*, so
    // a failure leaves the row visible with its key rather than the reverse.
    if let Err(err) = store::delete_provider(runtime.id(), secrets, &provider.slug).await {
        tracing::error!(
            company = %runtime.id(),
            provider = %provider.slug,
            error = %err,
            "could not roll back a rejected provider; a credential may be orphaned at \
             provider/<slug>/key and re-adding this slug would reuse it",
        );
    }
}

/// Records health, never failing the request over it.
///
/// A health record is a decoration on a row. Failing an otherwise successful add
/// because a decoration could not be written would be the tail wagging the dog.
async fn record_health(runtime: &CompanyRuntime, slug: &str, state: &str) {
    // Dependency-free: the same formatter the GraphQL layer already carries.
    let at = crate::server::graphql::iso8601(crate::ports::now_millis());
    match store::record_health(runtime.id(), runtime.secrets().as_ref(), slug, state, &at).await {
        Ok(true) => tracing::info!(
            company = %runtime.id(),
            provider = %slug,
            state = %state,
            "inference provider health changed",
        ),
        // Unchanged: the latch held, which is the point of it. Silent on
        // purpose — logging every repetition is the ~9k-events failure.
        Ok(false) => {}
        Err(err) => tracing::warn!(
            company = %runtime.id(),
            provider = %slug,
            error = %err,
            "could not record inference provider health",
        ),
    }
}

// ---- edit -------------------------------------------------------------------

/// `PUT …/inference/providers/{slug}` — change a connected provider.
///
/// Not an add with a different verb: the slug is fixed, so nothing here can
/// collide, and the kind cannot change — a provider that changed kind would be a
/// different provider wearing an existing row's routes.
async fn edit_provider(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Path(params): Path<ProviderPath>,
    Json(body): Json<EditProvider>,
) -> Result<Json<ProviderMutation>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let existing = require_provider(runtime, &params.slug).await?;

    if existing.origin == store::ProviderOrigin::EntryZero {
        return Err(ApiError(OpenCompanyError::InvalidRequest(
            "This company's original provider is changed through the inference config, \
             not as a list entry."
                .to_string(),
        )));
    }

    let base_url = match body.base_url.as_deref().map(str::trim) {
        None | Some("") => existing.base_url.clone(),
        Some(typed) => {
            // A cloud preset's endpoint is not the operator's to retype: the
            // paths in that table are too varied for a typo to be recoverable,
            // and the row would then point somewhere the catalogue says it does
            // not.
            if catalogue::cloud_provider(&existing.kind).is_some() {
                existing.base_url.clone()
            } else {
                catalogue::normalize_local_endpoint(typed).ok_or_else(|| {
                    ApiError(OpenCompanyError::InvalidRequest(
                        "That endpoint must be an http or https address.".to_string(),
                    ))
                })?
            }
        }
    };

    let provider = store::put_provider(
        runtime.id(),
        secrets,
        store::ProviderDraft {
            slug: existing.slug.clone(),
            label: body
                .label
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .unwrap_or(existing.label.clone()),
            kind: existing.kind.clone(),
            base_url,
            models: body.models.unwrap_or(existing.models.clone()),
            enabled: existing.enabled,
        },
    )
    .await
    .map_err(ApiError)?;

    if let Some(key) = body.key {
        store::store_provider_key(runtime.id(), secrets, &provider, key.trim())
            .await
            .map_err(ApiError)?;
        crate::server::inference_models::evict_company_catalogs(runtime.id().as_ref());
        // A rotation makes whatever was learnt about the old credential
        // meaningless — including a latched `auth` failure, which would
        // otherwise keep the row amber until something else happened to probe.
        if let Err(err) = store::forget_health(runtime.id(), secrets, &provider.slug).await {
            tracing::warn!(
                company = %runtime.id(),
                provider = %provider.slug,
                error = %err,
                "could not clear health after a credential rotation",
            );
        }
    }

    Ok(Json(ProviderMutation {
        status: effective_status(&state, runtime).await?,
        note: format!("{} updated.", provider.label),
        probe: None,
        affected_tiers: Vec::new(),
    }))
}

// ---- delete and disable -----------------------------------------------------

/// The `{slug}` capture.
#[derive(Debug, Deserialize)]
struct ProviderPath {
    slug: String,
}

/// `DELETE …/inference/providers/{slug}` — disconnect a provider.
///
/// Three things happen together and they are one operation, not a cleanup pass:
/// the credential is cleared, the record is removed, and every route pointing at
/// it is reset. Skipping any one of them leaves a state an operator cannot see:
/// an orphaned secret, a row that reappears, or a workload pinned to a provider
/// that no longer exists.
async fn delete_provider(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Path(params): Path<ProviderPath>,
) -> Result<Json<ProviderMutation>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let provider = require_provider(runtime, &params.slug).await?;

    if provider.origin == store::ProviderOrigin::EntryZero {
        return Err(ApiError(OpenCompanyError::InvalidRequest(
            "This company's original provider is cleared by resetting the inference \
             config, which also clears its key."
                .to_string(),
        )));
    }

    // Routes are scrubbed *before* the record goes, so the remaining-providers
    // list the three scrub rules need is the list as it will be afterwards.
    let mut routes = store::load_routes(runtime.id(), secrets)
        .await
        .map_err(ApiError)?;
    let remaining: Vec<store::Provider> = store::list_providers(runtime.id(), secrets)
        .await
        .map_err(ApiError)?
        .into_iter()
        .filter(|p| p.slug != provider.slug)
        .collect();
    let reset = resolve::scrub_removed(&mut routes, &provider, &remaining);
    if !reset.is_empty() {
        store::save_routes(runtime.id(), secrets, &routes)
            .await
            .map_err(ApiError)?;
    }

    // Clears the credential first and refuses the removal if that clear fails,
    // which is the half-state the operator can actually see and act on.
    store::delete_provider(runtime.id(), secrets, &provider.slug)
        .await
        .map_err(ApiError)?;
    if let Err(err) = store::forget_health(runtime.id(), secrets, &provider.slug).await {
        tracing::warn!(
            company = %runtime.id(),
            provider = %provider.slug,
            error = %err,
            "removed a provider but could not clear its health record",
        );
    }
    crate::server::inference_models::evict_company_catalogs(runtime.id().as_ref());

    let note = if reset.is_empty() {
        format!("{} is disconnected and its key is cleared.", provider.label)
    } else {
        format!(
            "{} is disconnected and its key is cleared. {} now resolve through the \
             primary provider.",
            provider.label,
            reset.join(", ")
        )
    };
    Ok(Json(ProviderMutation {
        status: effective_status(&state, runtime).await?,
        note,
        probe: None,
        affected_tiers: reset,
    }))
}

/// `POST …/inference/providers/{slug}/enabled` — switch a provider on or off.
///
/// **Disabling does not scrub routes, and that is deliberate** — it is the one
/// place this implementation departs from the plan it follows, for a reason the
/// rest of the design already settled. A disabled provider keeps its endpoint,
/// its label and its credential precisely so that "stop billing this account
/// this week" is expressible; scrubbing its routes would make re-enabling it a
/// re-configuration rather than a switch, and would lose the operator's choices
/// silently. The resolver already models this: a route naming a disabled
/// provider is [`resolve::Resolution::Disabled`] — *reported*, never demoted to
/// a sibling — and scrubbing here would make that variant unreachable.
///
/// What it does instead is **say which tiers are parked**, so the operator is
/// told rather than left to notice, which is the property the scrub was there
/// to provide.
async fn set_enabled(
    State(state): State<AppState>,
    company: AdminScopedCompany,
    Path(params): Path<ProviderPath>,
    Json(body): Json<SetEnabled>,
) -> Result<Json<ProviderMutation>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let provider = require_provider(runtime, &params.slug).await?;

    if !store::set_enabled(runtime.id(), secrets, &provider.slug, body.enabled)
        .await
        .map_err(ApiError)?
    {
        return Err(ApiError(OpenCompanyError::InvalidRequest(
            "This company's original provider cannot be switched off from the list; \
             reset the inference config instead."
                .to_string(),
        )));
    }

    let parked = if body.enabled {
        Vec::new()
    } else {
        parked_tiers(runtime, &provider).await?
    };
    let note = match (body.enabled, parked.is_empty()) {
        (true, _) => format!("{} is on.", provider.label),
        (false, true) => format!("{} is off. Nothing was routed through it.", provider.label),
        (false, false) => format!(
            "{} is off. {} are parked until it is switched back on.",
            provider.label,
            parked.join(", ")
        ),
    };
    Ok(Json(ProviderMutation {
        status: effective_status(&state, runtime).await?,
        note,
        probe: None,
        affected_tiers: parked,
    }))
}

/// The tiers whose route names `provider`, so switching it off can name them.
async fn parked_tiers(
    runtime: &CompanyRuntime,
    provider: &store::Provider,
) -> Result<Vec<String>, ApiError> {
    let routes = store::load_routes(runtime.id(), runtime.secrets().as_ref())
        .await
        .map_err(ApiError)?;
    Ok(routes
        .iter()
        .filter(|(_, route)| route.slug() == Some(provider.slug.as_str()))
        .map(|(tier, _)| tier.clone())
        .collect())
}

/// The provider, or a 404 naming the slug that resolved to nothing.
async fn require_provider(
    runtime: &CompanyRuntime,
    slug: &str,
) -> Result<store::Provider, ApiError> {
    store::get_provider(runtime.id(), runtime.secrets().as_ref(), slug)
        .await
        .map_err(ApiError)?
        .ok_or_else(|| {
            ApiError(OpenCompanyError::NotFound(format!(
                "this company has no provider `{slug}`"
            )))
        })
}

// ---- testing a stored provider ----------------------------------------------

/// `POST …/inference/providers/{slug}/test` — re-check a provider that is
/// already connected.
///
/// One of the three things that feed a row's health, and the only one an
/// operator can ask for: the other two are the add-time probe and the turn
/// path's own 401. **There is no poller.** One would cost a request per provider
/// per interval across every company this host serves, to learn something the
/// next real turn learns for free.
async fn test_provider(
    company: crate::server::ops::ScopedCompany,
    Path(params): Path<ProviderPath>,
) -> Result<Json<ProbeResultDto>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let provider = require_provider(runtime, &params.slug).await?;
    let key = store::load_provider_key(runtime.id(), secrets, &provider)
        .await
        .map_err(ApiError)?;

    match probe::probe_models(
        &provider.base_url,
        (!key.trim().is_empty()).then(|| key.trim()),
        catalogue::auth_style_for(&provider.kind),
        probe::default_policy(),
    )
    .await
    {
        Ok(models) => {
            record_health(runtime, &provider.slug, "ok").await;
            Ok(Json(ProbeResultDto {
                ok: true,
                class: None,
                message: None,
                model_count: models.len(),
            }))
        }
        Err(failure) => {
            tracing::info!(
                company = %runtime.id(),
                provider = %provider.slug,
                class = failure.class.as_str(),
                detail = %failure.raw,
                "inference provider test failed",
            );
            // **The test never deletes a credential**, whatever the class. An
            // add is a commitment being made and a rollback undoes it; a test is
            // a question being asked, and answering "your key is rejected" by
            // destroying it would make the button that reports a problem the
            // button that causes one.
            record_health(runtime, &provider.slug, failure.class.as_str()).await;
            Ok(Json(ProbeResultDto {
                ok: false,
                class: Some(failure.class.as_str().to_string()),
                message: Some(probe::describe(failure.class, &advisory_subject(&provider))),
                model_count: 0,
            }))
        }
    }
}

// ---- the draft probe --------------------------------------------------------

/// `POST …/inference/probe` — test an endpoint and a key that are not stored.
///
/// The list's add-then-test flow needs to probe a **draft**: the existing
/// `POST …/inference/test` probes the *saved* config, which by definition does
/// not exist yet at the moment the operator wants to know.
///
/// Generalising it creates an authenticated "send a request to an arbitrary URL
/// with an arbitrary key" primitive, which is SSRF-shaped. The answer is
/// explicit rather than inherited, and it is in two places on purpose:
/// `AdminScopedCompany` in this signature, and [`probe::check_endpoint`] applied
/// to the URL **and to every redirect target** inside the probe itself.
async fn probe_draft(company: AdminScopedCompany, Json(body): Json<ProbeDraft>) -> Response {
    let _ = &company;
    let kind = body.kind.as_deref().unwrap_or("custom");
    let auth = catalogue::auth_style_for(kind);
    let subject = catalogue::endpoint_host(&body.base_url).unwrap_or_else(|| "that host".into());
    match probe::probe_models(
        body.base_url.trim(),
        body.key.as_deref().filter(|k| !k.trim().is_empty()),
        auth,
        probe::default_policy(),
    )
    .await
    {
        Ok(models) => Json(ProbeResultDto {
            ok: true,
            class: None,
            message: None,
            model_count: models.len(),
        })
        .into_response(),
        Err(failure) => {
            tracing::info!(
                company = %company.runtime.id(),
                class = failure.class.as_str(),
                detail = %failure.raw,
                "draft inference probe failed",
            );
            // A 200 carrying `ok: false`, not a 5xx: the request succeeded and
            // the answer is "that endpoint did not work". A gateway status would
            // make the console's error handling treat a correct answer as a
            // broken host.
            Json(ProbeResultDto {
                ok: false,
                class: Some(failure.class.as_str().to_string()),
                message: Some(probe::describe(failure.class, &subject)),
                model_count: 0,
            })
            .into_response()
        }
    }
}

// ---- routes -----------------------------------------------------------------

/// What `GET …/inference/routes` answers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutesDto {
    /// Tier → route string.
    routes: BTreeMap<String, String>,
    /// The mode these routes describe. **Inferred, never stored** — a stored
    /// mode would be a fifth thing that can disagree with the four routes.
    mode: String,
    /// Routes naming a provider this company does not hold, as `[tier, slug]`.
    ///
    /// The second, independent mechanism behind the same invariant as the
    /// delete-time scrub, because the UI path can be bypassed by a config edit
    /// or an older build — and an unresolvable route has to be reported rather
    /// than discovered mid-turn.
    orphaned: Vec<(String, String)>,
}

/// `GET …/inference/routes` — the routing table, its inferred mode, and any
/// route naming a provider that is gone.
async fn get_routes(company: AdminScopedCompany) -> Result<Json<RoutesDto>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let routes = store::load_routes(runtime.id(), secrets)
        .await
        .map_err(ApiError)?;
    let providers = store::list_providers(runtime.id(), secrets)
        .await
        .map_err(ApiError)?;
    Ok(Json(RoutesDto {
        mode: mode_name(resolve::infer_routing_mode(&routes)),
        orphaned: resolve::orphaned_routes(&routes, &providers),
        routes: routes
            .into_iter()
            .map(|(tier, route)| (tier, route.to_route_string()))
            .collect(),
    }))
}

/// `PUT …/inference/routes` — replace the routing table.
///
/// A whole-table write rather than a per-row patch, because the modes are
/// whole-table statements: "route everything through one model" is not four
/// independent edits, and applying it as four would leave a visible intermediate
/// state where two rows have moved and two have not.
async fn put_routes(
    company: AdminScopedCompany,
    Json(body): Json<PutRoutes>,
) -> Result<Json<RoutesDto>, ApiError> {
    let runtime = company.runtime.as_ref();
    let secrets = runtime.secrets().as_ref();
    let providers = store::list_providers(runtime.id(), secrets)
        .await
        .map_err(ApiError)?;

    let mut routes = resolve::Routes::new();
    for (tier, raw) in body.routes {
        let tier = tier.trim().to_string();
        if resolve::Workload::from_tier(&tier).is_none() {
            return Err(ApiError(OpenCompanyError::InvalidRequest(format!(
                "`{tier}` is not a workload this runtime has a tier for."
            ))));
        }
        let route = resolve::ProviderRef::parse(&raw);
        // Fail closed on a route naming a provider nobody holds. Accepting it
        // and letting the turn discover it would attribute that workload's spend
        // to whatever the fallback happened to be — the same defect as resolving
        // an unknown provider kind instead of rejecting it.
        if let Some(slug) = route.slug()
            && !providers.iter().any(|p| p.slug == slug)
        {
            return Err(ApiError(OpenCompanyError::InvalidRequest(format!(
                "{tier} names `{slug}`, which this company has no provider for."
            ))));
        }
        routes.insert(tier, route);
    }
    store::save_routes(runtime.id(), secrets, &routes)
        .await
        .map_err(ApiError)?;

    Ok(Json(RoutesDto {
        mode: mode_name(resolve::infer_routing_mode(&routes)),
        orphaned: resolve::orphaned_routes(&routes, &providers),
        routes: routes
            .into_iter()
            .map(|(tier, route)| (tier, route.to_route_string()))
            .collect(),
    }))
}

/// The wire name of an inferred mode.
fn mode_name(mode: resolve::RoutingMode) -> String {
    match mode {
        resolve::RoutingMode::Managed => "managed",
        resolve::RoutingMode::Own => "own",
        resolve::RoutingMode::Advanced => "advanced",
    }
    .to_string()
}
