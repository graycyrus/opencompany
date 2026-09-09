//! Route tests for the company's TinyHumans credential (issue #586).

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::company::CompanyManifest;
use crate::ports::types::{CompanyId, CompanyRecord};
use crate::runtime::RuntimeBuilder;
use crate::server::router;
use crate::store::FsCompanyStore;
use crate::{AppConfig, AppState};

/// A value long and opaque enough that a leak would be unmistakable in a body.
const KEY: &str = "th_company_credential_SECRET_do_not_echo_me";

/// A company that grants Composio, so the status route has something to report
/// a credential tier *for*.
const GRANTED: &str = "[company]\nname = \"Acme\"\n[policy]\nmode = \"full\"\n\
     [tools]\nallow = [\"composio\"]\n[tools.composio]\ntoolkits = [\"gmail\"]\n";

fn home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("oc-company-key-")
        .tempdir()
        .expect("tempdir")
}

async fn state_with_manifest(
    home: &std::path::Path,
    company: &str,
    manifest_toml: &str,
) -> AppState {
    use crate::ports::CompanyStore;
    let manifest: CompanyManifest = toml::from_str(manifest_toml).unwrap();
    let store = FsCompanyStore::new(home.to_path_buf());
    let id = CompanyId::new(company);
    store
        .save(&CompanyRecord {
            overlay_retired_agents: Vec::new(),
            overlay_agent_edits: Vec::new(),
            id: id.clone(),
            manifest: manifest.clone(),
            ledger: Vec::new(),
            lifecycle: "running".to_string(),
            overlay_agents: Vec::new(),
            overlay_desk_members: Vec::new(),
            overlay_desk_order: Vec::new(),
            overlay_desks: Vec::new(),
            overlay_workflows: Vec::new(),
            overlay_budgets: Vec::new(),
            overlay_policy: None,
            overlay_tool_grants: None,
            overlay_desk_tools: Default::default(),
            disabled_workflows: Vec::new(),
            template_provenance: None,
            setup: None,
            name_confirmed: false,
            activation_completed_at: None,
            created_at_millis: None,
        })
        .await
        .unwrap();
    let runtime = RuntimeBuilder::new(home.to_path_buf(), manifest)
        .with_id(id.clone())
        .build()
        .await
        .unwrap();
    let state = AppState::new(AppConfig::default());
    state.registry().insert(id, std::sync::Arc::new(runtime));
    crate::server::test_support::seed_fixed_admin(&state, company).await;
    state
}

async fn send_as(
    state: &AppState,
    method: &str,
    uri: &str,
    body: Option<Value>,
    cookie: String,
) -> (StatusCode, Value, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie);
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value, raw)
}

async fn send(
    state: &AppState,
    company: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value, String) {
    send_as(
        state,
        method,
        uri,
        body,
        crate::server::test_support::fixed_cookie(company),
    )
    .await
}

/// The core round trip: an admin sets the key, the read plane reports it as the
/// company's own identity, and the value never comes back out.
#[tokio::test]
async fn the_key_round_trips_write_only_and_reports_the_company_tier() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "acme", GRANTED).await;

    // Nothing set, and the test process carries no platform identity: the
    // honest degraded state, not a broken picker.
    let (status, dto, raw) = send(&state, "acme", "GET", "/api/v1/company/credential", None).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    assert_eq!(dto["configured"], false);
    assert_eq!(dto["source"], "none");
    assert!(
        dto["notice"]
            .as_str()
            .unwrap_or_default()
            .contains("cannot be connected"),
        "the degraded state has to say what is unavailable: {dto}"
    );
    assert!(dto.get("key").is_none(), "status must never carry the key");

    // Set it.
    let (status, resp, raw) = send(
        &state,
        "acme",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    assert_eq!(resp["status"]["configured"], true);
    assert_eq!(resp["status"]["source"], "company");
    assert!(!raw.contains(KEY), "PUT response leaked the key: {raw}");

    // The consequence is stated, because it is the thing an admin most needs to
    // understand before pasting.
    let notice = resp["status"]["notice"].as_str().unwrap_or_default();
    assert!(notice.contains("spend"), "{notice}");
    assert!(notice.contains("company"), "{notice}");
    // …and so is the distinction from the model-provider key. These two cards
    // sit next to each other and both read "configured"; the copy is the only
    // thing standing between an admin and pasting an OpenRouter key here.
    assert!(
        notice.contains("Inference card"),
        "the notice must say which key this is NOT: {notice}"
    );

    // GET reflects it and still never carries the key.
    let (_, dto, raw) = send(&state, "acme", "GET", "/api/v1/company/credential", None).await;
    assert_eq!(dto["configured"], true);
    assert_eq!(dto["source"], "company");
    assert!(!raw.contains(KEY), "GET status leaked the key: {raw}");
}

