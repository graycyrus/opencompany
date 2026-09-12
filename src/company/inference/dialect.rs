//! What a request *means*, and how each model spells it.
//!
//! ## The bug this exists to stop recurring
//!
//! `temperature: Some(0.0)` is not a temperature. It is a caller saying **"be
//! deterministic"**, written in one vendor's dialect. We shipped the dialect
//! instead of the intent, so every model that spells determinism differently —
//! or cannot express it at all — returned a hard 400 and the feature died.
//!
//! That is the same root as two other defects found in the same audit: a 403
//! read as one vendor's meaning, and a tier name sent to vendors who never
//! published it. Each time, **one provider's dialect was treated as universal.**
//!
//! ## The rule
//!
//! **Code knows mechanisms. Data knows vendors.**
//!
//! No vendor name and no parameter name appears in the translation logic below
//! — [`translate`] cannot tell you what a `temperature` is. They appear only in
//! [`RULES`], which is data. Adding a vendor quirk, or teaching us a parameter
//! we have never sent, is a row in that table and not a change to any function.
//!
//! ## The four layers
//!
//! 1. **Callers state intent** — [`Sampling`], not a float. "Be deterministic"
//!    survives a vendor that has no temperature; `0.0` does not.
//! 2. **Rules are data** — [`RULES`], keyed by `(model pattern, parameter)` and
//!    **per-model rather than per-provider**, because Anthropic pre-Opus-4.6
//!    accepts a temperature range and post-4.6 rejects everything but `1.0`.
//!    A provider-keyed table cannot express that and would be wrong for one of
//!    the two halves whichever way it was written.
//! 3. **A parameter-agnostic translator** — [`translate`] walks whatever knobs
//!    it is handed, looks each one up, and applies the rule.
//! 4. **Learning from the 400** — [`parameter_blamed_by`] and [`remember_omit`].
//!    When a model rejects a parameter by name, we drop that one parameter,
//!    retry once, and remember. This is what stops the table from being a
//!    dependency: if a row is wrong, or a vendor changes silently between
//!    releases, the retry corrects us without one.
//!
//! The table is an **optimisation, not a requirement**. An unknown model costs
//! one wasted round-trip — a 400 is billed nothing — and then works.

use std::collections::HashSet;
use std::ops::RangeInclusive;
use std::sync::{OnceLock, RwLock};

/// What the caller wants, rather than the number one vendor writes it with.
///
/// The nine in-repo workloads that asked for `0.0` did not want the float; they
/// wanted a judge, a title or a triage to come out the same way twice. That
/// intent survives a model with no temperature. `0.0` does not — it is a 400 on
/// Anthropic's entire current lineup and `1e-8` on Groq.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Sampling {
    /// Repeatable output. Reaches for `seed` first and settles the sampler as
    /// far as the model allows; where a model permits neither, the request still
    /// **runs**, less repeatably. Degrade, never fail.
    Deterministic,
    /// No opinion. Sends nothing and lets the model use its own default, which
    /// is what `None` always meant and what `unwrap_or(0.0)` overrode.
    #[default]
    Default,
    /// A specific value the caller genuinely wants — a drafting workload that
    /// needs variety, or, later, an operator-supplied setting.
    Exact(f64),
}

/// A parameter we may put on the wire, before any model-specific translation.
#[derive(Clone, Debug, PartialEq)]
pub struct Knob {
    /// The OpenAI-dialect name, which is the dialect our body is written in.
    pub name: &'static str,
    /// The value the caller's intent produced.
    pub value: serde_json::Value,
}

impl Knob {
    fn new(name: &'static str, value: impl Into<serde_json::Value>) -> Self {
        Self {
            name,
            value: value.into(),
        }
    }
}

/// The seed used to mean "repeatable". Any constant does; it only has to be the
/// *same* constant across runs, which is the whole of what a caller asking for
/// determinism wants.
const DETERMINISTIC_SEED: i64 = 0;

