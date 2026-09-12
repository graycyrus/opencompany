import { describe, expect, it } from "vitest";

import type { ComposioCredentialSource, ComposioStatus } from "@/api/composio";
import {
  ACTIVE_BADGE,
  BYOK_LABEL,
  MANAGED_LABEL,
  composioForm,
  composioRows,
  credentialDialogBlurb,
  credentialDialogTitle,
  endpointHost,
  managedSourceOf,
  managedSubline,
  modeOf,
} from "@/composio/rows";
import type { ComposioRow, ComposioRowId } from "@/composio/types";

/**
 * The Composio Connected card, decided.
 *
 * Every branch these cover used to live inline in `ComposioSection.tsx`, where
 * the only way to reach one was to render the section and read the answer off a
 * screen. The rework moved them into `composio/rows.ts` precisely so the
 * combinations below are a table rather than a browser walk.
 */

function status(over: Partial<ComposioStatus> = {}): ComposioStatus {
  return {
    inBuild: true,
    granted: true,
    credentialSource: "attested",
    mode: "managed",
    backendUrl: "https://backend.composio.dev",
    toolkits: [],
    openMode: true,
    effectiveToolkits: [],
    effectiveCatalog: [],
    catalogSource: "manifest",
    catalogNotice: null,
    ...over,
  };
}

const row = (rows: ComposioRow[], id: ComposioRowId) =>
  rows.find((r) => r.id === id)!;
const managedOf = (over: Partial<ComposioStatus> = {}) =>
  row(composioRows(status(over)), "managed");
const byokOf = (over: Partial<ComposioStatus> = {}) =>
  row(composioRows(status(over)), "byok");

const SOURCES: ComposioCredentialSource[] = [
  "attested",
  "company",
  "static",
  "none",
];

describe("modeOf", () => {
  it("reads a host that never heard of BYOK as managed", () => {
    // The only route every host has, and the one whose controls are safe to
    // offer when we do not know. A `mode` this console has no copy for lands in
    // the same place rather than indexing a table with a key it does not hold.
    expect(modeOf(status({ mode: undefined }))).toBe("managed");
    expect(modeOf(status({ mode: "quantum" as never }))).toBe("managed");
    expect(modeOf(null)).toBe("managed");
  });

  it("reports each route it does know", () => {
    expect(modeOf(status({ mode: "managed" }))).toBe("managed");
    expect(modeOf(status({ mode: "byok" }))).toBe("byok");
  });
});

describe("managedSourceOf", () => {
  it("prefers the host's own answer about the managed chain", () => {
    expect(
      managedSourceOf(
        status({
          mode: "byok",
          credentialSource: "static",
          managedCredentialSource: "company",
        }),
      ),
    ).toBe("company");
  });

  it("falls back to credentialSource only where the two are defined to agree", () => {
    // Under `managed` the host defines them equal, so an older wire's
    // `credentialSource` is a correct stand-in.
    expect(
      managedSourceOf(
        status({ mode: "managed", credentialSource: "attested" }),
      ),
    ).toBe("attested");
  });

  it("says nothing about the managed chain when a BYOK host predates the field", () => {
    // The two are about different chains here, and inventing an answer is how a
    // row comes to claim a tier nobody established.
    expect(
      managedSourceOf(status({ mode: "byok", credentialSource: "static" })),
    ).toBeUndefined();
  });
});

describe("managedSubline", () => {
  /**
   * The truth table, and the reason it is a table.
   *
   * Issue #886: the console used to answer "is the managed route working" from
   * a boolean about whether somebody pasted a token, which is the FIRST of
   * three tiers and is routinely `false` on a working hosted tenant. Every row
   * below is a tier, and each says which account pays.
   */
  it("names the tier the managed chain resolves at", () => {
    expect(managedSubline("static")).toBe(
      "Using the Composio token saved for this company",
    );
    expect(managedSubline("company")).toBe(
      "Billed to this company's TinyHumans account",
    );
    expect(managedSubline("attested")).toBe(
      "Billed to whoever runs this server",
    );
    expect(managedSubline("none")).toBe(
      "No credential resolves — agents cannot connect apps",
    );
  });

  it("keeps company and attested apart", () => {
    // One bills this company's own account and the other bills whoever runs the
    // server. That is the decision an operator is on this page to make, so
    // collapsing them to one "connected" line would hide the only thing the
    // page is for.
    expect(managedSubline("company")).not.toBe(managedSubline("attested"));
  });

  it("says what the route is, rather than claiming a tier, when nothing said", () => {
    const line = managedSubline(undefined);
    expect(line).not.toContain("Billed");
    expect(line).not.toContain("No credential resolves");
  });
});

