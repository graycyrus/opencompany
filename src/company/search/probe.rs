//! Checking that a search provider answers, and classifying it when it does not.
//!
//! IO at the edge, classification pure. [`classify`] decides and [`describe`]
//! says, so the six classes are testable without a translator and the strings
//! stay where strings belong.
//!
//! # The classifier is per provider, and that is not a stylistic choice
//!
//! The inference surface this is shaped after classifies on the upstream error
//! *text* in a fixed branch order — proxy first, then `401`-or-`403`-with-
//! credential-wording, then endpoint, then timeout. That works because every
//! OpenAI-compatible endpoint signals a rejected key with `401`.
//!
//! **Brave does not.** A rejected Brave key comes back `422` with
//! `error.code == "SUBSCRIPTION_TOKEN_INVALID"`, and Brave's API reference
//! documents `200`, `404`, `422` and `429` and no `401` and no `403` at all.
//! Ported unchanged, that classifier would never fire its destructive branch for
//! Brave — leaving a key we have positive evidence is dead stored under an amber
//! "the check did not complete" — and would read Brave's only possible `403`,
//! which can only be a WAF, as a rejected key. That is the exact incident the
//! borrowed branch ordering exists to prevent, arriving through the other door.
//!
//! So [`classify`] takes the slug as well as the response. The generic branches
//! remain, in the borrowed order, for everything the per-provider rules do not
//! claim.
//!
//! # Only `auth` is destructive
//!
//! Every other class keeps the credential and shows an advisory, because the
//! credential is plausibly fine and the connection is not. A corporate proxy, a
//! WAF, a rate limit and a SearXNG instance with JSON output turned off all fail
//! a check while the credential — where there is one at all — is perfectly good.
//!
//! # The check costs a search
//!
//! No hosted search provider offers a free credential validator. All three
//! reject a bad key *before* running a search, so a failed check is free, but
//! confirming a good one costs one real query. The console says so on the button
//! it applies to. SearXNG is free, and is the only one that is.
//!
//! `reqwest` is used without a feature gate, the same assumption
//! [`crate::company::mcp_oauth`] already makes: it arrives with `oauth` and
//! `documents`, both of which are in the crate's default feature set.

use std::time::Duration;

use super::catalogue::{AuthStyle, SearchProviderInfo};

/// How long a connectivity check may take before it is abandoned.
///
/// Shorter than the harness's own 30s search timeout: a check is something an
/// operator is watching a spinner for, and one that has not answered in fifteen
/// seconds has already told them what they need to know.
const TIMEOUT: Duration = Duration::from_secs(15);

/// What a failed check means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeClass {
    /// The provider rejected the credential. **The only destructive class.**
    Auth,
    /// A SearXNG instance is reachable but will not serve JSON.
    Format,
    /// The account is out of credit, or rate limited.
    Quota,
    /// Nothing answered, or what answered was not this provider.
    Endpoint,
    /// It did not answer in time.
    Timeout,
    /// Something else. Deliberately the fallback, and never destructive.
    Unknown,
}

impl ProbeClass {
    /// The wire spelling, shared with the console mirror.
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeClass::Auth => "auth",
            ProbeClass::Format => "format",
            ProbeClass::Quota => "quota",
            ProbeClass::Endpoint => "endpoint",
            ProbeClass::Timeout => "timeout",
            ProbeClass::Unknown => "unknown",
        }
    }
}

/// Whether meeting this class should roll back the credential just written.
///
/// Exactly one class says yes, and that is the point. The naive add flow rolls
/// everything back on any failure, and the naive flow **destroys valid
/// credentials**.
pub fn destroys_credential(class: ProbeClass) -> bool {
    class == ProbeClass::Auth
}

/// What a check came back with.
#[derive(Debug, Clone)]
pub enum ProbeFailure {
    /// The request never got an answer — DNS, refused, TLS, timeout.
    Transport(String),
    /// The provider answered, and not with success.
    Status {
        /// The HTTP status.
        status: u16,
        /// The response body, read only for classification and **never shown to
        /// an operator**: it can echo request material, including fragments of
        /// the credential, and the sentence built from it lands in a banner
        /// somebody screenshots into a ticket.
        body: String,
    },
}

/// Whether `text` contains `needle` case-insensitively.
fn mentions(text: &str, needle: &str) -> bool {
    text.to_ascii_lowercase().contains(needle)
}

/// Whether `text` contains `code` as a standalone number.
///
/// Word boundaries, so `401` and `403` do not match inside an id like `1403`.
fn mentions_status(text: &str, code: u16) -> bool {
    let code = code.to_string();
    let bytes = text.as_bytes();
    text.match_indices(&code).any(|(at, _)| {
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_digit();
        let after = at + code.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_digit();
        before_ok && after_ok
    })
}

