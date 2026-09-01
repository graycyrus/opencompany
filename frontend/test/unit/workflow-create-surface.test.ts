import { describe, expect, it } from "vitest";

import type { CognitionPath } from "@/api/inference";
import { ApiError } from "@/api/types";
import {
  createSurface,
  draftCapabilityGap,
  nameFromDescription,
} from "@/lib/workflow-create-surface";

/**
 * Which of the two New-workflow dialogs renders.
 *
 * This is the branch the redesign lives or dies on, and its failure is silent
 * in one direction: answer `form` on a company whose copilot works and the
 * dialog looks exactly as it did before, so nothing reports that the one-box
 * dialog never shipped. A rendered test can only prove the cases somebody
 * thought to render; the decision is a pure function so every input can be.
 */

/** Every cognition path the host can report, so no new one is silently untested. */
const PATHS: CognitionPath[] = [
  "harness",
  "hosted",
  "sidecar",
  "echo",
  "custom",
  "test",
];

describe("createSurface", () => {
  it("shows the one box for every cognition path that is not the offline brain", () => {
    for (const cognition of PATHS.filter((p) => p !== "echo")) {
      expect(
        createSurface({
          editing: false,
          cognition,
          capabilityGap: null,
          writeRefused: false,
        }),
        `cognition=${cognition} can draft, so the dialog must be one box`,
      ).toBe("describe");
    }
  });

  it("shows the one box while the cognition read has not landed", () => {
    // `null` is both "in flight" and "this host has no /inference route". Issue
    // #753 leaves the copilot ENABLED in that case rather than refusing to draft
    // because it could not confirm, and this follows it: guessing `describe`
    // wrong is corrected out loud by the capability gap on the first Create,
    // where guessing `form` wrong is corrected by nothing at all.
    expect(
      createSurface({
        editing: false,
        cognition: null,
        capabilityGap: null,
        writeRefused: false,
      }),
    ).toBe("describe");
  });

  it("shows the manual form on the offline brain", () => {
    expect(
      createSurface({
        editing: false,
        cognition: "echo",
        capabilityGap: null,
        writeRefused: false,
      }),
    ).toBe("form");
  });

  it("shows the manual form once a draft has reported a capability gap", () => {
    for (const cognition of PATHS) {
      expect(
        createSurface({
          editing: false,
          cognition,
          capabilityGap: "This build has no copilot wired.",
          writeRefused: false,
        }),
        `a capability gap outranks cognition=${cognition}`,
      ).toBe("form");
    }
  });

  it("shows the manual form once a one-box create has been refused", () => {
    // The refusal that actually happens: the host mints a draft's id by
    // slugging and deduping against SAVED workflows only, so two similar
    // descriptions drafted before either is created mint the same id and the
    // second Create is told to pick a different one — by a dialog with no id
    // field. The fields have to come back or that is a dead end.
    expect(
      createSurface({
        editing: false,
        cognition: "hosted",
        capabilityGap: null,
        writeRefused: true,
      }),
    ).toBe("form");
  });

  it("is always the manual form in edit mode, whatever the copilot can do", () => {
    for (const cognition of PATHS) {
      expect(
        createSurface({
          editing: true,
          cognition,
          capabilityGap: null,
          writeRefused: false,
        }),
        `editing outranks cognition=${cognition}`,
      ).toBe("form");
    }
  });
});

describe("draftCapabilityGap", () => {
  it("names the three codes that mean this build cannot draft at all", () => {
    const cases: [number, string][] = [
      [404, "not_wired"],
      [409, "inference_required"],
      [409, "restart_required"],
    ];
    for (const [status, code] of cases) {
      expect(
        draftCapabilityGap(new ApiError(status, code, `refused: ${code}`)),
        `${status} ${code} is a capability gap`,
      ).toBe(`refused: ${code}`);
    }
  });

  it("does not treat an ordinary failure as a missing copilot", () => {
    // A dropped connection or a 500 says nothing about whether this company can
    // draft. Collapsing the redesign back to the old form over a flaky network
    // would be a redesign undone by wifi.
    expect(draftCapabilityGap(new ApiError(500, "internal", "boom"))).toBeNull();
    expect(draftCapabilityGap(new ApiError(400, "invalid_request", "describe it"))).toBeNull();
    expect(draftCapabilityGap(new Error("network down"))).toBeNull();
    expect(draftCapabilityGap("not_wired")).toBeNull();
    expect(draftCapabilityGap(null)).toBeNull();
  });

  it("keys on the code, never on the prose", () => {
    // A host that rewords its message must not silently change which dialog an
    // operator sees.
    expect(
      draftCapabilityGap(new ApiError(404, "unknown_route", "no copilot is wired here")),
    ).toBeNull();
  });
});

describe("nameFromDescription", () => {
  it("takes the first clause, which is where a sentence says what the thing is", () => {
    expect(
      nameFromDescription(
        "Every Monday morning, have the writer draft the digest and email it to the team.",
      ),
    ).toBe("Every Monday morning");
    expect(nameFromDescription("Chase overdue invoices. Weekly.")).toBe(
      "Chase overdue invoices",
    );
    expect(nameFromDescription("Publish the changelog")).toBe("Publish the changelog");
  });

  it("collapses whitespace and capitalises, so the name reads like a title", () => {
    expect(nameFromDescription("  weekly   digest\t  ")).toBe("Weekly digest");
  });

  it("caps a rambling clause rather than minting a paragraph-long name", () => {
    const long = "a".repeat(200);
    const name = nameFromDescription(long);
    expect(name.length).toBeLessThanOrEqual(61);
    expect(name.endsWith("…")).toBe(true);
  });

  it("derives nothing from a sentence with nothing usable in it", () => {
    // The caller must ASK for a name here rather than write an empty one: an
    // empty name derives an empty id, and the id is the permanent join key
    // nothing can fix after creation.
    expect(nameFromDescription("")).toBe("");
    expect(nameFromDescription("   ")).toBe("");
    expect(nameFromDescription(",,,")).toBe("");
    expect(nameFromDescription("...")).toBe("");
  });
});
