"use client";

import { useState, type FormEvent } from "react";
import type { AppId } from "@vendoai/core";
import { createVendoClient, useApp, useApps, type ShipDiff } from "@vendoai/ui";
import { AppFrame } from "@vendoai/ui/tree";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { mapleHostComponents } from "@/vendo/host-components";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// The same wire base the provider uses (08-ui §1); ship-diff and action calls
// ride the identical client surface the hooks use internally.
const client = createVendoClient({ baseUrl: "/api/vendo" });

/**
 * Maple's app workspace: apps open OUTSIDE the conversation, on the host page
 * (06-apps §9) — the venue where an in-client approval can mount a reviewed
 * version natively and where a version change drops it back to the sandbox.
 * The ship review panel surfaces `GET /apps/:id/ship-diff`, the exact delta an
 * approval would pin (approvals themselves are minted by the Cloud review
 * console; locally via the documented dev route in docs/in-client-approvals.md).
 */

function ShipReview({ appId }: { appId: AppId }) {
  const [diff, setDiff] = useState<ShipDiff>();
  const [error, setError] = useState<string>();
  const load = async () => {
    setError(undefined);
    try {
      setDiff(await client.apps.shipDiff(appId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ship review</CardTitle>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[13px] font-medium text-ink hover:bg-hover"
        >
          Load ship-diff
        </button>
      </CardHeader>
      <CardContent>
        {error ? <p role="alert" className="text-sm text-neg">{error}</p> : null}
        {diff ? (
          <div className="space-y-3" data-ship-diff>
            <p className="text-[13px] text-muted">
              Version <code className="text-ink">{diff.versionHash.slice(0, 22)}…</code> — an
              in-client approval pins exactly this hash.
            </p>
            {diff.pins.map((pin) => (
              <div key={pin.slot}>
                <p className="text-[13px] font-medium text-ink">
                  Forked host slot <code>{pin.slot}</code> → <code>{pin.component}</code>
                  {pin.drifted ? " (DRIFTED — review fails closed)" : null}
                </p>
                <pre className="mt-1 max-h-56 overflow-auto rounded-lg border border-border bg-hover p-3 text-[11px] leading-relaxed">
                  {pin.diff}
                </pre>
              </div>
            ))}
            {diff.generated.map((component) => (
              <div key={component.component}>
                <p className="text-[13px] font-medium text-ink">
                  Generated component <code>{component.component}</code>
                </p>
                <pre className="mt-1 max-h-56 overflow-auto rounded-lg border border-border bg-hover p-3 text-[11px] leading-relaxed">
                  {component.diff}
                </pre>
              </div>
            ))}
            {diff.pins.length === 0 && diff.generated.length === 0 ? (
              <p className="text-sm text-muted">No forked or generated components to review.</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">
            The reviewable delta between captured host source and what this app ships.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

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
              surface={surface}
              components={mapleHostComponents}
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
      <ShipReview appId={appId} />
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

export default function MapleAppsPage() {
  return (
    <VendoRoot>
      <AppsWorkspace />
    </VendoRoot>
  );
}
