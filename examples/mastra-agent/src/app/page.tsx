"use client";

import { useChat } from "@ai-sdk/react";
// --- vendo: the provider that points the embeds at the wire, and the one
// dispatcher component that turns a `vendo_*` tool output into the right embed.
import { VendoProvider, VendoToolResult } from "@vendoai/ui";
// --- /vendo
import { DefaultChatTransport } from "ai";
import { useState } from "react";

type ToolLikePart = { type: string; toolName?: string; state?: string; output?: unknown };

export default function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  return (
    // --- vendo: wrap the chat once — auth rides your session cookie, theme
    // rides the --vendo-* tokens. Everything inside is the plain chat page.
    <VendoProvider>
      {/* --- /vendo */}
      <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col bg-white font-sans dark:bg-black">
        <header className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h1 className="text-lg font-semibold text-black dark:text-zinc-50">Weather Agent</h1>
          <p className="text-sm text-zinc-500">Mastra weather starter + Vendo guarded tools, generated UI, and approvals</p>
        </header>

        <main className="flex flex-1 flex-col gap-6 px-6 py-8">
          {messages.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Try: &ldquo;What&rsquo;s the weather in Paris?&rdquo; → &ldquo;Make me a dashboard comparing weather in
              Paris, Tokyo and NYC&rdquo; → &ldquo;Email the report to ops@example.com&rdquo;
            </p>
          ) : null}

          {messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                {message.role === "user" ? "You" : "Weather Agent"}
              </span>
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <p key={index} className="whitespace-pre-wrap text-[15px] leading-7 text-zinc-800 dark:text-zinc-200">
                      {part.text}
                    </p>
                  );
                }
                // --- vendo: tool calls stream as dynamic-tool / tool-* parts.
                // Hand the finished output to <VendoToolResult> — it renders
                // the app embed for `vendo/app-ref@1`, the approval card for
                // `vendo/approval-ref@1`, and nothing for plain data (like the
                // starter's own weatherTool output).
                if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
                  const tool = part as ToolLikePart;
                  const toolName = tool.toolName ?? part.type.slice("tool-".length);
                  return (
                    <div key={index} className="flex flex-col gap-2">
                      <span className="w-fit rounded-full border border-zinc-200 px-2 py-0.5 font-mono text-xs text-zinc-500 dark:border-zinc-800">
                        {tool.state === "output-available" ? toolName : `Running ${toolName}…`}
                      </span>
                      {tool.state === "output-available" ? <VendoToolResult output={tool.output} /> : null}
                    </div>
                  );
                }
                // --- /vendo
                return null;
              })}
            </div>
          ))}

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">Something went wrong: {error.message}</p>
          ) : null}
        </main>

        <form
          className="sticky bottom-0 flex gap-2 border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-black"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim().length === 0) return;
            void sendMessage({ text: input });
            setInput("");
          }}
        >
          <input
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            value={input}
            placeholder="Ask about the weather…"
            onChange={(event) => setInput(event.target.value)}
          />
          <button
            type="submit"
            disabled={status !== "ready"}
            className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Send
          </button>
        </form>
      </div>
    </VendoProvider>
  );
}