/// Acceptance: a company with its key set can connect a provider without any
/// per-tenant provider app — the Composio plane must see the company's own
/// identity, with no Composio token pasted anywhere.
#[tokio::test]
async fn setting_the_key_credentials_composio_with_no_composio_token() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "brokered", GRANTED).await;

    // No Composio token, no platform identity in this process → nothing.
    let (_, dto, _) = send(&state, "brokered", "GET", "/api/v1/company/composio", None).await;
    assert_eq!(dto["credentialSource"], "none");

    send(
        &state,
        "brokered",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;

    // The company key alone credentials Composio. This is the issue in one
    // assertion: no `composio/token`, no provider app, still connectable.
    let (_, dto, raw) = send(&state, "brokered", "GET", "/api/v1/company/composio", None).await;
    assert_eq!(dto["credentialSource"], "company", "{raw}");
    assert!(
        !raw.contains(KEY),
        "the Composio status leaked the key: {raw}"
    );
}

/// Acceptance: clearing is real, and reverts to the honest degraded state
/// rather than stranding the console on a stale "connected" claim.
#[tokio::test]
async fn clearing_the_key_reverts_to_the_degraded_state() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "cleared", GRANTED).await;
    send(
        &state,
        "cleared",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;

    let (_, resp, _) = send(
        &state,
        "cleared",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": "" })),
    )
    .await;
    assert_eq!(resp["status"]["configured"], false);
    assert_eq!(resp["status"]["source"], "none");

    let (_, dto, _) = send(&state, "cleared", "GET", "/api/v1/company/composio", None).await;
    assert_eq!(dto["credentialSource"], "none");
}

/// A company's own Composio token still outranks the company key — the BYO
/// escape hatch is not taken away by this change.
#[tokio::test]
async fn a_pasted_composio_token_still_outranks_the_company_key() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "byo", GRANTED).await;
    send(
        &state,
        "byo",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;
    send(
        &state,
        "byo",
        "PUT",
        "/api/v1/company/composio/token",
        Some(json!({ "token": "byo-composio-token" })),
    )
    .await;

    let (_, dto, _) = send(&state, "byo", "GET", "/api/v1/company/composio", None).await;
    assert_eq!(
        dto["credentialSource"], "static",
        "a company that pasted its own Composio token keeps it: {dto}"
    );

    // The company key is still stored — the two are separate slots, and
    // clearing the Composio token falls back to the company's own identity
    // rather than to nothing.
    send(
        &state,
        "byo",
        "PUT",
        "/api/v1/company/composio/token",
        Some(json!({ "token": "" })),
    )
    .await;
    let (_, dto, _) = send(&state, "byo", "GET", "/api/v1/company/composio", None).await;
    assert_eq!(dto["credentialSource"], "company", "{dto}");
}

/// The two read planes answer **different questions**, and a company holding
/// both credentials is where that stops being pedantry.
///
/// `GET …/credential` reports whose identity the company *has*; `GET …/composio`
/// reports what a Composio call *presents*, which its BYO token overrides. Both
/// are correct simultaneously, and any refactor that "unifies" them would have
/// to break one of these two assertions.
#[tokio::test]
async fn the_credential_plane_and_the_composio_plane_may_honestly_disagree() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "disagree", GRANTED).await;

    send(
        &state,
        "disagree",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;
    send(
        &state,
        "disagree",
        "PUT",
        "/api/v1/company/composio/token",
        Some(json!({ "token": "byo-composio-token" })),
    )
    .await;

    let (_, credential, _) = send(
        &state,
        "disagree",
        "GET",
        "/api/v1/company/credential",
        None,
    )
    .await;
    let (_, composio, _) = send(&state, "disagree", "GET", "/api/v1/company/composio", None).await;

    assert_eq!(
        credential["source"], "company",
        "the company's own identity is set, whatever Composio presents: {credential}"
    );
    assert_eq!(
        composio["credentialSource"], "static",
        "a Composio call presents the BYO token, whatever identity the company holds: {composio}"
    );
    assert_eq!(credential["configured"], true);
}

