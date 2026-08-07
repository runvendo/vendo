{/* The launch announcement pill above the docs home hero. Styling lives in
    styles.css under .vendo-announce.

    The sparkle is an inline SVG rather than the ✨ emoji so it tints to the
    brand color and renders identically on every platform.

    Mintlify snippet rules honored: no npm imports (React hooks are
    pre-injected), named exports only, browser built-ins only. */}

export const AnnouncementPill = ({ href, children }) => (
  <a className="vendo-announce not-prose" href={href}>
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M12 2.5l2.1 5.6 5.6 2.1-5.6 2.1-2.1 5.6-2.1-5.6-5.6-2.1 5.6-2.1z"
      />
    </svg>
    {children}
    <span className="vendo-announce-arrow" aria-hidden="true">→</span>
  </a>
);
