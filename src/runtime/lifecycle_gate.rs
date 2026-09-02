//! The company lifecycle, mirrored where a synchronous caller can read it.
//!
//! `CompanyRecord::lifecycle` is the durable authority and
//! [`CompanyRuntime::ensure_running`](crate::company::runtime::CompanyRuntime::ensure_running)
//! reads it from the store. That read is `async`, and the two choke points
//! every entry point into new work already passes through are not both `async`
//! — [`RunSupervisor::begin`](crate::runtime::RunSupervisor::begin) holds a
//! lock and is deliberately synchronous. Without a synchronous answer the only
//! way to guard it is to ask each caller to remember an `await` before it, and
//! that is precisely how a company could be paused while its Run button still
//! started a billed run.
//!
//! So the durable value is mirrored here, in the same shape the emergency stop
//! already uses (a journal record plus an `AtomicBool` the policy gate reads,
//! `src/policy/gate.rs`): one writer — the transition that persisted it, or
//! boot hydration from the record it loaded — and any number of synchronous
//! readers.

use std::sync::{Arc, RwLock};

use crate::error::OpenCompanyError;

/// The lifecycle a company that is open for work is in.
pub const RUNNING: &str = "running";

/// A shared, synchronously readable mirror of `CompanyRecord::lifecycle`.
///
/// Cloning shares the value: the runtime and its [`RunSupervisor`] hold the
/// same gate, so a pause seen by one is seen by the other with no plumbing in
/// between.
#[derive(Clone, Debug)]
pub struct LifecycleGate {
    inner: Arc<RwLock<String>>,
}

impl Default for LifecycleGate {
    fn default() -> Self {
        Self::new(RUNNING)
    }
}

impl LifecycleGate {
    /// A gate holding `lifecycle`.
    pub fn new(lifecycle: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(lifecycle.into())),
        }
    }

    /// Records the lifecycle a transition just persisted, or that boot just
    /// loaded.
    ///
    /// Call it *after* the durable write, never before: a restart between the
    /// two comes up reading the record, and enforcement that started early
    /// would refuse work for a transition that never landed. Same ordering
    /// discipline as the emergency stop's `set_emergency`.
    pub fn set(&self, lifecycle: impl Into<String>) {
        let mut held = match self.inner.write() {
            Ok(held) => held,
            // A poisoned lock means a writer panicked mid-store. The value is a
            // single `String` written under one lock, so nothing can be torn;
            // recovering is strictly better than leaving the gate stuck on a
            // stale lifecycle, which would refuse work forever after a resume.
            Err(poisoned) => poisoned.into_inner(),
        };
        *held = lifecycle.into();
    }

    /// The mirrored lifecycle.
    pub fn current(&self) -> String {
        match self.inner.read() {
            Ok(held) => held.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// `Err(LifecycleConflict)` unless the company is open for work.
    ///
    /// Refuses every lifecycle that is not `running` rather than naming the
    /// ones it knows, matching `ensure_running`: a lifecycle added later is
    /// refused by default, which is the safe direction.
    pub fn ensure_running(&self) -> crate::Result<()> {
        let current = self.current();
        if current != RUNNING {
            return Err(OpenCompanyError::LifecycleConflict(current));
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_running_gate_admits_work() {
        assert!(LifecycleGate::default().ensure_running().is_ok());
    }

    #[test]
    fn every_lifecycle_but_running_is_refused() {
        for lifecycle in ["paused", "suspended", "archived", "something-new"] {
            let gate = LifecycleGate::new(lifecycle);
            let err = gate.ensure_running().expect_err(lifecycle);
            assert!(
                matches!(&err, OpenCompanyError::LifecycleConflict(l) if l == lifecycle),
                "{lifecycle}: {err}"
            );
        }
    }

    #[test]
    fn a_clone_sees_a_write_through_the_other_handle() {
        let gate = LifecycleGate::default();
        let shared = gate.clone();
        gate.set("paused");
        assert!(shared.ensure_running().is_err());
        shared.set(RUNNING);
        assert!(gate.ensure_running().is_ok());
    }
}
