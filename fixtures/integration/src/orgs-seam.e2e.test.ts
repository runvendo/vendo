/** kill-list A5 — orgs are a Vendo Cloud capability, never an OSS wire route.
 *
 * The org lifecycle (create/membership/role ladder/app transfer) used to be
 * OSS machinery gated on a console-side org check (ENG-263; that validate
 * endpoint no longer exists). It moved to Vendo Cloud entirely (data-residency,
 * 2026-07-16); the OSS wire keeps only the posture seam: every `/orgs` route
 * — list, create, and deep member/app subpaths alike — answers
 * `cloud-required` unconditionally, whether or not `VENDO_API_KEY` is set.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ADA, createStack, resetFixture, type Stack } from "./harness.js";

const KEY = `vnd_${"f".repeat(40)}`;

let stack: Stack;
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  await stack?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function expectCloudRequired(current: Stack, path: string, init?: RequestInit): Promise<void> {
  const response = await current.wireFetch(path, init, ADA);
  expect(response.status).toBe(402);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("cloud-required");
}

describe("kill-list A5: /orgs is a cloud-required seam, not an OSS route", () => {
  it("answers cloud-required on the list/create route and a deep member route without a key", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", undefined);
    stack = await createStack();

    await expectCloudRequired(stack, "/orgs");
    await expectCloudRequired(stack, "/orgs", { method: "POST", body: JSON.stringify({ name: "Acme" }) });
    await expectCloudRequired(stack, "/orgs/org_x/members", {
      method: "POST",
      body: JSON.stringify({ subject: "user_bob" }),
    });
  });

  it("answers cloud-required the same way with a VENDO_API_KEY set — the seam is unconditional", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", KEY);
    stack = await createStack();

    await expectCloudRequired(stack, "/orgs");
    await expectCloudRequired(stack, "/orgs", { method: "POST", body: JSON.stringify({ name: "Acme" }) });
    await expectCloudRequired(stack, "/orgs/org_x/members", {
      method: "POST",
      body: JSON.stringify({ subject: "user_bob" }),
    });
  });

  it("answers cloud-required for an org-scoped approvals/grants query, key or no key", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", undefined);
    stack = await createStack();

    await expectCloudRequired(stack, "/approvals?org=org_x");
    await expectCloudRequired(stack, "/grants?org=org_x");
    await expectCloudRequired(stack, "/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ ids: ["apr_1"], decision: { approve: true }, org: "org_x" }),
    });
  });
});
