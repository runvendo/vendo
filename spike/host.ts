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
  if (kind === "action") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {}, bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card",
        props: { title: "Confirm?", body: "x", action: { action: "confirm", label: "Confirm", payload: { amount: 10 } } } } };
  }
  if (kind === "state") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" },
      state: { accountName: "Checking ****1234" }, bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card",
        props: { title: "Acct", body: "x", accountName: { $state: "accountName" } } } };
  }
  if (kind === "throw") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {}, bundleSource,
      tree: { id: "root", kind: "component", source: "prewired", name: "__row", props: {}, children: [
        { id: "bad", kind: "component", source: "host", name: "Boom", props: {} },
        { id: "good", kind: "component", source: "host", name: "Card", props: { title: "OK", body: "survived" } },
      ] } };
  }
  if (kind === "mixed") {
    const bundleSource = await (await fetch("/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {}, bundleSource,
      tree: { id: "root", kind: "component", source: "prewired", name: "__row", props: {}, children: [
        { id: "b1", kind: "component", source: "prewired", name: "__badge", props: { label: "New" } },
        { id: "c1", kind: "component", source: "host", name: "Card", props: { title: "Hello", body: "World" } },
        { id: "g1", kind: "generated", payload: { note: "placeholder" } },
      ] } };
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
    payloadFor(params.get("case") || "").then((payload) => initStage(iframe, payload, async (req) => {
      ensure("action-log").textContent = `origin=${req.originNodeId} action=${req.name} result=ok`;
      return { result: "ok" };
    }));
  }
  if (e.data.type === "init-ack") ensure("init-ack").textContent = "initialized";
  if (e.data.type === "resize") {
    const iframe = document.getElementById("flowlet-stage") as HTMLIFrameElement;
    iframe.style.height = e.data.height + "px";
  }
  if (e.data.type === "egress") {
    ensure("egress-fetch").textContent = e.data.fetchResult;
    ensure("egress-img").textContent = e.data.imgResult;
  }
});
