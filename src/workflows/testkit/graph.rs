//! The graph builder — see the [module docs](super) for why it exists.

use crate::company::{
    RawEdge, RawNode, RawWorkflow, WorkflowDestinationDef, WorkflowFile, WorkflowPostconditionDef,
    WorkflowRetryDef, parse_workflow, render_workflow, validate_workflow,
};

/// Starts a graph with this id. Its `name` defaults to the id; override with
/// [`WorkflowBuilder::display_name`].
pub(crate) fn wf(id: &str) -> WorkflowBuilder {
    WorkflowBuilder {
        raw: RawWorkflow {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            owner_desk: None,
            nodes: Vec::new(),
            edges: Vec::new(),
        },
    }
}

/// A graph under construction. Node modifiers (`requires_approval`, `retry`,
/// `to_owner`, …) apply to the **most recently added node**, which is what makes
/// the chain read as one line per node.
pub(crate) struct WorkflowBuilder {
    raw: RawWorkflow,
}

impl WorkflowBuilder {
    // --- workflow-level fields ---------------------------------------------

    /// Sets the workflow's human-readable name.
    pub(crate) fn display_name(mut self, name: &str) -> Self {
        self.raw.name = name.to_string();
        self
    }

    /// Sets the workflow description.
    pub(crate) fn description(mut self, text: &str) -> Self {
        self.raw.description = Some(text.to_string());
        self
    }

    /// Sets the owning desk (issue #1862 prerequisite).
    pub(crate) fn owner_desk(mut self, desk: &str) -> Self {
        self.raw.owner_desk = Some(desk.to_string());
        self
    }

    // --- the twelve node kinds ---------------------------------------------
    //
    // One constructor per entry in `WORKFLOW_NODE_KINDS`, and each takes the
    // config its kind REQUIRES rather than leaving it to the caller: a graph
    // this builder produces passes the strict author-time pass, so a test that
    // means to exercise a missing-config refusal has to say so on purpose
    // rather than getting one by omission.

    /// A `trigger` — what starts the workflow.
    pub(crate) fn trigger(self, id: &str) -> Self {
        self.node(id, "trigger")
    }

    /// An `agent` node run by roster teammate `agent_ref`.
    pub(crate) fn agent(self, id: &str, agent_ref: &str) -> Self {
        let mut next = self.node(id, "agent");
        next.last_mut().agent = Some(agent_ref.to_string());
        next
    }

    /// A `tool_call` node running tool `slug`.
    pub(crate) fn tool_call(self, id: &str, slug: &str) -> Self {
        self.node(id, "tool_call").config("slug", slug)
    }

    /// An `http_request` node.
    pub(crate) fn http_request(self, id: &str, method: &str, url: &str) -> Self {
        self.node(id, "http_request")
            .config("method", method)
            .config("url", url)
    }

    /// A `condition` node branching on `field`. Its outgoing edges must be
    /// labelled `yes` / `no` — see [`Self::edge_labeled`].
    pub(crate) fn condition(self, id: &str, field: &str) -> Self {
        self.node(id, "condition").config("field", field)
    }

    /// An `output` node — a terminal report-back step.
    pub(crate) fn output(self, id: &str) -> Self {
        self.node(id, "output")
    }

    /// A `switch` node whose `field` selects the branch; each outgoing edge
    /// label is a case name.
    pub(crate) fn switch(self, id: &str, field: &str) -> Self {
        self.node(id, "switch").config("field", field)
    }

    /// A `merge` node — fan-in.
    pub(crate) fn merge(self, id: &str) -> Self {
        self.node(id, "merge")
    }

    /// A `split_out` node fanning the list at `path` into one item each.
    pub(crate) fn split_out(self, id: &str, path: &str) -> Self {
        self.node(id, "split_out").config("path", path)
    }

    /// A `transform` node mapping each `(field, expression)` pair.
    pub(crate) fn transform(self, id: &str, set: &[(&str, &str)]) -> Self {
        let mut table = toml::value::Table::new();
        for (field, expression) in set {
            table.insert((*field).to_string(), toml::Value::from(*expression));
        }
        self.node(id, "transform")
            .config("set", toml::Value::Table(table))
    }

    /// An `output_parser` node. Schema-less by default — a pass-through parser,
    /// which the authoring contract permits.
    pub(crate) fn output_parser(self, id: &str) -> Self {
        self.node(id, "output_parser")
    }

    /// A `sub_workflow` node running the saved workflow `workflow_id`.
    pub(crate) fn sub_workflow(self, id: &str, workflow_id: &str) -> Self {
        self.node(id, "sub_workflow")
            .config("workflow_id", workflow_id)
    }

    // --- modifiers on the most recently added node -------------------------

    /// Sets the last node's human-readable name (it defaults to the node id).
    pub(crate) fn named(mut self, name: &str) -> Self {
        self.last_mut().name = name.to_string();
        self
    }

    /// Sets the last node's `summary` — an `agent` node's instruction.
    pub(crate) fn summary(mut self, text: &str) -> Self {
        self.last_mut().summary = Some(text.to_string());
        self
    }

    /// Puts the last node's run behind an operator approval.
    pub(crate) fn requires_approval(mut self) -> Self {
        self.last_mut().requires_approval = Some(true);
        self
    }

    /// Sets the last node's `on_error` policy (`stop` / `continue` / `route`).
    /// A `route` node needs an outgoing edge labelled `error`.
    pub(crate) fn on_error(mut self, policy: &str) -> Self {
        self.last_mut().on_error = Some(policy.to_string());
        self
    }

    /// Sets the last node's retry attempt count.
    pub(crate) fn retry(mut self, max_attempts: u32) -> Self {
        self.retry_mut().max_attempts = Some(max_attempts);
        self
    }