/// The sampler setting that means "least random" in the OpenAI dialect. Rules
/// rewrite it per model; nothing outside this module names it.
const DETERMINISTIC_TEMPERATURE: f64 = 0.0;

impl Sampling {
    /// The intent behind a vendored `ModelRequest.temperature`.
    ///
    /// The boundary type carries a float, so intent has to be recovered at the
    /// edge rather than passed through it. `None` is the honest case — no
    /// opinion — and a value is taken at face value as [`Sampling::Exact`]:
    /// guessing that `0.0` "really meant" determinism would be inventing intent
    /// the caller did not express, which is the mistake this type exists to
    /// stop. In-repo callers state their intent directly and never come through
    /// here.
    pub fn from_request(temperature: Option<f64>) -> Self {
        match temperature {
            None => Self::Default,
            Some(value) => Self::Exact(value),
        }
    }

    /// The knobs this intent asks for, before translation.
    ///
    /// `Deterministic` asks for **both** `seed` and a settled sampler, and that
    /// ordering is the point: `seed` is the better lever and keeps working where
    /// the sampler is locked. On a model that fixes temperature at `1.0`, the
    /// rule rewrites the temperature and `seed` still carries what repeatability
    /// is available — a degraded answer rather than a failed request.
    pub fn knobs(self) -> Vec<Knob> {
        match self {
            Self::Default => Vec::new(),
            Self::Deterministic => vec![
                Knob::new("seed", DETERMINISTIC_SEED),
                Knob::new("temperature", DETERMINISTIC_TEMPERATURE),
            ],
            Self::Exact(value) => vec![Knob::new("temperature", value)],
        }
    }
}

