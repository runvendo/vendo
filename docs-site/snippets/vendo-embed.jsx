{/* Inline playable chrome surfaces for the docs (no iframe): shows the
    captured screenshot as an instant-paint poster (doubling as the no-JS and
    link-preview fallback), loads the self-contained embed bundle once, then
    swaps to the REAL component mounted against scripted data.

    Mintlify snippet rules honored: no npm imports (React hooks are
    pre-injected), named exports only, browser built-ins only. */}

export const VendoEmbed = ({ surface, poster, alt, height = 480, caption }) => {
  const containerRef = useRef(null);
  const disposeRef = useRef(null);
  const [live, setLive] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const mount = () => {
      if (cancelled || disposeRef.current || !containerRef.current) return;
      try {
        disposeRef.current = window.VendoDocsEmbed.mount(containerRef.current, { scenario: surface });
        setLive(true);
      } catch (error) {
        console.error("[vendo-embed]", error);
        setFailed(true);
      }
    };

    const onReady = () => mount();
    const onError = () => { if (!cancelled) setFailed(true); };
    if (window.VendoDocsEmbed) {
      mount();
    } else {
      window.addEventListener("vendo-docs-embed-ready", onReady, { once: true });
      // Every instance hears a shared load failure, not just the tag creator.
      window.addEventListener("vendo-docs-embed-error", onError, { once: true });
      const existing = document.querySelector('script[data-vendo-docs-embed]');
      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://vendo.run/playground/embed.js";
        script.async = true;
        script.dataset.vendoDocsEmbed = "";
        script.onerror = () => window.dispatchEvent(new Event("vendo-docs-embed-error"));
        document.head.appendChild(script);
      }
      // The bundle may have finished between the check above and the listener
      // registration — re-check so a won race never strands the poster.
      if (window.VendoDocsEmbed) mount();
    }

    return () => {
      cancelled = true;
      window.removeEventListener("vendo-docs-embed-ready", onReady);
      window.removeEventListener("vendo-docs-embed-error", onError);
      if (disposeRef.current) { disposeRef.current(); disposeRef.current = null; }
    };
  }, [surface]);

  return (
    <figure style={{ margin: "1.5rem 0" }}>
      <div
        style={{
          position: "relative",
          border: "1px solid #e5e5e5",
          borderRadius: "12px",
          overflow: "hidden",
          minHeight: `${height}px`,
        }}
      >
        {!live && (
          <img
            src={poster}
            alt={alt}
            style={{ display: "block", width: "100%", margin: 0 }}
          />
        )}
        {!live && !failed && (
          <div
            style={{
              position: "absolute", right: 10, bottom: 10, padding: "4px 10px",
              borderRadius: "999px", background: "rgba(17,17,17,.78)", color: "#fff",
              fontSize: "11px", fontWeight: 600,
            }}
          >
            loading live component…
          </div>
        )}
        {failed && (
          <div
            style={{
              position: "absolute", right: 10, bottom: 10, padding: "4px 10px",
              borderRadius: "999px", background: "rgba(17,17,17,.78)", color: "#fff",
              fontSize: "11px", fontWeight: 600,
            }}
          >
            live embed unavailable — <a href="https://vendo.run/playground" style={{ color: "#fff", textDecoration: "underline" }}>open the playground</a>
          </div>
        )}
        <div ref={containerRef} style={{ display: live ? "block" : "none", minHeight: `${height}px`, padding: "16px" }} />
      </div>
      {caption && (
        <figcaption style={{ fontSize: "0.8rem", color: "#6b6b76", textAlign: "center", marginTop: "0.5rem" }}>
          {caption}{live ? " — this is the real component; click around." : ""}
        </figcaption>
      )}
    </figure>
  );
};

{/* The live drop-in for a page: mounts the real corner launcher + overlay.
    Renders nothing visible itself; the launcher portals to the body. */}

export const VendoLauncher = () => {
  useEffect(() => {
    let dispose = null;
    let cancelled = false;
    const mountIt = () => {
      if (cancelled || dispose || !window.VendoDocsEmbed) return;
      try { dispose = window.VendoDocsEmbed.mountLauncher(); } catch (error) { console.error("[vendo-embed]", error); }
    };
    if (window.VendoDocsEmbed) {
      mountIt();
    } else {
      window.addEventListener("vendo-docs-embed-ready", mountIt, { once: true });
      const existing = document.querySelector('script[data-vendo-docs-embed]');
      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://vendo.run/playground/embed.js";
        script.async = true;
        script.dataset.vendoDocsEmbed = "";
        // A failed bundle means no launcher — silent by design, but announce
        // for any VendoEmbed instances sharing the tag.
        script.onerror = () => window.dispatchEvent(new Event("vendo-docs-embed-error"));
        document.head.appendChild(script);
      }
      if (window.VendoDocsEmbed) mountIt();
    }
    return () => {
      cancelled = true;
      window.removeEventListener("vendo-docs-embed-ready", mountIt);
      if (dispose) dispose();
    };
  }, []);
  return null;
};
