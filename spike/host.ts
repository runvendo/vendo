import { createStage, initStage } from "./stage-host";

const slot = document.getElementById("stage-slot")!;
const status = document.createElement("div");
status.id = "stage-status";
status.textContent = "booting";
document.body.appendChild(status);

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
    initStage(iframe, { theme: {}, state: {}, bundleSource: "", tree: { id: "root", kind: "generated", payload: null } });
  }
  if (e.data.type === "init-ack") ensure("init-ack").textContent = "initialized";
  if (e.data.type === "egress") {
    ensure("egress-fetch").textContent = e.data.fetchResult;
    ensure("egress-img").textContent = e.data.imgResult;
  }
});