/// How a model treats one parameter.
#[derive(Clone, Debug, PartialEq)]
pub enum Rule {
    /// Send it as asked. Most models, most parameters.
    Free,
    /// The model accepts exactly one value, so send that and nothing else.
    /// Anthropic post-Opus-4.6 temperature: *"A value of 1.0 … will be accepted
    /// for backwards compatibility, all other values will be rejected with a
    /// 400 error."*
    FixedAt(f64),
    /// The model rejects it at any value, so do not send it at all.
    Omit,
    /// The model wants the same thing under a different name.
    RenameTo(&'static str),
    /// The model accepts a narrower range than the dialect's; bring the value
    /// inside it rather than failing the request.
    ClampTo(RangeInclusive<f64>),
}

/// Which models a rule applies to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ModelPattern {
    /// The model id contains this, case-insensitively. Substring rather than
    /// equality because the same model arrives both bare (`claude-opus-5`, from
    /// a direct vendor) and namespaced (`anthropic/claude-opus-5`, from a
    /// gateway), and a dated snapshot suffix is common.
    Contains(&'static str),
}

impl ModelPattern {
    fn matches(self, model: &str) -> bool {
        match self {
            Self::Contains(needle) => model.contains(needle),
        }
    }
}

/// One row: this model, this parameter, this treatment.
#[derive(Clone, Debug)]
pub struct DialectRule {
    /// Which models it applies to.
    pub model: ModelPattern,
    /// The parameter's name in our dialect.
    pub parameter: &'static str,
    /// What to do with it.
    pub rule: Rule,
    /// Why, in the vendor's words where they have any. Kept beside the rule
    /// because a bare rule invites deletion by whoever next finds it surprising.
    pub because: &'static str,
}

/// Everything we know about how models differ.
///
/// **The only place in this module where a vendor or a parameter is named.**
/// Seeded from a documentation audit of all 29 shipped providers; every entry
/// traces to a vendor's own published contract.
///
/// Order matters only in that the first matching row wins, so put a narrower
/// pattern above a broader one.
pub const RULES: &[DialectRule] = &[
    // ---- Anthropic, post-Opus-4.6 -----------------------------------------
    //
    // Per-model and not per-provider: `claude-haiku-4-5` predates the cutoff and
    // still accepts a range, so a provider-keyed row would be wrong for it.
    DialectRule {
        model: ModelPattern::Contains("claude-opus-5"),
        parameter: "temperature",
        rule: Rule::FixedAt(1.0),
        because: "post-Opus-4.6: all values but 1.0 are rejected with a 400",
    },
    DialectRule {
        model: ModelPattern::Contains("claude-sonnet-5"),
        parameter: "temperature",
        rule: Rule::FixedAt(1.0),
        because: "post-Opus-4.6: all values but 1.0 are rejected with a 400",
    },
    DialectRule {
        model: ModelPattern::Contains("claude-fable-5"),
        parameter: "temperature",
        rule: Rule::FixedAt(1.0),
        because: "post-Opus-4.6: all values but 1.0 are rejected with a 400",
    },
    DialectRule {
        model: ModelPattern::Contains("claude-opus-5"),
        parameter: "top_p",
        rule: Rule::ClampTo(0.99..=1.0),
        because: "same deprecation notice as temperature; >= 0.99 accepted",
    },
    DialectRule {
        model: ModelPattern::Contains("claude-sonnet-5"),
        parameter: "top_p",
        rule: Rule::ClampTo(0.99..=1.0),
        because: "same deprecation notice as temperature; >= 0.99 accepted",
    },
    DialectRule {
        model: ModelPattern::Contains("claude-"),
        parameter: "top_k",
        rule: Rule::Omit,
        because: "rejected at any value on post-4.6 models",
    },
    // ---- OpenAI reasoning models ------------------------------------------
    //
    // The current lineup is entirely reasoning models, and the migration guide
    // says plainly: "Remove `temperature`, `top_p`, and `top_logprobs`."
    DialectRule {
        model: ModelPattern::Contains("gpt-6"),
        parameter: "temperature",
        rule: Rule::Omit,
        because: "reasoning model: does not support custom temperature",
    },
    DialectRule {
        model: ModelPattern::Contains("gpt-5"),
        parameter: "temperature",
        rule: Rule::Omit,
        because: "reasoning model: does not support custom temperature",
    },
    DialectRule {
        model: ModelPattern::Contains("gpt-6"),
        parameter: "top_p",
        rule: Rule::Omit,
        because: "reasoning model: does not support custom top_p",
    },
    DialectRule {
        model: ModelPattern::Contains("gpt-5"),
        parameter: "top_p",
        rule: Rule::Omit,
        because: "reasoning model: does not support custom top_p",
    },
    DialectRule {
        model: ModelPattern::Contains("gpt-6"),
        parameter: "max_tokens",
        rule: Rule::RenameTo("max_completion_tokens"),
        because: "max_tokens is deprecated and unsupported on reasoning models",
    },
    DialectRule {
        model: ModelPattern::Contains("gpt-5"),
        parameter: "max_tokens",
        rule: Rule::RenameTo("max_completion_tokens"),
        because: "max_tokens is deprecated and unsupported on reasoning models",
    },
    // ---- Together ----------------------------------------------------------
    //
    // Documented ceiling of 1, against the dialect's 2. Whether a larger value
    // 400s or clamps is not documented, so we clamp rather than find out on a
    // user's request.
    DialectRule {
        model: ModelPattern::Contains("meta-llama/"),
        parameter: "temperature",
        rule: Rule::ClampTo(0.0..=1.0),
        because: "Together documents a 0-1 range, not the dialect's 0-2",
    },
];

/// The rule for one parameter on one model.
///
/// A learned omission outranks the table: it was observed from the model's own
/// rejection, and the table is only what we believed beforehand.
pub fn rule_for(model: &str, parameter: &str) -> Rule {
    let model = model.to_ascii_lowercase();
    if learned_omissions().contains(&(model.clone(), parameter.to_string())) {
        return Rule::Omit;
    }
    RULES
        .iter()
        .find(|row| row.parameter == parameter && row.model.matches(&model))
        .map(|row| row.rule.clone())
        .unwrap_or(Rule::Free)
}

/// Applies every rule to every knob, producing the fields to put on the body.
///
/// **Contains no vendor name and no parameter name.** It walks whatever it is
/// handed; teaching it a new parameter is a [`RULES`] row, not an edit here.
pub fn translate(model: &str, knobs: Vec<Knob>) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    for knob in knobs {
        match rule_for(model, knob.name) {
            Rule::Omit => {}
            Rule::Free => out.push((knob.name.to_string(), knob.value)),
            Rule::RenameTo(name) => out.push((name.to_string(), knob.value)),
            Rule::FixedAt(value) => out.push((knob.name.to_string(), value.into())),
            Rule::ClampTo(range) => {
                // A non-numeric value cannot be clamped and is passed through:
                // the rule is about range, and misapplying it to a string would
                // be a second guess on top of a first.
                let value = match knob.value.as_f64() {
                    Some(raw) => serde_json::json!(raw.clamp(*range.start(), *range.end())),
                    None => knob.value,
                };
                out.push((knob.name.to_string(), value));
            }
        }
    }
    out
}

