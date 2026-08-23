{/* The copy-paste prompt card for installing Vendo with a coding agent.
    One card: title + agent logos, the prompt clamped to its first lines
    behind a blur-fade, one copy button. Styling lives in styles.css under
    .vendo-agent-prompt.

    Mintlify snippet rules honored: no npm imports (React hooks are
    pre-injected), named exports only, browser built-ins only. */}

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
