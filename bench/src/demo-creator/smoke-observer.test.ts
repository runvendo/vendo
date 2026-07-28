// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installSmokeObserverInPage } from "./smoke.js";

/** MutationObserver callbacks are microtasks; a macrotask tick drains them. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function assistantTurn(): HTMLElement {
  const article = document.createElement("article");
  article.setAttribute("data-role", "assistant");
  return article;
}

/** The live status ribbon the thread shows while a tool call is in flight. */
function toolRibbon(name: string): HTMLElement {
  const ribbon = document.createElement("div");
  ribbon.className = "fl-ribbon";
  ribbon.setAttribute("data-vendo-tool", name);
  return ribbon;
}

afterEach(() => {
  window.__vendoSmoke?.dispose();
  delete window.__vendoSmoke;
  document.body.innerHTML = "";
});

describe("installSmokeObserverInPage", () => {
  it("reports no sign of life on a page where nothing has happened", () => {
    installSmokeObserverInPage();
    expect(window.__vendoSmoke?.snapshot()).toEqual({ turnStarted: false, toolCall: false });
  });

  it("reports a turn started once an assistant article attaches", async () => {
    installSmokeObserverInPage();
    document.body.append(assistantTurn());
    await settle();
    expect(window.__vendoSmoke?.snapshot().turnStarted).toBe(true);
  });

  // The smoke turn may run on a thread that already holds turns (demo:fix
  // re-smokes a live demo). Counting a pre-existing article as this turn's
  // stream would call a dead agent alive.
  it("ignores assistant turns that were already on the page before it installed", async () => {
    document.body.append(assistantTurn(), assistantTurn());
    installSmokeObserverInPage();
    await settle();
    expect(window.__vendoSmoke?.snapshot().turnStarted).toBe(false);

    document.body.append(assistantTurn());
    await settle();
    expect(window.__vendoSmoke?.snapshot().turnStarted).toBe(true);
  });

  // The reason this is an observer and not a poll. The ribbon exists only while
  // a call is in flight, and a settled tool call leaves NO transcript trace at
  // all — so a 300ms poll misses a fast call entirely and reports a healthy
  // agent as one that never called a tool.
  it("catches a tool call that appeared and vanished between polls", async () => {
    installSmokeObserverInPage();
    const ribbon = toolRibbon("listInvoices");
    document.body.append(ribbon);
    ribbon.remove();
    await settle();
    expect(window.__vendoSmoke?.snapshot().toolCall).toBe(true);
  });

  it("catches a tool ribbon that attaches deep inside a re-rendered subtree", async () => {
    installSmokeObserverInPage();
    const wrapper = document.createElement("div");
    wrapper.append(toolRibbon("createInvoice"));
    document.body.append(wrapper);
    await settle();
    expect(window.__vendoSmoke?.snapshot().toolCall).toBe(true);
  });

  it("keeps both signals sticky — a settled turn does not un-prove itself", async () => {
    installSmokeObserverInPage();
    const ribbon = toolRibbon("listInvoices");
    const turn = assistantTurn();
    document.body.append(turn, ribbon);
    await settle();
    ribbon.remove();
    turn.remove();
    await settle();
    expect(window.__vendoSmoke?.snapshot()).toEqual({ turnStarted: true, toolCall: true });
  });

  it("stops recording once disposed", async () => {
    installSmokeObserverInPage();
    window.__vendoSmoke?.dispose();
    document.body.append(assistantTurn());
    await settle();
    expect(window.__vendoSmoke?.snapshot().turnStarted).toBe(false);
  });

  it("replaces a previous observer instead of stacking one", async () => {
    installSmokeObserverInPage();
    document.body.append(assistantTurn());
    await settle();
    installSmokeObserverInPage();
    expect(window.__vendoSmoke?.snapshot()).toEqual({ turnStarted: false, toolCall: false });
  });
});
