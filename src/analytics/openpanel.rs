//! The OpenPanel transport, and the one function that chooses a tracker.
//!
//! [`build`] is compiled into **every** build; `HttpOpenPanelTracker` is
//! compiled only under `--features analytics`. That split is the acceptance
//! criterion of issue #1739 expressed as a type rather than as a rule: in a
//! default build there is no type here that owns an HTTP client, so "a build
//! with no opt-in emits zero outbound analytics requests" is not a behaviour
//! that could regress — the code that would make the request is not in the
//! binary.
//!
//! Under the feature, [`build`] still returns [`NullTracker`] for every
//! [`Decision::Silent`], which is what a desktop or self-hosted install resolves
//! to. `a_self_hosted_build_makes_no_request` proves that against a real local
//! collector, and `a_hosted_tenant_reports` is its positive control — without
//! the second, a zero request count would be indistinguishable from a test that
//! never sends anything at all.
//!
//! # What is here, and what is deliberately not
//!
//! Everything about *what* an event says lives in [`crate::analytics::payload`],
//! [`Envelope`] and [`Event`], which are un-gated and tested in every lane. This
//! file owns only the HTTP call: how the body is delivered, how the credential
//! is presented, and what happens when the collector does not answer. Keeping
//! that line where it is is why a content leak would be caught by the default
//! `cargo test` rather than only by the one lane that compiles `reqwest`.
//!
//! # One request per event
//!
//! **OpenPanel has no batch endpoint.** `POST /track` takes a single
//! discriminated-union object; there is no array body and no `/batch` route, so
//! the batching this module used to do has nowhere to go. See [`Inner::drain`]
//! for what replaced it and why the queue survived the batch.

use std::sync::Arc;

use crate::analytics::config::Decision;
use crate::analytics::{Envelope, NullTracker, Tracker};

/// Chooses the tracker this process will use.
///
/// The whole of the "hosted tenants only, by default" decision lands here: a
/// [`Decision::Silent`] gets a [`NullTracker`], and in a build without the
/// `analytics` feature *every* decision does, because there is nothing else to
/// return.
pub fn build(decision: &Decision, envelope: Envelope) -> Arc<dyn Tracker> {
    match decision {
        Decision::Silent(_) => Arc::new(NullTracker),
        #[cfg(feature = "analytics")]
        Decision::Report {
            endpoint,
            credentials,
        } => Arc::new(http::HttpOpenPanelTracker::new(
            endpoint,
            credentials,
            envelope,
        )),
        // Without the feature there is no transport to hand back. Reporting was
        // configured and the build cannot honour it, which is worth one line at
        // boot: silently ignoring an explicit `OPENCOMPANY_ANALYTICS=on` is the
        // kind of quiet no-op an operator debugs for an hour.
        #[cfg(not(feature = "analytics"))]
        Decision::Report { .. } => {
            let _ = envelope;
            tracing::info!(
                "[analytics] reporting is configured but this build was compiled without \
                 the `analytics` feature, so nothing is sent"
            );
            Arc::new(NullTracker)
        }
    }
}

#[cfg(feature = "analytics")]
pub use http::HttpOpenPanelTracker;

/// The header OpenPanel takes the client id in.
///
/// Named here rather than inline because the gated tests assert the exact
/// spelling: a header the collector does not recognise is a 401 behind a
/// `debug!`, which is the silent failure this whole module is built around.
#[cfg(feature = "analytics")]
pub const CLIENT_ID_HEADER: &str = "openpanel-client-id";

/// The header OpenPanel takes the client secret in.
#[cfg(feature = "analytics")]
pub const CLIENT_SECRET_HEADER: &str = "openpanel-client-secret";

/// Names this client on the operator's own collector.
///
/// OpenPanel stores `openpanel-sdk-name` / `openpanel-sdk-version` on the event,
/// which is how an operator running one collector for several things tells this
/// traffic apart from a browser SDK's. It costs one header and answers "what is
/// writing to my project?" without anyone having to ask us.
#[cfg(feature = "analytics")]
pub const SDK_NAME_HEADER: &str = "openpanel-sdk-name";

/// The version half of the pair above.
#[cfg(feature = "analytics")]
pub const SDK_VERSION_HEADER: &str = "openpanel-sdk-version";

/// The value sent as [`SDK_NAME_HEADER`].
#[cfg(feature = "analytics")]
pub const SDK_NAME: &str = "opencompany";

/// **Event names OpenPanel refuses outright.**
///
/// `packages/constants/index.ts`, read at commit
/// `3060ca10213693cf0385be2713c8743d16733a2b`. A `track` whose `payload.name` is
/// one of these fails the collector's own zod refinement and comes back 400.
///
/// Copied here rather than merely known, because the failure it guards is the
/// one this module is least able to notice: a rejected event is a `debug!` line
/// and nothing else, so a name collision introduced years from now would look
/// exactly like a healthy instance that happens to report one fewer event. The
/// test below is a compile-time-vocabulary check against a runtime constant, and
/// it costs nothing to keep.
///
/// It is not the whole of OpenPanel's name validation — `event-blocklist.ts`
/// also rejects names over 80 characters, names containing a newline, names
/// beginning `/`, and a long anti-abuse substring list (`${`, `%{`, `../`,
/// `union select`, …). Those are asserted alongside it rather than transcribed:
/// transcribing a fifty-entry blocklist is how a copy goes stale.
pub const OPENPANEL_RESERVED_EVENT_NAMES: [&str; 2] = ["session_start", "session_end"];

