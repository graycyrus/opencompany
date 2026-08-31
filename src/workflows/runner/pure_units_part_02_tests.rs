// ── issue #1963: direct units for artifact folding and the settle notices ───
//
// The second half of the `include!`d suite (see `pure_units_part_01_tests.rs`
// for why these live outside `runner.rs`).

/// One captured-artifact map, in the shape `RunArtifacts::take` hands the
/// settle path: node id -> array of artifact rows.
fn artifact_rows(node_id: &str) -> serde_json::Map<String, Value> {
    let mut rows = serde_json::Map::new();
    rows.insert(
        node_id.to_string(),
        serde_json::json!([{ "source": "spec.md", "title": "Spec" }]),
    );
    rows
}

/// Issue #1963: an artifact belongs to a node the engine reported nothing for.
///
/// This is the entire reason `merge_run_artifacts` exists beside
/// `merge_transcripts`, which deliberately refuses to invent a slot: a node that
/// wrote a file and *then* errored has real files and no engine output, and
/// dropping them would make the inspector show neither text nor files for a
/// node that produced one of them.
///
/// A driven run cannot isolate this: on every arm the artifact map arrives
/// alongside a `nodes` map the engine or the observer already populated, so the
/// create-the-slot branch is only ever taken incidentally.
#[test]
fn an_artifact_for_a_node_the_engine_never_reported_gets_its_own_empty_slot() {
    let merged = merge_run_artifacts(serde_json::json!({}), &artifact_rows("draft"));

    assert_eq!(
        merged["draft"]["items"],
        serde_json::json!([]),
        "an invented slot must truthfully show no reply text"
    );
    assert_eq!(
        merged["draft"]["artifacts"][0]["source"],
        serde_json::json!("spec.md"),
        "while still surfacing the file the node actually wrote"
    );
}

/// Issue #1963: folding artifacts never rewrites what the engine reported.
/// The merge is additive by construction — it inserts one `artifacts` key —
/// and a regression that replaced the slot instead would silently drop every
/// node's output on a run that captured a file.
#[test]
fn folding_artifacts_leaves_a_reported_nodes_items_untouched() {
    let engine = serde_json::json!({
        "draft": { "items": [{ "json": { "text": "the draft" } }] },
        "review": { "items": [] }
    });

    let merged = merge_run_artifacts(engine.clone(), &artifact_rows("draft"));

    assert_eq!(
        merged["draft"]["items"], engine["draft"]["items"],
        "the engine's own items are not this function's to rewrite"
    );
    assert!(
        merged["review"].get("artifacts").is_none(),
        "a node that wrote no file gets no artifacts key at all"
    );
}

/// Issue #1963: a `nodes` value of another shape must not swallow the
/// artifacts.
///
/// Two of the five settle sites hand in a value that can legitimately be
/// `Null` — the failure and blocked arms build theirs from the progress
/// observer's map, which is empty when the drain timed out. Returning the
/// non-object untouched (the stance `merge_transcripts` takes) would discard
/// every captured file on exactly the arms where the artifacts are the only
/// record left.
#[test]
fn a_non_object_nodes_value_is_replaced_rather_than_losing_the_artifacts() {
    let merged = merge_run_artifacts(Value::Null, &artifact_rows("draft"));

    assert_eq!(
        merged["draft"]["artifacts"][0]["title"],
        serde_json::json!("Spec"),
        "a null nodes map must not take the captured files down with it"
    );
}

/// Issue #1963: no captured artifact, no change — including for a value the
/// merge would otherwise have coerced into an object. Nearly every run captures
/// nothing, so this early return is the path almost all traffic takes.
#[test]
fn merging_no_artifacts_returns_the_nodes_map_exactly_as_it_arrived() {
    let empty = serde_json::Map::new();

    assert_eq!(
        merge_run_artifacts(Value::Null, &empty),
        Value::Null,
        "an empty capture must not coerce a null map into an object"
    );
    let engine = serde_json::json!({ "draft": { "items": [] } });
    assert_eq!(
        merge_run_artifacts(engine.clone(), &empty),
        engine,
        "nor touch a real one"
    );
}

/// Issue #1963: the envelope wrapper reaches through `outcome.output`'s own
/// `{ "run": …, "nodes": … }` shape — the third of the three shapes the five
/// settle sites pass, and the only one where the artifacts must be folded a
/// level down rather than at the top.
///
/// A shape mismatch here loses artifacts on the clean-finish arm alone, which
/// is the arm every ordinary run takes and the one whose tests assert about
/// node output rather than about files.
#[test]
fn the_envelope_folds_artifacts_into_the_engines_nodes_key_and_leaves_run_alone() {
    let output = serde_json::json!({
        "run": { "id": "run-1" },
        "nodes": { "draft": { "items": [{ "json": { "text": "the draft" } }] } }
    });

    let merged = merge_run_artifacts_envelope(output, &artifact_rows("draft"));

    assert_eq!(
        merged["run"]["id"],
        serde_json::json!("run-1"),
        "the envelope's sibling keys are not the merge's to touch"
    );
    assert_eq!(
        merged["nodes"]["draft"]["artifacts"][0]["source"],
        serde_json::json!("spec.md"),
        "the artifacts belong one level down, beside the node's items"
    );
    assert_eq!(
        merged["nodes"]["draft"]["items"][0]["json"]["text"],
        serde_json::json!("the draft"),
        "and the node's own output survives the fold"
    );
}