describe("endpointHost", () => {
  it("reduces a URL to the host an operator can check", () => {
    expect(endpointHost("https://backend.composio.dev/api/v3")).toBe(
      "backend.composio.dev",
    );
  });

  it("hands back anything it cannot parse rather than swallowing it", () => {
    expect(endpointHost("not a url")).toBe("not a url");
    expect(endpointHost(undefined)).toBe("");
  });
});

describe("composioRows — the shape of the card", () => {
  it("returns both routes, managed first, whatever the status says", () => {
    for (const mode of ["managed", "byok"] as const) {
      for (const source of SOURCES) {
        const rows = composioRows(status({ mode, credentialSource: source }));
        expect(rows.map((r) => r.id)).toEqual(["managed", "byok"]);
      }
    }
    expect(composioRows(null).map((r) => r.id)).toEqual(["managed", "byok"]);
  });

  it("names each route", () => {
    const rows = composioRows(status());
    expect(row(rows, "managed").label).toBe(MANAGED_LABEL);
    expect(row(rows, "byok").label).toBe(BYOK_LABEL);
  });

  it("marks exactly one row active, for every combination", () => {
    // Single-select is the whole point: `composio/mode` is one stored scalar
    // and `resolve_access` reads one branch, so both-on and both-off are states
    // the host cannot hold. A per-row toggle would make both reachable.
    for (const mode of ["managed", "byok", undefined] as const) {
      for (const source of SOURCES) {
        for (const managedCredentialSource of [...SOURCES, undefined]) {
          const rows = composioRows(
            status({ mode, credentialSource: source, managedCredentialSource }),
          );
          expect(rows.filter((r) => r.active)).toHaveLength(1);
        }
      }
    }
  });

  it("badges the active row and only the active row", () => {
    const rows = composioRows(
      status({ mode: "byok", credentialSource: "static" }),
    );
    expect(row(rows, "byok").badge).toBe(ACTIVE_BADGE);
    expect(row(rows, "managed").badge).toBeNull();
  });
});

describe("composioRows — the managed row", () => {
  it("reports the managed tier from managedCredentialSource while BYOK is active", () => {
    // The field's whole reason for existing. Under BYOK the stored mode says
    // nothing about what managed would resolve to, and without this the console
    // could only offer the route back blind.
    const managed = managedOf({
      mode: "byok",
      credentialSource: "static",
      managedCredentialSource: "company",
    });
    expect(managed.active).toBe(false);
    expect(managed.subline).toBe("Billed to this company's TinyHumans account");
    expect(managed.controls.select).toBe(true);
  });

  it("suppresses Use this when the managed chain resolves to nothing", () => {
    // Switching to a route that resolves to nothing is an outage, not a choice.
    const managed = managedOf({
      mode: "byok",
      credentialSource: "static",
      managedCredentialSource: "none",
    });
    expect(managed.controls.select).toBe(false);
    expect(managed.subline).toBe(
      "No credential resolves — agents cannot connect apps",
    );
    expect(managed.tone).toBe("warning");
  });

  it("still offers Use this on a host that never said, because not-said is not none", () => {
    // Hiding it here would take the only route back to managed away from every
    // host predating the field.
    const managed = managedOf({ mode: "byok", credentialSource: "static" });
    expect(managed.controls.select).toBe(true);
  });

  it("offers no Use this on the row the company is already on", () => {
    expect(
      managedOf({ mode: "managed", credentialSource: "attested" }).controls
        .select,
    ).toBe(false);
  });

  it("offers the token controls only where a token can be added or is stored", () => {
    // `static` is the one tier that means a Composio token is stored for this
    // route; the others resolve from an identity there is nothing to remove.
    const stored = managedOf({ mode: "managed", credentialSource: "static" });
    expect(stored.controls).toMatchObject({
      addKey: false,
      replaceKey: true,
      removeKey: true,
    });

    for (const source of ["attested", "company", "none"] as const) {
      const bare = managedOf({ mode: "managed", credentialSource: source });
      expect(bare.controls, source).toMatchObject({
        addKey: true,
        replaceKey: false,
        removeKey: false,
      });
    }
  });

  it("offers nothing to remove on a row that is not the active route", () => {
    const managed = managedOf({
      mode: "byok",
      credentialSource: "static",
      managedCredentialSource: "static",
    });
    expect(managed.controls).toMatchObject({
      addKey: false,
      replaceKey: false,
      removeKey: false,
    });
  });

  it("calls the managed credential a token", () => {
    // Two different credentials authenticating two different hosts. The console
    // must never let them read as one.
    expect(managedOf().keyNoun).toBe("token");
    expect(byokOf().keyNoun).toBe("key");
  });
});

