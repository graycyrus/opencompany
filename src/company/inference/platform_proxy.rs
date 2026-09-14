//! The managed endpoint: the TinyHumans backend's **direct OpenRouter proxy**.
//!
//! Managed inference used to address the curated `/openai/v1` surface, which
//! resolves tier names (`chat-v1`, …) against the platform's own registry. It
//! now addresses `/agent-integrations/openrouter` instead (issue #2303):
//!
//! * `GET {base}/models` — the chat catalog, **enveloped and paginated**:
//!   `{success, data: {object, data: [...], total, limit, offset}}`. Served from
//!   a cached snapshot, and `503` before that snapshot has loaded.
//! * `POST {base}/chat/completions` — OpenAI chat completions, passed through
//!   unenveloped. `model` must be a **bare OpenRouter slug**; a tier name is
//!   rejected.
//!
//! Both routes take the same `INFERENCE`-scoped key the curated surface took, so
//! the managed credential chain is unchanged. What changes is the base URL
//! ([`base_for`]), the catalog shape ([`parse_page`]), and the model a turn puts
//! on the wire — only ever one chosen explicitly (`super::proxied_model`).
//!
//! Nothing here performs I/O. The two callers that fetch the catalog —
//! `crate::server::inference_models::discover_models` and
//! `super::probe::probe_models` — keep their own clients, redirect guards and
//! error classification, and share only the URL and the parser, so the shape
//! cannot drift between them.

use std::collections::HashSet;

/// The proxy's path on the platform backend, relative to its origin.
pub const PATH: &str = "/agent-integrations/openrouter";

/// The page size a catalog read asks for.
///
/// The backend's `parseModelListQuery` clamps `limit` to `[1, 500]` and defaults
/// it to 100. Asking for the maximum keeps a ~450-model catalog to one request;
/// paging still follows `total`, so a clamp lower than this costs requests, not
/// models.
pub const PAGE_LIMIT: usize = 500;

/// The most pages one catalog read will follow.
///
/// A bound, not an expectation: 20 pages of 500 is 10,000 models against a
/// catalog of a few hundred. It exists so an endpoint reporting a `total` it
/// never reaches cannot hold a read in a loop until the timeout.
pub const MAX_PAGES: usize = 20;

/// The managed proxy base for a managed endpoint URL.
///
/// **The origin is kept; the path is replaced.** An environment pointed with
/// `OPENCOMPANY_INFERENCE_URL` at `https://staging-api.tinyhumans.ai/openai/v1`
/// — the curated surface every existing deployment names — resolves to
/// `https://staging-api.tinyhumans.ai/agent-integrations/openrouter`, so a
/// staging or self-hosted backend still wins over production and no deployment
/// has to change a variable.
///
/// A URL that **already ends in [`PATH`]** is taken as written, prefix and all:
/// that is an operator naming the proxy explicitly, including behind a gateway
/// that mounts the backend under a sub-path.
///
/// The origin never changes, and that is the credential property: the managed
/// credential reaches exactly the origin it reached before this function
/// existed, never another host. A value that does not parse as a URL is not
/// rewritten into one — it keeps its text with [`PATH`] appended, so the
/// endpoint guard refuses it and names it, rather than this silently
/// substituting production.
pub fn base_for(managed_url: &str) -> String {
    let trimmed = managed_url.trim().trim_end_matches('/');
    if trimmed.ends_with(PATH) {
        return trimmed.to_string();
    }
    match url::Url::parse(trimmed) {
        Ok(parsed) if parsed.has_host() => {
            format!("{}{PATH}", parsed.origin().ascii_serialization())
        }
        _ => format!("{trimmed}{PATH}"),
    }
}

/// The catalog URL for the page starting at `offset`, relative to the base.
pub fn page_path(offset: usize) -> String {
    format!("/models?limit={PAGE_LIMIT}&offset={offset}")
}

/// One model the proxy's catalog lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    /// The bare OpenRouter slug — what goes back as `model`.
    pub id: String,
    /// `display_name`, when published.
    pub name: Option<String>,
    /// `context_length`, when published.
    pub context_length: Option<u64>,
}

/// One parsed page of the catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogPage {
    /// The usable entries, in the order the page listed them.
    pub entries: Vec<CatalogEntry>,
    /// How many entries the page carried, usable or not. Paging advances by
    /// this, so a malformed entry cannot make the next page start inside this
    /// one.
    pub raw_len: usize,
    /// The number of matches across every page, when the envelope reports it.
    pub total: Option<usize>,
}

/// What a caller does after reading a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NextPage {
    /// Fetch the page at this offset.
    At(usize),
    /// The catalog is complete.
    Done,
    /// [`MAX_PAGES`] were read and `total` was still not reached. The caller
    /// keeps what it has and says so.
    Truncated {
        /// Entries read so far.
        read: usize,
        /// What the envelope said there were.
        total: usize,
    },
}