#[cfg(feature = "analytics")]
mod http {
    use std::sync::{Arc, Mutex, Weak};
    use std::time::Duration;

    use async_trait::async_trait;

    use crate::analytics::config::ClientCredentials;
    use crate::analytics::{Envelope, Event, Tracker, payload};

    /// How often the background task drains the queue.
    ///
    /// A threshold alone is not enough: a quiet instance would hold its events
    /// until the next one arrived, which on a company that ran two turns and
    /// stopped is forever.
    const FLUSH_INTERVAL: Duration = Duration::from_secs(30);

    /// The most events held before the oldest are dropped.
    ///
    /// Analytics must never be able to grow without bound inside a tenant
    /// container. If the collector is unreachable for long enough to fill this,
    /// the right outcome is losing telemetry, not the process.
    const MAX_QUEUED: usize = 500;

    /// How long a send may take before it is abandoned. Short on purpose:
    /// nothing waits on this, but a request that never completes is a task that
    /// never ends.
    const SEND_TIMEOUT: Duration = Duration::from_secs(5);

    /// Queues events and POSTs them to OpenPanel, one request each.
    pub struct HttpOpenPanelTracker {
        inner: Arc<Inner>,
    }

    struct Inner {
        /// Carries the two credential headers as **default headers**, set once
        /// at construction and marked sensitive.
        ///
        /// This is the whole of the credential handling, and it is the part of
        /// the change worth reading twice. Mixpanel wanted its token stamped
        /// into every event's property bag, so the transport had to reach into
        /// a rendered payload and mutate it — which meant a captured body, a
        /// recorded event or a test fixture could carry the credential, and the
        /// only thing stopping it was that nothing did. OpenPanel authenticates
        /// with request headers, so the credential is set once, here, and never
        /// touches the body builder at all. There is no longer a code path that
        /// could put it in a payload.
        ///
        /// `HeaderValue::set_sensitive` on both, which keeps them out of
        /// `HeaderValue`'s own `Debug` and out of HPACK's shared table on
        /// HTTP/2.
        client: reqwest::Client,
        endpoint: String,
        /// Behind a lock because its cognition labels are re-read after boot
        /// — see [`Envelope::set_cognition`]. Only ever held to render one
        /// payload or to relabel, never across an await.
        envelope: std::sync::RwLock<Envelope>,
        queue: Mutex<Vec<serde_json::Value>>,
        /// Held for the whole of one `drain`, take **and** requests.
        ///
        /// Without it, the shutdown flush and the 30-second drain could
        /// overlap: the drain takes the entire queue and awaits its POSTs, the
        /// flush finds an empty queue, returns at once, and process exit
        /// cancels the requests still in flight. That loses events exactly when
        /// the collector is slow — the one case the graceful flush exists for.
        /// An **async** mutex because it is held across an await; the `queue`
        /// lock below stays a `std::sync` one and is never held across one.
        sending: tokio::sync::Mutex<()>,
        stop: tokio::sync::Notify,
        /// Whether the collector has already told us the credential is no good.
        ///
        /// A `401` is not a failure like the others. Every other thing that can
        /// go wrong here is transient — a collector restarting, a network
        /// blip — and deserves the `debug!` that #1739 settled on, because it
        /// resolves itself and a `warn!` per event would be a log flood for a
        /// problem nobody needs to act on. A refused credential resolves itself
        /// never: every event for the rest of the process's life is dropped, the
        /// boot line said "reporting to …", and the only trace is a `debug!` no
        /// operator has enabled. That is the exact failure this module exists to
        /// make impossible, arriving one layer below where the boot line can see
        /// it.
        ///
        /// So it is a `warn!`, and it is said **once**: the condition is
        /// permanent, so repeating it adds nothing and would drown the log of a
        /// busy tenant.
        credential_refused: std::sync::atomic::AtomicBool,
    }

