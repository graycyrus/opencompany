//! The store, against an in-memory port. No host, no network.
//!
//! The cases that must never regress are the convergence ones: an existing
//! company keeps working untouched, its first save moves it, and a second
//! provider's credential is genuinely a second credential rather than the same
//! slot under a new name — which is the bug the whole rework exists to fix.

use super::*;

#[derive(Default)]
struct MemSecrets {
    map: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[async_trait::async_trait]
impl SecretStore for MemSecrets {
    async fn get(&self, _company: &CompanyId, key: &str) -> Result<Option<SecretValue>> {
        Ok(self
            .map
            .lock()
            .unwrap()
            .get(key)
            .map(|value| SecretValue(value.clone())))
    }
    async fn set(&self, _company: &CompanyId, key: &str, value: SecretValue) -> Result<()> {
        self.map.lock().unwrap().insert(key.to_string(), value.0);
        Ok(())
    }
}

fn company() -> CompanyId {
    CompanyId::new("acme")
}

async fn seed(secrets: &MemSecrets, pairs: &[(&str, &str)]) {
    for (key, value) in pairs {
        secrets
            .set(&company(), key, SecretValue((*value).to_string()))
            .await
            .expect("seed");
    }
}

#[tokio::test]
async fn a_company_with_nothing_configured_has_no_providers() {
    let secrets = MemSecrets::default();
    assert!(
        list_providers(&company(), &secrets)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_legacy_flat_keys_are_read_as_entry_zero() {
    // An existing company must keep working with nothing written and nothing
    // moved. This is the whole argument for convergence over migration.
    let secrets = MemSecrets::default();
    seed(
        &secrets,
        &[(PROVIDER_SECRET, "exa"), (API_KEY_SECRET, "exa-key")],
    )
    .await;

    let providers = list_providers(&company(), &secrets).await.unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].slug, "exa");
    assert!(providers[0].enabled);
    assert!(
        provider_key_configured(&company(), &secrets, "exa")
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn managed_and_unknown_slugs_are_never_synthesised_into_a_row() {
    // Neither is a connection, so neither is a row to render or to resolve.
    for slug in ["managed", "google", ""] {
        let secrets = MemSecrets::default();
        seed(&secrets, &[(PROVIDER_SECRET, slug)]).await;
        assert!(
            list_providers(&company(), &secrets)
                .await
                .unwrap()
                .is_empty(),
            "{slug}"
        );
    }
}

#[tokio::test]
async fn saving_entry_zeros_key_moves_it_and_clears_the_flat_address() {
    let secrets = MemSecrets::default();
    seed(
        &secrets,
        &[(PROVIDER_SECRET, "exa"), (API_KEY_SECRET, "exa-key")],
    )
    .await;

    store_provider_key(&company(), &secrets, "exa", "exa-key-2")
        .await
        .unwrap();

    assert_eq!(
        secrets.map.lock().unwrap().get(API_KEY_SECRET).cloned(),
        Some(String::new()),
        "the flat key must be CLEARED, not merely shadowed — a key left behind is an \
         orphaned secret"
    );
    assert_eq!(
        load_provider_key(&company(), &secrets, "exa")
            .await
            .unwrap()
            .as_deref(),
        Some("exa-key-2")
    );
}

#[tokio::test]
async fn adding_a_second_provider_does_not_touch_entry_zeros_credential() {
    // The mirror image of the test above, and the more dangerous direction: a
    // write that cleared `search/api_key` unconditionally would destroy the
    // legacy provider's key while saving somebody else's.
    let secrets = MemSecrets::default();
    seed(
        &secrets,
        &[(PROVIDER_SECRET, "exa"), (API_KEY_SECRET, "exa-key")],
    )
    .await;

    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "brave".to_string(),
            enabled: true,
            endpoint: None,
        },
    )
    .await
    .unwrap();
    store_provider_key(&company(), &secrets, "brave", "brave-key")
        .await
        .unwrap();

    let slugs: Vec<String> = list_providers(&company(), &secrets)
        .await
        .unwrap()
        .into_iter()
        .map(|provider| provider.slug)
        .collect();
    assert_eq!(slugs, vec!["exa".to_string(), "brave".to_string()]);

    assert_eq!(
        load_provider_key(&company(), &secrets, "exa")
            .await
            .unwrap()
            .as_deref(),
        Some("exa-key")
    );
    assert_eq!(
        load_provider_key(&company(), &secrets, "brave")
            .await
            .unwrap()
            .as_deref(),
        Some("brave-key"),
        "two providers, two credentials — this is the bug the rework exists to fix"
    );
}

#[tokio::test]
async fn a_converged_entry_zero_is_not_listed_twice() {
    let secrets = MemSecrets::default();
    seed(
        &secrets,
        &[(PROVIDER_SECRET, "exa"), (API_KEY_SECRET, "exa-key")],
    )
    .await;
    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "exa".to_string(),
            enabled: true,
            endpoint: None,
        },
    )
    .await
    .unwrap();

    let providers = list_providers(&company(), &secrets).await.unwrap();
    assert_eq!(providers.len(), 1, "{providers:?}");
}

