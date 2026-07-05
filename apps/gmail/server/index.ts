/**
 * The Gmail clone's backend: mail API + embedded Vendo runtime routes.
 * Runs via tsx — plain `node` cannot load the tsc-built @vendoai/* dists
 * (extensionless ESM imports). The CRA dev server proxies /api here.
 */
import express from "express";
import { createMailApi } from "./api";
import { MailStore } from "./store";
import { seedMessages, DEMO_ME } from "./seed";
import { createDemoAgent } from "./vendo/agent";
import { demoTools, demoPreviews } from "./vendo/tools";
import { modelGenerate } from "./vendo/drafting";
import { postToSlack } from "./vendo/slack";
import { handleChat, principalAllowed } from "./vendo/chat";
import { createActionHandler } from "./vendo/action";

const PORT = Number(process.env.GMAIL_API_PORT ?? 3198);

const store = new MailStore(seedMessages(), DEMO_ME);
const tools = demoTools({ store, generate: modelGenerate(), postToSlack });
const agent = createDemoAgent({ extraTools: tools });
const handleAction = createActionHandler(tools, {
  preview: demoPreviews({ store, generate: modelGenerate() }),
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", createMailApi(store));

app.post("/api/vendo/chat", (req, res) => {
  void handleChat(req, res, agent).catch((error: unknown) => {
    console.error("[vendo] chat failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "chat failed" });
    else res.end();
  });
});

app.post("/api/vendo/action", (req, res) => {
  // Same local-only door as chat: stage dispatches execute real writes.
  if (!principalAllowed(req)) {
    res.status(403).json({ error: "Vendo demo actions are restricted to local runs." });
    return;
  }
  void handleAction(req.body ?? {}).then(
    ({ status, body }) => res.status(status).json(body),
    (error: unknown) => {
      console.error("[vendo] action failed:", error);
      res.status(500).json({ error: "action failed" });
    },
  );
});

// Reset the demo mailbox between takes.
app.post("/api/vendo/reset", (req, res) => {
  if (!principalAllowed(req)) {
    res.status(403).json({ error: "restricted to local runs" });
    return;
  }
  store.reset();
  res.json({ ok: true });
});

// Loopback-only bind: the Host-header guard in chat.ts is spoofable by any
// peer that can reach the socket, and this server can post to real Slack.
// Nothing but the local CRA proxy should ever reach it.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[gmail-demo] mail API + Vendo listening on http://127.0.0.1:${PORT}`);
});
