// @vitest-environment jsdom
//
// `MascotAvatar`'s own contract, mocked at the `@rive-app/react-canvas`
// boundary rather than rendered for real: jsdom has no WebGL/canvas support
// (`Not implemented: HTMLCanvasElement's getContext()`), so the actual Rive
// artboard — whether hover visibly swaps the mascot's cap for headphones —
// can only be watched in a real browser (see
// `docs/issue/mascot-profile-avatar/open-questions.md` §3 for how that was
// verified). What a unit test *can* pin, and this one does: which
// `mascotAnimationNumber` value each `state` prop writes, that
// `prefers-reduced-motion` overrides `hover`/`replying` back to idle, and
// that the colors are set once the ViewModel instance is bound.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rive = vi.hoisted(() => ({
  setNumber: vi.fn(),
  setHandRgb: vi.fn(),
  setSkinRgb: vi.fn(),
}));

vi.mock("@rive-app/react-canvas", () => ({
  useRive: () => ({ rive: {}, RiveComponent: () => createElement("canvas") }),
  useViewModel: () => ({}),
  useViewModelInstance: () => ({}),
  useViewModelInstanceNumber: () => ({ value: 1, setValue: rive.setNumber }),
  useViewModelInstanceColor: (name: string) => ({
    setRgb: name === "handColor" ? rive.setHandRgb : rive.setSkinRgb,
  }),
}));

const { MascotAvatar } = await import("@/components/mascot-avatar");

let container: HTMLDivElement;
let root: Root;
let reduced = false;

/**
 * Same stub as `team-add-agent-dialog.test.ts` / `cov-chat-members-add-remove.test.ts`:
 * jsdom ships no `matchMedia`, and `MascotAvatar`'s own
 * `usePrefersReducedMotion` reaches for it unguarded. `reduced` is mutable
 * so a single test can flip it between renders.
 */
function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return reduced;
      },
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

beforeEach(() => {
  reduced = false;
  stubMatchMedia();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function render(state: "idle" | "hover" | "replying") {
  act(() => {
    root.render(createElement(MascotAvatar, { state }));
  });
}

describe("MascotAvatar", () => {
  it("writes 1 for idle, 2 for hover, 3 for replying", () => {
    render("idle");
    expect(rive.setNumber).toHaveBeenLastCalledWith(1);
    render("hover");
    expect(rive.setNumber).toHaveBeenLastCalledWith(2);
    render("replying");
    expect(rive.setNumber).toHaveBeenLastCalledWith(3);
  });

  it("defaults to idle when no state prop is given", () => {
    act(() => {
      root.render(createElement(MascotAvatar, {}));
    });
    expect(rive.setNumber).toHaveBeenLastCalledWith(1);
  });

  it("holds idle under prefers-reduced-motion, regardless of the requested state", () => {
    reduced = true;
    render("hover");
    expect(rive.setNumber).toHaveBeenLastCalledWith(1);
  });

  it("sets the mascot's default colorway once bound", () => {
    render("idle");
    expect(rive.setHandRgb).toHaveBeenCalledWith(0xb4, 0x90, 0x0b);
    expect(rive.setSkinRgb).toHaveBeenCalledWith(0xf7, 0xd1, 0x45);
  });

  it("renders hidden from assistive tech — the mascot is decorative, the teammate's name carries the meaning", () => {
    render("idle");
    const wrapper = container.querySelector("[aria-hidden]");
    expect(wrapper).not.toBeNull();
  });
});
