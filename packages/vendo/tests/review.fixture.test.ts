import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { appVersionHash } from "@vendoai/apps";
import {
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

interface ModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

/** The screen agent's own brief (`environmentNote`), verbatim — the one marker
 *  that says a prompt belongs to the assembly loop. An EDIT rides that loop now:
 *  there is one builder, and it answers by saving the whole rewritten document. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** `save_app`'s own reply, which is a tool RESULT rather than text — its presence
 *  is how this model knows the current run already saved. */
const SAVED_MARKER = "That save landed.";

/** The whole prompt as text, tool results included. */
const promptText = (call: ModelCall): string => JSON.stringify(call.prompt ?? "");

/**
 * Renames, as the one builder performs them: write this app's whole `app.tsx`
 * with the new title on it and save it. One save per assembly run, then a
 * closing word.
 */
const screenModel = (renames: string[]): LanguageModel => {
  let saves = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const saving = (prompt: string): boolean =>
    prompt.includes(SCREEN_BRIEF_MARKER) && !prompt.includes(SAVED_MARKER);
  const rewrite = (): string => {
    const rename = renames[Math.min(saves, renames.length - 1)];
    saves += 1;
    if (rename === undefined) throw new Error("scripted model exhausted");
    return `import { Stack, Text } from "@vendo/screen";

export default function TransferRemix() {
  return (
    <Stack>
      <Text text="${rename}" />
    </Stack>
  );
}
`;
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-review-fixture",
    modelId: "vendo-review-fixture-v1",
    supportedUrls: {},
    async doGenerate(modelCall: ModelCall) {
      if (!saving(promptText(modelCall))) {
        return { content: [{ type: "text" as const, text: "done" }], finishReason: "stop" as const, usage };
      }
      return {
        content: [{
          type: "tool-call" as const,
          toolCallId: "call_save_app",
          toolName: "save_app",
          input: JSON.stringify({ content: rewrite() }),
        }],
        finishReason: "tool-calls" as const,
        usage,
      };
    },
    async doStream(modelCall: ModelCall) {
      const content = saving(promptText(modelCall)) ? rewrite() : undefined;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (content === undefined) {
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "done" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
            } else {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call_save_app",
                toolName: "save_app",
                input: JSON.stringify({ content }),
              });
              controller.enqueue({ type: "finish", finishReason: "tool-calls", usage });
            }
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

/** `as` = a host-resolved principal subject; omit it for a caller the host
 *  resolves to no identity at all (which the wire refuses outright). */
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
  it("a seeded app is invisible until approved; reject sends the note back; approval swaps versions natively", async () => {
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
      model: screenModel(["Transfer remix v1", "Transfer remix v2", "Transfer remix v3"]),
      // Host-resolved principal from the fixture header; absent = no identity,
      // which the wire refuses with `forbidden`.
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

    // 1. The user's Remix gesture: the instruction rides with it, and the fork
    // and its first edit land as ONE operation.
    const seedResponse = await vendo.handler(request("POST", "/apps/seed", {
      as: user,
      body: { component: "TransferPanel", instruction: "Rename it" },
    }));
    expect(seedResponse.status).toBe(200);
    const seeded = await seedResponse.json() as AppDocument;
    const appId = seeded.id;
    const v1Hash = appVersionHash(seeded);

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
    // A caller the host resolves to NO identity is refused outright; the
    // masked-out cases below are real, unrelated subjects.
    const noIdentity = await vendo.handler(request("GET", "/apps/review-queue"));
    expect(noIdentity.status).toBe(403);
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

    // 4. Rejection: the note is required; a caller with no identity is refused.
    const noteless = await vendo.handler(request("POST", `/apps/${appId}/reject-review`, { as: reviewer, body: {} }));
    expect(noteless.status).toBe(400);
    const rejectNoIdentity = await vendo.handler(request("POST", `/apps/${appId}/reject-review`, { body: { note: "nope" } }));
    expect(rejectNoIdentity.status).toBe(403);
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
    // The remix IS its screen, so what ships is what that screen paints — and
    // the assertion names the version, because the version is the whole claim.
    expect(JSON.stringify(granted.payload.nodes)).toContain("Transfer remix v2");

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
    // v2's screen, NOT v3's — naming the version is the whole claim here: the last
    // APPROVED source keeps rendering while the new one waits, so unreviewed code
    // never ships.
    expect(JSON.stringify(during.payload.nodes)).toContain("Transfer remix v2");
    expect(JSON.stringify(during.payload.nodes)).not.toContain("Transfer remix v3");
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