/// Whether this response is the provider saying the credential is wrong.
///
/// Per provider, because the providers do not agree — see the module header.
/// Anything not positively recognised as a credential rejection is **not**
/// `auth`, which is the safe direction: the worst outcome of a miss is an amber
/// advisory beside a stored key, while the worst outcome of a false positive is
/// a deleted working credential.
fn is_auth_rejection(slug: &str, status: u16, body: &str) -> bool {
    match slug {
        // Brave answers 422, never 401 or 403. A 422 that is *not* the token
        // code is a request-shape problem — our bug, not their key — so it is
        // deliberately not auth.
        "brave" => status == 422 && mentions(body, "subscription_token_invalid"),
        // Exa documents 401 for a bad key. Its 402 means EITHER no credential at
        // all OR out of credit, so the body decides rather than the status.
        "exa" => {
            status == 401
                || (status == 402
                    && (mentions(body, "invalid_api_key") || mentions(body, "invalid api key")))
        }
        // Querit answers 401 with `error_code` as a string.
        "querit" => status == 401,
        // SearXNG has no credential to reject. Its 403 means something else
        // entirely — see the `Format` arm below.
        "searxng" => false,
        // An unknown slug cannot be positively recognised, so it never is.
        _ => false,
    }
}

/// The class of a failed check.
pub fn classify(slug: &str, failure: &ProbeFailure) -> ProbeClass {
    match failure {
        ProbeFailure::Transport(error) => classify_transport(error),
        ProbeFailure::Status { status, body } => classify_status(slug, *status, body),
    }
}

/// [`classify`] for a request that never got an answer.
fn classify_transport(error: &str) -> ProbeClass {
    if mentions(error, "timeout") || mentions(error, "timed out") || mentions(error, "deadline") {
        return ProbeClass::Timeout;
    }
    ProbeClass::Endpoint
}

/// [`classify`] for a response the provider actually sent.
fn classify_status(slug: &str, status: u16, body: &str) -> ProbeClass {
    // The proxy branch runs FIRST, and it is not negotiable. Otherwise the word
    // "authentication" inside `407 Proxy Authentication Required` matches a
    // credential rule and a corporate proxy deletes a valid key.
    if status == 407
        || mentions_status(body, 407)
        || mentions(body, "cloudflare")
        || mentions(body, "bad gateway")
        || mentions(body, "proxy authentication")
    {
        return ProbeClass::Unknown;
    }

    if is_auth_rejection(slug, status, body) {
        return ProbeClass::Auth;
    }

    // A SearXNG 403 is neither a credential problem nor a WAF: JSON output is
    // off. SearXNG ships `search.formats: [html]` and aborts with 403 when a
    // format is not enabled, which makes this the single most likely failure
    // when connecting a perfectly healthy instance. Classifying it as `auth`
    // would try to delete a key that does not exist; classifying it as
    // `unknown` would throw away the one message that could fix it.
    if slug == "searxng" && status == 403 {
        return ProbeClass::Format;
    }

    if status == 429 || status == 402 {
        return ProbeClass::Quota;
    }

    if status == 404 || status == 502 || status == 503 {
        return ProbeClass::Endpoint;
    }

    ProbeClass::Unknown
}

/// One sentence for a class. **Never interpolates the upstream body.**
///
/// `provider` is the label to name. `auth`, `endpoint` and `timeout` are about a
/// specific thing and naming it is the difference between a dead end and a next
/// step; the others are about the account or the check, so they name neither.
pub fn describe(class: ProbeClass, provider: &str) -> String {
    match class {
        ProbeClass::Auth => {
            format!("Could not reach {provider}: the provider rejected the credential.")
        }
        ProbeClass::Format => {
            "Saved. The instance has JSON output turned off — add `json` to `search.formats` in \
             its settings.yml."
                .to_string()
        }
        ProbeClass::Quota => "Saved. The account is out of credit.".to_string(),
        ProbeClass::Endpoint => format!("Saved, but nothing answered at {provider}."),
        ProbeClass::Timeout => format!("Saved, but {provider} did not answer in time."),
        ProbeClass::Unknown => "Saved, but the check did not complete.".to_string(),
    }
}

