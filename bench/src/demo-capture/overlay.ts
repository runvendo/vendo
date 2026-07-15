export interface CaptureOverlayOptions {
  label: string;
  beat: string;
  continuity?: boolean;
}

export interface CaptureOverlaySnapshot {
  elapsedMs: number;
  firstPaintMs?: number;
  usableMs?: number;
  blankSamples: number;
  continuityWatching: boolean;
}

export interface CaptureOverlayApi {
  arm(): void;
  setPhase(phase: string): void;
  watchContinuity(): void;
  snapshot(): CaptureOverlaySnapshot;
}

export function remixCompletionPhase(blankSamples: number): string {
  return blankSamples === 0
    ? "REMIX COMPLETE · IFRAME STAYED VISIBLE"
    : `REMIX COMPLETE · ${blankSamples} BLANK SAMPLES`;
}

declare global {
  interface Window {
    __vendoDemoCapture?: CaptureOverlayApi;
  }
}

/**
 * Self-contained so Playwright can serialize it directly through page.evaluate.
 * The proof overlay starts from the real composer submit event, then stays in
 * the recorded page through first paint and usable state.
 */
export function installCaptureOverlayInPage(options: CaptureOverlayOptions): void {
  const doc = document;
  const view = doc.defaultView ?? window;
  doc.querySelector("[data-demo-capture-overlay]")?.remove();

  const overlay = doc.createElement("aside");
  overlay.dataset.demoCaptureOverlay = "true";
  overlay.setAttribute("aria-label", "Demo capture stopwatch");
  overlay.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "z-index:2147483647",
    "width:290px",
    "box-sizing:border-box",
    "padding:12px 14px",
    "border:1px solid rgba(255,255,255,.24)",
    "border-radius:12px",
    "background:rgba(8,10,14,.92)",
    "box-shadow:0 10px 35px rgba(0,0,0,.35)",
    "color:#fff",
    "font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    "pointer-events:none",
  ].join(";");

  const title = doc.createElement("div");
  title.textContent = `${options.label} · ${options.beat}`;
  title.style.cssText = "font-size:11px;letter-spacing:.08em;color:#cbd5e1";
  const timer = doc.createElement("div");
  timer.dataset.demoCaptureTimer = "true";
  timer.textContent = "00:00.000";
  timer.style.cssText = "margin:3px 0 8px;font-size:30px;font-variant-numeric:tabular-nums;letter-spacing:-.04em";
  const phase = doc.createElement("div");
  phase.dataset.demoCapturePhase = "true";
  phase.textContent = "ARMED · SUBMIT STARTS TIMER";
  phase.style.cssText = "margin-bottom:7px;color:#fde68a";
  const paint = doc.createElement("div");
  paint.dataset.demoCapturePaint = "true";
  paint.textContent = "FIRST PAINT  —";
  const usable = doc.createElement("div");
  usable.dataset.demoCaptureUsable = "true";
  usable.textContent = "USABLE       —";
  const bars = doc.createElement("div");
  bars.textContent = "BAR <1s PAINT · <10s USABLE";
  bars.style.cssText = "margin-top:7px;color:#94a3b8;font-size:10px";
  const continuity = doc.createElement("div");
  continuity.dataset.demoCaptureContinuity = "true";
  continuity.textContent = options.continuity ? "IFRAME CONTINUITY · WAITING" : "";
  continuity.style.cssText = "margin-top:7px;color:#86efac;font-size:10px";
  overlay.append(title, timer, phase, paint, usable, bars, continuity);
  doc.body.append(overlay);

  let armed = true;
  let startedAt: number | undefined;
  let firstPaintMs: number | undefined;
  let usableMs: number | undefined;
  let continuityWatching = false;
  let blankSamples = 0;

  const now = () => view.Date.now();
  const elapsed = () => startedAt === undefined ? 0 : Math.max(0, now() - startedAt);
  const format = (milliseconds: number) => {
    const total = Math.max(0, Math.floor(milliseconds));
    const minutes = Math.floor(total / 60_000);
    const seconds = Math.floor((total % 60_000) / 1_000);
    const millis = total % 1_000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  };
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const render = () => {
    timer.textContent = format(elapsed());
    paint.textContent = `FIRST PAINT  ${firstPaintMs === undefined ? "—" : format(firstPaintMs)}`;
    usable.textContent = `USABLE       ${usableMs === undefined ? "—" : format(usableMs)}`;
    if (continuityWatching) {
      const frames = [...doc.querySelectorAll<HTMLIFrameElement>([
        'iframe[title^="Generated component:"]',
        'iframe[title^="Vendo generated component:"]',
      ].join(","))];
      const frameVisible = frames.some((frame) => visible(frame) && frame.srcdoc.trim().length > 0);
      if (!frameVisible) blankSamples += 1;
      continuity.textContent = `${frameVisible ? "IFRAME VISIBLE" : "IFRAME BLANK"} · BLANK SAMPLES ${blankSamples}`;
      continuity.style.color = frameVisible ? "#86efac" : "#fca5a5";
    }
  };
  const inspect = () => {
    if (startedAt === undefined) return;
    const nodes = [...doc.querySelectorAll<HTMLElement>("[data-vendo-node-id]")];
    if (firstPaintMs === undefined && nodes.some(visible)) {
      firstPaintMs = elapsed();
      phase.textContent = "FIRST GENERATED PAINT";
      phase.style.color = firstPaintMs < 1_000 ? "#86efac" : "#fca5a5";
    }
    const messageList = doc.querySelector('.fl-msglist[aria-busy="false"]');
    const composer = doc.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]:not([disabled])');
    if (firstPaintMs !== undefined && usableMs === undefined && messageList !== null && composer !== null) {
      usableMs = elapsed();
      phase.textContent = "VIEW USABLE";
      phase.style.color = usableMs < 10_000 ? "#86efac" : "#fca5a5";
    }
    render();
  };
  const start = () => {
    if (startedAt !== undefined || !armed) return;
    startedAt = now();
    armed = false;
    phase.textContent = "GENERATING";
    phase.style.color = "#fde68a";
    render();
  };

  doc.addEventListener("submit", (event) => {
    const form = event.target;
    if (form instanceof view.HTMLFormElement && form.getAttribute("aria-label") === "Message composer") start();
  }, true);
  new view.MutationObserver((records) => {
    // Updating the stopwatch itself is also a DOM mutation. Ignore those
    // records so the proof overlay cannot create a MutationObserver feedback
    // loop while the host UI is idle.
    if (records.some((record) => !overlay.contains(record.target))) inspect();
  }).observe(doc.body, { childList: true, subtree: true, attributes: true });
  view.setInterval(() => {
    inspect();
    render();
  }, 50);

  view.__vendoDemoCapture = {
    arm() {
      armed = true;
      phase.textContent = "ARMED · SUBMIT STARTS TIMER";
      phase.style.color = "#fde68a";
    },
    setPhase(nextPhase) {
      phase.textContent = nextPhase;
    },
    watchContinuity() {
      continuityWatching = true;
      blankSamples = 0;
      render();
    },
    snapshot() {
      return {
        elapsedMs: elapsed(),
        ...(firstPaintMs === undefined ? {} : { firstPaintMs }),
        ...(usableMs === undefined ? {} : { usableMs }),
        blankSamples,
        continuityWatching,
      };
    },
  };
}