    impl HttpOpenPanelTracker {
        /// Builds a tracker and starts its drain loop.
        ///
        /// The credential is validated for header-safety in
        /// [`crate::analytics::config::resolve`], which is why the two
        /// `from_str` calls here can fall back rather than fail: by the time a
        /// [`Decision::Report`](crate::analytics::config::Decision::Report)
        /// exists, both halves are printable ASCII with no space, which is a
        /// strict subset of what `HeaderValue` takes. The fallback is an empty
        /// header value, which the collector refuses with a 401 — a loud,
        /// bounded outcome rather than a panic at boot, for a branch that is
        /// unreachable given the check upstream.
        pub fn new(endpoint: &str, credentials: &ClientCredentials, envelope: Envelope) -> Self {
            let inner = Arc::new(Inner {
                client: reqwest::Client::builder()
                    .timeout(SEND_TIMEOUT)
                    .default_headers(request_headers(credentials))
                    .build()
                    .unwrap_or_default(),
                endpoint: endpoint.to_string(),
                envelope: std::sync::RwLock::new(envelope),
                queue: Mutex::new(Vec::new()),
                sending: tokio::sync::Mutex::new(()),
                stop: tokio::sync::Notify::new(),
                credential_refused: std::sync::atomic::AtomicBool::new(false),
            });

            // A `Weak` so the loop cannot keep the tracker alive, and
            // `try_current` so constructing one outside a runtime is a
            // flush-only tracker rather than a panic. Neither is theoretical:
            // the drop path is how a rebuilt runtime retires its tracker, and a
            // synchronous test constructs one with no reactor.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let weak = Arc::downgrade(&inner);
                handle.spawn(async move { drain_loop(weak).await });
            }

            Self { inner }
        }
    }

    /// Every header this client sends on every request: the two credential
    /// halves, marked sensitive, and the two that name the client.
    pub(super) fn request_headers(credentials: &ClientCredentials) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

        let sensitive = |raw: &str| {
            let mut value =
                HeaderValue::from_str(raw).unwrap_or_else(|_| HeaderValue::from_static(""));
            value.set_sensitive(true);
            value
        };

        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(super::CLIENT_ID_HEADER),
            sensitive(credentials.expose_id()),
        );
        headers.insert(
            HeaderName::from_static(super::CLIENT_SECRET_HEADER),
            sensitive(credentials.expose_secret()),
        );
        // Compile-time constants, both. They name this client on a collector the
        // operator may be pointing several things at.
        headers.insert(
            HeaderName::from_static(super::SDK_NAME_HEADER),
            HeaderValue::from_static(super::SDK_NAME),
        );
        if let Ok(version) = HeaderValue::from_str(env!("CARGO_PKG_VERSION")) {
            headers.insert(HeaderName::from_static(super::SDK_VERSION_HEADER), version);
        }
        headers
    }

    impl Drop for HttpOpenPanelTracker {
        fn drop(&mut self) {
            self.inner.stop.notify_waiters();
        }
    }

    impl std::fmt::Debug for HttpOpenPanelTracker {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // No endpoint and certainly no credential: this type holds one, and
            // a `{:?}` in a log line is exactly how one escapes.
            f.write_str("HttpOpenPanelTracker")
        }
    }

    async fn drain_loop(weak: Weak<Inner>) {
        loop {
            let Some(inner) = weak.upgrade() else { return };
            let stopped = {
                let stop = &inner.stop;
                tokio::select! {
                    _ = stop.notified() => true,
                    _ = tokio::time::sleep(FLUSH_INTERVAL) => false,
                }
            };
            inner.drain().await;
            if stopped {
                return;
            }
        }
    }

    /// The one rendering of a transport failure this module is allowed to log.
    ///
    /// `reqwest::Error` keeps the request URL and prints it — `… for url (…)` —
    /// and that URL is `OPENCOMPANY_ANALYTICS_ENDPOINT`. A self-hosted collector
    /// is routinely reached through an authenticated proxy, and that is
    /// precisely where the proxy's key lives: in userinfo
    /// (`https://user:key@host/track`) or in the query string (`?key=…`). So a
    /// collector that merely goes unreachable wrote the operator's credential
    /// into container logs, on a path the boot line's redaction never touched
    /// and the `ClientCredentials` redaction guards different strings from
    /// entirely.
    ///
    /// `without_url` **removes** the URL rather than rewriting it, which is why
    /// this is not a second redaction surface to keep in step with
    /// `boot::loggable_endpoint`. There is nothing here to diverge: the error
    /// carries no URL at all, and the destination on the same log line comes
    /// from that one helper, so the transport learns about a new place a URL can
    /// hold a secret at the same moment the boot line does.
    pub(super) fn loggable_send_error(error: reqwest::Error) -> String {
        error.without_url().to_string()
    }

    impl Inner {
        /// Takes everything queued and posts it, **one request per event**.
        /// Every failure is swallowed after one debug line: a dead collector is
        /// a no-op, per #1739's constraints.
        ///
        /// Serialized: a caller entering while another drain is in flight waits
        /// for it and then takes whatever has arrived since. That is what makes
        /// [`Tracker::flush`] a real guarantee rather than a queue inspection —
        /// see [`Inner::sending`].
        ///
        /// # Why the queue survived the loss of batching
        ///
        /// The obvious reading of "OpenPanel has no batch endpoint" is to drop
        /// the queue and fire a request from `track` itself. That is the wrong
        /// trade twice over. `track` is called from the cycle bracket and the
        /// usage meter, both on a turn's hot path, and it is **synchronous and
        /// infallible** by contract — it cannot await, so firing from it means
        /// spawning a task per event, which is unbounded concurrency against a
        /// collector the process does not control, with no back-pressure and no
        /// ceiling on memory. The queue is what bounds both: at most
        /// [`MAX_QUEUED`] events exist at once, and at most one drain runs at a
        /// time.
        ///
        /// # The unreachable collector, and why the drain gives up early
        ///
        /// Each request has its own [`SEND_TIMEOUT`]. Sequentially, a full
        /// queue against a black-holing collector would be
        /// `500 × 5s` — over forty minutes of a task doing nothing but proving
        /// the same thing five hundred times, and forty minutes in which the
        /// shutdown flush would block behind [`Inner::sending`] until its own
        /// budget cut it off. So a **transport** error abandons the rest of the
        /// drain: the collector is down, the remaining events are going
        /// nowhere, and the next interval will try again with whatever has
        /// accumulated since. They are dropped rather than requeued, because
        /// requeuing an unbounded backlog is how a bounded queue stops being
        /// bounded.
        ///
        /// An **HTTP status** failure does not abandon it. That is a per-event
        /// answer — a rejected event name, a payload the collector will not
        /// accept — and the events behind it may well be fine. Treating the two
        /// alike would let one malformed event silence a whole drain.
        async fn drain(&self) {
            let _sending = self.sending.lock().await;
            let events = {
                let mut queue = self.queue.lock().expect("analytics queue");
                if queue.is_empty() {
                    return;
                }
                std::mem::take(&mut *queue)
            };

            let total = events.len();
            for (sent, event) in events.into_iter().enumerate() {
                match self.client.post(&self.endpoint).json(&event).send().await {
                    Ok(response) if response.status().is_success() => {}
                    Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                        self.report_refused_credential();
                    }
                    Ok(response) => tracing::debug!(
                        status = %response.status(),
                        "[analytics] the collector refused an event; dropping it"
                    ),
                    Err(error) => {
                        tracing::debug!(
                            endpoint = %crate::analytics::boot::loggable_endpoint(&self.endpoint),
                            error = %loggable_send_error(error),
                            dropped = total - sent,
                            "[analytics] could not reach the collector; dropping the rest \
                             of this drain"
                        );
                        return;
                    }
                }
            }
        }

        /// Says once, out loud, that the collector will not accept this
        /// process's credential. Never quotes it.
        fn report_refused_credential(&self) {
            use std::sync::atomic::Ordering;
            if self.credential_refused.swap(true, Ordering::Relaxed) {
                return;
            }
            tracing::warn!(
                endpoint = %crate::analytics::boot::loggable_endpoint(&self.endpoint),
                "[analytics] the collector refused this instance's credential (401). \
                 Every event will be dropped until OPENCOMPANY_ANALYTICS_CLIENT_ID and \
                 OPENCOMPANY_ANALYTICS_CLIENT_SECRET name a write client on that \
                 collector. Note that OpenPanel requires the client id to be a UUIDv4."
            );
        }
    }

    #[async_trait]
    impl Tracker for HttpOpenPanelTracker {
        fn track(&self, event: Event) {
            let body = {
                let envelope = self.inner.envelope.read().expect("analytics envelope");
                payload(&envelope, &event)
            };
            let mut queue = self.inner.queue.lock().expect("analytics queue");
            if queue.len() >= MAX_QUEUED {
                queue.remove(0);
            }
            queue.push(body);
        }

        async fn flush(&self) {
            // Waits on any in-flight periodic drain before taking what is left,
            // so a shutdown overlapping the 30-second loop does not return while
            // the previous drain is still on the wire.
            self.inner.drain().await;
        }

        fn observe_cognition(&self, cognition: crate::ports::brain::Cognition) {
            self.inner
                .envelope
                .write()
                .expect("analytics envelope")
                .set_cognition(cognition);
        }
    }
}

