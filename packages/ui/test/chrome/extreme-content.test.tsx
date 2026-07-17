// @vitest-environment jsdom
// ENG-218 — extreme-content solidity: long-thread windowing, entrance-animation
// gating on restore, huge-message truncation/expand, and bounded tool-payload
// previews. Rides a static in-memory thread client (no wire) so a 200-turn
// transcript can be mounted deterministically.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@vendoai/core";
import type { UIMessage } from "ai";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { LONG_TEXT_CAP, truncateHead } from "../../src/chrome/truncate.js";

const NOW = new Date("2026-07-15T00:00:00Z").toISOString();

function makeThread(id: string, turns: number, overrides: UIMessage[] = []): Thread {
  const messages: UIMessage[] = Array.from({ length: turns }, (_, index) => [
    { id: `u${index}`, role: "user" as const, parts: [{ type: "text" as const, text: `Question ${index + 1}` }] },
    {
      id: `a${index}`,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: `Answer ${index + 1}: here is a considered reply.` }],
    },
  ]).flat();
  return { id, subject: "browser-user", createdAt: NOW, updatedAt: NOW, messages: [...messages, ...overrides] };
}

/** A client that serves a fixed thread by id (and in list() so useVendoThread
    adopts it) without any network. */
function staticThreadClient(thread: Thread): VendoClient {
  const base = createVendoClient({ baseUrl: "http://vendo.test" });
  return {
    ...base,
    threads: {
      ...base.threads,
      list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
      get: async id => (id === thread.id ? thread : base.threads.get(id)),
    },
  };
}

function mount(thread: Thread) {
  return render(
    <VendoProvider client={staticThreadClient(thread)}>
      <VendoThread threadId={thread.id} />
    </VendoProvider>,
  );
}

const articles = (container: HTMLElement) => container.querySelectorAll("article[data-role]");

afterEach(cleanup);

describe("truncateHead (ENG-218)", () => {
  it("returns short text unchanged and bounds long text to the cap", () => {
    expect(truncateHead("hello")).toBe("hello");
    const long = "a".repeat(LONG_TEXT_CAP * 2);
    expect(truncateHead(long).length).toBeLessThanOrEqual(LONG_TEXT_CAP);
  });
});

describe("long-thread windowing (ENG-218)", () => {
  it("renders only a bounded trailing window of a very long thread, not every turn", async () => {
    const thread = makeThread("thr_long", 200); // 400 messages
    const view = mount(thread);
    await waitFor(() => expect(articles(view.container).length).toBeGreaterThan(0));
    // The whole transcript is 400 turns; only the trailing window is in the DOM.
    expect(articles(view.container).length).toBeLessThanOrEqual(60);
    // The latest turn is present; the very first is deferred.
    expect(screen.getByText("Answer 200: here is a considered reply.")).toBeTruthy();
    expect(screen.queryByText("Question 1")).toBeNull();
  });

  it("reveals the deferred head in chunks via the 'earlier messages' control", async () => {
    const thread = makeThread("thr_long2", 200);
    const view = mount(thread);
    const olderButton = await screen.findByRole("button", { name: /earlier message/i });
    const before = articles(view.container).length;
    fireEvent.click(olderButton);
    await waitFor(() => expect(articles(view.container).length).toBeGreaterThan(before));
  });

  it("does not window a short thread (no 'earlier messages' control)", async () => {
    const thread = makeThread("thr_short", 5); // 10 messages
    const view = mount(thread);
    await waitFor(() => expect(articles(view.container).length).toBe(10));
    expect(screen.queryByRole("button", { name: /earlier message/i })).toBeNull();
  });
});

describe("entrance-animation gating on restore (ENG-218)", () => {
  it("marks every restored turn as no-entrance so a reopened thread doesn't stampede", async () => {
    const thread = makeThread("thr_restore", 5);
    const view = mount(thread);
    await waitFor(() => expect(articles(view.container).length).toBe(10));
    // Every turn present at restore is gated out of the entrance animation.
    const gated = view.container.querySelectorAll("article.fl-no-entrance");
    expect(gated.length).toBe(10);
  });
});

describe("huge-message truncation + expand (ENG-218)", () => {
  const huge = "x ".repeat(LONG_TEXT_CAP); // well over the cap

  const lastByClass = (container: HTMLElement, selector: string) => {
    const nodes = container.querySelectorAll(selector);
    return nodes[nodes.length - 1] as HTMLElement;
  };

  it("collapses a huge assistant message and expands it on demand", async () => {
    const thread = makeThread("thr_huge_a", 1, [
      { id: "big", role: "assistant", parts: [{ type: "text", text: huge }] },
    ]);
    const view = mount(thread);
    const expand = await screen.findByRole("button", { name: /show full message/i });
    const collapsedLen = lastByClass(view.container, ".fl-md").textContent?.length ?? 0;
    expect(collapsedLen).toBeLessThan(huge.length);
    fireEvent.click(expand);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show less/i })).toBeTruthy(),
    );
    expect(lastByClass(view.container, ".fl-md").textContent?.length ?? 0).toBeGreaterThan(collapsedLen);
  });

  it("collapses a huge user message and expands it on demand", async () => {
    const thread = makeThread("thr_huge_u", 1, [
      { id: "bigu", role: "user", parts: [{ type: "text", text: huge }] },
    ]);
    const view = mount(thread);
    const expand = await screen.findByRole("button", { name: /show full message/i });
    const collapsedLen = lastByClass(view.container, ".fl-usertext").textContent?.length ?? 0;
    expect(collapsedLen).toBeLessThan(huge.length);
    fireEvent.click(expand);
    await waitFor(() => expect(screen.getByRole("button", { name: /show less/i })).toBeTruthy());
    expect(lastByClass(view.container, ".fl-usertext").textContent?.length ?? 0).toBeGreaterThan(collapsedLen);
  });
});