#[tokio::test]
async fn deleting_a_provider_clears_its_credential() {
    let secrets = MemSecrets::default();
    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "brave".to_string(),
            enabled: true,
            endpoint: None,
        },
    )
    .await
    .unwrap();
    store_provider_key(&company(), &secrets, "brave", "brave-key")
        .await
        .unwrap();

    delete_provider(&company(), &secrets, "brave")
        .await
        .unwrap();

    assert!(
        list_providers(&company(), &secrets)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        !provider_key_configured(&company(), &secrets, "brave")
            .await
            .unwrap(),
        "re-adding a provider must not silently reuse the key it had before"
    );
}

#[tokio::test]
async fn deleting_entry_zero_clears_the_flat_keys_too() {
    let secrets = MemSecrets::default();
    seed(
        &secrets,
        &[
            (PROVIDER_SECRET, "searxng"),
            (ENDPOINT_SECRET, "https://search.acme.internal"),
        ],
    )
    .await;

    delete_provider(&company(), &secrets, "searxng")
        .await
        .unwrap();

    assert!(
        list_providers(&company(), &secrets)
            .await
            .unwrap()
            .is_empty()
    );
    for key in [PROVIDER_SECRET, API_KEY_SECRET, ENDPOINT_SECRET] {
        assert_eq!(
            secrets.map.lock().unwrap().get(key).cloned(),
            Some(String::new()),
            "{key}"
        );
    }
}

#[tokio::test]
async fn disabling_the_marked_provider_clears_the_marker() {
    // Rather than moving it to something the operator never chose.
    let secrets = MemSecrets::default();
    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "brave".to_string(),
            enabled: true,
            endpoint: None,
        },
    )
    .await
    .unwrap();
    set_default_slug(&company(), &secrets, "brave")
        .await
        .unwrap();
    store_provider_key(&company(), &secrets, "brave", "brave-not-a-real-key")
        .await
        .unwrap();

    set_enabled(&company(), &secrets, "brave", false)
        .await
        .unwrap();

    assert_eq!(load_default_slug(&company(), &secrets).await.unwrap(), None);
    assert!(
        !list_providers(&company(), &secrets).await.unwrap()[0].enabled,
        "disabled is not deleted — the credential and the record stay"
    );
    // `|| true` made this unconditional, which is worse than no assertion at
    // all: it read as a check on the very property the test is named for. The
    // key now has to be there to be kept, so it is stored first.
    assert!(
        provider_key_configured(&company(), &secrets, "brave")
            .await
            .unwrap(),
        "disabling must not take the credential with it"
    );
}

#[tokio::test]
async fn deleting_the_marked_provider_clears_the_marker() {
    let secrets = MemSecrets::default();
    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "brave".to_string(),
            enabled: true,
            endpoint: None,
        },
    )
    .await
    .unwrap();
    set_default_slug(&company(), &secrets, "brave")
        .await
        .unwrap();

    delete_provider(&company(), &secrets, "brave")
        .await
        .unwrap();

    assert_eq!(load_default_slug(&company(), &secrets).await.unwrap(), None);
}

#[tokio::test]
async fn a_self_hosted_endpoint_round_trips_on_its_own_address() {
    let secrets = MemSecrets::default();
    put_provider(
        &company(),
        &secrets,
        SearchProvider {
            slug: "searxng".to_string(),
            enabled: true,
            endpoint: Some("https://search.acme.internal".to_string()),
        },
    )
    .await
    .unwrap();

    let providers = list_providers(&company(), &secrets).await.unwrap();
    assert_eq!(
        providers[0].endpoint.as_deref(),
        Some("https://search.acme.internal")
    );
}