#[cfg(all(test, feature = "analytics"))]
mod test {
    use super::*;
    use crate::analytics::config::{
        CLIENT_ID_ENV, CLIENT_SECRET_ENV, ENABLE_ENV, ENDPOINT_ENV, resolve,
    };
    use crate::analytics::types::OpaqueId;
    use crate::analytics::{Event, Outcome, Trigger};
    use crate::app::config::MapEnv;
    use crate::app::deployment::{DEPLOYMENT_ENV, Deployment};
    use crate::ports::brain::Cognition;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// Obviously-fake credentials. Never a real one, in a file or anywhere else.
    const TEST_CLIENT_ID: &str = "not-a-real-client-id";
    const TEST_CLIENT_SECRET: &str = "not-a-real-client-secret";

    /// The headers each request arrived with, in order, name and value.
    type SeenHeaders = Arc<std::sync::Mutex<Vec<Vec<(String, String)>>>>;

    /// A local collector that counts what it is sent and keeps the bodies and
    /// the headers.
    struct Collector {
        hits: Arc<AtomicUsize>,
        bodies: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        headers: SeenHeaders,
        url: String,
        shutdown: tokio::sync::oneshot::Sender<()>,
        handle: tokio::task::JoinHandle<()>,
    }

    async fn spawn_collector() -> Collector {
        spawn_collector_with(Duration::ZERO, 0).await
    }

