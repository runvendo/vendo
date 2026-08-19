/**
 * The browser half of the standalone seam: the SHIPPED `useVendoChat`, against
 * the real `agentHandler()` mount next door. Deliberately unstyled and
 * unadorned — every element here exists to be asserted on, and nothing between
 * the hook and the wire is this file's own invention.
 */
import { useVendoChat } from "@vendoai/ui";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const textOf = (parts: { type: string }[]): string =>
  parts.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

function AgentChat(): React.JSX.Element {
  // The hook stores nothing, so the conversation's id is the HOST's to carry.
  // This one carries it in the URL — the same way a real app's route would.
  const opened = new URLSearchParams(globalThis.location.search).get("thread") ?? undefined;
  const chat = useVendoChat({
    api: "/api/agent",
    ...(opened === undefined ? {} : { threadId: opened }),
    onThreadId: (id) => {
      const next = new URL(globalThis.location.href);
      next.searchParams.set("thread", id);
      globalThis.history.replaceState(null, "", next);
    },
  });
  const [draft, setDraft] = useState("");

  return (
    <main>
      <p data-testid="thread-id">{chat.threadId ?? ""}</p>
      <p data-testid="status">{chat.status}</p>
      <ul data-testid="messages">
        {chat.messages.map((message) => (
          <li key={message.id} data-testid={`message-${message.role}`}>{textOf(message.parts)}</li>
        ))}
      </ul>
      <ul data-testid="interruptions">
        {chat.interruptions.map((interruption) => (
          <li key={interruption.id} data-testid="interruption">
            <span data-testid="interruption-tool">
              {interruption.type === "approval" ? interruption.toolCall.tool : "input"}
            </span>
            <button data-testid="approve" onClick={() => void chat.resume({ [interruption.id]: "approve" })}>
              Approve
            </button>
          </li>
        ))}
      </ul>
      <input
        data-testid="composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        data-testid="send"
        onClick={() => {
          chat.sendMessage({ text: draft });
          setDraft("");
        }}
      >
        Send
      </button>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<AgentChat />);
