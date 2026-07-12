import { grantStore, threadStore, createStore } from "../../dist/index.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("dataDir argument is required");

const store = createStore({ dataDir });
await store.ensureSchema();
await store.records("durability_records").put({ id: "durable_record", data: { durable: true } });
await grantStore(store).create(
  { kind: "user", subject: "durable_user" },
  {
    id: "grt_durable",
    subject: "durable_user",
    tool: "host_durable_read",
    descriptorHash: "sha256:durable",
    scope: { kind: "tool" },
    duration: "standing",
    source: "chat",
    grantedAt: "2026-01-02T03:04:05.000Z",
  },
);
await threadStore(store).put(
  { kind: "user", subject: "durable_user" },
  { id: "thr_durable", messages: [{ role: "user", text: "persist me" }] },
);

if (process.send) process.send("WRITES-DURABLE");
console.log("WRITES-DURABLE");
setInterval(() => undefined, 1_000);
