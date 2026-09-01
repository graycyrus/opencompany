//! The builder's own contract (issue #1963).
//!
//! These are unit tests of a **test helper**, which is unusual and deliberate:
//! everything PR 2–4 of this effort asserts is written against graphs this
//! builder produces, so a builder that quietly emitted a shape the real
//! authoring path would refuse would make every one of those suites green
//! against a graph no operator could ever save. That failure is invisible from
//! inside those suites — they would all pass — so it has to be pinned here.

use super::*;
use crate::company::WORKFLOW_NODE_KINDS;

/// A graph naming every kind in
/// [`WORKFLOW_NODE_KINDS`](crate::company::WORKFLOW_NODE_KINDS) once, wired so
/// every node is reachable from the trigger.
fn every_kind() -> WorkflowBuilder {
    wf("every_kind")
        .display_name("Every kind")
        .description("One node of each kind the authoring contract accepts.")
        .owner_desk("engineering")
        .trigger("start")
        .named("Nightly")
        .agent("draft", "writer")
        .tool_call("fetch", "web_fetch")
        .http_request("call", "GET", "https://example.com/api")
        .condition("gate", "=item.ok")
        .switch("route", "=item.tier")
        .merge("join")
        .split_out("fan", "items")
        .transform("shape", &[("title", "=item.title")])
        .output_parser("parse")
        .sub_workflow("child", "other_workflow")
        .output("done")
        .edge("start", "draft")
        .edge("draft", "fetch")
        .edge("fetch", "call")
        .edge("call", "gate")
        .edge_labeled("gate", "route", "yes")
        .edge_labeled("gate", "join", "no")
        .edge_labeled("route", "fan", "premium")
        .edge_labeled("route", "join", "free")
        .edge("fan", "shape")
        .edge("shape", "parse")
        .edge("parse", "join")
        .edge("join", "child")
        .edge("child", "done")
}

/// Every kind the authoring contract accepts is buildable, and the built graph
/// carries exactly those kinds back.
///
/// The list is read from `WORKFLOW_NODE_KINDS` rather than written out, so a
/// thirteenth kind added to the contract fails here until the builder can make
/// one — which is the only thing that stops the builder from silently covering
/// eleven of twelve kinds forever.
#[test]
fn the_builder_can_make_every_node_kind_the_authoring_contract_accepts() {
    let file = every_kind().build();

    let built: Vec<&str> = file.nodes.iter().map(|n| n.kind.as_str()).collect();
    for kind in WORKFLOW_NODE_KINDS {
        assert!(
            built.contains(kind),
            "the builder cannot produce a `{kind}` node, so no test can exercise one: built \
             {built:?}"
        );
    }
    assert_eq!(
        file.nodes.len(),
        WORKFLOW_NODE_KINDS.len(),
        "the fixture should name each kind exactly once: {built:?}"
    );
}

/// The builder goes **through** `parse_workflow`, not around it.
///
/// The whole reason it renders TOML: a builder that assembled a `WorkflowFile`
/// by hand would happily hand back a graph with an edge to a node that does not
/// exist, and every suite built on it would be asserting against a graph the
/// loader would reject on disk. So an invalid graph must come back as the
/// parser's own refusal, in the parser's own words.
#[test]
fn a_graph_the_real_parser_refuses_comes_back_as_its_refusal_not_as_a_workflow() {
    let err = wf("dangling")
        .trigger("start")
        .output("done")
        .edge("start", "done")
        .edge("done", "nowhere")
        .try_build()
        .expect_err("an edge to a node that does not exist must not build");

    let message = err.to_string();
    assert!(
        message.contains("nowhere"),
        "the refusal must name the endpoint the author got wrong, exactly as the on-disk loader \
         would: {message}"
    );
}