#[tokio::test]
async fn an_unreadable_index_is_reported_rather_than_read_as_empty() {
    // Resolving a corrupt index to "no providers" would quietly move every agent
    // onto managed search and bill the platform for it.
    let secrets = MemSecrets::default();
    seed(&secrets, &[(PROVIDER_INDEX_KEY, "{not json")]).await;
    assert!(list_providers(&company(), &secrets).await.is_err());
}

/// A store that yields on every call, so concurrent callers genuinely interleave.
///
/// [`MemSecrets`] never awaits anything real, so two tasks driven by the same
/// runtime run one after the other and a read-modify-write race cannot be
/// observed through it. A port that yields is the honest stand-in for one that
/// talks to a database, and it is what makes the test below mean anything.
#[derive(Default)]
struct SlowSecrets {
    inner: MemSecrets,
}

#[async_trait::async_trait]
impl SecretStore for SlowSecrets {
    async fn get(&self, company: &CompanyId, key: &str) -> Result<Option<SecretValue>> {
        tokio::task::yield_now().await;
        self.inner.get(company, key).await
    }
    async fn set(&self, company: &CompanyId, key: &str, value: SecretValue) -> Result<()> {
        tokio::task::yield_now().await;
        self.inner.set(company, key, value).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_connects_do_not_overwrite_each_other_in_the_index() {
    // Every index mutation is list-modify-save, and the list is the whole list.
    // Interleave two of them and one edit is lost: both credentials are stored,
    // and only one of the two rows survives in the index — an orphaned secret at
    // an address nothing reads. `SecretStore` offers no compare-and-swap to fix
    // this with, so the mutations are serialised per company instead.
    //
    // Four slugs at once, against a port that yields on every call, so the
    // interleaving is real rather than theoretical.
    let secrets = std::sync::Arc::new(SlowSecrets::default());
    let slugs = ["brave", "exa", "querit", "searxng"];

    let mut tasks = Vec::new();
    for slug in slugs {
        let secrets = secrets.clone();
        tasks.push(tokio::spawn(async move {
            put_provider(
                &company(),
                secrets.as_ref(),
                SearchProvider {
                    slug: slug.to_string(),
                    enabled: true,
                    endpoint: None,
                },
            )
            .await
        }));
    }
    for task in tasks {
        task.await.expect("task").expect("put_provider");
    }

    let mut stored: Vec<String> = list_providers(&company(), secrets.as_ref())
        .await
        .expect("list")
        .into_iter()
        .map(|provider| provider.slug)
        .collect();
    stored.sort();
    let mut expected: Vec<String> = slugs.iter().map(|slug| slug.to_string()).collect();
    expected.sort();
    assert_eq!(
        stored, expected,
        "every connect must survive the others, not just the last one to write"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_concurrent_remove_does_not_resurrect_the_row_it_removed() {
    // The other direction of the same race: a toggle that read the index before
    // the remove wrote it will save its own copy back, complete with the row the
    // remove had just taken out.
    let secrets = std::sync::Arc::new(SlowSecrets::default());
    for slug in ["brave", "exa"] {
        put_provider(
            &company(),
            secrets.as_ref(),
            SearchProvider {
                slug: slug.to_string(),
                enabled: true,
                endpoint: None,
            },
        )
        .await
        .expect("seed");
    }

    let removing = {
        let secrets = secrets.clone();
        tokio::spawn(async move { delete_provider(&company(), secrets.as_ref(), "brave").await })
    };
    let toggling = {
        let secrets = secrets.clone();
        tokio::spawn(async move { set_enabled(&company(), secrets.as_ref(), "exa", false).await })
    };
    removing.await.expect("task").expect("delete");
    toggling.await.expect("task").expect("toggle");

    let stored = list_providers(&company(), secrets.as_ref()).await.expect("list");
    assert_eq!(stored.len(), 1, "brave must stay removed: {stored:?}");
    assert_eq!(stored[0].slug, "exa", "{stored:?}");
    assert!(!stored[0].enabled, "the toggle must survive too: {stored:?}");
}
