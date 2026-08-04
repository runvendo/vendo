/**
 * The two things composition has to SAY about packs: a name a pack claimed that
 * something else in the deployment already owns (F4), and a `packs:` list that
 * quietly leaves the agent unable to build apps (F6).
 */
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { APPS_PACK_NAME } from "./apps.js";
import { hostPackToolCollision, hostToolNamesIn, missingAppsPackWarning, vendoDirOf } from "./boot.js";

const owners = new Map([["check_report", "compliance-reports"]]);

describe("hostPackToolCollision (F4)", () => {
  it("names the pack, the tool, and the host as the other claimant", () => {
    const error = hostPackToolCollision(owners, ["host_listInvoices", "check_report"]);

    expect(error).toBeInstanceOf(VendoError);
    expect(error?.code).toBe("conflict");
    expect(error?.message).toContain("compliance-reports");
    expect(error?.message).toContain("check_report");
    expect(error?.message).toMatch(/host tools/);
  });

  it("offers only the remedy that actually works", () => {
    const message = hostPackToolCollision(owners, ["check_report"])?.message ?? "";

    expect(message).toMatch(/rename it in the pack/);
    // NOT "rename the host tool in overrides.json": ToolOverride has no `name`
    // field, so that is not a thing a host can do. And NOT "disable it" either:
    // a disabled tool still reserves its name (registry.ts `register`), so the
    // collision would survive the fix we told them to make.
    expect(message).not.toMatch(/overrides\.json/);
    expect(message).not.toMatch(/disable/i);
  });

  it("says nothing when no host tool name is claimed by a pack", () => {
    expect(hostPackToolCollision(owners, ["host_listInvoices", "host_sendEmail"])).toBeUndefined();
  });

  it("says nothing when the host has no tools at all", () => {
    expect(hostPackToolCollision(owners, [])).toBeUndefined();
  });

  it("does not mistake a name that merely CONTAINS a pack tool name", () => {
    expect(hostPackToolCollision(owners, ["check_report_v2", "precheck_report"])).toBeUndefined();
  });

  it("says nothing when no pack declared any tool", () => {
    expect(hostPackToolCollision(new Map(), ["check_report"])).toBeUndefined();
  });
});

describe("vendoDirOf — the same .vendo resolution the tool registry uses", () => {
  // The registry's readOptionalVendoJson accepts `dir` as EITHER the host root
  // or the .vendo directory itself. A gate that only ever appended /.vendo/ read
  // a different file — and when profileDir pointed at .vendo it read nothing at
  // all, which turned the boot check into a silent no-op.
  it("appends .vendo to a host root", () => {
    expect(vendoDirOf("/app")).toBe("/app/.vendo");
    expect(vendoDirOf(".")).toBe("./.vendo");
  });

  it("uses a .vendo directory as-is", () => {
    expect(vendoDirOf("/app/.vendo")).toBe("/app/.vendo");
    expect(vendoDirOf("./.vendo")).toBe("./.vendo");
  });

  it("uses a .vendo directory with a trailing slash as-is", () => {
    expect(vendoDirOf("/app/.vendo/")).toBe("/app/.vendo/");
  });

  it("does not mistake a directory that merely ends in the letters vendo", () => {
    expect(vendoDirOf("/app/myvendo")).toBe("/app/myvendo/.vendo");
    expect(vendoDirOf("/app/.vendorx")).toBe("/app/.vendorx/.vendo");
  });
});

describe("hostToolNamesIn — the names the gate compares against", () => {
  it("reads the tool names out of a tools.json document", () => {
    expect(hostToolNamesIn(JSON.stringify({
      format: "vendo.tools/1",
      tools: [{ name: "host_invoices_list" }, { name: "host_invoices_get" }],
    }))).toEqual(["host_invoices_list", "host_invoices_get"]);
  });

  it("yields nothing for an absent file", () => {
    expect(hostToolNamesIn(undefined)).toEqual([]);
  });

  it("yields nothing for malformed JSON rather than throwing", () => {
    // The registry is the real parser and reports properly; this gate exists to
    // say something useful early, never to become a second validator.
    expect(hostToolNamesIn("{not json")).toEqual([]);
  });

  it("yields nothing for a document with no tools array", () => {
    expect(hostToolNamesIn(JSON.stringify({ format: "vendo.tools/1" }))).toEqual([]);
    expect(hostToolNamesIn(JSON.stringify({ tools: "nope" }))).toEqual([]);
  });

  it("skips entries with no usable name", () => {
    expect(hostToolNamesIn(JSON.stringify({ tools: [{ name: "ok" }, {}, { name: 7 }, null] })))
      .toEqual(["ok"]);
  });
});

describe("missingAppsPackWarning (F6)", () => {
  it("warns when an explicit packs list has no apps pack", () => {
    const warning = missingAppsPackWarning(["compliance-reports"]);

    expect(warning).toContain("compliance-reports");
    expect(warning).toMatch(/apps\(\)/);
    // The consequence, said plainly — this is the whole point of the warning.
    expect(warning).toMatch(/cannot build|no longer build|build apps/i);
  });

  it("says nothing when the list includes the apps pack", () => {
    expect(missingAppsPackWarning([APPS_PACK_NAME, "compliance-reports"])).toBeUndefined();
  });

  it("says nothing when packs was never configured — the default already includes apps()", () => {
    expect(missingAppsPackWarning(undefined)).toBeUndefined();
  });

  it("warns for an explicitly empty list", () => {
    expect(missingAppsPackWarning([])).toMatch(/apps\(\)/);
  });
});