/// Per-node policy lands on the **first-class** fields, never inside `config`.
///
/// `validate` rejects `on_error` / `retry` / `requires_approval` / `schedule` /
/// `destination` / `repeatable` / `postcondition` as `config` keys — they would
/// be silently shadowed by the first-class fields written after them. A builder
/// that took the easy route and stuffed them into `config` would therefore
/// produce a graph that does not parse at all; this pins that it does not, and
/// that each value survives the TOML round trip.
#[test]
fn node_policy_round_trips_as_first_class_fields_rather_than_config_keys() {
    let file = wf("policy")
        .trigger("start")
        .schedule("0 9 * * 1")
        .agent("draft", "writer")
        .summary("Write the brief.")
        .postcondition("field_present", Some("json.brief"))
        .tool_call("publish", "publish_artifact")
        .requires_approval()
        .repeatable(false)
        .on_error("route")
        .retry(3)
        .retry_backoff(250, "exponential")
        .output("recover")
        .output("done")
        .to_email("ops@example.com")
        .edge("start", "draft")
        .edge("draft", "publish")
        .edge("publish", "done")
        .edge_labeled("publish", "recover", "error")
        .build();

    let node = |id: &str| {
        file.nodes
            .iter()
            .find(|n| n.id == id)
            .unwrap_or_else(|| panic!("node `{id}` is in the built graph"))
    };

    assert_eq!(file.trigger_schedule(), Some("0 9 * * 1"));
    assert_eq!(
        node("draft")
            .postcondition
            .as_ref()
            .map(|p| p.require.as_str()),
        Some("field_present"),
        "an agent node's postcondition must survive as typed data"
    );
    let publish = node("publish");
    assert_eq!(publish.requires_approval, Some(true));
    assert_eq!(publish.repeatable, Some(false));
    assert_eq!(publish.on_error.as_deref(), Some("route"));
    let retry = publish
        .retry
        .as_ref()
        .expect("the retry policy round-trips");
    assert_eq!(
        (
            retry.max_attempts,
            retry.backoff_ms,
            retry.backoff.as_deref()
        ),
        (Some(3), Some(250), Some("exponential")),
        "all three retry fields must survive, not just the one set last"
    );
    assert_eq!(
        node("done").destination.as_ref().map(|d| d.kind.as_str()),
        Some("email"),
        "an output node's destination is host-side delivery data and must not be lost"
    );
}

/// An edge label survives the round trip **and becomes the engine port**.
///
/// The label is the only part of a graph whose meaning changes on the way into
/// the engine: `translate` maps a `condition`'s `yes`/`no` onto the `true`/
/// `false` ports and carries a `switch`'s case name verbatim. A builder whose
/// labels were dropped would still produce a parsing graph — and every
/// branch-routing test written on it would be exercising a single unbranched
/// path while reporting success.
#[test]
fn an_edge_label_reaches_the_engine_as_the_branch_port_it_names() {
    let file = every_kind().build();
    let graph = crate::workflows::translate(&file);

    let port = |from: &str, to: &str| {
        graph
            .edges
            .iter()
            .find(|e| e.from_node == from && e.to_node == to)
            .map(|e| e.from_port.clone())
            .unwrap_or_else(|| panic!("no edge `{from}` -> `{to}` in the translated graph"))
    };

    assert_eq!(port("gate", "route"), "true", "`yes` is the true branch");
    assert_eq!(port("gate", "join"), "false", "`no` is the false branch");
    assert_eq!(
        port("route", "fan"),
        "premium",
        "a switch case name is carried verbatim as the port"
    );
    assert_eq!(
        port("start", "draft"),
        "main",
        "an unlabeled edge stays on the default port"
    );

    tinyflows::compiler::compile(&graph).expect("a builder-made graph compiles for the engine");

    // The fourth mapping, which needs its own graph because it is the one port
    // that depends on a node FIELD as well as the label: an `error` edge only
    // becomes the engine's error port when its source is `on_error = "route"`.
    let routed = wf("routed")
        .trigger("start")
        .tool_call("fetch", "web_fetch")
        .on_error("route")
        .output("done")
        .output("recover")
        .edge("start", "fetch")
        .edge("fetch", "done")
        .edge_labeled("fetch", "recover", "error")
        .build();
    let routed = crate::workflows::translate(&routed);
    let error_port = routed
        .edges
        .iter()
        .find(|e| e.from_node == "fetch" && e.to_node == "recover")
        .map(|e| e.from_port.as_str());
    assert_eq!(
        error_port,
        Some("error"),
        "a routing node's recovery edge must reach the engine on the error port, or the failure          item is silently delivered to the happy path"
    );
    tinyflows::compiler::compile(&routed).expect("the routing graph compiles for the engine");
}

/// A builder-made graph passes the **strict** author-time pass, not merely the
/// lenient loader.
///
/// `parse_workflow` runs `validate` with `strict = false` (issue #682), so a
/// `condition` with no `field` or a `tool_call` with no `slug` still loads. If
/// the builder emitted those, `build()` would succeed and every graph in every
/// later suite would be a shape the console itself would refuse to save — a
/// corpus of tests passing against graphs no operator could author.
#[test]
fn a_builder_made_graph_is_one_the_console_would_also_accept() {
    let problems = every_kind().strict_problems();
    assert!(
        problems.is_empty(),
        "the builder must fill each kind's required config, or every suite built on it tests a \
         graph the author-time path rejects: {problems:?}"
    );
}

