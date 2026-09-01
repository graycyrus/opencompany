// Part 2 of `settle_arms_test`: driving one exit, and the single assertion
// every row of the table is evaluated by. Textually included by the parent,
// which owns the imports.

/// What one exit left behind: the run body (the partial one on the failure
/// exit) and the durable snapshot, if any.
struct Settled {
    run: WorkflowRun,
    stored: Option<crate::ports::WorkflowRunOutputRecord>,
}

/// Drives `exit` over [`settle_arms_graph`] and returns what it settled into.
async fn drive(exit: ExitUnderTest) -> Settled {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut deps, _journal) =
        super::gated_tool_turn_test::deps("http://127.0.0.1:1/unused".to_string(), dir.path());
    let store = Arc::new(FsOps::new(dir.path()));
    deps.run_output_store = Some(store.clone());
    let record = super::gated_tool_turn_test::record();

    let mut ctx = WorkflowRunContext::new(false);
    ctx.dry_run = exit == ExitUnderTest::DryRun;
    let run_id = ctx.run_id.clone();
    let cancel = ctx.cancel.clone();

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let tail = match exit {
        ExitUnderTest::GenuineFailure => TailBehaviour::Fail,
        ExitUnderTest::OnlyBlocked => TailBehaviour::Block {
            approvals: deps.approval_requests.clone(),
        },
        ExitUnderTest::HardAbort => TailBehaviour::Wedge {
            entered: entered.clone(),
        },
        ExitUnderTest::CleanCancel => TailBehaviour::HoldUntilReleased {
            entered: entered.clone(),
            release: release.clone(),
        },
        ExitUnderTest::DryRun | ExitUnderTest::Normal => TailBehaviour::Succeed,
    };
    let turn = Arc::new(SettleArmsTurn { tail });

    let graph = settle_arms_graph();
    let mut running = Box::pin(run_workflow_lane_aware(
        turn,
        deps,
        &record,
        &graph,
        serde_json::json!({ "request": "go" }),
        &ctx,
    ));

    // The two cancelling exits have to reach the tail node before the stop, or
    // they would be testing a cancel that arrived before the run started.
    let result = match exit {
        ExitUnderTest::HardAbort | ExitUnderTest::CleanCancel => {
            let reached = entered.notified();
            tokio::select! {
                _ = &mut running => panic!(
                    "the run settled before the tail node was reached, so this fixture drove \
                     some other exit than {exit:?}"
                ),
                () = reached => {}
            }
            cancel.cancel();
            // Clean cancel: release AFTER the token is flipped, so the turn
            // resolves into a wound-down engine. Hard abort: never released.
            if exit == ExitUnderTest::CleanCancel {
                release.notify_one();
            }
            tokio::time::timeout(HARD_ABORT_CEILING, running)
                .await
                .unwrap_or_else(|_| {
                    panic!("the stopped run never came back within {HARD_ABORT_CEILING:?}")
                })
        }
        _ => running.await,
    };

    let run = match result {
        Ok(run) => run,
        Err(err) => err
            .partial_run()
            .expect("a genuine failure carries the partial run it had already done")
            .clone(),
    };
    let stored = store
        .get_run_output(&record.id, &run_id)
        .await
        .expect("reading the durable snapshot back must not itself fail");
    Settled { run, stored }
}

/// The whole post-pass, asserted against one row of [`TABLE`].
async fn assert_settle_invariants(exit: ExitUnderTest) {
    let expected = row(exit);
    let settled = drive(exit).await;
    let run = &settled.run;

    assert_eq!(
        run.cancelled, expected.cancelled,
        "on the {exit:?} exit the run's own reading of whether an operator stopped it is wrong, \
         which is what decides whether it lands in the failure count: {:?}",
        run.nodes
    );

    match expected.capped {
        CappedReading::Reclassified => {
            assert_node_ran(run, "capped_work");
            assert_node_status(run, "capped_work", WorkflowNodeStatus::Error);
        }
        CappedReading::NoRowsAtAll => {
            assert!(
                run.nodes.is_empty(),
                "the {exit:?} exit reports no result, so it must carry no node rows — a row here \
                 means the exit grew a body and its post-pass expectations are now unstated: {:?}",
                run.nodes
            );
        }
        CappedReading::NothingCanBeCapped => {
            assert_node_ran(run, "capped_work");
            assert_node_status(run, "capped_work", WorkflowNodeStatus::Ok);
        }
    }

    match expected.tail_status {
        Some(status) => assert_node_status(run, "tail_work", status),
        None => assert_node_skipped(run, "done"),
    }

    match expected.persist {
        PersistedAs::NotCalled => assert!(
            settled.stored.is_none(),
            "the {exit:?} exit must persist no run-output snapshot at all, and one was written: \
             {:?}",
            settled.stored
        ),
        PersistedAs::Partial | PersistedAs::Complete => {
            let stored = settled.stored.as_ref().unwrap_or_else(|| {
                panic!(
                    "the {exit:?} exit must persist a run-output snapshot, and none was written — \
                     reopening this run from History would report that it predates output capture"
                )
            });
            let want_partial = expected.persist == PersistedAs::Partial;
            assert_eq!(
                stored.partial, want_partial,
                "the {exit:?} exit persisted its snapshot with partial = {}, but the flag must be \
                 true exactly when the engine returned no outcome.output — an operator reading \
                 this record cannot tell a whole run from a fragment: {stored:?}",
                stored.partial
            );
            assert_eq!(
                stored.workflow_id, "settle_arms",
                "the snapshot must name the workflow that produced it"
            );
        }
    }

    assert_eq!(
        !run.approvals.is_empty(),
        expected.keeps_approval_receipts,
        "the {exit:?} exit's handling of the approval receipts its nodes filed is wrong. A card \
         is durable the moment it is written, so an exit that drops the row leaves a card on the \
         operator's Approvals page that no run admits to opening: {:?}",
        run.approvals
    );
    assert_eq!(
        !run.blocked_nodes.is_empty(),
        expected.keeps_blocked_nodes,
        "the {exit:?} exit's reading of which nodes are waiting on a person is wrong: {:?}",
        run.blocked_nodes
    );
}