    /// A collector that takes `delay` to answer and refuses the first
    /// `refuse_first` requests with a 400, so a test can observe both what
    /// happens while a request is in flight and what happens after one event is
    /// rejected.
    async fn spawn_collector_with(delay: Duration, refuse_first: usize) -> Collector {
        let hits = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let headers = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_hits = hits.clone();
        let seen_bodies = bodies.clone();
        let seen_headers = headers.clone();

        let app = axum::Router::new().route(
            "/track",
            axum::routing::post(
                move |received: axum::http::HeaderMap,
                      axum::Json(body): axum::Json<serde_json::Value>| {
                    let hits = seen_hits.clone();
                    let bodies = seen_bodies.clone();
                    let headers = seen_headers.clone();
                    async move {
                        if !delay.is_zero() {
                            tokio::time::sleep(delay).await;
                        }
                        let seen = hits.fetch_add(1, Ordering::SeqCst);
                        bodies.lock().unwrap().push(body);
                        headers.lock().unwrap().push(
                            received
                                .iter()
                                .map(|(name, value)| {
                                    (
                                        name.as_str().to_string(),
                                        value.to_str().unwrap_or_default().to_string(),
                                    )
                                })
                                .collect(),
                        );
                        if seen < refuse_first {
                            axum::http::StatusCode::BAD_REQUEST
                        } else {
                            axum::http::StatusCode::OK
                        }
                    }
                },
            ),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/track", listener.local_addr().unwrap());
        let (shutdown, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });

        Collector {
            hits,
            bodies,
            headers,
            url,
            shutdown,
            handle,
        }
    }

    impl Collector {
        async fn stop(self) {
            let _ = self.shutdown.send(());
            let _ = self.handle.await;
        }

        fn header(&self, request: usize, name: &str) -> Option<String> {
            self.headers.lock().unwrap()[request]
                .iter()
                .find(|(seen, _)| seen == name)
                .map(|(_, value)| value.clone())
        }
    }

    fn envelope() -> Envelope {
        Envelope::new(
            OpaqueId::instance("0123456789abcdef0123456789abcdef"),
            Deployment::HostedTenant,
            Cognition::default(),
        )
    }

    /// A reporting environment pointed at `endpoint`, which `pairs` overrides.
    fn env(endpoint: &str, pairs: &[(&str, &str)]) -> MapEnv {
        let mut all = vec![
            (CLIENT_ID_ENV, TEST_CLIENT_ID),
            (CLIENT_SECRET_ENV, TEST_CLIENT_SECRET),
            (ENDPOINT_ENV, endpoint),
        ];
        all.extend_from_slice(pairs);
        MapEnv::new(all)
    }

    fn events() -> Vec<Event> {
        vec![
            Event::InstanceStarted {
                companies: 1,
                storage: "fs",
                setup_complete: true,
            },
            Event::TurnFinished {
                trigger: Trigger::OperatorMessage,
                outcome: Outcome::Ok,
                failure: None,
                duration_ms: 12,
                effects_executed: 0,
                approvals_parked: 0,
            },
        ]
    }

    /// **Issue #1739's first acceptance criterion.** A build that *has* the
    /// transport compiled in, pointed at a live collector, with a credential in
    /// the environment, and not declared hosted: it must send nothing.
    ///
    /// Note what is deliberately stacked against the assertion — the feature is
    /// on, the client exists, the endpoint resolves, both halves of the
    /// credential are present. The only thing that is not is consent. That is
    /// the configuration a self-hoster who copied a hosted deployment's env file
    /// would have.
    #[tokio::test]
    async fn a_self_hosted_build_makes_no_request() {
        let collector = spawn_collector().await;
        let env = env(&collector.url, &[]);

        let decision = resolve(Deployment::from_env(&env), &env);
        let tracker = build(&decision, envelope());
        for event in events() {
            tracker.track(event);
        }
        tracker.flush().await;

        assert_eq!(
            collector.hits.load(Ordering::SeqCst),
            0,
            "a self-hosted build must not dial out"
        );
        collector.stop().await;
    }

