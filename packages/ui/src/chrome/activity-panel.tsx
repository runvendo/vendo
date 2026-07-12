import { useState } from "react";
import { useActivity } from "../hooks/use-activity.js";
import { ChromeRoot } from "./chrome-root.js";

/** 08-ui §4 — self-scoped, user-facing audit transparency. */
export function ActivityPanel() {
  const { events, loadMore } = useActivity();
  const [error, setError] = useState<string>();

  const loadNext = async () => {
    setError(undefined);
    try {
      await loadMore();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ChromeRoot>
      <section className="fl-act" aria-labelledby="vendo-activity-heading">
        <header className="fl-act-head">
          <span className="fl-act-ic fl-act-tick" aria-hidden="true">✓</span>
          <h2 id="vendo-activity-heading" className="fl-act-head-lbl" style={{ margin: 0 }}>Activity</h2>
        </header>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {events.length === 0 ? <p className="fl-act-row">Nothing has run as you yet</p> : (
          <table className="fl-act-body" style={{ borderCollapse: "collapse", display: "block", width: "100%" }}>
            <caption className="fl-act-now" style={{ padding: "8px 13px", textAlign: "left" }}>Actions performed as your account</caption>
            <thead style={{ display: "block" }}>
              <tr
                className="fl-act-row"
                style={{
                  borderBottom: "1px solid var(--vendo-border)",
                  display: "grid",
                  gridTemplateColumns: "1.35fr .8fr 1.25fr 1.25fr .8fr 1fr",
                }}
              >
                <th style={{ textAlign: "left" }}>Time</th>
                <th style={{ textAlign: "left" }}>Kind</th>
                <th style={{ textAlign: "left" }}>Tool</th>
                <th style={{ textAlign: "left" }}>Inputs</th>
                <th style={{ textAlign: "left" }}>Outcome</th>
                <th style={{ textAlign: "left" }}>Decided by</th>
              </tr>
            </thead>
            <tbody style={{ display: "block" }}>
              {events.map(event => {
                const ok = event.outcome === "ok";
                const running = event.outcome === undefined;
                const pending = event.outcome === "pending-approval";
                return (
                  <tr
                    className="fl-act-row"
                    key={event.id}
                    style={{
                      borderBottom: "1px solid var(--vendo-border)",
                      display: "grid",
                      gridTemplateColumns: "1.35fr .8fr 1.25fr 1.25fr .8fr 1fr",
                    }}
                  >
                    <td className="fl-act-sub" style={{ marginLeft: 0, maxWidth: "none" }}><time dateTime={event.at}>{event.at}</time></td>
                    <td>{event.kind}</td>
                    <td className="fl-act-lbl">{event.tool ?? "—"}</td>
                    <td className="fl-act-sub" style={{ marginLeft: 0, maxWidth: "none" }}>{event.inputPreview ?? "—"}</td>
                    <td>
                      <span className="fl-act-ic" aria-hidden="true">
                        {running ? <span className="fl-act-pulse" />
                          : pending ? <span className="fl-act-spin" />
                          : <span className={ok ? "fl-act-tick" : "fl-act-x"}>{ok ? "✓" : "✕"}</span>}
                      </span>
                      <span>{event.outcome ?? "—"}</span>
                    </td>
                    <td className="fl-act-sub" style={{ marginLeft: 0, maxWidth: "none" }}>{event.decidedBy ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="fl-act-row">
          <button className="fl-btn" type="button" onClick={() => void loadNext()}>Load more</button>
        </div>
      </section>
    </ChromeRoot>
  );
}
