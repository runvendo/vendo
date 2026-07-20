/**
 * An in-page VendoClient over the static wire payload fixtures — the
 * playground's replacement for the live wire. Reads answer from fixture
 * state; mutations update that state in memory so flows (approve, dismiss,
 * disconnect) behave; streaming never lands here because every scenario mounts
 * the ScriptedTransport at the provider seam.
 */
import { VendoError, type AppDocument } from "@vendoai/core";
import type { VendoClient } from "@vendoai/ui";
import type { PlaygroundFixtures } from "./fixtures.js";

export function createFakeClient(fixtures: PlaygroundFixtures): VendoClient {
  const state = {
    threads: [...fixtures.threads],
    apps: [...fixtures.apps],
    automations: fixtures.automations.map((entry) => ({ ...entry })),
    connections: [...fixtures.connections],
    approvals: [...fixtures.approvals],
    grants: [...fixtures.grants],
    runs: [...fixtures.runs],
  };

  const app = (id: string): AppDocument => {
    const found = state.apps.find((candidate) => candidate.id === id);
    if (!found) throw new VendoError("not-found", `Unknown app ${id}`);
    return found;
  };

  return {
    baseUrl: "playground:fake",
    headers: {},

    threads: {
      // Streaming rides the scripted transport (the provider override); the
      // playground never opens a live turn stream.
      stream: async () => new Response(null, { status: 501 }),
      list: async () => state.threads.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      get: async (id) => {
        const found = state.threads.find((candidate) => candidate.id === id);
        if (!found) throw new VendoError("not-found", `Unknown thread ${id}`);
        return found.thread;
      },
      delete: async (id) => {
        state.threads = state.threads.filter((candidate) => candidate.id !== id);
      },
    },

    approvals: {
      pending: async () => [...state.approvals],
      decide: async (ids) => {
        const decided = new Set(Array.isArray(ids) ? ids : [ids]);
        state.approvals = state.approvals.filter((approval) => !decided.has(approval.id));
      },
    },

    grants: {
      list: async () => [...state.grants],
      revoke: async (id) => {
        state.grants = state.grants.filter((grant) => grant.id !== id);
      },
    },

    connections: {
      list: async () => [...state.connections],
      // The scripted catalog mirrors the scenarios' explicit connectors prop;
      // surfaces resolving in auto mode see the same two toolkits.
      catalog: async () => [
        { toolkit: "slack", connector: "composio" },
        { toolkit: "github", connector: "composio" },
      ],
      initiate: async ({ toolkit, connector }) => ({
        id: `conn_${toolkit}_new`,
        connector: connector ?? "composio",
        // A same-page anchor: nothing to OAuth against in the playground.
        redirectUrl: "#connected",
      }),
      status: async (id) => {
        const found = state.connections.find((candidate) => candidate.id === id);
        return found ?? { id, connector: "composio", toolkit: "slack", status: "active" };
      },
      disconnect: async (id) => {
        state.connections = state.connections.filter((candidate) => candidate.id !== id);
      },
    },

    apps: {
      list: async () => [...state.apps],
      create: async ({ prompt }) => {
        const created: AppDocument = {
          format: "vendo/app@1",
          id: `app_created_${state.apps.length + 1}`,
          name: prompt.slice(0, 40) || "New app",
          description: `Scripted playground app for “${prompt}”.`,
          ui: "tree",
          tree: state.apps[0]?.tree,
        };
        state.apps.push(created);
        return created;
      },
      get: async (id) => app(id),
      delete: async (id) => {
        state.apps = state.apps.filter((candidate) => candidate.id !== id);
      },
      open: async (id) => {
        const document = app(id);
        if (!document.tree) throw new VendoError("validation", `App ${id} has no tree surface`);
        return { kind: "tree", payload: document.tree };
      },
      call: async () => ({ status: "ok", output: { ok: true } }),
      pingMachine: async () => ({ state: "awake" }),
      edit: async (id) => ({ app: app(id), version: { at: new Date().toISOString(), intent: "edit", rung: 2 } }),
      history: async () => [{ at: "2026-07-18T09:05:30.000Z", intent: "create", rung: 2 }],
      undo: async (id) => app(id),
      exportApp: async (id) => new TextEncoder().encode(JSON.stringify(app(id))),
      importApp: async (bytes) => {
        const imported = JSON.parse(new TextDecoder().decode(bytes)) as AppDocument;
        state.apps.push(imported);
        return imported;
      },
      fork: async (id) => {
        const source = app(id);
        const fork: AppDocument = { ...source, id: `${source.id}_fork`, name: `${source.name} (fork)`, forkedFrom: source.id };
        state.apps.push(fork);
        return fork;
      },
      shipDiff: async (id) => ({ appId: id, versionHash: "sha256:playground", pins: [], generated: [] }),
      pinDrift: async () => [],
      rebasePin: async (id, slot) => ({
        status: "rebased",
        app: app(id),
        version: { at: new Date().toISOString(), intent: "rebase", rung: 2 },
        slot,
        baseHash: "sha256:playground",
        replayed: [],
      }),
    },

    automations: {
      list: async () => state.automations.map((entry) => ({ ...entry })),
      enable: async (id) => {
        const entry = state.automations.find((candidate) => candidate.app.id === id);
        if (entry) entry.enabled = true;
        return { enabled: true, missing: [] };
      },
      disable: async (id) => {
        const entry = state.automations.find((candidate) => candidate.app.id === id);
        if (entry) entry.enabled = false;
      },
      dryRun: async () => ({
        steps: [
          { id: "step_1", tool: "host_listRenewals", wouldAsk: false },
          { id: "step_2", tool: "slack_SLACK_SEND_MESSAGE", wouldAsk: true },
        ],
        grantsMissing: [],
      }),
    },

    runs: {
      list: async (filter) => ({
        runs: state.runs.filter((run) => (filter?.appId === undefined ? true : run.appId === filter.appId)),
      }),
      get: async (id) => {
        const found = state.runs.find((run) => run.id === id);
        if (!found) throw new VendoError("not-found", `Unknown run ${id}`);
        return found;
      },
      stop: async () => undefined,
    },

    activity: {
      list: async () => [...fixtures.activity],
    },

    status: async () => fixtures.status,
  };
}