describe("composioRows — the #886 trap", () => {
  it("renders a hosted tenant nobody pasted anything for as working", () => {
    // The exact shape of the bug: `credentialSource: "attested"` is a company
    // whose agents are calling Composio tools successfully through the
    // instance's platform identity. A row driven off "did somebody paste a
    // token" reports it as unconfigured, in the alarm colour.
    const managed = managedOf({
      mode: "managed",
      credentialSource: "attested",
    });

    expect(managed.active).toBe(true);
    expect(managed.tone).toBe("muted");
    expect(managed.subline).toBe("Billed to whoever runs this server");
    expect(managed.subline).not.toContain("No credential");
  });

  it("does the same for a company brokered through its own TinyHumans key", () => {
    const managed = managedOf({ mode: "managed", credentialSource: "company" });
    expect(managed.tone).toBe("muted");
    expect(managed.subline).toBe("Billed to this company's TinyHumans account");
  });
});

describe("composioRows — the own-account row", () => {
  it("reports a stored key and the endpoint it reaches", () => {
    const byok = byokOf({
      mode: "byok",
      credentialSource: "static",
      backendUrl: "https://backend.composio.dev",
    });
    expect(byok.subline).toBe("•••• configured · backend.composio.dev");
    expect(byok.tone).toBe("muted");
    expect(byok.controls).toMatchObject({
      select: false,
      addKey: false,
      replaceKey: true,
    });
  });

  it("warns when BYOK is selected with no key stored", () => {
    // A real, reachable fail-closed state: `resolve_access` withholds the tools
    // rather than borrowing the platform's identity, and a row that reported
    // "using its own account" here would be the #886 shape one route over.
    const byok = byokOf({ mode: "byok", credentialSource: "none" });
    expect(byok.active).toBe(true);
    expect(byok.tone).toBe("warning");
    expect(byok.subline).toBe(
      "No API key stored — agents get no Composio tools",
    );
    expect(byok.controls).toMatchObject({ addKey: true, replaceKey: false });
  });

  it("offers Use this, and nothing else, from the managed route", () => {
    const byok = byokOf({ mode: "managed", credentialSource: "attested" });
    expect(byok.subline).toBe("Not connected");
    expect(byok.controls).toMatchObject({
      select: true,
      addKey: false,
      replaceKey: false,
      removeKey: false,
    });
  });

  it("never offers Remove key", () => {
    // Clearing a BYOK key is not "the key goes away": the host derives the
    // route from whether one exists, so the write that removes it is the same
    // write that moves the company to managed — which the managed row's
    // "Use this" already is. One action under two names is how an operator
    // comes to believe they are two.
    for (const mode of ["managed", "byok"] as const) {
      for (const source of SOURCES) {
        expect(
          byokOf({ mode, credentialSource: source }).controls.removeKey,
          `${mode}/${source}`,
        ).toBe(false);
      }
    }
  });
});

