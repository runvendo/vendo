import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { appVersionHash, pinComponentName } from "@vendoai/apps";
import type { AppDocument, Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

const scriptedModel = (responses: string[]): LanguageModel => {
  let call = 0;
  const next = (): string => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (response === undefined) throw new Error("scripted model exhausted");
    return response;
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-review-fixture",
    modelId: "vendo-review-fixture-v1",
    supportedUrls: {},
    async doGenerate(_call: ModelCall) {
      return {
        content: [{ type: "text" as const, text: next() }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(_call: ModelCall) {
      const text = next();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: text });
            controller.enqueue({ type: "text-end", id: "text_1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
};

const USER_HEADER = "x-fixture-user";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `as` = a host-resolved principal subject; omit it for an anonymous caller. */
const request = (method: string, path: string, options: { as?: string; body?: unknown } = {}): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.as === undefined ? {} : { [USER_HEADER]: options.as }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

describe.sequential("remix W1c — the review-kind lifecycle through the real umbrella", () => {
  it("fork is invisible until approved; reject sends the note back; approval swaps versions natively", async () => {
    // A review-kind host slot, captured by the REAL sync from <Remixable review>.
    const root = await mkdtemp(join(tmpdir(), "vendo-review-journey-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    const hostSource = `export default function TransferPanel() {
  return <form><span>Transfer</span><button>Send</button></form>;
}\n`;
    await writeFile(join(root, "src", "TransferPanel.tsx"), hostSource);
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import TransferPanel from "./TransferPanel";
export default function Page() {
  return <Remixable review><TransferPanel /></Remixable>;
}
`);
    const synced = await vendoSync({ root, out: join(root, ".vendo") });
    expect(synced.pins.captured).toEqual(["TransferPanel"]);
    // W1a handoff: sync wrote the kind into the baseline file.
    const baseline = JSON.parse(await readFile(join(root, ".vendo", "remixable", "TransferPanel.json"), "utf8")) as { review?: boolean };
    expect(baseline.review).toBe(true);

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    const user = "user_ada";
    const reviewer = "host_reviewer";
    const vendo = createVendo({
      model: scriptedModel([
        '<Edit><SetName name="Transfer remix v2"/></Edit>',
        '<Edit><SetName name="Transfer remix v3"/></Edit>',
      ]),
      // Host-resolved principal from the fixture header; absent = anonymous
      // (the wire mints an ephemeral session — the "non-admin" caller).
      principal: async (req): Promise<Principal | null> => {
        const subject = req.headers.get(USER_HEADER);
        return subject === null ? null : { kind: "user", subject };
      },
      store,
      development: true,
      // Round-2 hardening: reviewing takes the composition's explicit
      // assertion — even a dev composition never infers it from a principal.
      apps: { review: { reviewer: (ctx) => ctx.principal.subject === reviewer } },
    });

    // 1. The user's Remix gesture forks the review-kind slot.
    const forkResponse = await vendo.handler(request("POST", "/apps/fork-pin", { as: user, body: { slot: "TransferPanel" } }));
    expect(forkResponse.status).toBe(200);
    const fork = await forkResponse.json() as { app: AppDocument };
    const appId = fork.app.id;
    const v1Hash = appVersionHash(fork.app);

    // 2. Unapproved: the user gets the pending state and the ORIGINAL — the
    // payload ships no fork source, so a jailed render can never occur.
    const pending = await (await vendo.handler(request("GET", `/apps/${appId}/open`, { as: user }))).json();
    expect(pending.kind).toBe("tree");
    expect(pending.payload.inClient).toEqual({
      granted: false,
      versionHash: v1Hash,
      reason: "pending-review",
      review: { status: "pending", versionHash: v1Hash },
    });
    expect(pending.components).toBeUndefined();
    expect(pending.payload.components).toBeUndefined();
    expect(pending.payload.furnishings).toBeUndefined();

    // 3. The review queue: the ASSERTED reviewer sees the submission with the
    // ship-diff; an anonymous caller gets nothing (masked).
    const queueResponse = await vendo.handler(request("GET", "/apps/review-queue", { as: reviewer }));
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      appId,
      requester: user,
      slot: "TransferPanel",
      versionHash: v1Hash,
      resubmissions: 0,
      shipDiff: { appId, versionHash: v1Hash },
    });
    expect(queue[0].submittedAt).toEqual(expect.any(String));
    const masked = await vendo.handler(request("GET", "/apps/review-queue"));
    expect(masked.status).toBe(200);
    expect(await masked.json()).toEqual([]);
    // A host-resolved NON-reviewer sees only their own submissions — the
    // owner their own item, anyone else nothing (never another user's fork
    // source) — and their reject is masked like any unowned app.
    const ownItems = await (await vendo.handler(request("GET", "/apps/review-queue", { as: user }))).json();
    expect(ownItems).toHaveLength(1);
    expect(ownItems[0]).toMatchObject({ appId, requester: user });
    expect(await (await vendo.handler(request("GET", "/apps/review-queue", { as: "user_bob" }))).json()).toEqual([]);
    expect((await vendo.handler(request("POST", `/apps/${appId}/reject-review`, { as: "user_bob", body: { note: "nope" } }))).status).toBe(404);
    // WITHOUT the reviewer assertion a dev composition serves no cross-owner
    // review capability at all: own items only, and reject refuses loudly,
    // naming the hook to set.
    const unasserted = createVendo({
      principal: async (req): Promise<Principal | null> => {
        const subject = req.headers.get(USER_HEADER);
        return subject === null ? null : { kind: "user", subject };
      },
      store,
      development: true,
    });
    expect(await (await unasserted.handler(request("GET", "/apps/review-queue", { as: reviewer }))).json()).toEqual([]);
    const unassertedReject = await unasserted.handler(request("POST", `/apps/${appId}/reject-review`, { as: reviewer, body: { note: "nope" } }));
    expect(unassertedReject.status).toBe(403);
    expect(((await unassertedReject.json()) as { error: { message: string } }).error.message).toContain("apps.review.reviewer");
    // The seam carries the in-client approval seam's FULL scoping: outside a
    // development composition it is masked for EVERY caller — production
    // reviews ride Cloud's console or the self-hoster's own admin route over
    // the runtime surface, never this door.
    const production = createVendo({
      principal: async (req): Promise<Principal | null> => {
        const subject = req.headers.get(USER_HEADER);
        return subject === null ? null : { kind: "user", subject };
      },
      store,
    });
    expect(await (await production.handler(request("GET", "/apps/review-queue", { as: reviewer }))).json()).toEqual([]);
    expect((await production.handler(request("POST", `/apps/${appId}/reject-review`, { as: reviewer, body: { note: "nope" } }))).status).toBe(404);

    // 4. Rejection: the note is required; an anonymous caller is masked out.
    const noteless = await vendo.handler(request("POST", `/apps/${appId}/reject-review`, { as: reviewer, body: {} }));
    expect(noteless.status).toBe(400);
    const anonymous = await vendo.handler(request("POST", `/apps/${appId}/reject-review`, { body: { note: "nope" } }));
    expect(anonymous.status).toBe(404);
    const rejected = await vendo.handler(request("POST", `/apps/${appId}/reject-review`, {
      as: reviewer,
      body: { note: "Keep the send button label exactly as shipped." },
    }));
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      appId,
      versionHash: v1Hash,
      note: "Keep the send button label exactly as shipped.",
      by: reviewer,
    });

    // The queue drops it; the note reaches the user's panel; work survives.
    expect(await (await vendo.handler(request("GET", "/apps/review-queue", { as: reviewer }))).json()).toEqual([]);
    const noted = await (await vendo.handler(request("GET", `/apps/${appId}/open`, { as: user }))).json();
    expect(noted.payload.inClient.review).toMatchObject({
      status: "rejected",
      note: "Keep the send button label exactly as shipped.",
      by: reviewer,
    });

    // 5. The user edits → the new version supersedes the rejection and the
    // resubmission count increments.
    const editResponse = await vendo.handler(request("POST", `/apps/${appId}/edit`, { as: user, body: { instruction: "Rename it" } }));
    expect(editResponse.status).toBe(200);
    const edited = await editResponse.json() as { app: AppDocument; failure?: unknown };
    expect(edited.failure).toBeUndefined();
    const v2Hash = appVersionHash(edited.app);
    const resubmitted = await (await vendo.handler(request("GET", "/apps/review-queue", { as: reviewer }))).json();
    expect(resubmitted).toHaveLength(1);
    expect(resubmitted[0]).toMatchObject({ appId, versionHash: v2Hash, resubmissions: 1 });

    // 6. Approval grants the native venue for exactly that hash — the fork
    // now ships, in place, as real code. Never from the remixing user
    // themselves though, even on this dev seam: approval IS the review.
    const selfApproved = await vendo.handler(request("POST", "/dev/inclient-approval", {
      as: user,
      body: { appId, approvedBy: "host-security-review" },
    }));
    expect(selfApproved.status).toBe(403);
    expect(((await selfApproved.json()) as { error: { message: string } }).error.message).toContain("apps.review.reviewer");
    const approved = await vendo.handler(request("POST", "/dev/inclient-approval", {
      as: reviewer,
      body: { appId, approvedBy: "host-security-review" },
    }));
    expect(approved.status).toBe(200);
    const granted = await (await vendo.handler(request("GET", `/apps/${appId}/open`, { as: user }))).json();
    expect(granted.payload.inClient).toMatchObject({
      granted: true,
      versionHash: v2Hash,
      approvedBy: "host-security-review",
    });
    expect(granted.payload.inClient.review).toBeUndefined();
    const componentName = pinComponentName("TransferPanel");
    expect(granted.components?.[componentName]).toContain("TransferPanel");

    // 7. Another edit: the LAST approved version keeps rendering natively
    // while the new one is pending — never a gap, never unreviewed code.
    const reEdited = await (await vendo.handler(request("POST", `/apps/${appId}/edit`, { as: user, body: { instruction: "Rename again" } }))).json() as { app: AppDocument };
    const v3Hash = appVersionHash(reEdited.app);
    const during = await (await vendo.handler(request("GET", `/apps/${appId}/open`, { as: user }))).json();
    expect(during.payload.inClient).toMatchObject({
      granted: true,
      versionHash: v2Hash,
      review: { status: "pending", versionHash: v3Hash },
    });
    expect(during.components?.[componentName]).toContain("TransferPanel");
    // ...and the pending version is back in the reviewer's queue.
    const pendingAgain = await (await vendo.handler(request("GET", "/apps/review-queue", { as: reviewer }))).json();
    expect(pendingAgain[0]).toMatchObject({ appId, versionHash: v3Hash, resubmissions: 1 });

    // 8. Approving the new version swaps it in.
    await vendo.handler(request("POST", "/dev/inclient-approval", { as: reviewer, body: { appId, approvedBy: "host-security-review" } }));
    const swapped = await (await vendo.handler(request("GET", `/apps/${appId}/open`, { as: user }))).json();
    expect(swapped.payload.inClient).toMatchObject({ granted: true, versionHash: v3Hash });
    expect(swapped.payload.inClient.review).toBeUndefined();
  }, 120_000);
});