/// Every destination kind an `output` node may name survives the round trip.
///
/// Delivery runs host-side, after the engine returns, so a destination is not
/// engine config and cannot be validated by anything downstream of
/// `translate` — if the builder dropped it, a delivery suite would run against
/// graphs that ask for no delivery at all and pass by reporting nothing sent.
#[test]
fn an_output_nodes_destination_round_trips_for_every_kind_it_may_name() {
    let file = wf("fanout")
        .trigger("start")
        .output("to_admins")
        .to_owner()
        .output("to_person")
        .to_email("ops@example.com")
        .output("to_room")
        .to_channel("operator")
        .edge("start", "to_admins")
        .edge("start", "to_person")
        .edge("start", "to_room")
        .build();

    let destination = |id: &str| {
        file.nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.destination.as_ref())
            .map(|d| (d.kind.clone(), d.target.clone()))
            .unwrap_or_else(|| panic!("node `{id}` kept no destination"))
    };

    assert_eq!(destination("to_admins"), ("owner".to_string(), None));
    assert_eq!(
        destination("to_person"),
        ("email".to_string(), Some("ops@example.com".to_string()))
    );
    assert_eq!(
        destination("to_room"),
        ("channel".to_string(), Some("operator".to_string()))
    );

    assert!(
        file.has_output_destination(),
        "the graph must read as one that is trying to deliver somewhere"
    );
}

/// `strict_problems` runs the **strict** pass, and the lenient one is not a
/// weaker version of it — it is a different answer.
///
/// Issue #1970: `a_builder_made_graph_is_one_the_console_would_also_accept`
/// asserts only `problems.is_empty()`, which a **lenient** pass satisfies more
/// easily than a strict one, so flipping `validate_workflow(&self.raw, true)` to
/// `false` made that assertion weaker rather than redder and left the guard
/// every graph-based suite leans on standing in name only. This is the
/// discriminator: the graph below loads through `parse_workflow` — the lenient
/// read path a pre-#661 file still has to survive (issue #682) — and the console
/// would refuse to save it, so an empty problem list here can only mean the
/// strict pass never ran.
///
/// Both strict-only families are named, because they are enforced in different
/// places: per-kind required config (`workflow_file.rs`, issue #661) and the
/// `condition` branch label vocabulary.
#[test]
fn strict_problems_reports_what_only_the_strict_author_time_pass_refuses() {
    let graph = wf("pre_661")
        .trigger("start")
        // A condition with no branch expression, whose branch carries no
        // `yes`/`no` label. Both are strict-only refusals.
        .condition("gate", "")
        .output("done")
        .edge("start", "gate")
        .edge("gate", "done");

    graph.try_build().expect(
        "the lenient read path must still load this, or the graph proves nothing about which pass \
         ran",
    );

    let problems = graph.strict_problems();
    assert!(
        problems.iter().any(|p| p.contains("config.field")),
        "the strict pass must report a `condition` with no `config.field` (issue #661); a lenient \
         pass reports nothing at all, which is why an `is_empty()` assertion cannot tell them \
         apart: {problems:?}"
    );
    assert!(
        problems
            .iter()
            .any(|p| p.contains("must be labeled `yes` or `no`")),
        "the strict pass must report a condition branch that names no port — the label rule is \
         the other half of what the console refuses and the loader accepts: {problems:?}"
    );
}

/// Every node keeps a display name, and so does the workflow.
///
/// Issue #1970: nothing asserted `RawNode::name` or `RawWorkflow::name`, so a
/// builder that emitted an empty name for every node was invisible — such a
/// graph still parses, still translates, still compiles, and every suite built
/// on it stays green. The name is what the console lists and what an operator
/// reads on a run card, so a corpus of nameless nodes is a corpus of graphs no
/// operator could tell apart.
#[test]
fn a_node_and_the_workflow_both_keep_the_display_name_the_builder_gave_them() {
    let file = every_kind().build();
    let named = |id: &str| {
        file.nodes
            .iter()
            .find(|n| n.id == id)
            .unwrap_or_else(|| panic!("node `{id}` is in the built graph"))
            .name
            .as_str()
    };

    assert_eq!(
        file.name, "Every kind",
        "`display_name` must reach the parsed graph — it is the title the console lists"
    );
    assert_eq!(
        named("start"),
        "Nightly",
        "`named` must override the default rather than being dropped on the way through TOML"
    );
    assert_eq!(
        named("draft"),
        "draft",
        "a node given no explicit name is named after its id, never left blank"
    );

    let default = wf("unnamed")
        .trigger("start")
        .output("done")
        .edge("start", "done")
        .build();
    assert_eq!(
        default.name, "unnamed",
        "a workflow given no `display_name` is named after its id, so no builder-made graph is \
         ever anonymous"
    );
}
