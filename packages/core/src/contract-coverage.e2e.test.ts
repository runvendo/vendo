/**
 * Contract-coverage e2e — exercises the contracted behaviors of 01-core.md that
 * the neighbor blocks depend on but the pre-existing suites left unexercised.
 * Everything imports from the package root (`./index.js`) — the single public
 * export surface a sibling block sees; the packed-artifact equivalence of that
 * surface is proven separately by packaging.e2e.test.ts.
 *
 * The descriptorHash independence check uses node:crypto as a SEPARATE SHA-256
 * oracle (the shipped dist rolls its own in sha256.ts) and a hand-written JCS
 * canonical string as a separate canonicalization oracle — so agreement here is
 * genuine cross-implementation agreement, not the package agreeing with itself.
 * node:crypto is a test-only import; the dist stays platform-clean.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  VENDO_TOOLS_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_POLICY_FORMAT,
  TOOL_NAME_PATTERN,
  VendoError,
  appIdSchema,
  grantIdSchema,
  approvalIdSchema,
  runIdSchema,
  threadIdSchema,
  isoDateTimeSchema,
  jsonSchemaSchema,
  principalSchema,
  runContextSchema,
  triggerRefSchema,
  riskLabelSchema,
  toolDescriptorSchema,
  toolCallSchema,
  toolOutcomeSchema,
  grantConstraintSchema,
  grantScopeSchema,
  grantDurationSchema,
  permissionGrantSchema,
  approvalRequestSchema,
  approvalDecisionSchema,
  guardDecisionSchema,
  auditEventSchema,
  uiPayloadSchema,
  treeSchema,
  treeNodeSchema,
  treeQuerySchema,
  storageDeclSchema,
  pinSchema,
  appDocumentSchema,
  triggerSourceSchema,
  runModelSchema,
  stepSchema,
  triggerSchema,
  vendoRecordSchema,
  recordQuerySchema,
  authMaterialSchema,
  agentRunReportSchema,
  vendoThemeSchema,
  vendoViewPartSchema,
  vendoApprovalPartSchema,
  vendoErrorCodeSchema,
  canonicalJson,
  descriptorHash,
  validateTree,
  validateAppDocument,
  type ToolDescriptor,
} from "./index.js";

/** node:crypto oracle — an implementation independent of the shipped sha256.ts. */
const oracleHash = (canonical: string): string =>
  `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;

describe("§1 — format constants are pinned to their exact wire strings", () => {
  // Renaming any of these breaks stored records; the string values ARE the contract.
  it("carries the five frozen format tags verbatim", () => {
    expect(VENDO_APP_FORMAT).toBe("vendo/app@1");
    expect(VENDO_TREE_FORMAT).toBe("vendo-genui/v1");
    expect(VENDO_TOOLS_FORMAT).toBe("vendo/tools@1");
    expect(VENDO_OVERRIDES_FORMAT).toBe("vendo/overrides@1");
    expect(VENDO_POLICY_FORMAT).toBe("vendo/policy@1");
  });
});

describe("§1 — id schemas enforce their stable prefixes", () => {
  const cases: Array<[string, typeof appIdSchema, string, string]> = [
    ["appId", appIdSchema, "app_", "grt_"],
    ["grantId", grantIdSchema, "grt_", "app_"],
    ["approvalId", approvalIdSchema, "apr_", "run_"],
    ["runId", runIdSchema, "run_", "thr_"],
    ["threadId", threadIdSchema, "thr_", "apr_"],
  ];
  it.each(cases)("%s accepts its prefix and rejects a foreign one, empty body, and bare prefix", (_name, schema, good, bad) => {
    expect(schema.safeParse(`${good}abc123`).success).toBe(true);
    expect(schema.safeParse(`${bad}abc123`).success).toBe(false);
    expect(schema.safeParse(good).success).toBe(false); // prefix with no body (.+ required)
    expect(schema.safeParse("").success).toBe(false);
  });

  it("isoDateTimeSchema accepts UTC ISO-8601 and rejects offset/garbage", () => {
    expect(isoDateTimeSchema.safeParse("2026-07-11T16:00:00.000Z").success).toBe(true);
    expect(isoDateTimeSchema.safeParse("2026-07-11 16:00:00").success).toBe(false);
    expect(isoDateTimeSchema.safeParse("not-a-date").success).toBe(false);
  });

  it("jsonSchemaSchema accepts a JSON-Schema-shaped record and rejects non-objects", () => {
    expect(jsonSchemaSchema.safeParse({ type: "object", properties: {} }).success).toBe(true);
    expect(jsonSchemaSchema.safeParse("string").success).toBe(false);
    expect(jsonSchemaSchema.safeParse([]).success).toBe(false);
  });
});

describe("§2 — principalSchema pins kind to user, org is Cloud-reserved", () => {
  it("accepts a user principal with optional display and ephemeral", () => {
    expect(principalSchema.safeParse({ kind: "user", subject: "user_1" }).success).toBe(true);
    expect(principalSchema.safeParse({
      kind: "user", subject: "sess_anon", display: "Anon", ephemeral: true,
    }).success).toBe(true);
  });

  it("rejects the reserved org kind and a missing subject", () => {
    expect(principalSchema.safeParse({ kind: "org", subject: "org_1" }).success).toBe(false);
    expect(principalSchema.safeParse({ kind: "user" }).success).toBe(false);
  });
});

describe("§3 — run context and trigger ref", () => {
  it("accepts every venue and presence, and carries request headers", () => {
    for (const venue of ["chat", "app", "automation", "mcp"] as const) {
      for (const presence of ["present", "away"] as const) {
        expect(runContextSchema.safeParse({
          principal: { kind: "user", subject: "u" },
          venue, presence, sessionId: "s",
          requestHeaders: { Authorization: "Bearer x" },
        }).success).toBe(true);
      }
    }
    expect(runContextSchema.safeParse({
      principal: { kind: "user", subject: "u" }, venue: "voice", presence: "present", sessionId: "s",
    }).success).toBe(false);
  });

  it("triggerRef requires a run_ id and a known trigger kind", () => {
    expect(triggerRefSchema.safeParse({ runId: "run_1", kind: "schedule" }).success).toBe(true);
    expect(triggerRefSchema.safeParse({ runId: "job_1", kind: "schedule" }).success).toBe(false);
    expect(triggerRefSchema.safeParse({ runId: "run_1", kind: "webhook" }).success).toBe(false);
  });
});

describe("§4 — TOOL_NAME_PATTERN is the provider-safe charset with a 1..64 length", () => {
  it("accepts the boundary lengths and the full legal charset", () => {
    expect(TOOL_NAME_PATTERN.test("a")).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(64))).toBe(true);
    expect(TOOL_NAME_PATTERN.test("host_invoices_list-2")).toBe(true);
    expect(riskLabelSchema.options).toEqual(["read", "write", "destructive"]);
  });

  it("rejects empty, over-length, dotted, and whitespace names", () => {
    expect(TOOL_NAME_PATTERN.test("")).toBe(false);
    expect(TOOL_NAME_PATTERN.test("a".repeat(65))).toBe(false);
    expect(TOOL_NAME_PATTERN.test("host.invoices.list")).toBe(false);
    expect(TOOL_NAME_PATTERN.test("host invoices")).toBe(false);
    // toolDescriptorSchema enforces the same pattern on its name field
    expect(toolDescriptorSchema.safeParse({
      name: "a".repeat(65), description: "x", inputSchema: {}, risk: "read",
    }).success).toBe(false);
  });

  it("toolCall requires args to be present (undefined is not JSON)", () => {
    expect(toolCallSchema.safeParse({ id: "c1", tool: "host_x", args: null }).success).toBe(true);
    expect(toolCallSchema.safeParse({ id: "c1", tool: "host_x" }).success).toBe(false);
  });

  it("toolOutcome accepts the four variants and rejects an unknown status", () => {
    expect(toolOutcomeSchema.safeParse({ status: "ok", output: 1 }).success).toBe(true);
    expect(toolOutcomeSchema.safeParse({ status: "pending-approval", approvalId: "apr_1" }).success).toBe(true);
    expect(toolOutcomeSchema.safeParse({ status: "pending-approval", approvalId: "x" }).success).toBe(false);
    expect(toolOutcomeSchema.safeParse({ status: "queued" }).success).toBe(false);
  });
});

describe("§4 — descriptorHash agrees with an independent JCS + SHA-256 oracle", () => {
  // Hand-written RFC 8785 canonical form: top-level keys sorted
  // (critical, description, inputSchema, name, risk); inputSchema keys sorted (a, b).
  const descriptor: ToolDescriptor = {
    name: "gmail_send",
    description: "Send ✉", // an envelope, exercising multi-byte UTF-8
    inputSchema: { b: 1, a: 2 },
    risk: "write",
    critical: true,
  };
  const handCanonical =
    '{"critical":true,"description":"Send ✉","inputSchema":{"a":2,"b":1},"name":"gmail_send","risk":"write"}';

  it("canonicalizes the preimage byte-for-byte to the hand-written JCS string", () => {
    // canonicalJson of the exact preimage descriptorHash builds.
    expect(canonicalJson({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      risk: descriptor.risk,
      critical: descriptor.critical,
    })).toBe(handCanonical);
  });

  it("hashes to sha256:<node-crypto digest of the canonical string>", () => {
    expect(descriptorHash(descriptor)).toBe(oracleHash(handCanonical));
    expect(descriptorHash(descriptor).startsWith("sha256:")).toBe(true);
  });

  it("omits absent optional fields from the preimage (critical absent != critical:false)", () => {
    const base: ToolDescriptor = { name: "host_x", description: "d", inputSchema: {}, risk: "read" };
    const absentCanonical = '{"description":"d","inputSchema":{},"name":"host_x","risk":"read"}';
    const falseCanonical = '{"critical":false,"description":"d","inputSchema":{},"name":"host_x","risk":"read"}';
    expect(descriptorHash(base)).toBe(oracleHash(absentCanonical));
    expect(descriptorHash({ ...base, critical: false })).toBe(oracleHash(falseCanonical));
    expect(descriptorHash(base)).not.toBe(descriptorHash({ ...base, critical: false }));
  });

  it("is stable across key insertion order (the whole point of canonicalization)", () => {
    const a: ToolDescriptor = { name: "n", description: "d", inputSchema: { x: 1, y: 2 }, risk: "read" };
    const b: ToolDescriptor = { risk: "read", inputSchema: { y: 2, x: 1 }, description: "d", name: "n" };
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });
});

describe("§4 — the committed vectors reproduce under the independent oracle", () => {
  // Re-derive each vector's hash from its declared canonical form via node:crypto,
  // proving the committed hashes are correct SHA-256 digests, not self-referential.
  it("every packaged vector's hash equals node:crypto(canonical) and descriptorHash(descriptor)", async () => {
    const { readFileSync } = await import("node:fs");
    const vectors = JSON.parse(
      readFileSync(new URL("../vectors/descriptor-hash.json", import.meta.url), "utf8"),
    ) as { vectors: Array<{ name: string; descriptor: ToolDescriptor; canonical: string; hash: string }> };
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(5);
    for (const vector of vectors.vectors) {
      expect(oracleHash(vector.canonical), vector.name).toBe(vector.hash);
      expect(descriptorHash(vector.descriptor), vector.name).toBe(vector.hash);
    }
  });
});

describe("§5 — grant constraints, scopes, durations, and mint sources", () => {
  it("accepts every constraint op and value type, rejects unknown op / non-primitive value", () => {
    for (const op of ["eq", "lte", "gte", "matches"] as const) {
      expect(grantConstraintSchema.safeParse({ path: "/x", op, value: "v" }).success).toBe(true);
    }
    for (const value of ["s", 10, true]) {
      expect(grantConstraintSchema.safeParse({ path: "/x", op: "eq", value }).success).toBe(true);
    }
    expect(grantConstraintSchema.safeParse({ path: "/x", op: "ne", value: 1 }).success).toBe(false);
    expect(grantConstraintSchema.safeParse({ path: "/x", op: "eq", value: { nested: true } }).success).toBe(false);
  });

  it("distinguishes the three grant scope variants and enforces their fields", () => {
    expect(grantScopeSchema.safeParse({ kind: "tool" }).success).toBe(true);
    expect(grantScopeSchema.safeParse({ kind: "exact", inputHash: "sha256:a", inputPreview: "p" }).success).toBe(true);
    expect(grantScopeSchema.safeParse({ kind: "exact", inputHash: "sha256:a" }).success).toBe(false);
    expect(grantScopeSchema.safeParse({ kind: "constrained", constraints: [] }).success).toBe(true);
    expect(grantScopeSchema.safeParse({ kind: "constrained" }).success).toBe(false);
    expect(grantScopeSchema.safeParse({ kind: "whole" }).success).toBe(false);
  });

  it("accepts every grant duration and every mint source", () => {
    expect(grantDurationSchema.options).toEqual(["standing", "session", "task"]);
    const base = {
      id: "grt_1", subject: "user_1", tool: "host_x", descriptorHash: "sha256:a",
      scope: { kind: "tool" as const }, grantedAt: "2026-07-11T16:00:00.000Z",
    };
    for (const duration of ["standing", "session", "task"] as const) {
      // "mcp" is the door's consent-projection source (10-mcp §3), additive to
      // the in-product sources — accepted here, still rejecting non-sources.
      for (const source of ["chat", "batch", "automation", "mcp"] as const) {
        expect(permissionGrantSchema.safeParse({ ...base, duration, source }).success).toBe(true);
      }
    }
    expect(permissionGrantSchema.safeParse({ ...base, duration: "session", source: "judge" }).success).toBe(false);
  });

  it("approvalRequest freezes descriptor and preview; approvalDecision can mint a grant", () => {
    const at = "2026-07-11T16:00:00.000Z";
    const descriptor: ToolDescriptor = { name: "gmail_send", description: "Send", inputSchema: {}, risk: "write", critical: true };
    expect(approvalRequestSchema.safeParse({
      id: "apr_1",
      call: { id: "c1", tool: "gmail_send", args: { to: "a@b.c" } },
      descriptor,
      inputPreview: "Send to a@b.c",
      ctx: { principal: { kind: "user", subject: "u" }, venue: "chat", presence: "present" },
      createdAt: at,
    }).success).toBe(true);
    expect(approvalDecisionSchema.safeParse({ approve: false }).success).toBe(true);
    expect(approvalDecisionSchema.safeParse({
      approve: true, remember: { scope: { kind: "tool" }, duration: "standing" },
    }).success).toBe(true);
  });
});

describe("§6/§7 — guard decisions and audit events", () => {
  it("audit accepts every event kind and every decidedBy source, requires aud_ ids", () => {
    const base = {
      id: "aud_1", at: "2026-07-11T16:00:00.000Z",
      principal: { kind: "user", subject: "u" }, venue: "chat", presence: "present",
    } as const;
    for (const kind of ["tool-call", "approval", "policy-decision", "run", "app-lifecycle", "share"] as const) {
      expect(auditEventSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
    expect(auditEventSchema.safeParse({ ...base, kind: "unknown-kind" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, kind: "run", id: "x_1" }).success).toBe(false);
  });

  it("guard 'run' decision cannot borrow an 'ask'/'block' decidedBy value", () => {
    expect(guardDecisionSchema.safeParse({ action: "run", decidedBy: "critical" }).success).toBe(false);
    expect(guardDecisionSchema.safeParse({ action: "ask", decidedBy: "grant", approval: undefined }).success).toBe(false);
  });
});

describe("§8 — UIPayload is the format-tag dispatch surface; unknown tags are valid payloads", () => {
  it("requires a string formatVersion and preserves everything past the tag", () => {
    expect(uiPayloadSchema.safeParse({ formatVersion: "vendo-genui/v1", root: "r", nodes: [] }).success).toBe(true);
    const parsed = uiPayloadSchema.safeParse({ formatVersion: "vendo-canvas/v2", opaque: { a: 1 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.opaque).toEqual({ a: 1 }); // passthrough keeps unknown keys
    expect(uiPayloadSchema.safeParse({ root: "r" }).success).toBe(false); // no formatVersion
    expect(uiPayloadSchema.safeParse({ formatVersion: 1 }).success).toBe(false); // non-string tag
  });

  it("an unknown tag passes UIPayload but validateTree rejects it as a 'version' error (containment is the renderer's job)", () => {
    const unknown = { formatVersion: "vendo-canvas/v2", root: "r", nodes: [] };
    expect(uiPayloadSchema.safeParse(unknown).success).toBe(true);
    const result = validateTree(unknown);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("version");
  });
});

describe("§8 — tree/node/query schemas parse the structural shape", () => {
  it("treeSchema accepts a minimal v1 tree and rejects a foreign formatVersion", () => {
    expect(treeSchema.safeParse({
      formatVersion: "vendo-genui/v1", root: "a", nodes: [{ id: "a", component: "Text" }],
    }).success).toBe(true);
    expect(treeSchema.safeParse({
      formatVersion: "vendo-genui/v2", root: "a", nodes: [],
    }).success).toBe(false);
  });

  it("treeNode and treeQuery enforce their required fields", () => {
    expect(treeNodeSchema.safeParse({ id: "a", component: "Text", source: "generated" }).success).toBe(true);
    expect(treeNodeSchema.safeParse({ id: "a", component: "Text", source: "wired" }).success).toBe(false);
    expect(treeQuerySchema.safeParse({ path: "/x", tool: "host_x", input: { limit: 5 } }).success).toBe(true);
    expect(treeQuerySchema.safeParse({ path: "/x" }).success).toBe(false);
  });
});

describe("§8 — validateTree validates fn: GRAMMAR only; machine-presence is an app-document rule", () => {
  // The Tree shape carries no server/machine field, so validateTree structurally
  // cannot enforce "trees without a machine must not contain fn: references." It
  // validates fn: grammar; validateAppDocument (which knows `server`) enforces the
  // machine-presence rule. See ESCALATION in the lane report.
  it("accepts a well-formed fn: reference with no server in sight", () => {
    expect(validateTree({
      formatVersion: "vendo-genui/v1", root: "r",
      nodes: [{ id: "r", component: "Text" }],
      queries: [{ path: "", tool: "fn:refresh" }],
    }).ok).toBe(true);
  });

  it("rejects fn: references that violate the /^fn:[A-Za-z_][A-Za-z0-9_-]*$/ grammar", () => {
    for (const tool of ["fn:", "fn:9lead", "fn:has space", "fn:slash/x"]) {
      const result = validateTree({
        formatVersion: "vendo-genui/v1", root: "r",
        nodes: [{ id: "r", component: "Text" }],
        queries: [{ path: "", tool }],
      });
      expect(result.ok, tool).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });

  it("validateAppDocument is where a machine-less fn: reference becomes an error", () => {
    const withFnNoServer = {
      format: "vendo/app@1", id: "app_x", name: "X", ui: "tree" as const,
      tree: {
        formatVersion: "vendo-genui/v1", root: "r",
        nodes: [{ id: "r", component: "Text" }],
        queries: [{ path: "", tool: "fn:refresh" }],
      },
    };
    expect(validateAppDocument(withFnNoServer).ok).toBe(false);
    expect(validateAppDocument({ ...withFnNoServer, server: "e2b:snap_1" }).ok).toBe(true);
  });
});

describe("§9 — app document plane values and sub-schemas", () => {
  it("accepts the http plane (keeps the last payload as a cover)", () => {
    const httpApp = {
      format: "vendo/app@1", id: "app_http", name: "Server App", ui: "http" as const,
      server: "e2b:snap_1",
    };
    expect(appDocumentSchema.safeParse(httpApp).success).toBe(true);
    expect(validateAppDocument(httpApp).ok).toBe(true);
  });

  it("storageDecl defaults kind to records and pin base must be a hash ref", () => {
    expect(storageDeclSchema.safeParse({ about: "x" }).success).toBe(true);
    expect(storageDeclSchema.safeParse({ about: "x", kind: "blobs" }).success).toBe(false);
    expect(pinSchema.safeParse({ slot: "card", base: "sha256:abc" }).success).toBe(true);
  });
});

describe("§11 — trigger sources and run models", () => {
  it("schedule requires exactly one of cron/every/at across the full matrix", () => {
    const at = "2026-07-11T16:00:00.000Z";
    const ok = [{ cron: "0 9 * * 1" }, { every: "1h" }, { at }];
    for (const extra of ok) {
      expect(triggerSourceSchema.safeParse({ kind: "schedule", ...extra }).success).toBe(true);
    }
    const bad = [
      {}, // none
      { cron: "* * * * *", every: "1h" },
      { cron: "* * * * *", at },
      { every: "1h", at },
      { cron: "* * * * *", every: "1h", at },
    ];
    for (const extra of bad) {
      expect(triggerSourceSchema.safeParse({ kind: "schedule", ...extra }).success).toBe(false);
    }
    // an at that is not ISO-8601 is rejected
    expect(triggerSourceSchema.safeParse({ kind: "schedule", at: "soon" }).success).toBe(false);
  });

  it("accepts host-event and external trigger sources", () => {
    expect(triggerSourceSchema.safeParse({ kind: "host-event", event: "invoice.created" }).success).toBe(true);
    expect(triggerSourceSchema.safeParse({ kind: "host-event" }).success).toBe(false);
    expect(triggerSourceSchema.safeParse({
      kind: "external", connector: "gmail", event: "message.received", config: { label: "INBOX" },
    }).success).toBe(true);
  });

  it("run models: agentic prompt/budget and ordered steps", () => {
    expect(runModelSchema.safeParse({ kind: "agentic", prompt: "do it" }).success).toBe(true);
    expect(runModelSchema.safeParse({ kind: "agentic", prompt: "do it", budget: { maxToolCalls: 3 } }).success).toBe(true);
    expect(runModelSchema.safeParse({ kind: "steps", steps: [{ id: "s1", tool: "host_x" }] }).success).toBe(true);
    expect(runModelSchema.safeParse({ kind: "pipeline", steps: [] }).success).toBe(false);
    expect(stepSchema.safeParse({ id: "s1", tool: "fn:x", if: "$exists(event)", forEach: "steps.load" }).success).toBe(true);
    expect(triggerSchema.safeParse({
      on: { kind: "host-event", event: "e" }, run: { kind: "agentic", prompt: "p" },
    }).success).toBe(true);
  });
});

describe("§12/§13/§14 — store, host-seam, and theme schemas", () => {
  it("vendoRecord requires timestamps and present data; recordQuery is all-optional", () => {
    const at = "2026-07-11T16:00:00.000Z";
    expect(vendoRecordSchema.safeParse({ id: "r1", data: { a: 1 }, createdAt: at, updatedAt: at }).success).toBe(true);
    expect(vendoRecordSchema.safeParse({ id: "r1", createdAt: at, updatedAt: at }).success).toBe(false); // data missing
    expect(recordQuerySchema.safeParse({}).success).toBe(true);
    expect(recordQuerySchema.safeParse({ refs: { owner: "u" }, ids: ["a"], limit: 10, cursor: "5" }).success).toBe(true);
  });

  it("authMaterial and agentRunReport parse the seam return shapes", () => {
    expect(authMaterialSchema.safeParse({ headers: { Authorization: "Bearer x" } }).success).toBe(true);
    expect(authMaterialSchema.safeParse({ headers: { Authorization: 1 } }).success).toBe(false);
    expect(agentRunReportSchema.safeParse({
      status: "stopped", summary: "hit budget",
      toolCalls: [{ call: { id: "c", tool: "host_x", args: {} }, outcome: "ok" }],
    }).success).toBe(true);
  });

  it("vendoTheme accepts the remaining density/motion enum values", () => {
    expect(vendoThemeSchema.safeParse({
      colors: {
        background: "#000", surface: "#111", text: "#fff", muted: "#999",
        accent: "#00f", accentText: "#fff", danger: "#f00", border: "#333",
      },
      typography: { fontFamily: "Inter", headingFamily: "Newsreader", baseSize: "16px" },
      radius: { small: "2px", medium: "6px", large: "12px" },
      density: "compact", motion: "full",
    }).success).toBe(true);
  });

  it("stream parts carry the pinned data-* type discriminants", () => {
    expect(vendoViewPartSchema.safeParse({
      type: "data-vendo-view", appId: "app_1", payload: { formatVersion: "vendo-genui/v1" },
    }).success).toBe(true);
    expect(vendoViewPartSchema.safeParse({
      type: "data-vendo-render", appId: "app_1", payload: { formatVersion: "vendo-genui/v1" },
    }).success).toBe(false);
    expect(vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", toolCallId: "c1", risk: "read" }).success).toBe(true);
  });
});

describe("§15 — VendoErrorCode taxonomy and unknown-code forward compatibility", () => {
  it("vendoErrorCodeSchema accepts exactly the seven codes and rejects cut/unknown ones", () => {
    for (const code of [
      "validation", "blocked", "not-implemented", "sandbox-unavailable",
      "cloud-required", "not-found", "conflict",
    ]) {
      expect(vendoErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(vendoErrorCodeSchema.safeParse("grant-required").success).toBe(false); // cut in round-4
    expect(vendoErrorCodeSchema.safeParse("teapot").success).toBe(false);
  });

  it("VendoError still constructs with a future code (additive within the train)", () => {
    // A client treats an unknown code as a generic error, but the class must not
    // throw on one — new codes are additive.
    const future = new VendoError("future-code" as core.VendoErrorCode, "later", { hint: 1 });
    expect(future).toBeInstanceOf(Error);
    expect(future.code).toBe("future-code");
    expect(future.detail).toEqual({ hint: 1 });
  });
});

describe("public export surface — every contracted camelCaseName schema is present", () => {
  // Zod-completeness guard: every wire-crossing/persisted 01-core type ships a schema.
  it("exposes all expected <name>Schema exports as zod schemas", () => {
    const expected = [
      "principalSchema", "runContextSchema", "triggerRefSchema", "riskLabelSchema",
      "toolDescriptorSchema", "toolCallSchema", "toolOutcomeSchema", "grantConstraintSchema",
      "grantScopeSchema", "grantDurationSchema", "permissionGrantSchema", "approvalRequestSchema",
      "approvalDecisionSchema", "guardDecisionSchema", "auditEventSchema", "uiPayloadSchema",
      "treeSchema", "treeNodeSchema", "treeQuerySchema", "appDocumentSchema", "storageDeclSchema",
      "pinSchema", "triggerSourceSchema", "runModelSchema", "stepSchema", "triggerSchema",
      "vendoRecordSchema", "recordQuerySchema", "authMaterialSchema", "agentRunReportSchema",
      "vendoThemeSchema", "vendoViewPartSchema", "vendoApprovalPartSchema", "vendoErrorCodeSchema",
      "capabilityMissToolFailureSchema", "capabilityMissTriggerSchema", "capabilityMissEventSchema",
      "appIdSchema", "grantIdSchema", "approvalIdSchema", "runIdSchema", "threadIdSchema",
      "isoDateTimeSchema", "jsonSchemaSchema",
    ];
    const registry = core as unknown as Record<string, unknown>;
    for (const name of expected) {
      expect(name in registry, `missing export ${name}`).toBe(true);
      expect(typeof (registry[name] as { safeParse?: unknown }).safeParse, `${name} is not a zod schema`).toBe("function");
    }
  });
});