/// Parse one catalog page.
///
/// **The envelope is required.** A body in the plain OpenAI `{ "data": [...] }`
/// shape is an error here, not an empty page: the shape is chosen explicitly by
/// the caller (a proxied decl reads this shape), and an endpoint that answers
/// in the other one is not the proxy, which is a fact worth reporting rather
/// than a catalog worth guessing at.
///
/// `success: false` is a failure carrying the backend's own message. Entries
/// are read leniently, the same way the OpenAI parser reads them: a missing or
/// non-string `id` drops that entry, a malformed optional field drops only that
/// field.
pub fn parse_page(body: &str) -> Result<CatalogPage, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("the model catalog was not JSON: {error}"))?;
    if value.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("no reason given");
        return Err(format!("the model catalog reported a failure: {message}"));
    }
    let Some(data) = value.get("data").filter(|data| data.is_object()) else {
        return Err(
            "the model catalog was not in the platform proxy's `{success, data}` envelope"
                .to_string(),
        );
    };
    let Some(raw) = data.get("data").and_then(serde_json::Value::as_array) else {
        return Err("the model catalog envelope carried no `data` list".to_string());
    };
    let entries = raw
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            Some(CatalogEntry {
                id: id.to_string(),
                name: entry
                    .get("display_name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                context_length: entry
                    .get("context_length")
                    .and_then(serde_json::Value::as_u64),
            })
        })
        .collect();
    let total = data
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .and_then(|total| usize::try_from(total).ok());
    Ok(CatalogPage {
        entries,
        raw_len: raw.len(),
        total,
    })
}

/// Accumulates pages into one catalog, deduplicated by id in listing order.
#[derive(Debug, Default)]
pub struct Collector {
    seen: HashSet<String>,
    entries: Vec<CatalogEntry>,
    offset: usize,
    pages: usize,
}

impl Collector {
    /// The offset of the next page to request.
    pub fn offset(&self) -> usize {
        self.offset
    }

    /// Take in a page and say what to do next.
    ///
    /// Paging stops on an empty page (so a `total` the endpoint never reaches
    /// cannot loop), on reaching `total`, on an envelope with no `total` at all
    /// (one page is then the whole answer), and after [`MAX_PAGES`].
    pub fn push(&mut self, page: CatalogPage) -> NextPage {
        self.pages += 1;
        for entry in page.entries {
            if self.seen.insert(entry.id.clone()) {
                self.entries.push(entry);
            }
        }
        if page.raw_len == 0 {
            return NextPage::Done;
        }
        self.offset += page.raw_len;
        match page.total {
            Some(total) if self.offset < total && self.pages >= MAX_PAGES => NextPage::Truncated {
                read: self.offset,
                total,
            },
            Some(total) if self.offset < total => NextPage::At(self.offset),
            _ => NextPage::Done,
        }
    }