describe("composioRows — controls that cannot act are not offered", () => {
  it("never offers Test on the managed row", () => {
    // `POST …/composio/api-key/test` probes the BYOK key against Composio. The
    // managed route's credential is a bearer the TinyHumans backend
    // recognises, and there is no cheap call that tells a bad bearer apart from
    // a backend that is down — so a Test here could only report an outage as a
    // rejected credential, which is the misclassification the whole probe
    // design exists to avoid. Pinned rather than left to be rediscovered.
    for (const mode of ["managed", "byok"] as const) {
      for (const source of SOURCES) {
        for (const managedCredentialSource of [...SOURCES, undefined]) {
          const [managed] = composioRows(
            status({ mode, credentialSource: source, managedCredentialSource }),
          );
          expect(
            managed?.controls.test,
            `${mode}/${source}/${managedCredentialSource}`,
          ).toBe(false);
        }
      }
    }
  });

  it("offers Test on the own-account row exactly where there is a key to check", () => {
    // The host answers `409 not_configured` when the company is on the managed
    // route or is on BYOK with a blank slot. Both are permanent states, so the
    // honest rendering is no control rather than one that can only fail — which
    // is the same rule every other `false` in this object follows.
    for (const mode of ["managed", "byok"] as const) {
      for (const source of SOURCES) {
        const row = byokOf({ mode, credentialSource: source });
        expect(row.controls.test, `${mode}/${source}`).toBe(
          mode === "byok" && source !== "none",
        );
      }
    }
  });

  it("never offers a control on the row a company is not on, except Use this", () => {
    for (const mode of ["managed", "byok"] as const) {
      for (const source of SOURCES) {
        for (const managedCredentialSource of [...SOURCES, undefined]) {
          for (const r of composioRows(
            status({ mode, credentialSource: source, managedCredentialSource }),
          )) {
            if (r.active) continue;
            expect(
              r.controls.addKey ||
                r.controls.replaceKey ||
                r.controls.removeKey,
              `${r.id} ${mode}/${source}/${managedCredentialSource}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe("composioForm", () => {
  it("renders nothing when nothing was asked for", () => {
    expect(composioForm(null, composioRows(status()))).toBeNull();
  });

  it("opens the API key field from the own-account row's Use this", () => {
    // That route cannot be chosen without the key that makes it resolve, so its
    // select is a hand-off to this form rather than a write.
    const rows = composioRows(
      status({ mode: "managed", credentialSource: "attested" }),
    );
    expect(composioForm({ row: "byok", action: "add" }, rows)).toEqual({
      row: "byok",
      credential: "composio-api-key",
      keyNoun: "key",
      rotating: false,
    });
  });

  it("opens the token field from the managed row", () => {
    const rows = composioRows(
      status({ mode: "managed", credentialSource: "attested" }),
    );
    expect(composioForm({ row: "managed", action: "add" }, rows)).toEqual({
      row: "managed",
      credential: "composio-token",
      keyNoun: "token",
      rotating: false,
    });
  });

  it("marks a rotation as one", () => {
    const rows = composioRows(
      status({ mode: "byok", credentialSource: "static" }),
    );
    expect(
      composioForm({ row: "byok", action: "replace" }, rows)?.rotating,
    ).toBe(true);
  });

  it("drops a form the rows no longer permit", () => {
    // The stale-form bug this exists for: an operator opens "replace the key on
    // the own-account row", the status moves underneath them — a refresh,
    // another admin — and the field's Save would write a credential for a route
    // the company is no longer on.
    const moved = composioRows(
      status({ mode: "managed", credentialSource: "attested" }),
    );
    expect(composioForm({ row: "byok", action: "replace" }, moved)).toBeNull();
  });

  it("drops a managed replace once the token it would rotate is gone", () => {
    const cleared = composioRows(
      status({ mode: "managed", credentialSource: "attested" }),
    );
    expect(
      composioForm({ row: "managed", action: "replace" }, cleared),
    ).toBeNull();
  });
});

describe("the credential dialog's copy", () => {
  // The form is a modal now, and a modal with a generic heading is worse than
  // the inline card it replaces: the rows that opened it are behind an overlay,
  // so the title is the only thing left saying which route this credential is
  // for.
  const form = (row: ComposioRowId, action: "add" | "replace") =>
    composioForm(
      { row, action },
      composioRows(
        status(
          row === "byok" && action === "replace"
            ? { mode: "byok", credentialSource: "static" }
            : action === "replace"
              ? { mode: "managed", credentialSource: "static" }
              : { mode: "managed", credentialSource: "attested" },
        ),
      ),
    )!;

  it("names the route, and says add or replace", () => {
    expect(credentialDialogTitle(form("byok", "add"))).toBe(
      "Connect this company's own Composio account",
    );
    expect(credentialDialogTitle(form("byok", "replace"))).toBe(
      "Replace this company's Composio API key",
    );
    expect(credentialDialogTitle(form("managed", "add"))).toBe(
      "Add a token for the managed route",
    );
    expect(credentialDialogTitle(form("managed", "replace"))).toBe(
      "Replace the token for the managed route",
    );
  });

  it("never titles a dialog with the field's own label", () => {
    // The popup takes its accessible name from this string, so a title
    // containing the field's label makes `getByLabel(/Composio token/)` match
    // both the dialog and the input inside it — which is a strict-mode
    // violation in the e2e that rotates the managed token, not a cosmetic
    // complaint.
    for (const row of ["byok", "managed"] as const) {
      for (const action of ["add", "replace"] as const) {
        expect(credentialDialogTitle(form(row, action))).not.toContain(
          "Composio token",
        );
      }
    }
  });

  it("says what storing it does, per route", () => {
    expect(credentialDialogBlurb(form("byok", "add"))).toContain(
      "instead of the managed route's",
    );
    expect(credentialDialogBlurb(form("managed", "add"))).toContain(
      "this company only",
    );
    // The blurb is about the route, so rotating does not change it — what
    // changes is the title and the button.
    expect(credentialDialogBlurb(form("managed", "replace"))).toBe(
      credentialDialogBlurb(form("managed", "add")),
    );
  });
});
