//! Classification, against the response shapes the providers actually send.
//!
//! Every body below is the real one, taken from the provider's own
//! documentation or from an unauthenticated probe with an obviously fake key.
//! The four cases that matter most are the ones the ordering exists for: Brave's
//! `422`, Brave's `403`, SearXNG's `403`, and `407 Proxy Authentication
//! Required`.

use super::*;

fn status(code: u16, body: &str) -> ProbeFailure {
    ProbeFailure::Status {
        status: code,
        body: body.to_string(),
    }
}

#[test]
fn brave_rejects_a_bad_key_with_422_not_401() {
    // Brave's API reference documents 200/404/422/429 and no 401 and no 403.
    // A classifier that maps auth to 401/403 leaves this key stored.
    let body = r#"{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid.","meta":{"component":"authentication"},"status":422},"type":"ErrorResponse"}"#;
    assert_eq!(classify("brave", &status(422, body)), ProbeClass::Auth);
    assert!(destroys_credential(ProbeClass::Auth));
}

#[test]
fn a_brave_403_is_a_waf_and_must_not_delete_the_key() {
    // Brave never uses 403 for authentication, so a 403 from that host can only
    // be something in front of it.
    assert_eq!(
        classify("brave", &status(403, "Forbidden")),
        ProbeClass::Unknown
    );
    assert!(!destroys_credential(ProbeClass::Unknown));
}

#[test]
fn a_brave_422_that_is_not_the_token_code_is_our_bug_not_their_key() {
    let body =
        r#"{"error":{"code":"VALIDATION","detail":"Unable to validate request parameter(s)"}}"#;
    assert_eq!(classify("brave", &status(422, body)), ProbeClass::Unknown);
}

#[test]
fn exa_rejects_a_bad_key_with_401() {
    let body = r#"{"requestId":"abc","error":"Invalid API key","tag":"INVALID_API_KEY"}"#;
    assert_eq!(classify("exa", &status(401, body)), ProbeClass::Auth);
}

#[test]
fn an_exa_402_without_credential_wording_is_out_of_credit_not_a_bad_key() {
    // 402 means either "no credential at all" or "out of credit", so the body
    // decides. Out of credit keeps the key.
    assert_eq!(
        classify("exa", &status(402, r#"{"error":"insufficient credits"}"#)),
        ProbeClass::Quota
    );
    assert!(!destroys_credential(ProbeClass::Quota));
}

#[test]
fn querit_rejects_a_bad_key_with_401_and_a_string_typed_code() {
    let body =
        r#"{"error_code":"401","error_msg":"Invalid authorization header format.","search_id":7}"#;
    assert_eq!(classify("querit", &status(401, body)), ProbeClass::Auth);
}

#[test]
fn a_searxng_403_means_json_is_off_not_that_a_key_was_rejected() {
    // There is no key. Deleting one would be deleting nothing, and the operator
    // would lose the only message that tells them what to change.
    assert_eq!(
        classify("searxng", &status(403, "Forbidden")),
        ProbeClass::Format
    );
    assert!(!destroys_credential(ProbeClass::Format));
    assert!(describe(ProbeClass::Format, "SearXNG").contains("search.formats"));
}

#[test]
fn a_proxy_challenge_is_never_auth_whatever_provider_it_arrives_for() {
    // The word "authentication" inside `407 Proxy Authentication Required` is
    // the reason this branch runs first.
    for slug in ["brave", "exa", "querit", "searxng"] {
        assert_eq!(
            classify(slug, &status(407, "Proxy Authentication Required")),
            ProbeClass::Unknown,
            "{slug}"
        );
    }
}

#[test]
fn a_cloudflare_interstitial_is_not_auth() {
    assert_eq!(
        classify(
            "exa",
            &status(403, "<title>Just a moment...</title> Cloudflare")
        ),
        ProbeClass::Unknown
    );
}

#[test]
fn a_status_like_number_inside_an_id_does_not_match() {
    // Word boundaries: `1403` and `4071` are not statuses.
    let body = r#"{"requestId":"req-1403-4071","error":"something else"}"#;
    assert_eq!(classify("exa", &status(500, body)), ProbeClass::Unknown);
}

#[test]
fn rate_limiting_is_quota_everywhere_and_keeps_the_credential() {
    for slug in ["brave", "exa", "querit"] {
        assert_eq!(
            classify(slug, &status(429, "")),
            ProbeClass::Quota,
            "{slug}"
        );
    }
}

#[test]
fn a_404_is_the_endpoint_and_a_timeout_is_a_timeout() {
    assert_eq!(classify("querit", &status(404, "")), ProbeClass::Endpoint);
    assert_eq!(
        classify(
            "searxng",
            &ProbeFailure::Transport("error sending request: operation timed out".to_string())
        ),
        ProbeClass::Timeout
    );
    assert_eq!(
        classify(
            "searxng",
            &ProbeFailure::Transport("dns error: failed to lookup address".to_string())
        ),
        ProbeClass::Endpoint
    );
}

#[test]
fn only_auth_is_destructive() {
    for class in [
        ProbeClass::Format,
        ProbeClass::Quota,
        ProbeClass::Endpoint,
        ProbeClass::Timeout,
        ProbeClass::Unknown,
    ] {
        assert!(!destroys_credential(class), "{}", class.as_str());
    }
    assert!(destroys_credential(ProbeClass::Auth));
}

#[test]
fn no_sentence_carries_the_upstream_body() {
    // The body can echo request material, including fragments of a key, and
    // these sentences land in a banner somebody screenshots into a ticket.
    let leak = "sk-not-a-real-key";
    let body = format!(r#"{{"error":"bad token {leak}"}}"#);
    let class = classify("exa", &status(401, &body));
    assert!(!describe(class, "Exa").contains(leak));
}

#[test]
fn the_metadata_service_is_refused_and_a_private_instance_is_not() {
    // A self-hosted SearXNG at an RFC1918 address is the ordinary deployment,
    // so the guard here is narrower than the one that fetches pasted links.
    assert!(guard_instance_url("http://169.254.169.254/").is_err());
    assert!(guard_instance_url("http://[fe80::1]/").is_err());
    assert!(guard_instance_url("http://[::169.254.169.254]/").is_err());
    assert!(guard_instance_url("http://0.0.0.0/").is_err());

    assert!(guard_instance_url("http://10.0.0.5:8080").is_ok());
    assert!(guard_instance_url("http://192.168.1.20").is_ok());
    assert!(guard_instance_url("http://127.0.0.1:8888").is_ok());
    assert!(guard_instance_url("https://search.acme.internal").is_ok());
}

#[test]
fn a_non_http_scheme_is_refused_before_anything_is_fetched() {
    assert!(guard_instance_url("file:///etc/passwd").is_err());
    assert!(guard_instance_url("ftp://example.test").is_err());
    assert!(guard_instance_url("not a url at all").is_err());
}