/// The write is admin-only, for the same reason the Composio token write is:
/// this key repoints the company's entire brokered surface at whatever account
/// the caller controls, and it is the company's wallet.
#[tokio::test]
async fn a_member_cannot_set_the_companys_credential() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "acme", GRANTED).await;
    let member =
        crate::server::test_support::seed_session(&state, "acme", crate::ports::UserRole::Member)
            .await;

    let (status, body, raw) = send_as(
        &state,
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
        member,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{raw}");
    assert_eq!(body["code"], "forbidden", "{body}");
    assert!(
        body["error"].as_str().unwrap_or_default().contains("admin"),
        "the refusal has to say why: {body}"
    );

    // The refusal is real, not merely a different status.
    let (_, dto, _) = send(&state, "acme", "GET", "/api/v1/company/credential", None).await;
    assert_eq!(
        dto["configured"], false,
        "a refused write must not have stored anything: {dto}"
    );
}

/// Setting the credential is journaled, so a change to what the company acts
/// through is never invisible — and a clear is told apart from a set.
#[tokio::test]
async fn setting_and_clearing_are_journaled_with_an_actor() {
    use crate::ports::types::CompanyEvent;

    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "audited", GRANTED).await;
    send(
        &state,
        "audited",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": KEY })),
    )
    .await;
    send(
        &state,
        "audited",
        "PUT",
        "/api/v1/company/credential",
        Some(json!({ "key": "" })),
    )
    .await;

    let id = CompanyId::new("audited");
    let runtime = state.registry().get(&id).expect("registered");
    let events = runtime
        .events()
        .read_from(&id, crate::ports::types::EventSeq::new(0), 200)
        .await
        .expect("events");
    let changes: Vec<(String, bool)> = events
        .iter()
        .filter_map(|stored| match &stored.event {
            CompanyEvent::ToolAccessChanged { change, by, .. } => {
                Some((change.clone(), by.is_some()))
            }
            _ => None,
        })
        .collect();
    assert!(
        changes.contains(&("company_key_set".to_string(), true)),
        "a set must be journaled with who did it: {changes:?}"
    );
    assert!(
        changes.contains(&("company_key_cleared".to_string(), true)),
        "a clear must be told apart from a set: {changes:?}"
    );
    // …and it must not borrow the Composio token's vocabulary. Both routes
    // append `ToolAccessChanged` to one log, so if this route spoke
    // `credential_set` an auditor could not tell a rotation of the company's
    // whole identity from a swap of one integration's token.
    assert!(
        !changes
            .iter()
            .any(|(change, _)| change == "credential_set" || change == "credential_cleared"),
        "no Composio write happened here, so no Composio audit word may appear: {changes:?}"
    );
}

// ---------------------------------------------------------------------------
// The one-click key grant (PKCE). See `server::hub_link`.
// ---------------------------------------------------------------------------

/// The key the mock hub mints when a grant is redeemed.
const GRANTED_KEY: &str = "tiny_live_granted_by_the_hub_do_not_echo_me";

/// A state with a hub that will mint `GRANTED_KEY` for the right verifier.
///
/// The verifier is not known until the host mints one, so the exchange is
/// seeded *after* `start` — which is also the only way to assert that the host
/// sends the challenge for the verifier it actually kept.
async fn state_with_hub(home: &std::path::Path, company: &str) -> AppState {
    state_with_manifest(home, company, GRANTED)
        .await
        .with_hub_identity(std::sync::Arc::new(
            crate::server::hub_identity::MockHubIdentityExchange::new(),
        ))
}

/// Pulls `state=` out of the authorize URL the console is told to navigate to.
fn state_param(authorize_url: &str) -> String {
    let (_, after) = authorize_url
        .split_once("state%3D")
        .expect("state in callback");
    after
        .split(['&', '%'])
        .next()
        .expect("state value")
        .to_string()
}

#[tokio::test]
async fn a_host_with_no_hub_offers_no_link_and_refuses_to_start_one() {
    let home_dir = home();
    let state = state_with_manifest(home_dir.path(), "acme", GRANTED).await;

    // The status says so, which is what keeps the console from rendering a
    // button whose only possible outcome is a 404.
    let (status, dto, raw) = send(&state, "acme", "GET", "/api/v1/company/credential", None).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    assert_eq!(dto["hubLink"], false);

    let (status, _, raw) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/start",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{raw}");
}

