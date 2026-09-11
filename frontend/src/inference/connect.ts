// Connecting a provider, as decisions rather than markup.
//
// What the add dialog offers, what each category asks for, and whether a typed
// name may be used — every branch the connect flow makes, as a plain function
// over plain data. The dialogs are then layout plus handlers, with nothing in
// them that deserves a test of its own.
//
// These mirror rules the host also holds (`store::slugify`, `store::check_slug`,
// `catalogue::normalize_local_endpoint`). That is not a second opinion: the
// console needs them to disable a button before a request is made, and the host
// needs them because a console is not a security boundary. Where they overlap
// they are written to agree, and both sides are pinned.

import {
  CLI_LOGINS,
  CLOUD_PROVIDERS,
  COPY,
  LOCAL_RUNTIMES,
  cloudProvider,
  endpointHost,
  isReservedSlug,
  localRuntime,
} from "./catalogue";
import type { Provider } from "./types";

/** One choosable row in the add dialog. */
export interface AddOption {
  /** What is sent as `kind`. */
  value: string;
  /** The name. */
  label: string;
  /** The second line — monospace, and different per category. */
  detail: string;
}

/** The three lists, each already filtered to what is not yet connected. */
export interface AddOptions {
  cloud: AddOption[];
  local: AddOption[];
  cli: AddOption[];
}

/**
 * Whether this company already holds the provider a catalogue option would add.
 *
 * **Codex is the trap and this is where it is sprung.** The Codex CLI login *is*
 * an OpenAI credential, so it stores under the `openai` slug and surfaces as the
 * OpenAI row. Keying its already-connected check on the literal `codex` never
 * matches, so the dialog would offer Codex forever however many times it was
 * connected. The check is on the slug the option **stores under**, not the slug
 * it is called.
 */
export function isConnected(providers: readonly Provider[], optionSlug: string): boolean {
  const cli = CLI_LOGINS.find((c) => c.optionSlug === optionSlug);
  const stored = cli?.storedSlug ?? optionSlug;
  return providers.some((p) => p.slug === stored);
}

/**
 * What each category offers, minus what is already connected.
 *
 * **Each category lists only what is not yet connected.** The page behind the
 * modal shows the rest, and offering to add something twice is how you get two
 * rows for one provider.
 *
 * The detail lines differ per category because the categories ask three
 * different questions: a cloud provider is identified by the host its key goes
 * to, a local runtime by the fact that it is local, and a CLI login by whose
 * credential it borrows.
 */
export function addOptions(providers: readonly Provider[]): AddOptions {
  return {
    cloud: CLOUD_PROVIDERS.filter((p) => !isConnected(providers, p.slug)).map((p) => ({
      value: p.slug,
      label: p.label,
      // The host, not the whole URL: the path is noise at a glance and the host
      // is the part an operator recognises.
      detail: endpointHost(p.endpoint),
    })),
    local: LOCAL_RUNTIMES.filter((r) => !isConnected(providers, r.slug)).map((r) => ({
      value: r.slug,
      label: r.label,
      detail: COPY.detailLocal,
    })),
    cli: CLI_LOGINS.filter((c) => !isConnected(providers, c.optionSlug)).map((c) => ({
      value: c.optionSlug,
      label: c.label,
      detail: COPY.detailCli,
    })),
  };
}

/** What the key dialog for a chosen option has to ask for. */
export interface CredentialAsk {
  /** The dialog's title. */
  title: string;
  /** Whether an API key field is shown. */
  needsKey: boolean;
  /** Whether an endpoint field is shown. */
  needsEndpoint: boolean;
  /** What a key for this provider looks like, for the input placeholder. */
  keyPlaceholder?: string;
  /** A starting endpoint, where one is conventional. */
  defaultEndpoint?: string;
}