    /// The positive control that makes the test above non-vacuous: the same
    /// collector, the same events, the same code path, one variable changed.
    ///
    /// It also pins the whole wire contract — **one request per event**, the two
    /// auth headers by their exact spelling, and OpenPanel's discriminated-union
    /// body with the identity as `profileId` rather than as a property.
    #[tokio::test]
    async fn a_hosted_tenant_reports_with_the_full_envelope() {
        let collector = spawn_collector().await;
        let env = env(&collector.url, &[(DEPLOYMENT_ENV, "hosted-tenant")]);

        let decision = resolve(Deployment::from_env(&env), &env);
        assert!(decision.reports(), "{decision:?}");
        let tracker = build(&decision, envelope());
        for event in events() {
            tracker.track(event);
        }
        tracker.flush().await;

        // Two events, two requests. OpenPanel has no batch endpoint, so this is
        // the one number that changed shape rather than value.
        assert_eq!(
            collector.hits.load(Ordering::SeqCst),
            2,
            "one request per event"
        );

        let bodies = collector.bodies.lock().unwrap().clone();
        let first = &bodies[0];
        assert_eq!(first["type"], "track");
        assert_eq!(first["payload"]["name"], "instance_started");
        assert_eq!(
            first["payload"]["profileId"],
            "i_0123456789abcdef0123456789abcdef"
        );

        let properties = &first["payload"]["properties"];
        assert_eq!(properties["deployment"], "hosted-tenant");
        assert!(properties["app_version"].is_string());
        assert!(properties["harness_in_build"].is_boolean());
        assert_eq!(bodies[1]["payload"]["name"], "turn_finished");

        for request in 0..2 {
            assert_eq!(
                collector.header(request, CLIENT_ID_HEADER).as_deref(),
                Some(TEST_CLIENT_ID),
                "request {request} carried no client id header"
            );
            assert_eq!(
                collector.header(request, CLIENT_SECRET_HEADER).as_deref(),
                Some(TEST_CLIENT_SECRET),
                "request {request} carried no client secret header"
            );
        }

        collector.stop().await;
    }

    /// **The credential travels in headers and nowhere else.**
    ///
    /// The transport this replaced stamped Mixpanel's token into every event's
    /// property bag, which put a credential one `dbg!` away from a test fixture
    /// or a captured body. Nothing does that now, and this is the assertion that
    /// keeps it true: not one byte of either half appears in any body on the
    /// wire.
    #[tokio::test]
    async fn no_credential_reaches_the_request_body() {
        let collector = spawn_collector().await;
        let env = env(&collector.url, &[(DEPLOYMENT_ENV, "hosted-tenant")]);
        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());
        for event in events() {
            tracker.track(event);
        }
        tracker.flush().await;

        for body in collector.bodies.lock().unwrap().iter() {
            let rendered = body.to_string().to_ascii_lowercase();
            for half in [TEST_CLIENT_ID, TEST_CLIENT_SECRET] {
                assert!(
                    !rendered.contains(&half.to_ascii_lowercase()),
                    "the body carried {half}: {rendered}"
                );
            }
        }
        // The self-check: the needle really is findable where it *is* supposed
        // to be, or the guard above would pass on a transport that sent no
        // credential at all.
        assert_eq!(
            collector.header(0, CLIENT_SECRET_HEADER).as_deref(),
            Some(TEST_CLIENT_SECRET)
        );

