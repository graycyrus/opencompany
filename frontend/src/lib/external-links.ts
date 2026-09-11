import { tauriCore } from "@/api/transport/bridge";

/**
 * Hand an outward link to the operator's browser when the console is running
 * inside the desktop shell.
 *
 * # Why this exists
 *
 * Every outward link in the console is an ordinary anchor —
 * `<a href={url} target="_blank" rel="noreferrer">`. In a browser that opens a
 * tab. A Tauri webview has no tab to open and no browser to open it in, so the
 * click does nothing at all: no window, no error, no console message. The
 * operator sees a link that is not a link.
 *
 * That was every one of them, on every screen, including the first-run wizard's
 * only route to an API key — so an operator who did not already hold one had no
 * way forward on the first screen of a build they had just installed.
 *
 * # Why a delegated listener rather than a component
 *
 * A helper each anchor calls fixes the anchors that remember to call it. The
 * next one written is dead again, silently, and the failure only shows up in a
 * packaged build. One capture-phase listener covers the anchors that exist and
 * the ones nobody has written yet.
 *
 * # Why it is inert on the web
 *
 * `tauriCore()` is `null` in a browser, so nothing is intercepted and the
 * anchor's own behaviour stands. The console keeps working in a normal tab
 * exactly as before, which is also what keeps the E2E suite meaningful.
 */
export function installExternalLinkOpener(doc: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    // A modified click asks for the platform's own behaviour. Nothing to
    // improve on, and hijacking it would be worse than the bug.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as Element | null)?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || !href) return;
    if (!isOutwardHref(href)) return;

    // Probed at click time, not at install time: a listener installed before
    // the bridge is injected would otherwise decide "web" once and stay wrong
    // for the life of the window.
    const core = tauriCore();
    if (!core) return;

    event.preventDefault();
    // The command is fire-and-forget on purpose. A rejection here means the
    // shell refused the open, and there is nothing this layer can do about it
    // that is better than leaving the operator where they were — but it must
    // not surface as an unhandled rejection.
    void core.invoke("plugin:shell|open", { path: href }).catch(() => {});
  };

  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}

/**
 * Whether this `href` leaves the console.
 *
 * `http`/`https` and `mailto:` go out. An in-app hash route, a relative path
 * and a `blob:`/`data:` URL do not, and handing any of them to the operating
 * system would replace a working link with a failed one.
 */
export function isOutwardHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("/")) return false;
  return /^(https?:|mailto:)/i.test(value);
}
