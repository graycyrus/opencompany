//! The closed vocabulary of console views (issue #1739).
//!
//! The console tells the host which page an operator opened, and that string
//! arrives over HTTP from a client this crate does not control. It is therefore
//! folded onto a fixed list here before it can reach a payload — the same rule
//! every other textual property in this module follows, and for the same
//! reason: an unanticipated value is the one that leaks something.
//!
//! **The view, never the hash.** `#/chat/dm:ada-1f3k` and `#/tasks/<uuid>` name
//! a teammate and a task; `chat` and `tasks` name a page. Only the second half
//! is a fact about the product rather than about the company using it, so the
//! route's second segment is not accepted here at all — the caller sends the
//! view alone, and anything it sends that is not on this list becomes `other`.

/// Every routed console view, mirroring `frontend/src/lib/console-routes.ts`.
///
/// Kept in step by `a_console_view_matches_the_console_route_table`, which reads
/// the TypeScript rather than trusting this copy: a view added to the console
/// and missed here would silently report as `other`, which reads as "operators
/// do not use that page".
const VIEWS: &[&str] = &[
    "overview",
    "company",
    "chat",
    "conversation",
    "inbox",
    "tasks",
    "ledgers",
    "team",
    "workspace",
    "brain",
    "approvals",
    "workflows",
    "observatory",
    "pages",
    "finances",
    "settings",
    "feedback",
    "setup",
    "not-found",
];

/// The stable slug for a console view, or `other` for anything unrecognised.
///
/// Returns a `&'static str` from [`VIEWS`] rather than the caller's string, so
/// the value that reaches a payload is a literal compiled into this repository
/// even though the input arrived over the network.
pub fn console_view_slug(raw: &str) -> &'static str {
    let key = raw.trim().to_ascii_lowercase();
    VIEWS
        .iter()
        .find(|view| **view == key)
        .copied()
        .unwrap_or(crate::analytics::types::OTHER)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn every_known_view_keeps_its_own_name() {
        for view in VIEWS {
            assert_eq!(console_view_slug(view), *view);
        }
    }

    /// The point of the fold: what arrives is not what is reported.
    #[test]
    fn anything_else_becomes_other() {
        for raw in [
            "",
            "Overview ",
            "OVERVIEW",
            // The shapes that carry ids, and the reason the route takes a view
            // rather than a hash.
            "chat/dm:ada-1f3k",
            "tasks/9a8b3a85-85db-4efd-878a-efdeee0b0417",
            "#/settings/brain",
            "a page nobody has written yet",
        ] {
            let slug = console_view_slug(raw);
            if raw.trim().eq_ignore_ascii_case("overview") {
                assert_eq!(slug, "overview", "case and padding fold: {raw:?}");
                continue;
            }
            assert_eq!(slug, crate::analytics::types::OTHER, "{raw:?}");
        }
    }

    /// The returned value is always a literal from this file, never the input.
    ///
    /// A classifier that echoed its argument would pass the two tests above for
    /// every known view and leak on every unknown one, which is exactly the
    /// direction this module refuses to fail in.
    #[test]
    fn the_slug_is_never_the_callers_string() {
        let needle = "NotARealViewNameThatWouldLeak";
        let slug = console_view_slug(needle);
        assert!(
            !slug.contains("NotARealView"),
            "the classifier echoed its input: {slug}"
        );
        // The self-check: the needle really is findable when it is not folded,
        // so the assertion above is refusing something findable.
        assert!(needle.contains("NotARealView"));
    }
}
