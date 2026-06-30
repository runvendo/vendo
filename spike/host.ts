import { createStage } from "./stage-host";

const slot = document.getElementById("stage-slot")!;
const status = document.createElement("div");
status.id = "stage-status";
status.textContent = "booting";
document.body.appendChild(status);

createStage(slot);
window.addEventListener("message", (e) => {
  if (e.data?.flowlet && e.data.type === "ready") status.textContent = "ready";
});
