import { createStage, initStage } from "./stage-host";
import type { InitPayload } from "./types";

const slot = document.getElementById("stage-slot")!;
const status = document.createElement("div");
status.id = "stage-status";
status.textContent = "booting";
document.body.appendChild(status);

const params = new URLSearchParams(location.search);

async function payloadFor(kind: string): Promise<InitPayload> {
  if (kind === "card") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return {
      theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" },
      state: {},
      bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card", props: { title: "Hello", body: "World" } },
    };
  }
  if (kind === "state") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" },
      state: { accountName: "Checking ****1234" }, bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card",
        props: { title: "Acct", body: "x", accountName: { $state: "accountName" } } } };
  }
  return { theme: {}, state: {}, bundleSource: "", tree: { id: "root", kind: "generated", payload: null } };
}

function ensure(id: string) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; document.body.appendChild(el); }
  return el;
}

createStage(slot);
window.addEventListener("message", (e) => {
  if (!e.data?.flowlet) return;
  if (e.data.type === "ready") {
    status.textContent = "ready";
    const iframe = document.getElementById("flowlet-stage") as HTMLIFrameElement;
    payloadFor(params.get("case") || "").then((payload) => initStage(iframe, payload));
  }
  if (e.data.type === "init-ack") ensure("init-ack").textContent = "initialized";
  if (e.data.type === "egress") {
    ensure("egress-fetch").textContent = e.data.fetchResult;
    ensure("egress-img").textContent = e.data.imgResult;
  }
});
