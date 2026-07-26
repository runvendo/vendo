// Chip tap interception: exact chip prompt + cached app ⇒ an instant-attach
// streamed turn; anything else (unknown prompt, signed-out, erased cache) ⇒
// null so the REAL agent generates with its normal progress UI.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

const state = {
  session: { subject: "vendo-demo", display: "Yousef Helal", email: "yousef@maple.com" } as
    | { subject: string; display: string; email: string }
    | null,
  manifest: [{ key: "subs", prompt: "Build me a subscriptions tracker", appId: "app_gen_1" }],
  apps: new Map<string, { format: string; id: string; name: string }>([
    ["app_gen_1", { format: "vendo/app@1", id: "app_gen_1", name: "Subscriptions tracker" }],
  ]),
  threads: new Map<string, { id: string; data: unknown }>(),
};

vi.mock("@/vendo/auth", () => ({
  resolveMapleSession: async () => state.session,
}));
vi.mock("@/vendo/chips", () => ({
  readChipManifest: async (subject: string) => (subject === "vendo-demo" ? state.manifest : []),
}));
vi.mock("@/vendo/server", () => ({
  vendo: {
    apps: {
      get: async (appId: string) => state.apps.get(appId) ?? null,
      open: async (appId: string) =>
        state.apps.has(appId) ? { kind: "tree", payload: { nodes: [], components: {} } } : null,
    },
    store: {
      records: () => ({
        get: async (id: string) => state.threads.get(id) ?? null,
        put: async (record: { id: string; data: unknown }) => {
          state.threads.set(record.id, record);
          return record;
        },
      }),
    },
  },
}));

import { chipThreadsResponse } from "./chips-response";

function threadPost(text: string): Request {
  const message: UIMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text }],
  };
  return new Request("http://127.0.0.1/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

beforeEach(() => {
  state.session = { subject: "vendo-demo", display: "Yousef Helal", email: "yousef@maple.com" };
  state.apps.set("app_gen_1", { format: "vendo/app@1", id: "app_gen_1", name: "Subscriptions tracker" });
  state.threads.clear();
});

describe("chipThreadsResponse", () => {
  it("streams an instant attach for a cached chip prompt and persists the thread", async () => {
    const response = await chipThreadsResponse(threadPost("Build me a subscriptions tracker"));
    expect(response).not.toBeNull();
    const body = await response!.text();
    expect(body).toContain("data-vendo-view");
    expect(body).toContain("app_gen_1");
    expect(state.threads.size).toBe(1);
  });

  it("passes an unknown prompt through to the real agent", async () => {
    expect(await chipThreadsResponse(threadPost("Something else entirely"))).toBeNull();
  });

  it("cache miss (app erased) falls through to normal live generation", async () => {
    state.apps.delete("app_gen_1");
    expect(await chipThreadsResponse(threadPost("Build me a subscriptions tracker"))).toBeNull();
  });

  it("signed-out requests pass through untouched", async () => {
    state.session = null;
    expect(await chipThreadsResponse(threadPost("Build me a subscriptions tracker"))).toBeNull();
  });

  it("non-thread routes pass through", async () => {
    const request = new Request("http://127.0.0.1/api/vendo/apps", { method: "POST", body: "{}" });
    expect(await chipThreadsResponse(request)).toBeNull();
  });
});
