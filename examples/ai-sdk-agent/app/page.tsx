"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";
// --- vendo: the provider that points the embeds at the wire, and the one
// dispatcher component that turns a `vendo_*` tool output into the right embed.
import { VendoProvider, VendoToolResult } from "@vendoai/ui";
// --- /vendo

export default function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage } = useChat();
  return (
    // --- vendo: wrap the chat once — auth rides your session cookie, theme
    // rides the --vendo-* tokens. Everything inside is the stock quickstart.
    <VendoProvider>
      {/* --- /vendo */}
      <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
        {messages.map((message) => (
          <div key={message.id} className="whitespace-pre-wrap">
            {message.role === "user" ? "User: " : "AI: "}
            {message.parts.map((part, i) => {
              switch (part.type) {
                case "text":
                  return <div key={`${message.id}-${i}`}>{part.text}</div>;
                // --- vendo: `vendo_*` tools stream as dynamic-tool parts. Hand
                // the finished output to <VendoToolResult> — it renders the app
                // embed for `vendo/app-ref@1`, the approval card for
                // `vendo/approval-ref@1`, and nothing for plain data.
                case "dynamic-tool":
                  return (
                    <div key={`${message.id}-${i}`} className="py-1">
                      {part.state === "output-available" ? (
                        <VendoToolResult output={part.output} />
                      ) : (
                        <div className="text-zinc-400">
                          Running {part.toolName}…
                        </div>
                      )}
                    </div>
                  );
                // --- /vendo
              }
            })}
          </div>
        ))}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
        >
          <input
            className="fixed dark:bg-zinc-900 bottom-0 w-full max-w-md p-2 mb-8 border border-zinc-300 dark:border-zinc-800 rounded shadow-xl"
            value={input}
            placeholder="Say something..."
            onChange={(e) => setInput(e.currentTarget.value)}
          />
        </form>
      </div>
      {/* --- vendo */}
    </VendoProvider>
    // --- /vendo
  );
}
