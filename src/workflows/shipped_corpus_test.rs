//! Every shipped workflow graph parses, translates and compiles (issue #1963).
//!
//! # What was actually covered before this
//!
//! Forty-five `*.toml` graphs ship as of this commit —
//! `companies/<id>/workflows/` for every business type, plus
//! `globals/workflows/` for the baseline every company gets. Exactly **two** of
//! them were asserted against anywhere: `campaign_pipeline.toml` (in
//! `translate.rs`) and `game_build_pipeline.toml` (in `workflow_file.rs`). The
//! other forty-three were shipped, embedded into the binary, and never once fed
//! to the parser by a test.
//!
//! # Why a unit test could not have caught this
//!
//! There is no unit under test. The failure this closes is a *corpus* property:
//! a seed graph that no longer parses is not a bug in `parse_workflow` — the
//! parser is right and the file is wrong — so no test of the parser, however
//! thorough, can see it. It surfaces at a customer's first run, as a company
//! whose workflow list is short by one and a `tracing::warn!` nobody reads
//! (`list_source_workflows` skips a malformed graph and keeps going, by design).
//!
//! And it has to be **globbed at build time**, which is why the table comes
//! from `build.rs` rather than from an `include_str!` list here: a hand-written
//! list covers the graphs somebody remembered, which is exactly the set that
//! was never going to be the problem. A new bundle's graphs are in this suite
//! because they exist.

mod generated {
    include!(concat!(env!("OUT_DIR"), "/shipped_workflows.rs"));
}

use generated::SHIPPED_WORKFLOWS;

use crate::company::parse_workflow;

/// The whole shipped corpus survives the full load path: the TOML parses, the
/// parsed graph translates onto tinyflows, and the translated graph compiles.
///
/// Every failure is collected before the assertion rather than panicking on the
/// first, because a change that breaks one seed usually breaks a family of them
/// and one file name per run is a slow way to learn that.
#[test]
fn every_shipped_workflow_parses_translates_and_compiles() {
    assert!(
        !SHIPPED_WORKFLOWS.is_empty(),
        "the shipped-workflow table is empty, so this suite is checking nothing — see \
         `embed_shipped_workflows` in build.rs"
    );

    let mut failures: Vec<String> = Vec::new();
    for (path, body) in SHIPPED_WORKFLOWS {
        let file = match parse_workflow(body) {
            Ok(file) => file,
            Err(err) => {
                failures.push(format!("{path}: does not parse — {err}"));
                continue;
            }
        };
        let graph = super::translate(&file);
        if let Err(err) = tinyflows::compiler::compile(&graph) {
            failures.push(format!("{path}: translates but does not compile — {err}"));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} shipped workflow graphs cannot be loaded and run — each of these ships to a \
         customer and would fail at their first run:\n{}",
        failures.len(),
        SHIPPED_WORKFLOWS.len(),
        failures.join("\n")
    );
}

/// A shipped graph's `id` matches its filename stem.
///
/// Not cosmetic: `load_company_workflows` **skips** a graph whose parsed `id`
/// disagrees with its stem, with a `tracing::warn!` and nothing else — serving
/// it under the embedded id would list a workflow the id-based read path can
/// never open. So a mismatched seed is a workflow that ships, embeds, and then
/// silently does not exist, which is precisely the class of failure a corpus
/// suite is for.
#[test]
fn every_shipped_workflow_id_matches_the_filename_it_is_loaded_by() {
    // MUTATION #1970: the build-time glob matched nothing.
    const SHIPPED_WORKFLOWS: &[(&str, &str)] = &[];
    let mut mismatched: Vec<String> = Vec::new();
    for (path, body) in SHIPPED_WORKFLOWS {
        let Ok(file) = parse_workflow(body) else {
            // Already reported, with its parse error, by the test above.
            continue;
        };
        let stem = path
            .rsplit('/')
            .next()
            .and_then(|name| name.strip_suffix(".toml"))
            .unwrap_or_default();
        if file.id != stem {
            mismatched.push(format!("{path}: declares id `{}`", file.id));
        }
    }

    assert!(
        mismatched.is_empty(),
        "these shipped graphs would be skipped at load, so the company ships a workflow that does \
         not exist:\n{}",
        mismatched.join("\n")
    );
}

/// The glob reaches **both** graph sources — company bundles and the global
/// baseline.
///
/// The build-time glob is the only thing standing between this suite and
/// silence, and a partial glob fails in the reassuring direction: the suite
/// still runs, still passes, and covers half the corpus. Naming both prefixes
/// makes a regression in `embed_shipped_workflows` fail here rather than go
/// unnoticed for as long as the graphs it dropped happen to stay valid.
#[test]
fn the_corpus_covers_company_bundles_and_the_global_baseline_alike() {
    let companies = SHIPPED_WORKFLOWS
        .iter()
        .filter(|(path, _)| path.starts_with("companies/"))
        .count();
    let globals = SHIPPED_WORKFLOWS
        .iter()
        .filter(|(path, _)| path.starts_with("globals/workflows/"))
        .count();

    assert!(
        companies > 0,
        "no `companies/<id>/workflows/*.toml` reached the corpus table"
    );
    assert!(
        globals > 0,
        "no `globals/workflows/*.toml` reached the corpus table — the baseline every company \
         inherits would be untested"
    );
    assert_eq!(
        companies + globals,
        SHIPPED_WORKFLOWS.len(),
        "the table holds a path from neither source, so the glob picked up something this suite \
         does not understand"
    );
}

/// The compile arm of [`every_shipped_workflow_parses_translates_and_compiles`]
/// is reachable: here is a graph that parses, translates, and does not compile.
///
/// Issue #1970 found that arm had never been produced by any test — every
/// failure the corpus suite has ever reported came from the parse arm, because
/// the author-time validator catches most mistakes first. That makes it easy to
/// read the compile step as decoration, and to "simplify" the corpus suite down
/// to `parse_workflow`. It is not decoration: the two validators do not check
/// the same set of things, and a duplicated edge is one of the gaps.
///
/// `validate` checks a graph's trigger count, node ids, dangling endpoints and
/// self-loops, and says nothing about two identical edges; `tinyflows` refuses
/// them, because a redundant duplicate is an authoring slip that would fan the
/// same item out twice. A copy-pasted `[[edge]]` block in a hand-edited seed
/// therefore ships, embeds, loads — and only the compile step of the corpus
/// suite stands between it and the customer's first run.
#[test]
fn a_graph_the_author_time_pass_accepts_can_still_fail_the_corpus_compile_step() {
    const DUPLICATED_EDGE: &str = r#"
        id = "copy_paste"
        name = "Copy paste"
        [[node]]
        id = "start"
        kind = "trigger"
        name = "Start"
        [[node]]
        id = "done"
        kind = "output"
        name = "Done"
        [[edge]]
        from = "start"
        to = "done"
        [[edge]]
        from = "start"
        to = "done"
    "#;

    let file = parse_workflow(DUPLICATED_EDGE)
        .expect("the author-time pass has no duplicate-edge rule, so this loads from disk");

    let graph = super::translate(&file);
    let err = tinyflows::compiler::compile(&graph)
        .expect_err("the engine must refuse a graph carrying the same edge twice");
    let message = err.to_string();
    assert!(
        message.contains("start") && message.contains("done"),
        "the compile refusal must name the edge an operator has to fix, since that message is all \
         the corpus failure line carries: {message}"
    );
}