#[tokio::test]
async fn starting_a_link_sends_the_console_to_the_hub_with_a_challenge_not_a_secret() {
    let home_dir = home();
    let state = state_with_hub(home_dir.path(), "acme").await;

    let (status, dto, raw) = send(&state, "acme", "GET", "/api/v1/company/credential", None).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    assert_eq!(dto["hubLink"], true);

    let (status, resp, raw) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/start",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{raw}");

    let url = resp["authorizeUrl"].as_str().expect("authorizeUrl");
    assert!(
        url.contains("/auth/key?"),
        "must start the grant flow: {url}"
    );
    assert!(
        url.contains("code_challenge_method=S256"),
        "plain must never be offered: {url}"
    );
    assert!(
        url.contains("key%3Dlink"),
        "the return leg needs this console's own marker, not the hub's key=auth: {url}"
    );

    // The verifier is the one thing that must not be in a URL the browser
    // follows. Only its SHA-256 goes out, and the response carries neither the
    // verifier nor anything else redeemable.
    let state_value = state_param(url);
    let link = state
        .hub_links()
        .take(&state_value, "acme")
        .expect("the start parked a pending link");
    assert!(
        !url.contains(&link.verifier),
        "the verifier must never leave this host: {url}"
    );
    assert!(url.contains(&crate::server::hub_link::challenge_for(&link.verifier)));
}

#[tokio::test]
async fn finishing_a_link_stores_the_minted_key_as_both_the_company_and_inference_credential() {
    let home_dir = home();
    let state = state_with_hub(home_dir.path(), "acme").await;

    let (_, resp, _) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/start",
        Some(json!({})),
    )
    .await;
    let url = resp["authorizeUrl"].as_str().unwrap().to_string();
    let state_value = state_param(&url);

    // Play the hub: it is the one participant that legitimately learns both the
    // verifier (from the challenge it was sent, at redemption) and the code it
    // handed the browser. Peeked rather than taken, so the link is still parked
    // for the route to spend.
    let verifier = state
        .hub_links()
        .peek_verifier(&state_value)
        .expect("the start parked a pending link");
    let state = state.with_hub_identity(std::sync::Arc::new(
        crate::server::hub_identity::MockHubIdentityExchange::new().with_grant(
            "grant-code",
            &verifier,
            GRANTED_KEY,
        ),
    ));

    let (status, resp, raw) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/finish",
        Some(json!({ "state": state_value, "code": "grant-code" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{raw}");

    // One grant, both credentials. An admin who had to run this twice — once
    // for Connections, once for Inference — would be back to two errands.
    assert_eq!(resp["status"]["configured"], true);
    assert_eq!(resp["status"]["source"], "company");
    assert!(
        !raw.contains(GRANTED_KEY),
        "the minted key must never be echoed to the console: {raw}"
    );

    let (_, inference, raw) = send(&state, "acme", "GET", "/api/v1/company/inference", None).await;
    assert_eq!(
        inference["keyConfigured"], true,
        "the same grant must arm inference: {raw}"
    );

    // Single-use: the same handle and code cannot be spent again.
    let (status, _, raw) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/finish",
        Some(json!({ "state": state_value, "code": "grant-code" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{raw}");
}

#[tokio::test]
async fn a_replayed_or_unknown_state_is_refused() {
    let home_dir = home();
    let state = state_with_hub(home_dir.path(), "acme").await;

    let (status, _, raw) = send(
        &state,
        "acme",
        "POST",
        "/api/v1/company/credential/link/finish",
        Some(json!({ "state": "never-minted", "code": "whatever" })),
    )
    .await;
    // A `state` this host never minted, one that expired, and one already spent
    // are the same answer on purpose: the remedy is identical, and telling them
    // apart would say which handles had once been real.
    assert_eq!(status, StatusCode::BAD_REQUEST, "{raw}");
}

#[tokio::test]
async fn a_member_cannot_start_or_finish_a_link() {
    let home_dir = home();
    let state = state_with_hub(home_dir.path(), "acme").await;
    crate::server::test_support::seed_fixed_member(&state, "acme").await;
    let member = crate::server::test_support::member_cookie("acme");

    // Same authority `PUT /credential` needs. That the key is minted rather
    // than pasted changes who types it, not what it does.
    let (status, _, raw) = send_as(
        &state,
        "POST",
        "/api/v1/company/credential/link/start",
        Some(json!({})),
        member.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{raw}");

    let (status, _, raw) = send_as(
        &state,
        "POST",
        "/api/v1/company/credential/link/finish",
        Some(json!({ "state": "x", "code": "y" })),
        member,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{raw}");
}