/// Refuses an instance address this host must not fetch on an operator's behalf.
///
/// # Why this is not [`crate::server::ops::memory_ingest`]'s guard
///
/// That guard refuses **every** private address, including `.internal`
/// hostnames, which is right for fetching a link an operator pasted from the
/// internet and wrong here: a self-hosted SearXNG instance at `10.0.0.5` or
/// `search.acme.internal` is the *normal* deployment, and reusing it would
/// refuse the ordinary case. It is also `#[cfg(feature = "documents")]`, and
/// this surface is deliberately ungated.
///
/// So this is a narrower rule rather than a copy: the class that is never a
/// search instance and is always someone's cloud metadata service.
///
/// The residual reach is real — an administrator can point this at a private
/// address and learn whether something answers there — and it is why the probe
/// route requires [`AdminScopedCompany`](crate::server::ops::scope) rather than
/// the `ScopedCompany` the read routes use. It is an allowance, not an
/// oversight.
///
/// This is the third copy of a URL-shape rule in the tree, and the second one's
/// own comment already says the lasting fix is to lift it somewhere both can
/// depend on. Doing that is a separate change: the three want three different
/// address policies, so lifting means parameterising, not just moving.
pub fn guard_instance_url(url: &str) -> Result<(), String> {
    let parsed = url
        .parse::<axum::http::Uri>()
        .map_err(|_| "not a URL".to_string())?;
    match parsed.scheme_str() {
        Some("http") | Some("https") => {}
        _ => return Err("a SearXNG instance address must be http:// or https://".to_string()),
    }
    let host = parsed
        .host()
        .ok_or_else(|| "no host in the URL".to_string())?;
    // A bracketed IPv6 literal keeps its brackets in `Uri::host`.
    let host = host.trim_start_matches('[').trim_end_matches(']');

    if let Ok(address) = host.parse::<std::net::IpAddr>()
        && is_metadata_address(address)
    {
        return Err("that address is a cloud metadata service, not a search instance".to_string());
    }
    Ok(())
}

/// Link-local and the cloud metadata services that live there.
///
/// Loopback and RFC1918 are deliberately **absent**: both are ordinary places
/// for a self-hosted instance. Link-local is not — nobody runs SearXNG on
/// `169.254.169.254`, and everybody's instance metadata service does.
fn is_metadata_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast(),
        std::net::IpAddr::V6(v6) => {
            if v6.is_unspecified() || v6.segments()[0] & 0xffc0 == 0xfe80 {
                return true;
            }
            // `to_ipv4`, not `to_ipv4_mapped`: the deprecated IPv4-compatible
            // form (`::a.b.c.d`) carries the same address and the mapped reader
            // answers `None` for it.
            v6.to_ipv4()
                .is_some_and(|v4| is_metadata_address(std::net::IpAddr::V4(v4)))
        }
    }
}

/// Asks a provider whether it answers for this credential.
///
/// One request, chosen per provider because there is no shape they share. For
/// the three account providers it is a one-result search — the cheapest real
/// call each offers, since none publishes a free validator. For SearXNG it is
/// the JSON search the tool itself will make, which costs the operator nothing
/// and is the only call that proves JSON output is enabled.
///
/// # Errors
///
/// Returns the failure for [`classify`] to read. Never returns the response body
/// to the caller beyond that.
pub async fn probe(
    info: &SearchProviderInfo,
    credential: Option<&str>,
    endpoint: Option<&str>,
) -> Result<(), ProbeFailure> {
    let base = endpoint.unwrap_or(info.endpoint).trim_end_matches('/');
    if base.is_empty() {
        return Err(ProbeFailure::Transport("no endpoint to check".to_string()));
    }

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // A redirect to somewhere else is not this provider answering, and
        // following one is how a guarded address is reached anyway.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| ProbeFailure::Transport(err.to_string()))?;

    let request = match info.slug {
        "brave" => client.get(format!("{base}/web/search?q=opencompany&count=1")),
        "exa" => client
            .post(format!("{base}/search"))
            .json(&serde_json::json!({ "query": "opencompany", "numResults": 1 })),
        "querit" => client
            .post(format!("{base}/search"))
            .json(&serde_json::json!({ "query": "opencompany", "count": 1 })),
        "searxng" => {
            let path = if base.ends_with("/search") {
                base.to_string()
            } else {
                format!("{base}/search")
            };
            client.get(format!("{path}?q=opencompany&format=json"))
        }
        other => {
            return Err(ProbeFailure::Transport(format!(
                "no connectivity check is defined for `{other}`"
            )));
        }
    };

    let request = match (info.auth, credential) {
        (Some(AuthStyle::Header(name)), Some(key)) => request.header(name, key),
        (Some(AuthStyle::Bearer), Some(key)) => request.bearer_auth(key),
        _ => request,
    };

    let response = request
        .send()
        .await
        .map_err(|err| ProbeFailure::Transport(err.to_string()))?;

    let status = response.status().as_u16();
    if response.status().is_success() {
        return Ok(());
    }
    // Capped: the body is read for classification and thrown away, and an
    // endpoint that answers a checked request with a gigabyte is not one this
    // host should buffer.
    let body = response.text().await.unwrap_or_default();
    let body = body.chars().take(4096).collect::<String>();
    Err(ProbeFailure::Status { status, body })
}

#[cfg(test)]
#[path = "probe_test.rs"]
mod probe_test;
