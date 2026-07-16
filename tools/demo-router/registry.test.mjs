import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRegistry, RegistryCorruptError } from "./registry.mjs";

function tempRegistryPath() {
  return path.join(mkdtempSync(path.join(tmpdir(), "demo-router-registry-")), "data", "registry.json");
}

const sampleRow = {
  id: "acme",
  url: "https://demo-acme.up.railway.app",
  prospect: "Acme Widgets",
  expiresAt: "2099-01-01T00:00:00Z",
};

describe("registry CRUD", () => {
  it("upsert fills defaults (killed, hits, createdAt) and get returns the row", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    const stored = registry.upsert(sampleRow);
    assert.equal(stored.id, "acme");
    assert.equal(stored.url, sampleRow.url);
    assert.equal(stored.prospect, "Acme Widgets");
    assert.equal(stored.killed, false);
    assert.equal(stored.hits, 0);
    assert.ok(!Number.isNaN(Date.parse(stored.createdAt)));
    assert.deepEqual(registry.get("acme"), stored);
  });

  it("upsert on an existing id updates fields but preserves createdAt and hits", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    const first = registry.upsert(sampleRow);
    registry.recordHit("acme");
    const second = registry.upsert({ ...sampleRow, url: "https://elsewhere.example" });
    assert.equal(second.url, "https://elsewhere.example");
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.hits, 1);
  });

  it("rejects an id that is not slug-shaped", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    assert.throws(() => registry.upsert({ ...sampleRow, id: "Not A Slug" }), /slug/);
  });

  it("list returns every row and remove deletes one", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    registry.upsert(sampleRow);
    registry.upsert({ ...sampleRow, id: "globex", prospect: "Globex" });
    assert.deepEqual(registry.list().map((row) => row.id).sort(), ["acme", "globex"]);
    assert.equal(registry.remove("acme"), true);
    assert.equal(registry.remove("acme"), false);
    assert.deepEqual(registry.list().map((row) => row.id), ["globex"]);
  });

  it("patch merges partial fields and returns undefined for unknown ids", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    registry.upsert(sampleRow);
    const patched = registry.patch("acme", { killed: true });
    assert.equal(patched.killed, true);
    assert.equal(patched.url, sampleRow.url);
    assert.equal(registry.patch("nope", { killed: true }), undefined);
  });

  it("persists across instances (fresh instance reads the same file)", () => {
    const filePath = tempRegistryPath();
    createRegistry({ filePath }).upsert(sampleRow);
    const reopened = createRegistry({ filePath });
    assert.equal(reopened.get("acme").prospect, "Acme Widgets");
  });
});

describe("registry atomic writes", () => {
  it("leaves no temp file behind and the file is always valid JSON", () => {
    const filePath = tempRegistryPath();
    const registry = createRegistry({ filePath });
    registry.upsert(sampleRow);
    registry.patch("acme", { killed: true });
    const entries = readdirSync(path.dirname(filePath));
    assert.deepEqual(entries, ["registry.json"]);
    assert.doesNotThrow(() => JSON.parse(readFileSync(filePath, "utf8")));
  });
});