/**
 * What connecting `optionSlug` asks the operator for.
 *
 * The three categories are three different questions, and this is the function
 * that says so: **cloud wants a key** (its endpoint is a preset, and the paths in
 * that table are too varied to be typed), **local wants an endpoint** (that is
 * the thing being chosen), and **a CLI login wants nothing** because another tool
 * already holds the credential. `omlx` is the one row that wants both.
 */
export function credentialAsk(optionSlug: string): CredentialAsk {
  const cloud = cloudProvider(optionSlug);
  if (cloud) {
    return {
      title: `Connect ${cloud.label}`,
      needsKey: true,
      needsEndpoint: false,
      keyPlaceholder: cloud.keyPlaceholder,
    };
  }
  const local = localRuntime(optionSlug);
  if (local) {
    return {
      title: `Connect ${local.label}`,
      needsKey: local.needsKey,
      needsEndpoint: true,
      defaultEndpoint: local.defaultEndpoint,
    };
  }
  const cli = CLI_LOGINS.find((c) => c.optionSlug === optionSlug);
  if (cli) {
    return { title: `Connect ${cli.label}`, needsKey: false, needsEndpoint: false };
  }
  return {
    title: "Add cloud provider",
    needsKey: true,
    needsEndpoint: true,
    keyPlaceholder: "sk-...",
  };
}

/**
 * Turns a typed name into a slug.
 *
 * **The slug is derived, never typed.** An operator names the thing; the address
 * falls out. Asking for both invites them to disagree, and the one they see in a
 * routing entry would then be the one they never chose. Mirrors `store::slugify`.
 */
export function slugify(label: string): string {
  let out = "";
  let lastDash = true;
  for (const ch of label.trim()) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/-+$/, "");
}

/** Why a slug cannot be used. */
export type SlugError = "empty" | "taken" | "reserved";

/**
 * Whether a derived slug may be used for a **custom** provider.
 *
 * Three named failures rather than a boolean, because they need three different
 * sentences: one is "pick another name", one is "you already have this", and one
 * is "that name belongs to something we ship".
 *
 * The catalogue check applies to custom providers only. Adding the catalogue's
 * own `groq` entry *should* take the slug `groq` — that is the same provider,
 * not a collision.
 */
export function checkSlug(providers: readonly Provider[], slug: string): SlugError | null {
  const trimmed = slug.trim();
  if (!trimmed) return "empty";
  if (providers.some((p) => p.slug === trimmed)) return "taken";
  if (isReservedSlug(trimmed)) return "reserved";
  return null;
}

/** What to say about a slug that cannot be used. */
export function slugErrorCopy(error: SlugError): string {
  switch (error) {
    case "empty":
      return "Enter a provider name to generate a slug.";
    case "taken":
      return "This company already has a provider with that name.";
    case "reserved":
      return "That name belongs to a built-in provider.";
  }
}

/**
 * A typed endpoint, normalised — or `null` when it is not one.
 *
 * `/v1` is appended when the path is empty, because that is where an
 * OpenAI-compatible surface lives and `http://localhost:11434` is what the
 * runtime's own documentation prints. A path the operator supplied is left
 * exactly as typed: appending is not guessing, and someone who typed a path
 * meant it. Mirrors `catalogue::normalize_local_endpoint`.
 */
export function normalizeEndpoint(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const split = trimmed.indexOf("://");
  if (split === -1) return null;
  const scheme = trimmed.slice(0, split).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const rest = trimmed.slice(split + 3);
  if (!rest.trim()) return null;
  if (!rest.includes("/")) return `${trimmed}/v1`;
  return trimmed;
}

/**
 * Whether the custom-provider dialog's Add button may be pressed.
 *
 * Every reason it cannot, answered in one place so the button's disabled state
 * and the inline errors beside the fields cannot disagree about the same form.
 */
export function customProviderReady(
  providers: readonly Provider[],
  draft: { label: string; baseUrl: string },
): boolean {
  return (
    checkSlug(providers, slugify(draft.label)) === null &&
    normalizeEndpoint(draft.baseUrl) !== null
  );
}