        collector.stop().await;
    }

    /// An operator who switched it off stays off, even on a hosted tenant.
    #[tokio::test]
    async fn an_opted_out_tenant_makes_no_request() {
        let collector = spawn_collector().await;
        let env = env(
            &collector.url,
            &[(DEPLOYMENT_ENV, "hosted-tenant"), (ENABLE_ENV, "off")],
        );

        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());
        for event in events() {
            tracker.track(event);
        }
        tracker.flush().await;

        assert_eq!(collector.hits.load(Ordering::SeqCst), 0);
        collector.stop().await;
    }

    /// **A refused event does not stop the drain.**
    ///
    /// A per-event HTTP status is a per-event answer — a name the collector
    /// rejects, a body it will not take — and the events behind it may be
    /// perfectly good. Without this, one malformed event would silence an entire
    /// drain, which is the failure mode that matters most in a module where
    /// every other failure is already silent.
    #[tokio::test]
    async fn a_refused_event_does_not_stop_the_drain() {
        let collector = spawn_collector_with(Duration::ZERO, 1).await;
        let env = env(&collector.url, &[(DEPLOYMENT_ENV, "hosted-tenant")]);
        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());

        for _ in 0..3 {
            tracker.track(Event::InstanceStarted {
                companies: 1,
                storage: "fs",
                setup_complete: true,
            });
        }
        tracker.flush().await;

        assert_eq!(
            collector.hits.load(Ordering::SeqCst),
            3,
            "the two events behind a refused one must still be attempted"
        );
        collector.stop().await;
    }

    /// The queue is bounded. An unreachable collector must cost telemetry, not
    /// a tenant container's memory — and `track` must not block whatever the
    /// collector does.
    #[tokio::test]
    async fn the_queue_is_bounded() {
        // Nothing listens here; the point is that `track` never blocks and
        // never grows without bound whatever the collector does.
        let env = env(
            "http://127.0.0.1:1/track",
            &[(DEPLOYMENT_ENV, "hosted-tenant")],
        );
        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());
        for _ in 0..2_000 {
            tracker.track(Event::InstanceStarted {
                companies: 1,
                storage: "fs",
                setup_complete: true,
            });
        }
        // No assertion on an internal count — the observable property is that
        // this returns at all, promptly, with no reachable collector.
    }

    /// **An unreachable collector costs one timeout, not one per queued event.**
    ///
    /// This is the case losing the batch endpoint created. With a single POST
    /// carrying everything, an unreachable collector cost exactly one
    /// `SEND_TIMEOUT`. One request per event, drained sequentially, would cost
    /// `queued × SEND_TIMEOUT` — up to forty minutes at a full queue — during
    /// which the shutdown flush is blocked behind the same lock and a
    /// container's `SIGTERM` budget is long gone.
    ///
    /// Asserted on **connections the collector actually accepted**, not on
    /// elapsed time, because a timing threshold on a black-holing socket is a
    /// flaky test. The listener accepts and never answers, so each attempt is a
    /// real connection that pays the full timeout: three queued events must
    /// produce **one** connection, not three.
    #[tokio::test]
    async fn an_unreachable_collector_costs_one_timeout_for_the_whole_drain() {
        let accepted = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/track", listener.local_addr().unwrap());
        let counted = accepted.clone();
        // Accepts and holds. Never reads, never answers — the shape a collector
        // behind a wedged proxy has, and the one a refused port does not
        // exercise because it fails instantly.
        let black_hole = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                held.push(socket);
            }
        });

        let env = env(&url, &[(DEPLOYMENT_ENV, "hosted-tenant")]);
        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());
        for _ in 0..3 {
            tracker.track(Event::InstanceStarted {
                companies: 1,
                storage: "fs",
                setup_complete: true,
            });
        }

        let started = Instant::now();
        tracker.flush().await;
        let waited = started.elapsed();

        assert_eq!(
            accepted.load(Ordering::SeqCst),
            1,
            "the drain must give up after the first transport failure, not pay a \
             timeout for every queued event"
        );
        assert!(
            waited < Duration::from_secs(12),
            "a drain against a black hole took {waited:?}, which is more than one \
             send timeout and would outlive a container's shutdown budget"
        );
        // And the flush still returned, which is the property `Tracker::flush`
        // promises: analytics never prevents a shutdown.
        black_hole.abort();
    }

    /// **A transport failure must not carry the collector credential.**
    ///
    /// `OPENCOMPANY_ANALYTICS_ENDPOINT` names a collector the operator runs, and
    /// such a collector is routinely fronted by an authenticated proxy, which
    /// carries its key in one of the two places a URL can hold one.
    /// `reqwest::Error` retains the request URL and prints it, so an unreachable
    /// collector — a routine event, not an exotic one — wrote that key into the
    /// debug log.
    ///
    /// Measured against reqwest 0.12.28 rather than assumed, and the two places
    /// do **not** behave alike:
    ///
    /// | in the endpoint | what `reqwest::Error`'s `Display` printed |
    /// |---|---|
    /// | `http://someone:KEY@127.0.0.1:1/track` | `… for url (http://127.0.0.1:1/track)` — userinfo already stripped |
    /// | `http://127.0.0.1:1/track?key=KEY` | `… for url (http://127.0.0.1:1/track?key=KEY)` — **leaked verbatim** |
    ///
    /// So the query string is the live leak; userinfo is not, today. Both are
    /// covered here anyway, because "the dependency strips it" is not a
    /// property this crate owns — it is one `cargo update` from being false,
    /// and nothing here would fail when it changed. `without_url` removes the
    /// URL outright, so neither shape can reach the line whatever reqwest
    /// decides to print.
    ///
    /// Asserted **case-insensitively**, with the self-check below: this guard
    /// once shipped in a form that passed a deliberate leak, because the value
    /// came back lowercased.
    #[tokio::test]
    async fn a_transport_failure_never_carries_the_endpoint_credential() {
        const SECRET: &str = "NotARealCollectorKey";
        let needle = SECRET.to_ascii_lowercase();

        // The self-check, on the shape that is measurably still leaking. A
        // guard that cannot find the needle in the **unstripped** error proves
        // nothing about the stripped one — the needle may never have been
        // there at all. If reqwest ever starts redacting query strings too,
        // this fails loudly and says so, rather than leaving a guard behind
        // that asserts nothing.
        let leaky = format!("http://127.0.0.1:1/track?key={SECRET}");
        let unstripped = send_failing(&leaky).await.to_string();
        assert!(
            unstripped.to_ascii_lowercase().contains(&needle),
            "the needle must be findable before stripping, or this guard is \
             vacuous: {unstripped}"
        );

        for endpoint in [
            // Port 1 refuses, so each of these is a real transport error rather
            // than a fabricated one.
            format!("http://someone:{SECRET}@127.0.0.1:1/track"),
            leaky.clone(),
            format!("http://someone:{SECRET}@127.0.0.1:1/track?key={SECRET}"),
        ] {
            let logged = super::http::loggable_send_error(send_failing(&endpoint).await);
            assert!(
                !logged.to_ascii_lowercase().contains(&needle),
                "the transport error leaked the collector credential from \
                 {endpoint:?}: {logged}"
            );
            assert!(
                !logged.is_empty(),
                "stripping the URL must still leave the operator a reason: {logged}"
            );

            // And the destination is still named on the same line — through the
            // one redaction helper the boot line uses, not a second one.
            let named = crate::analytics::boot::loggable_endpoint(&endpoint);
            assert!(
                !named.to_ascii_lowercase().contains(&needle),
                "the endpoint field leaked it instead: {named}"
            );
            assert!(
                named.contains("127.0.0.1"),
                "the operator still has to be able to tell where it was going: {named}"
            );
        }
    }

    /// One real, refused request. Nothing listens on port 1.
    async fn send_failing(endpoint: &str) -> reqwest::Error {
        reqwest::Client::new()
            .post(endpoint)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect_err("nothing listens on port 1")
    }

    /// **A shutdown flush waits for a send already in flight.**
    ///
    /// The periodic drain takes the whole queue before it awaits its POSTs, so
    /// a flush that only inspected the queue would find it empty, return at
    /// once, and let process exit cancel the request carrying the event —
    /// losing telemetry precisely when the collector is slow, which is the one
    /// case the graceful flush exists for.
    ///
    /// Asserted by timing, against a collector that takes 600ms: the second
    /// flush must not return before the first request completes. The threshold
    /// is 300ms against a 600ms delay, so it neither trips on scheduling jitter
    /// nor passes without the wait (the unserialized version returns in
    /// microseconds).
    #[tokio::test]
    async fn a_flush_waits_for_a_send_already_in_flight() {
        let collector = spawn_collector_with(Duration::from_millis(600), 0).await;
        let env = env(&collector.url, &[(DEPLOYMENT_ENV, "hosted-tenant")]);
        let tracker = build(&resolve(Deployment::from_env(&env), &env), envelope());

        tracker.track(Event::InstanceStarted {
            companies: 1,
            storage: "fs",
            setup_complete: true,
        });

        // Stands in for the 30-second drain loop: it takes the queue and is
        // then parked on the POST.
        let first = {
            let tracker = tracker.clone();
            tokio::spawn(async move { tracker.flush().await })
        };
        // Long enough for the spawned task to take the queue and start its
        // request, short enough to be well inside the 600ms the collector takes.
        tokio::time::sleep(Duration::from_millis(150)).await;

        let started = Instant::now();
        tracker.flush().await;
        let waited = started.elapsed();

        assert!(
            waited >= Duration::from_millis(300),
            "the flush returned in {waited:?} while a send was still in flight; \
             on a real shutdown that event would be cancelled with the process"
        );

        first.await.expect("the in-flight send finished");
        assert_eq!(
            collector.hits.load(Ordering::SeqCst),
            1,
            "the event really was in flight and really did land"
        );
        collector.stop().await;
    }

    /// **The header-safety check in `config` really is a subset of what a
    /// header value accepts.**
    ///
    /// `config::resolve` refuses a credential it judges unfit for a header, and
    /// it makes that judgement in the un-gated build, where `reqwest` may not
    /// even be in the dependency graph — so the rule is written by hand there
    /// and is deliberately *stricter* than `HeaderValue`. That is only safe
    /// while the subset claim holds: anything `resolve` accepts, the transport
    /// must be able to put on the wire. Nothing else in the tree would notice
    /// the day it stopped holding, so it is asserted here, in the one lane that
    /// has a `HeaderValue` to compare against.
    ///
    /// The reverse containment is deliberately **not** asserted: `HeaderValue`
    /// takes space, tab and the whole `0xA0..=0xFF` range, and refusing those is
    /// the point.
    #[test]
    fn the_header_safety_check_is_a_subset_of_what_a_header_accepts() {
        use crate::analytics::config::Decision;
        use reqwest::header::HeaderValue;

        // Every single byte, plus the multi-byte shapes a mangled secret
        // actually arrives in.
        let mut candidates: Vec<String> = (1u8..=255)
            .map(|byte| format!("ok{}", byte as char))
            .collect();
        candidates.extend(
            [
                "not-a-real-client-secret",
                "op_sk_9zQx-4Kd_7Yb2Lp0",
                "550e8400-e29b-41d4-a716-446655440000",
                "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
                "wrapped\nsecret",
                "tab\tseparated",
                "spaced out",
                "caf\u{e9}-latte",
                "\u{4f8b}\u{3048}",
            ]
            .map(str::to_string),
        );

        let mut accepted = 0usize;
        for candidate in &candidates {
            let decision = resolve(
                Deployment::HostedTenant,
                &env(
                    "https://collector.invalid/track",
                    &[
                        (CLIENT_ID_ENV, candidate.as_str()),
                        (CLIENT_SECRET_ENV, candidate.as_str()),
                    ],
                ),
            );
            if matches!(decision, Decision::Report { .. }) {
                accepted += 1;
                assert!(
                    HeaderValue::from_str(candidate.trim()).is_ok(),
                    "`resolve` accepted {candidate:?}, which cannot go in a header — the \
                     subset claim in `config::is_header_safe` no longer holds"
                );
            }
        }

        // The control: the loop above would pass trivially if `resolve` had
        // started refusing everything.
        assert!(
            accepted > 50,
            "only {accepted} of {} candidates were accepted; the check has become so \
             strict that the subset assertion means nothing",
            candidates.len()
        );
    }
}