/// Which parameter, if any, a 400 is blaming — given only the parameters we
/// actually sent.
///
/// Scoped to what we sent on purpose. A body naming a field we did not send is
/// talking about something else, and dropping a parameter on that evidence would
/// be the same class of mistake as the 403: acting on our own text rather than
/// the vendor's.
///
/// Deliberately not a list of vendor error formats. Every published rejection
/// names the offending field, and the field names are ours — so asking "which of
/// mine does it mention" needs no dialect knowledge and cannot go stale.
pub fn parameter_blamed_by(body: &str, sent: &[String]) -> Option<String> {
    let body = body.to_ascii_lowercase();
    // A rejection is about the request's shape. Without this, a model whose
    // *content* mentions a parameter name could talk us into dropping it.
    const REJECTION_MARKERS: &[&str] = &[
        "unsupported",
        "not supported",
        "unsupported_value",
        "unsupported_parameter",
        "unknown parameter",
        "unrecognized",
        "not permitted",
        "invalid_request_error",
        "is deprecated",
        "does not support",
        "extra inputs",
        "unexpected",
    ];
    if !REJECTION_MARKERS.iter().any(|m| body.contains(m)) {
        return None;
    }
    // Longest first: `max_completion_tokens` contains `max_tokens` nowhere, but
    // a future pair that does would otherwise blame the shorter name.
    let mut candidates: Vec<&String> = sent.iter().collect();
    candidates.sort_by_key(|name| std::cmp::Reverse(name.len()));
    candidates
        .into_iter()
        .find(|name| body.contains(&name.to_ascii_lowercase()))
        .cloned()
}

/// What we have learned from models rejecting parameters by name.
///
/// Process-wide and in-memory: it is a cache, not a record. Losing it on restart
/// costs one round-trip per model, which is the same price a cold start pays
/// anyway, and it means a vendor that fixes a restriction is not remembered as
/// broken forever.
fn learned_omissions() -> std::sync::RwLockReadGuard<'static, HashSet<(String, String)>> {
    learned_store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records that `model` rejects `parameter`, so the next request omits it
/// without spending a round-trip.
pub fn remember_omit(model: &str, parameter: &str) {
    let mut set = learned_store()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set.insert((model.to_ascii_lowercase(), parameter.to_string()));
}

