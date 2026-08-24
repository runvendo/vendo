/**
 * SEAM: the upload door WRITES and the shell READS, with no stub between them.
 *
 * Both halves are the shipped ones — a real `POST /files` request through
 * `vendo.handler`, and a real `bash` call through `vendo.guardedTools`, which is
 * the same guard-bound registry a turn executes on. A harness that mocked either
 * side could never catch the two disagreeing about where the bytes are.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import {
  UPLOAD_HEADER,
  VENDO_BASH_TOOL,
  type PermissionGrant,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-shell-seam-secret-with-entropy";
const SUBJECT = "host_sam";
const principal: Principal = { kind: "user", subject: SUBJECT };

const grant: PermissionGrant = {
  id: "grt_shell_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:shell-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-23T00:00:00.000Z",
};

async function bearer(): Promise<Record<string, string>> {
  const mint = genericJwtPreset({ secret: SECRET });
  return (await mint(principal, grant))!.headers;
}

async function compose(): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-shell-seam-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return createVendo({ store, auth: jwt({ secret: SECRET }) });
}

const upload = (deployment: Vendo, name: string, body: string, headers: Record<string, string>) =>
  deployment.handler(new Request(`https://host.test/api/vendo/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "text/csv", [UPLOAD_HEADER]: "1", ...headers },
    body: new TextEncoder().encode(body) as BodyInit,
  }));

const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_shell_seam",
  // `trn_` + exactly 32 hex (ids.ts:69) — the guard writes a real audit row for
  // this call and `auditEventSchema` rejects anything else.
  turnId: `trn_${"0".repeat(28)}5ea1`,
};

const run = async (deployment: Vendo, command: string): Promise<{ stdout: string; exitCode: number }> => {
  const outcome = await deployment.guardedTools.execute(
    { id: `call_${Math.random().toString(36).slice(2)}`, tool: VENDO_BASH_TOOL, args: { command } },
    ctx,
  );
  expect(outcome.status).toBe("ok");
  return (outcome as { output: { stdout: string; exitCode: number } }).output;
};

describe("SEAM — what the upload door writes, the shell reads", () => {
  it("greps a file that arrived over the wire seconds earlier", async () => {
    const deployment = await compose();
    const headers = await bearer();
    const response = await upload(
      deployment,
      "ledger.csv",
      "month,revenue\njan,31000\nfeb,39000\nmar,28000\n",
      headers,
    );
    const { path } = await response.json() as { path: string };

    const counted = await run(deployment, `wc -l < ${path}`);
    expect(counted.exitCode).toBe(0);
    expect(counted.stdout.trim()).toBe("4");

    // `awk`, not `bc`: just-bash 3.4.2 ships no `bc`.
    const summed = await run(deployment, `tail -n +2 ${path} | cut -d, -f2 | awk '{t+=$1} END {print t}'`);
    expect(summed.stdout.trim()).toBe("98000");
  });

  it("writes a file the workspace keeps, readable through the workspace door", async () => {
    const deployment = await compose();
    const uploaded = await upload(deployment, "ledger.csv", "month,revenue\njan,31000\nfeb,39000\n", await bearer());
    const { path: staged } = await uploaded.json() as { path: string };
    expect(staged).toMatch(/^\/user\/uploads\/[0-9a-f]{8}-ledger\.csv$/);

    const written = await run(
      deployment,
      `mkdir -p /user/files && tail -n +2 ${staged} | sort -t, -k2 -nr > /user/files/ranked.csv`,
    );
    expect(written.exitCode).toBe(0);

    // The REAL read path, through a workspace opened AFTER the tool call.
    const workspace = await deployment.harness.workspace(principal);
    expect(await workspace.readFile("/user/files/ranked.csv")).toBe("feb,39000\njan,31000\n");
  });
});