    /// Sets the last node's retry backoff curve and base delay.
    pub(crate) fn retry_backoff(mut self, backoff_ms: u64, curve: &str) -> Self {
        let retry = self.retry_mut();
        retry.backoff_ms = Some(backoff_ms);
        retry.backoff = Some(curve.to_string());
        self
    }

    /// Sets the last node's 5-field UTC cron. Only a `trigger` may carry one.
    pub(crate) fn schedule(mut self, cron: &str) -> Self {
        self.last_mut().schedule = Some(cron.to_string());
        self
    }

    /// Declares whether a continuation may repeat the last node's call
    /// (issue #850). Only `tool_call` / `http_request` may carry it.
    pub(crate) fn repeatable(mut self, repeatable: bool) -> Self {
        self.last_mut().repeatable = Some(repeatable);
        self
    }

    /// Declares the last (`agent`) node's deterministic postcondition
    /// (issue #1866). `field` is `None` for `non_empty`.
    pub(crate) fn postcondition(mut self, require: &str, field: Option<&str>) -> Self {
        self.last_mut().postcondition = Some(WorkflowPostconditionDef {
            require: require.to_string(),
            field: field.map(str::to_string),
        });
        self
    }

    /// Sets one free-form `config` key on the last node.
    pub(crate) fn config(mut self, key: &str, value: impl Into<toml::Value>) -> Self {
        let node = self.last_mut();
        let table = node
            .config
            .get_or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
        table
            .as_table_mut()
            .expect("a node's config is always built as a table here")
            .insert(key.to_string(), value.into());
        self
    }

    // --- edges --------------------------------------------------------------

    /// An unlabeled edge.
    pub(crate) fn edge(mut self, from: &str, to: &str) -> Self {
        self.raw.edges.push(RawEdge {
            from: from.to_string(),
            to: to.to_string(),
            label: None,
        });
        self
    }

    /// A labelled edge. The label becomes the engine port: `yes`/`no` on a
    /// `condition`, a case name on a `switch`, `error` out of an
    /// `on_error = "route"` node.
    pub(crate) fn edge_labeled(mut self, from: &str, to: &str, label: &str) -> Self {
        self.raw.edges.push(RawEdge {
            from: from.to_string(),
            to: to.to_string(),
            label: Some(label.to_string()),
        });
        self
    }

    // --- terminals ----------------------------------------------------------

    /// The on-disk TOML this graph renders to, through the production
    /// `render_workflow` — the same renderer the console's create route uses.
    pub(crate) fn render(&self) -> String {
        render_workflow(&self.raw).expect("a builder-made graph renders to TOML")
    }

    /// Parses the rendered TOML through the production `parse_workflow`,
    /// returning its error rather than panicking — for a test that means to
    /// assert a refusal.
    pub(crate) fn try_build(&self) -> crate::Result<WorkflowFile> {
        parse_workflow(&self.render())
    }

    /// The parsed graph, or a panic naming every validation problem and the
    /// TOML that produced them.
    pub(crate) fn build(&self) -> WorkflowFile {
        match self.try_build() {
            Ok(file) => file,
            Err(err) => panic!(
                "the built graph `{}` does not parse, so no test could ever run it: {err}\n--- \
                 rendered TOML ---\n{}",
                self.raw.id,
                self.render()
            ),
        }
    }

    /// Every problem the **strict** author-time pass finds — the rules
    /// `parse_workflow` deliberately skips on the lenient load path (issue
    /// #682). Empty means the console would accept this graph too, not merely
    /// the loader.
    pub(crate) fn strict_problems(&self) -> Vec<String> {
        validate_workflow(&self.raw, true)
    }

    // --- internals ----------------------------------------------------------

    fn node(mut self, id: &str, kind: &str) -> Self {
        self.raw.nodes.push(RawNode {
            id: id.to_string(),
            kind: kind.to_string(),
            name: id.to_string(),
            summary: None,
            agent: None,
            schedule: None,
            repeatable: None,
            config: None,
            on_error: None,
            retry: None,
            requires_approval: None,
            postcondition: None,
            destination: None,
        });
        self
    }

    fn destination(mut self, kind: &str, target: Option<&str>) -> Self {
        self.last_mut().destination = Some(WorkflowDestinationDef {
            kind: kind.to_string(),
            target: target.map(str::to_string),
        });
        self
    }

    fn retry_mut(&mut self) -> &mut WorkflowRetryDef {
        self.last_mut().retry.get_or_insert(WorkflowRetryDef {
            max_attempts: None,
            backoff_ms: None,
            backoff: None,
        })
    }

    fn last_mut(&mut self) -> &mut RawNode {
        self.raw
            .nodes
            .last_mut()
            .expect("a node modifier was called before any node was added")
    }
}

/// The three delivery destinations an `output` node may name.
///
/// Their own `impl` block so one `allow` covers exactly the three methods it is
/// about. `to_owner` names the `owner` **destination kind** — these are builder
/// setters, not conversions of the builder into something else — so the
/// `to_*`-takes-`&self` convention `clippy::wrong_self_convention` enforces does
/// not apply, and renaming them away from the destination kinds they set would
/// cost more than the lint buys.
#[allow(clippy::wrong_self_convention)]
impl WorkflowBuilder {
    /// Routes the last (`output`) node's report to the company's owner.
    pub(crate) fn to_owner(self) -> Self {
        self.destination("owner", None)
    }

    /// Routes the last (`output`) node's report to an email address.
    pub(crate) fn to_email(self, address: &str) -> Self {
        self.destination("email", Some(address))
    }

    /// Routes the last (`output`) node's report to a wired channel.
    pub(crate) fn to_channel(self, channel: &str) -> Self {
        self.destination("channel", Some(channel))
    }
}
