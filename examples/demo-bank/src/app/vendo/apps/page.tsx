"use client";

import { useState, type FormEvent } from "react";
import type { AppId } from "@vendoai/core";
import { createVendoClient, hostComponentMap, useApp, useApps } from "@vendoai/ui";
import { AppFrame } from "@vendoai/ui/tree";
import { withBasePath } from "@/lib/base-path";
import { mapleRegistry } from "@/vendo/registry";
import { Card, CardContent } from "@/components/ui/card";

// The same wire base the provider uses (08-ui §1); ship-diff and action calls
// ride the identical client surface the hooks use internally.
const client = createVendoClient({ baseUrl: withBasePath("/api/vendo") });

/**
 * Maple's app workspace: apps open OUTSIDE the conversation, on the host page,
 * rendered in the sandboxed brand-native surface.
 */

function OpenApp({ appId }: { appId: AppId }) {
  const { surface, edit, refresh } = useApp(appId);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = instruction.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await edit(value);
      if (result.issues) setError(result.issues.join("; "));
      else setInstruction("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-5" data-app-surface>
          {surface ? (
            <AppFrame
              key={appId}
              appId={appId}
              surface={surface}
              components={hostComponentMap(mapleRegistry)}
              onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})}
            />
          ) : (
            <p role="status" className="text-sm text-muted">Opening app…</p>
          )}
        </CardContent>
      </Card>
      <form className="flex items-center gap-2" aria-label="Edit app" onSubmit={(event) => void submit(event)}>
        <input
          className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted"
          placeholder="Ask Vendo to change this app (e.g. “Remix the net worth card”)"
          value={instruction}
          onChange={(event) => setInstruction(event.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          className="h-9 rounded-lg bg-ink px-3.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Editing…" : "Edit"}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="h-9 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-ink hover:bg-hover"
        >
          Refresh
        </button>
      </form>
      {error ? <p role="alert" className="text-sm text-neg">{error}</p> : null}
    </div>
  );
}

function AppsWorkspace() {
  const { apps, create, remove } = useApps();
  const [selected, setSelected] = useState<AppId>();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const app = await create(value);
      setPrompt("");
      setSelected(app.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Apps</h1>
        <p className="text-sm text-muted">Personal apps built with Vendo, running on Maple.</p>
      </div>
      <form className="flex items-center gap-2" aria-label="Create app" onSubmit={(event) => void submit(event)}>
        <input
          className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted"
          placeholder="Describe a new app"
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={busy || !prompt.trim()}
          className="h-9 rounded-lg bg-ink px-3.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </form>
      {error ? <p role="alert" className="text-sm text-neg">{error}</p> : null}
      {apps.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="list" aria-label="Your apps">
          {apps.map((app) => (
            <span key={app.id} role="listitem" className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSelected(app.id)}
                aria-current={selected === app.id ? "true" : undefined}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  selected === app.id
                    ? "border-ink bg-ink text-white"
                    : "border-border bg-surface text-ink hover:bg-hover"
                }`}
              >
                {app.name}
              </button>
              <button
                type="button"
                aria-label={`Remove ${app.name}`}
                className="rounded-md px-1.5 py-1 text-sm text-muted hover:text-ink"
                onClick={() => {
                  void remove(app.id).then(() => {
                    setSelected((current) => (current === app.id ? undefined : current));
                  });
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {selected ? <OpenApp key={selected} appId={selected} /> : null}
    </div>
  );
}

// No <VendoRoot> of its own: `app/layout.tsx` already mounts one around every
// page, and a nested provider is the one this page's surfaces actually read —
// so it shadowed the layout's, brand fonts and all.
export default function MapleAppsPage() {
  return <AppsWorkspace />;
}
