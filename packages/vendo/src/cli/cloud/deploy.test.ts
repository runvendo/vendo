import type { AppDocument, PermissionGrant, Principal } from "@vendoai/core";
import { appStore, createStore, grantStore } from "@vendoai/store";
import { describe, expect, it, vi } from "vitest";
import { CLI_VERSION } from "../shared.js";
import { CloudError, cloudFetch } from "./client.js";
import { readLocalProject, runDeploy } from "./deploy.js";

const trigger: NonNullable<AppDocument["trigger"]> = {
  on: { kind: "external", connector: "stripe", event: "invoice.paid" },
  run: { kind: "steps", steps: [{ id: "notify", tool: "host_notifications_send" }] },
};

function automation(id: string, secrets?: string[]): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: id,
    trigger,
    ...(secrets === undefined ? {} : { secrets }),
  };
}

function grant(
  id: string,
  appId: string,
  overrides: Partial<PermissionGrant> = {},
): PermissionGrant {
  return {
    id,
    subject: "user_a",
    tool: "host_notifications_send",
    descriptorHash: "sha256:test",
    scope: { kind: "tool" },
    duration: "standing",
    appId,
    source: "automation",
    grantedAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe("cloud deploy", () => {
  it("deploys enabled automations with their grants and explicitly provided referenced secrets", async () => {
    const enabled = automation("app_enabled", ["TOKEN", "MISSING"]);
    const disabled = automation("app_disabled");
    const ordinary: AppDocument = { format: "vendo/app@1", id: "app_view", name: "View" };
    const messages = output();
    const response = {
      org: { id: "org_1", slug: "acme" },
      instance: { status: "active" },
      applied: { apps: 1, grants: 1, secrets: 1 },
      webhooks: [{ app_id: "app_enabled", source: "stripe", url: "https://hooks.vendo.run/acme/app_enabled" }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(response, { status: 201 }));
    const fetcher = vi.fn((path: string, request = {}) => cloudFetch(path, { ...request, fetchImpl }));
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [
        { doc: enabled, enabled: true },
        { doc: disabled, enabled: false },
        { doc: ordinary, enabled: true },
      ],
      grants: [
        grant("grt_enabled", "app_enabled"),
        grant("grt_disabled", "app_disabled"),
        grant("grt_chat", "app_enabled", { source: "chat" }),
        grant("grt_other_subject", "app_enabled", { subject: "user_b" }),
      ],
    });

    expect(await runDeploy([
      "--key", "vnd_test", "--secret", "TOKEN=plain=value", "--secret", "UNUSED=ignored",
    ], {
      output: messages.sink,
      fetcher,
      env: {},
      localProjectReader,
    })).toBe(0);

    expect(fetcher).toHaveBeenCalledWith("/api/v1/hosted/deploy", expect.objectContaining({
      auth: "key",
      apiKey: "vnd_test",
      method: "POST",
      body: {
        apps: [{ doc: enabled, enabled: true }],
        grants: [grant("grt_enabled", "app_enabled")],
        secrets: [{ name: "TOKEN", value: "plain=value" }],
      },
    }));
    expect(fetchImpl).toHaveBeenCalledWith("https://console.vendo.run/api/v1/hosted/deploy", {
      method: "POST",
      headers: {
        accept: "application/json",
        "user-agent": `vendo-cli/${CLI_VERSION}`,
        "content-type": "application/json",
        authorization: "Bearer vnd_test",
        "x-vendo-deployment-host": expect.any(String),
        "x-vendo-deployment-name": expect.any(String),
      },
      body: JSON.stringify({
        apps: [{ doc: enabled, enabled: true }],
        grants: [grant("grt_enabled", "app_enabled")],
        secrets: [{ name: "TOKEN", value: "plain=value" }],
      }),
    });
    expect(messages.errors).toEqual([
      "Automation app_enabled references missing secret MISSING; pass --secret MISSING=VALUE",
    ]);
    expect(messages.logs.join("\n")).toContain("Vendo Cloud deploy: acme (active)");
    expect(messages.logs.join("\n")).toContain("APPLIED");
    expect(messages.logs.join("\n")).toContain("app_enabled  stripe  https://hooks.vendo.run/acme/app_enabled");
  });

  it("lets repeatable --app select disabled automations and emits the raw response in --json mode", async () => {
    const enabled = automation("app_enabled");
    const disabled = automation("app_disabled");
    const messages = output();
    const response = {
      org: { id: "org_1", slug: "acme" },
      instance: { status: "active" },
      applied: { apps: 2, grants: 2, secrets: 0 },
      webhooks: [],
    };
    const fetcher = vi.fn().mockResolvedValue(response);
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{ doc: enabled, enabled: true }, { doc: disabled, enabled: false }],
      grants: [grant("grt_enabled", "app_enabled"), grant("grt_disabled", "app_disabled")],
    });

    expect(await runDeploy([
      "--app", "app_disabled", "--app=app_enabled", "--subject", "user_a", "--json", "--key=vnd_test",
    ], { output: messages.sink, fetcher, env: {}, localProjectReader })).toBe(0);

    expect(localProjectReader).toHaveBeenCalledWith(expect.objectContaining({ subject: "user_a" }));
    expect(fetcher).toHaveBeenCalledWith("/api/v1/hosted/deploy", expect.objectContaining({
      body: {
        apps: [{ doc: enabled, enabled: true }, { doc: disabled, enabled: false }],
        grants: [grant("grt_enabled", "app_enabled"), grant("grt_disabled", "app_disabled")],
        secrets: [],
      },
    }));
    expect(messages.logs).toEqual([JSON.stringify(response, null, 2)]);
  });

  it("warns once per app for fn: steps without blocking the deploy", async () => {
    const app = automation("app_fn_steps");
    app.trigger = {
      ...trigger,
      run: {
        kind: "steps",
        steps: [
          { id: "first", tool: "fn:first" },
          { id: "second", tool: "fn:second" },
        ],
      },
    };
    const secondApp = automation("app_second_fn");
    secondApp.trigger = {
      ...trigger,
      run: { kind: "steps", steps: [{ id: "only", tool: "fn:only" }] },
    };
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({
      org: { id: "org_1", slug: "acme" },
      instance: { status: "active" },
      applied: { apps: 2, grants: 0, secrets: 0 },
      webhooks: [],
    });
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{ doc: app, enabled: true }, { doc: secondApp, enabled: true }],
      grants: [],
    });

    expect(await runDeploy(["--key", "vnd_test"], {
      output: messages.sink,
      fetcher,
      env: {},
      localProjectReader,
    })).toBe(0);
    expect(messages.errors).toEqual([
      "WARNING: Automation app_fn_steps has fn: steps that target the app's machine, which is unreachable from hosted sandboxes in v1; those steps will fail/park when fired hosted.",
      "WARNING: Automation app_second_fn has fn: steps that target the app's machine, which is unreachable from hosted sandboxes in v1; those steps will fail/park when fired hosted.",
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an explicit --app that is not an automation", async () => {
    const messages = output();
    const fetcher = vi.fn();
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{ doc: { format: "vendo/app@1", id: "app_view", name: "View" }, enabled: true }],
      grants: [],
    });

    expect(await runDeploy(["--app", "app_view", "--key", "vnd_test"], {
      output: messages.sink,
      fetcher,
      env: {},
      localProjectReader,
    })).toBe(1);
    expect(messages.errors).toEqual(["App app_view is not an automation"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to send plaintext secret values to a non-TLS API URL", async () => {
    const messages = output();
    const fetcher = vi.fn();
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{ doc: automation("app_enabled", ["TOKEN"]), enabled: true }],
      grants: [],
    });

    expect(await runDeploy([
      "--key", "vnd_test", "--api-url", "http://cloud.test", "--secret", "TOKEN=plain",
    ], { output: messages.sink, fetcher, env: {}, localProjectReader })).toBe(1);
    expect(messages.errors).toEqual(["Deploying secret values requires an HTTPS Vendo Cloud URL"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the machine-command cloud-required error", async () => {
    const messages = output();
    const fetcher = vi.fn().mockRejectedValue(new CloudError("cloud-required", "Upgrade", 402));
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{ doc: automation("app_enabled"), enabled: true }],
      grants: [],
    });

    expect(await runDeploy(["--key", "vnd_test"], {
      output: messages.sink,
      fetcher,
      localProjectReader,
    })).toBe(1);
    expect(messages.errors).toEqual(["This key's org needs a Cloud plan (cloud-required)."]);
  });
});

