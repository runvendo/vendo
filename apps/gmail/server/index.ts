/**
 * The Gmail clone's backend: mail API + (embedded) Flowlet runtime routes.
 * Runs via tsx — plain `node` cannot load the tsc-built @flowlet/* dists
 * (extensionless ESM imports). The CRA dev server proxies /api here.
 */
import express from "express";
import { createMailApi } from "./api";
import { MailStore } from "./store";
import { seedMessages, DEMO_ME } from "./seed";

const PORT = Number(process.env.GMAIL_API_PORT ?? 3198);

export const store = new MailStore(seedMessages(), DEMO_ME);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", createMailApi(store));

app.listen(PORT, () => {
  console.log(`[gmail-demo] mail API listening on http://localhost:${PORT}`);
});