    /// Everything collected.
    pub fn finish(self) -> Vec<CatalogEntry> {
        self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the base URL ------------------------------------------------------

    #[test]
    fn the_curated_platform_url_moves_to_the_proxy_on_the_same_origin() {
        assert_eq!(
            base_for("https://api.tinyhumans.ai/openai/v1"),
            "https://api.tinyhumans.ai/agent-integrations/openrouter"
        );
        assert_eq!(
            base_for("https://api.tinyhumans.ai/openai/v1/"),
            "https://api.tinyhumans.ai/agent-integrations/openrouter"
        );
    }

    /// The staging override is the case this rule exists for: an environment
    /// variable nobody will edit keeps pointing its tenants at staging.
    #[test]
    fn a_staging_override_still_wins_over_production() {
        assert_eq!(
            base_for("https://staging-api.tinyhumans.ai/openai/v1"),
            "https://staging-api.tinyhumans.ai/agent-integrations/openrouter"
        );
    }

    #[test]
    fn a_port_and_a_bare_origin_are_kept() {
        assert_eq!(
            base_for("http://127.0.0.1:8099/v1"),
            "http://127.0.0.1:8099/agent-integrations/openrouter"
        );
        assert_eq!(
            base_for("http://127.0.0.1:8099"),
            "http://127.0.0.1:8099/agent-integrations/openrouter"
        );
    }

    #[test]
    fn a_url_that_already_names_the_proxy_is_taken_as_written() {
        assert_eq!(
            base_for("https://gateway.example/tinyhumans/agent-integrations/openrouter/"),
            "https://gateway.example/tinyhumans/agent-integrations/openrouter"
        );
    }

    /// The credential property, stated as one: whatever the managed URL was,
    /// the derived base is on the same origin, so the managed credential never
    /// reaches a host it did not reach before.
    #[test]
    fn derivation_never_changes_the_origin() {
        for input in [
            "https://api.tinyhumans.ai/openai/v1",
            "https://staging-api.tinyhumans.ai/openai/v1",
            "https://gateway.example/some/prefix/openai/v1",
            "http://127.0.0.1:6969/v1",
            "https://env.example",
        ] {
            let before = url::Url::parse(input).unwrap().origin();
            let after = url::Url::parse(&base_for(input)).unwrap().origin();
            assert_eq!(before, after, "{input}");
        }
    }

    #[test]
    fn an_unparsable_value_is_not_replaced_with_production() {
        let derived = base_for("not a url");
        assert!(!derived.contains("tinyhumans.ai"), "{derived}");
        assert!(derived.ends_with(PATH), "{derived}");
    }

    #[test]
    fn the_page_path_asks_for_the_maximum_page() {
        assert_eq!(page_path(0), "/models?limit=500&offset=0");
        assert_eq!(page_path(500), "/models?limit=500&offset=500");
    }

    // ---- the envelope ------------------------------------------------------

    #[test]
    fn a_page_is_unwrapped_from_the_envelope() {
        let page = parse_page(
            r#"{"success":true,"data":{"object":"list","data":[
                {"id":"openai/gpt-4o-mini","display_name":" GPT-4o mini ","context_length":128000,
                 "input_modalities":["text","image"],"supports_tools":true,"supports_thinking":false,
                 "pricing":{"input_per_1m":0.15,"output_per_1m":0.6}},
                {"id":"vendor/model-b"}
            ],"total":2,"limit":500,"offset":0}}"#,
        )
        .expect("a well-formed page parses");

        assert_eq!(page.raw_len, 2);
        assert_eq!(page.total, Some(2));
        assert_eq!(
            page.entries[0],
            CatalogEntry {
                id: "openai/gpt-4o-mini".into(),
                name: Some("GPT-4o mini".into()),
                context_length: Some(128_000),
            }
        );
        assert_eq!(page.entries[1].id, "vendor/model-b");
    }

    /// The other shape is not quietly read as an empty catalog.
    #[test]
    fn an_openai_shaped_body_is_not_the_proxy_catalog() {
        let error = parse_page(r#"{"data":[{"id":"chat-v1"}]}"#).unwrap_err();
        assert!(error.contains("envelope"), "{error}");
    }

    #[test]
    fn success_false_is_a_failure_carrying_the_backends_reason() {
        let error =
            parse_page(r#"{"success":false,"error":"The OpenRouter integration is not enabled"}"#)
                .unwrap_err();
        assert!(error.contains("not enabled"), "{error}");
    }

    #[test]
    fn a_malformed_entry_drops_itself_and_still_counts_toward_paging() {
        let page = parse_page(
            r#"{"success":true,"data":{"data":[
                {"id":"vendor/good"},{"id":42},{"id":"   "},
                {"id":"vendor/also-good","context_length":"wide","display_name":7}
            ],"total":4}}"#,
        )
        .unwrap();
        let ids: Vec<&str> = page.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["vendor/good", "vendor/also-good"]);
        assert_eq!(page.entries[1].context_length, None);
        assert_eq!(page.entries[1].name, None);
        assert_eq!(page.raw_len, 4, "paging advances past the bad entries too");
    }

    // ---- paging ------------------------------------------------------------

    fn page(ids: &[&str], total: Option<usize>) -> CatalogPage {
        CatalogPage {
            entries: ids
                .iter()
                .map(|id| CatalogEntry {
                    id: (*id).to_string(),
                    name: None,
                    context_length: None,
                })
                .collect(),
            raw_len: ids.len(),
            total,
        }
    }

    #[test]
    fn paging_follows_total_and_stops_there() {
        let mut collector = Collector::default();
        assert_eq!(collector.offset(), 0);
        assert_eq!(
            collector.push(page(&["a/1", "a/2"], Some(3))),
            NextPage::At(2)
        );
        assert_eq!(collector.push(page(&["a/3"], Some(3))), NextPage::Done);
        let ids: Vec<String> = collector.finish().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["a/1", "a/2", "a/3"]);
    }

    /// A backend that clamps `limit` below what was asked for still yields the
    /// whole catalog, because paging advances by what arrived.
    #[test]
    fn a_clamped_page_size_costs_requests_not_models() {
        let mut collector = Collector::default();
        assert_eq!(collector.push(page(&["a/1"], Some(2))), NextPage::At(1));
        assert_eq!(collector.push(page(&["a/2"], Some(2))), NextPage::Done);
        assert_eq!(collector.finish().len(), 2);
    }

    #[test]
    fn an_empty_page_ends_a_read_whose_total_is_never_reached() {
        let mut collector = Collector::default();
        assert_eq!(collector.push(page(&["a/1"], Some(900))), NextPage::At(1));
        assert_eq!(collector.push(page(&[], Some(900))), NextPage::Done);
    }

    #[test]
    fn a_page_with_no_total_is_the_whole_answer() {
        let mut collector = Collector::default();
        assert_eq!(collector.push(page(&["a/1"], None)), NextPage::Done);
    }

    #[test]
    fn duplicates_across_pages_are_kept_once() {
        let mut collector = Collector::default();
        collector.push(page(&["a/1", "a/2"], Some(4)));
        collector.push(page(&["a/2", "a/3"], Some(4)));
        let ids: Vec<String> = collector.finish().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["a/1", "a/2", "a/3"]);
    }

    #[test]
    fn the_page_bound_reports_truncation_instead_of_looping() {
        let mut collector = Collector::default();
        let mut last = NextPage::Done;
        for _ in 0..MAX_PAGES {
            last = collector.push(page(&["x/1"], Some(1_000_000)));
        }
        assert_eq!(
            last,
            NextPage::Truncated {
                read: MAX_PAGES,
                total: 1_000_000
            }
        );
    }
}