/// The one cell the reader and the writer share. A single `OnceLock` rather than
/// one per accessor — two cells would each initialise their own empty set, and
/// everything written through one would be invisible to the other.
fn learned_store() -> &'static RwLock<HashSet<(String, String)>> {
    static LEARNED: OnceLock<RwLock<HashSet<(String, String)>>> = OnceLock::new();
    LEARNED.get_or_init(|| RwLock::new(HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_intent_with_no_opinion_puts_nothing_on_the_wire() {
        // The original defect, stated as intent: `Default` is "no opinion", and
        // `unwrap_or(0.0)` turned it into the most opinionated value there is.
        assert!(Sampling::Default.knobs().is_empty());
        assert!(translate("claude-sonnet-5", Sampling::Default.knobs()).is_empty());
    }

    #[test]
    fn determinism_survives_a_model_that_forbids_a_temperature() {
        // The whole point of the intent layer. Anthropic post-4.6 rejects every
        // temperature but 1.0, so a caller asking for determinism used to get a
        // hard 400. Now the request goes out, and `seed` carries what
        // repeatability is available.
        let fields = translate("claude-sonnet-5", Sampling::Deterministic.knobs());
        let by_name: std::collections::HashMap<_, _> = fields.into_iter().collect();
        assert_eq!(by_name["temperature"], serde_json::json!(1.0));
        assert!(
            by_name.contains_key("seed"),
            "seed is the lever that still works here"
        );
    }

    #[test]
    fn the_same_intent_is_spelled_differently_per_model() {
        // One intent, three dialects, no caller aware of any of them.
        let anthropic = translate("anthropic/claude-opus-5", Sampling::Deterministic.knobs());
        assert!(anthropic.iter().any(|(k, v)| k == "temperature"
            && *v == serde_json::json!(1.0)));

        let openai = translate("gpt-6-astra", Sampling::Deterministic.knobs());
        assert!(
            !openai.iter().any(|(k, _)| k == "temperature"),
            "a reasoning model takes no temperature at all"
        );

        let ordinary = translate("llama3:latest", Sampling::Deterministic.knobs());
        assert!(ordinary.iter().any(|(k, v)| k == "temperature"
            && *v == serde_json::json!(0.0)));
    }

    #[test]
    fn a_namespaced_id_and_a_bare_id_get_the_same_answer() {
        // The same model arrives bare from a direct vendor and namespaced from a
        // gateway. A rule that only matched one of the two would be right half
        // the time and silent about the other half.
        assert_eq!(
            rule_for("claude-opus-5", "temperature"),
            rule_for("anthropic/claude-opus-5", "temperature")
        );
    }

    #[test]
    fn a_rename_moves_the_value_and_drops_the_old_name() {
        let fields = translate("gpt-5.6-sol", vec![Knob::new("max_tokens", 16384)]);
        assert_eq!(
            fields,
            vec![("max_completion_tokens".to_string(), serde_json::json!(16384))]
        );
    }

    #[test]
    fn a_clamp_brings_a_value_inside_the_range_rather_than_failing() {
        let fields = translate("meta-llama/Llama-3.3-70B", vec![Knob::new("temperature", 1.8)]);
        assert_eq!(fields, vec![("temperature".to_string(), serde_json::json!(1.0))]);
    }

    #[test]
    fn an_unknown_model_is_free_rather_than_guessed_at() {
        // The table is an optimisation. A model nobody has written a row for
        // gets exactly what the caller asked for, and the 400-learning layer
        // corrects us if that turns out to be wrong.
        assert_eq!(rule_for("some-model-nobody-has-seen", "temperature"), Rule::Free);
    }

    #[test]
    fn a_rejection_blames_only_a_parameter_we_actually_sent() {
        let sent = vec!["temperature".to_string(), "max_tokens".to_string()];
        assert_eq!(
            parameter_blamed_by(
                "Unsupported value: 'temperature' does not support 0.2 with this model.",
                &sent
            )
            .as_deref(),
            Some("temperature")
        );
        // A field we did not send is not ours to drop.
        assert_eq!(
            parameter_blamed_by("Unsupported parameter: 'logit_bias'", &sent),
            None
        );
        // And a 400 that is not about the request's shape teaches us nothing.
        assert_eq!(
            parameter_blamed_by("the temperature in Paris is 19 degrees", &sent),
            None
        );
    }

    #[test]
    fn what_is_learned_from_a_rejection_outranks_the_table() {
        // The property that makes the table an optimisation rather than a
        // dependency: a vendor that changes silently corrects us without a
        // release.
        let model = "learning-test-model-v1";
        assert_eq!(rule_for(model, "top_p"), Rule::Free);
        remember_omit(model, "top_p");
        assert_eq!(rule_for(model, "top_p"), Rule::Omit);
        assert!(translate(model, vec![Knob::new("top_p", 0.5)]).is_empty());
    }
}
