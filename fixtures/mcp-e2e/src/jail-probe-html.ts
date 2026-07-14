const escapeScript = (source: string): string => source.replace(/<\/script/gi, "<\\/script");

const levelTwoScript = `
(() => {
  const report = (message) => parent.postMessage({ vendoProbe: true, ...message }, "*");
  document.addEventListener("securitypolicyviolation", (event) => {
    report({ level: "csp", frame: "srcdoc-2", policy: event.originalPolicy, directive: event.effectiveDirective });
  });
  let evalInJail;
  try {
    const value = new Function("return 1")();
    evalInJail = { ok: value === 1, detail: "new Function returned " + String(value) };
  } catch (error) {
    evalInJail = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  report({ level: "srcdoc-2", evalInJail });
})();
`;

const levelTwoHtml = [
  "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>",
  `<script>${escapeScript(levelTwoScript)}<\/script>`,
  "</body></html>",
].join("");

const levelOneScript = `
(() => {
  const report = (message) => parent.postMessage({ vendoProbe: true, ...message }, "*");
  document.addEventListener("securitypolicyviolation", (event) => {
    report({ level: "csp", frame: "srcdoc-1", policy: event.originalPolicy, directive: event.effectiveDirective });
  });
  report({ level: "srcdoc-1" });
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.setAttribute("title", "Vendo capability probe level 2");
  inner.srcdoc = ${JSON.stringify(levelTwoHtml).replace(/</g, "\\u003c")};
  window.addEventListener("message", (event) => {
    if (event.source === inner.contentWindow && event.data?.vendoProbe === true) report(event.data);
  });
  document.body.appendChild(inner);
})();
`;

const levelOneHtml = [
  "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>",
  `<script>${escapeScript(levelOneScript)}<\/script>`,
  "</body></html>",
].join("");

const probeScript = `
(() => {
  const seenPolicies = new Set();
  const csp = document.querySelector("#observed-csp");
  const set = (id, ok, detail) => {
    const row = document.querySelector("#" + id);
    row.dataset.status = ok ? "pass" : "fail";
    row.querySelector(".verdict").textContent = ok ? "PASS" : "FAIL";
    row.querySelector(".detail").textContent = detail;
  };
  const addPolicy = (frame, policy, directive) => {
    const text = frame + " [" + directive + "]: " + (policy || "(originalPolicy unavailable)");
    seenPolicies.add(text);
    csp.textContent = Array.from(seenPolicies).join("\\n");
  };

  document.querySelector("#base-uri").textContent = document.baseURI;
  document.addEventListener("securitypolicyviolation", (event) => {
    addPolicy("app", event.originalPolicy, event.effectiveDirective);
  });

  try {
    const value = eval("1+1");
    set("eval-direct", value === 2, "eval returned " + String(value));
  } catch (error) {
    set("eval-direct", false, error instanceof Error ? error.message : String(error));
  }
  try {
    const value = new Function("return 1")();
    set("new-function", value === 1, "new Function returned " + String(value));
  } catch (error) {
    set("new-function", false, error instanceof Error ? error.message : String(error));
  }

  const outer = document.createElement("iframe");
  outer.setAttribute("sandbox", "allow-scripts");
  outer.setAttribute("title", "Vendo capability probe level 1");
  outer.srcdoc = ${JSON.stringify(levelOneHtml).replace(/</g, "\\u003c")};
  window.addEventListener("message", (event) => {
    if (event.source !== outer.contentWindow || event.data?.vendoProbe !== true) return;
    const message = event.data;
    if (message.level === "srcdoc-1") {
      set("srcdoc-1", true, "level 1 posted to the app frame");
    } else if (message.level === "srcdoc-2") {
      set("srcdoc-2", true, "level 2 posted through level 1");
      set("postmessage-cross", true, "level 2 -> level 1 -> app frame");
      set("eval-in-jail", message.evalInJail?.ok === true, message.evalInJail?.detail || "no eval result");
    } else if (message.level === "csp") {
      addPolicy(message.frame || "nested", message.policy, message.directive || "unknown");
    }
  });
  document.body.appendChild(outer);

  setTimeout(() => {
    for (const id of ["srcdoc-1", "srcdoc-2", "postmessage-cross", "eval-in-jail"]) {
      const row = document.querySelector("#" + id);
      if (row.dataset.status === "pending") set(id, false, "no report received within 5 seconds");
    }
  }, 5000);
})();
`;

const resultRow = (id: string, label: string): string => `
  <div class="result" id="${id}" data-status="pending">
    <span class="name">${label}</span>
    <strong class="verdict">WAIT</strong>
    <span class="detail">running…</span>
  </div>`;

/** Standalone MCP Apps capability probe. It intentionally declares no CSP of its own. */
export const JAIL_PROBE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vendo jail capability probe</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    h1 { margin: 0 0 8px; font: 800 30px/1.15 system-ui, sans-serif; }
    .lede { margin: 0 0 20px; font: 600 17px/1.4 system-ui, sans-serif; }
    .result { display: grid; grid-template-columns: minmax(180px, 1fr) 100px 2fr; gap: 16px; align-items: start; padding: 14px 16px; margin: 10px 0; border: 3px solid #888; border-radius: 12px; font-size: 18px; }
    .result[data-status="pass"] { border-color: #159447; background: color-mix(in srgb, #159447 13%, Canvas); }
    .result[data-status="fail"] { border-color: #d33434; background: color-mix(in srgb, #d33434 13%, Canvas); }
    .name { font-weight: 800; }
    .verdict { font: 900 22px/1 system-ui, sans-serif; }
    .detail, #base-uri, #observed-csp { overflow-wrap: anywhere; white-space: pre-wrap; }
    .facts { margin-top: 20px; padding: 16px; border: 2px solid #888; border-radius: 12px; }
    .facts h2 { margin: 0 0 8px; font-size: 17px; }
    iframe { position: absolute; width: 1px; height: 1px; border: 0; opacity: 0; pointer-events: none; }
  </style>
</head>
<body>
  <h1>Vendo jail capability probe</h1>
  <p class="lede">Large PASS/FAIL rows are the screenshot verdict. A FAIL detail preserves the browser/CSP error.</p>
  ${resultRow("eval-direct", "eval-direct")}
  ${resultRow("new-function", "new-function")}
  ${resultRow("srcdoc-1", "srcdoc-1")}
  ${resultRow("srcdoc-2", "srcdoc-2")}
  ${resultRow("postmessage-cross", "postMessage cross-nesting")}
  ${resultRow("eval-in-jail", "eval-in-jail")}
  <section class="facts">
    <h2>document.baseURI</h2>
    <div id="base-uri">probe script did not run</div>
    <h2>Observed CSP violation policies</h2>
    <div id="observed-csp">No violation event observed. Browsers expose originalPolicy only after a violation.</div>
  </section>
  <script>${escapeScript(probeScript)}<\/script>
</body>
</html>`;