describe("routeFor", () => {
  it("routes a live row and reports unknown/killed/expired", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    registry.upsert(sampleRow);
    registry.upsert({ ...sampleRow, id: "dead", killed: true });
    registry.upsert({ ...sampleRow, id: "old", expiresAt: "2020-01-01T00:00:00Z" });

    const now = new Date("2026-07-16T00:00:00Z");
    assert.deepEqual(registry.routeFor("acme", now), { kind: "live", url: sampleRow.url });
    assert.deepEqual(registry.routeFor("dead", now), { kind: "killed" });
    assert.deepEqual(registry.routeFor("old", now), { kind: "expired" });
    assert.deepEqual(registry.routeFor("nope", now), { kind: "unknown" });
  });

  it("kill wins over expiry, and expiry is exact at the boundary", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    registry.upsert({ ...sampleRow, id: "both", expiresAt: "2020-01-01T00:00:00Z", killed: true });
    registry.upsert({ ...sampleRow, id: "edge", expiresAt: "2026-07-16T00:00:00Z" });
    assert.deepEqual(registry.routeFor("both", new Date("2026-07-16T00:00:00Z")), { kind: "killed" });
    assert.deepEqual(registry.routeFor("edge", new Date("2026-07-16T00:00:00.000Z")), { kind: "expired" });
    assert.deepEqual(registry.routeFor("edge", new Date("2026-07-15T23:59:59Z")), { kind: "live", url: sampleRow.url });
  });

  it("treats an unparseable expiresAt as expired (fail closed)", () => {
    const filePath = tempRegistryPath();
    const registry = createRegistry({ filePath });
    registry.upsert(sampleRow);
    // Corrupt just the date by editing the file the way an operator might.
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.acme.expiresAt = "not-a-date";
    writeFileSync(filePath, JSON.stringify(raw));
    const reopened = createRegistry({ filePath });
    assert.deepEqual(reopened.routeFor("acme", new Date()), { kind: "expired" });
  });
});

describe("recordHit", () => {
  it("increments hits and is a silent no-op for unknown ids", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    registry.upsert(sampleRow);
    registry.recordHit("acme");
    registry.recordHit("acme");
    registry.recordHit("nope");
    assert.equal(registry.get("acme").hits, 2);
  });
});

describe("corrupt file fail-closed", () => {
  function corruptRegistry() {
    const filePath = tempRegistryPath();
    const registry = createRegistry({ filePath });
    registry.upsert(sampleRow); // create the directory + a valid file first
    writeFileSync(filePath, "{ not json");
    const logs = [];
    return { filePath, registry: createRegistry({ filePath, log: (message) => logs.push(message) }), logs };
  }

  it("routeFor answers unknown for every id and never rewrites the file", () => {
    const { filePath, registry } = corruptRegistry();
    assert.deepEqual(registry.routeFor("acme", new Date()), { kind: "unknown" });
    assert.equal(readFileSync(filePath, "utf8"), "{ not json");
  });

  it("admin operations throw RegistryCorruptError instead of overwriting", () => {
    const { filePath, registry } = corruptRegistry();
    assert.throws(() => registry.list(), RegistryCorruptError);
    assert.throws(() => registry.get("acme"), RegistryCorruptError);
    assert.throws(() => registry.upsert(sampleRow), RegistryCorruptError);
    assert.throws(() => registry.patch("acme", { killed: true }), RegistryCorruptError);
    assert.throws(() => registry.remove("acme"), RegistryCorruptError);
    assert.throws(() => registry.count(), RegistryCorruptError);
    assert.equal(readFileSync(filePath, "utf8"), "{ not json");
  });

  it("recordHit is best-effort: silent no-op on a corrupt file", () => {
    const { filePath, registry } = corruptRegistry();
    assert.doesNotThrow(() => registry.recordHit("acme"));
    assert.equal(readFileSync(filePath, "utf8"), "{ not json");
  });

  it("logs the corruption once, not per operation", () => {
    const { registry, logs } = corruptRegistry();
    registry.routeFor("a", new Date());
    registry.routeFor("b", new Date());
    try { registry.list(); } catch { /* expected */ }
    assert.equal(logs.filter((line) => /corrupt/i.test(line)).length, 1);
  });

  it("a wrong-shape (but valid JSON) file is also corrupt", () => {
    const filePath = tempRegistryPath();
    const first = createRegistry({ filePath });
    first.upsert(sampleRow);
    writeFileSync(filePath, JSON.stringify({ acme: { hits: "many" } }));
    const registry = createRegistry({ filePath, log: () => {} });
    assert.deepEqual(registry.routeFor("acme", new Date()), { kind: "unknown" });
    assert.throws(() => registry.list(), RegistryCorruptError);
  });

  it("a missing file is NOT corrupt — it is an empty registry", () => {
    const registry = createRegistry({ filePath: tempRegistryPath() });
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.count(), 0);
    assert.deepEqual(registry.routeFor("anything", new Date()), { kind: "unknown" });
  });
});