/// Issue #1963: an envelope with no `nodes` key at all still gets one. A graph
/// whose only node errored produces an envelope carrying `run` and nothing
/// else, and the file that node wrote before it failed is then the run's only
/// surviving product.
#[test]
fn an_envelope_with_no_nodes_key_gains_one_holding_the_artifacts() {
    let merged = merge_run_artifacts_envelope(
        serde_json::json!({ "run": { "id": "run-2" } }),
        &artifact_rows("draft"),
    );

    assert_eq!(
        merged["nodes"]["draft"]["items"],
        serde_json::json!([]),
        "the invented node slot still says the node produced no reply text"
    );
    assert_eq!(
        merged["nodes"]["draft"]["artifacts"][0]["title"],
        serde_json::json!("Spec")
    );
}

/// Issue #1963: a non-object `outcome.output` is wrapped in a fresh `nodes`
/// envelope rather than being merged into or returned bare — so the value the
/// run reports keeps the one shape every downstream reader parses.
#[test]
fn a_non_object_engine_output_is_wrapped_in_a_nodes_envelope() {
    let merged = merge_run_artifacts_envelope(Value::Null, &artifact_rows("draft"));

    assert!(
        merged.get("nodes").is_some(),
        "the result must still be an envelope: {merged}"
    );
    assert_eq!(
        merged["nodes"]["draft"]["artifacts"][0]["source"],
        serde_json::json!("spec.md")
    );
}

/// Issue #1963: with nothing captured the envelope is returned byte-identical,
/// non-object values included — the wrapper must not manufacture a `nodes` key
/// on the overwhelming majority of runs that wrote no file.
#[test]
fn an_envelope_with_no_artifacts_is_returned_exactly_as_it_arrived() {
    let empty = serde_json::Map::new();
    let output = serde_json::json!({ "run": { "id": "run-3" } });

    assert_eq!(
        merge_run_artifacts_envelope(output.clone(), &empty),
        output,
        "no capture, no envelope rewrite"
    );
    assert_eq!(
        merge_run_artifacts_envelope(Value::Null, &empty),
        Value::Null,
        "and a null output stays null rather than becoming an empty envelope"
    );
}

/// Issue #1963 (issue #1865's sentence half): the notice names the step and
/// says the run kept going, which is the fact that distinguishes it from a
/// stopped run's headline.
#[test]
fn the_errored_node_notice_names_the_step_and_says_the_run_continued_past_it() {
    let notice = errored_node_notice("summarize");

    assert!(
        notice.contains("\"summarize\""),
        "the operator must not have to open the canvas to find the red chip: \
         {notice}"
    );
    assert!(
        notice.contains("the run continued past it"),
        "a degraded run is not a stopped one, and the sentence has to say so: \
         {notice}"
    );
}

/// Issue #1963: the notice covers two causes — a genuinely errored capability
/// under `on_error = "continue"`, and an agent turn truncated at the iteration
/// cap — and the row carries no reason text to tell them apart (issue #371's
/// no-`String`-arm invariant). Claiming either one would be a guess printed to
/// an operator as fact.
///
/// A driven run reaches only one cause at a time, so nothing that starts from a
/// graph can notice the wording drifting toward whichever cause its fixture
/// happens to exercise.
#[test]
fn the_errored_node_notice_never_claims_which_of_its_two_causes_it_was() {
    let notice = errored_node_notice("summarize").to_lowercase();

    for guess in ["approval", "iteration", "cap", "budget", "timed out"] {
        assert!(
            !notice.contains(guess),
            "the row carries no reason, so the sentence must not name one \
             (\"{guess}\"): {notice}"
        );
    }
}

/// Issue #1963: the persist-failure notice tells the operator the run itself
/// survived. Without that sentence a lost inspector snapshot reads as a lost
/// run, and the operator re-runs work that already completed.
#[test]
fn the_persist_failure_notice_says_the_run_itself_was_unaffected() {
    let notice = run_output_persist_failed_notice();

    assert!(
        notice.contains("The run itself was unaffected"),
        "a lost snapshot must not read as a lost run: {notice}"
    );
    assert!(
        notice.contains("reopening it later"),
        "and it has to say when the operator will notice: {notice}"
    );
}

/// Issue #1963: a structural graph problem is the caller's, and reaches the
/// console as a 4xx rather than a harness fault — the distinction the whole of
/// `map_engine_error` exists to draw.
#[test]
fn a_validation_engine_error_maps_to_an_invalid_request() {
    let mapped = map_engine_error(tinyflows::error::EngineError::Validation(
        tinyflows::error::ValidationError::MissingTrigger,
    ));

    match mapped {
        OpenCompanyError::InvalidRequest(message) => assert!(
            message.contains("workflow graph is invalid") && message.contains("no trigger node"),
            "the operator needs the engine's own reason, not just the category: \
             {message}"
        ),
        other => {
            panic!("a validation failure is the author's to fix, not a harness fault: {other}")
        }
    }
}

/// Issue #1963: every other engine failure is a harness error. The match's
/// catch-all arm means a variant added to `EngineError` upstream lands here
/// silently, so this pins that each of the current ones does — including
/// `Input`, which the vendored engine documents as raised *before any node
/// runs* and which is therefore the most tempting to reclassify.
///
/// A driven run can only produce whichever variant its fixture provokes; the
/// mapping is a total function and is tested as one.
#[test]
fn every_non_validation_engine_error_maps_to_a_harness_error() {
    let cases = vec![
        tinyflows::error::EngineError::Capability("the tool refused".to_string()),
        tinyflows::error::EngineError::Unimplemented("subflows"),
        tinyflows::error::EngineError::LoopLimit {
            node: "retry".to_string(),
            limit: 5,
        },
    ];

    for err in cases {
        let described = err.to_string();
        match map_engine_error(err) {
            OpenCompanyError::Harness(message) => assert_eq!(
                message, described,
                "the engine's own wording must survive the mapping intact"
            ),
            other => panic!("\"{described}\" is a runtime failure, not a bad request: {other}"),
        }
    }
}
