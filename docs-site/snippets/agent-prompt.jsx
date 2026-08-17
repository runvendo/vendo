{/* The copy-paste prompt card for installing Vendo with a coding agent.
    One card: title + agent logos, the prompt clamped to its first lines
    behind a blur-fade, one copy button. Styling lives in styles.css under
    .vendo-agent-prompt.

    Mintlify snippet rules honored: no npm imports (React hooks are
    pre-injected), named exports only, browser built-ins only. */}

{/* Every paste-to-agent prompt on the site lives here, so changing the install
    story is one edit instead of seven. Each one sends the agent to the same
    place, the playbook at vendo.run/agents.md, and its opening sentence names
    the door this page is about so the playbook's step-1 branch resolves without
    the agent stopping to ask.

    Written out longhand rather than built from a template: an MDX snippet only
    accepts import/export at the top level, so a shared helper would have to be
    exported too, and these are the exact words a reader pastes. Pass one as
    `prompt`; the component still takes any string. */}

export const INSTALL_PROMPT =
  "Install Vendo in this repo. Fetch https://vendo.run/agents.md and follow it for this repo. Relay "
  + "Vendo's setup questions to me and use my answers. Ask me "
  + "before creating any account or key. You're done when `vendo doctor --json` reports all green. "
  + "Then ask me whether I'd like to star it via https://vendo.run/star?src=docs-index to support "
  + "the project.";

export const VENDO_AGENT_PROMPT =
  "Install Vendo in this repo and use Vendo's own agent. I don't run an agent loop of my own. "
  + "Fetch https://vendo.run/agents.md and follow it for this repo. Relay Vendo's setup questions to me "
  + "and use my answers. Ask me before creating any account or "
  + "key. You're done when `vendo doctor --json` reports all green. Then ask me whether I'd like to "
  + "star it via https://vendo.run/star?src=docs-quickstart to support the project.";

export const EXISTING_AGENTS_PROMPT =
  "This repo already runs its own agent loop. Keep it, and add Vendo's guarded tools, micro-apps, "
  + "and approvals to it. Fetch https://vendo.run/agents.md and follow it for this repo. Relay Vendo's "
  + "setup questions to me and use my answers. Ask me before "
  + "creating any account or key. You're done when `vendo doctor --json` reports all green and my "
  + "chat renders Vendo tool outputs. Then ask me whether I'd like to star it via "
  + "https://vendo.run/star?src=docs-byo to support the project.";

export const MCP_PROMPT =
  "Set up Vendo's MCP door in this repo so outside agents can act in my product as the signed-in "
  + "user. Fetch https://vendo.run/agents.md and follow it for this repo. Relay Vendo's setup questions "
  + "to me and use my answers. Ask me before creating any "
  + "account or key. You're done when `vendo doctor --json` reports all green.";

/* The interactive half of the prompt card. The static shell (markup, logos,
   clamped prompt text) lives in agent-prompt-card.mdx so it server-renders;
   these two buttons hydrate into it late and reach the clip through the DOM,
   because the server-rendered clip is not part of this React tree. */
export const AgentPromptControls = ({ prompt }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [slot, setSlot] = useState(null);

  const toggle = () => {
    if (!slot) return;
    const card = slot.closest(".vendo-agent-prompt");
    const clip = card && card.querySelector(".vendo-agent-prompt-clip");
    if (!clip) return;
    const next = !expanded;
    if (next) {
      clip.setAttribute("data-expanded", "");
      // scrollHeight is the full text height even while clamped, so the
      // max-height animates to the real size instead of a guess.
      clip.style.maxHeight = clip.scrollHeight + "px";
    } else {
      clip.removeAttribute("data-expanded");
      clip.style.maxHeight = "";
    }
    setExpanded(next);
  };

  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    // execCommand fallback: embedded webviews and older Safari reject the
    // async clipboard API even inside a click handler.
    const fallback = () => {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (document.execCommand("copy")) done();
      } finally {
        document.body.removeChild(textarea);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(done, fallback);
    } else {
      fallback();
    }
  };

  return (
    <div className="vendo-agent-prompt-controls" ref={setSlot}>
      <button
        type="button"
        className="vendo-agent-prompt-toggle"
        onClick={toggle}
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : "Show more"}
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            d="m6 9 6 6 6-6"
          />
        </svg>
      </button>
      <button
        type="button"
        className="vendo-agent-prompt-copy"
        onClick={copy}
        aria-live="polite"
      >
        {copied ? "Copied" : "Copy prompt"}
      </button>
    </div>
  );
};