describe("local project deploy reader", () => {
  it("requires --subject when the local store contains multiple subjects", async () => {
    const store = createStore({ dataDir: "memory://cloud-deploy-multiple-subjects" });
    await store.ensureSchema();
    await appStore(store).put({ kind: "user", subject: "user_b" }, automation("app_b"));
    await appStore(store).put({ kind: "user", subject: "user_a" }, automation("app_a"));

    await expect(readLocalProject({ storeFactory: () => store })).rejects.toThrow(
      "Multiple local Vendo subjects found: user_a, user_b. Pass --subject <subject>.",
    );
  });

  it("reads only the selected subject and its active automation grants", async () => {
    const store = createStore({ dataDir: "memory://cloud-deploy-subject" });
    await store.ensureSchema();
    const principalA: Principal = { kind: "user", subject: "user_a" };
    const principalB: Principal = { kind: "user", subject: "user_b" };
    await appStore(store).put(principalA, automation("app_a"), { enabled: false });
    await appStore(store).put(principalB, automation("app_b"));
    await grantStore(store).create(principalA, grant("grt_active", "app_a"));
    await grantStore(store).create(principalA, grant("grt_expired", "app_a", {
      expiresAt: "2020-01-01T00:00:00.000Z",
    }));
    await grantStore(store).create(principalA, grant("grt_chat", "app_a", { source: "chat" }));

    await expect(readLocalProject({ subject: "user_a", storeFactory: () => store })).resolves.toEqual({
      subject: "user_a",
      apps: [{ doc: automation("app_a"), enabled: false }],
      grants: [grant("grt_active", "app_a")],
    });
  });
});
