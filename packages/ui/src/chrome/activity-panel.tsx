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
      <section className="vendo-stack" aria-labelledby="vendo-activity-heading">
        <h2 id="vendo-activity-heading">Activity</h2>
        {error ? <div role="alert" className="vendo-danger">{error}</div> : null}
        {events.length === 0 ? <p>Nothing has run as you yet</p> : (
          <div className="vendo-table-wrap">
            <table className="vendo-table">
              <caption className="vendo-muted">Actions performed as your account</caption>
              <thead><tr><th>Time</th><th>Kind</th><th>Tool</th><th>Inputs</th><th>Outcome</th><th>Decided by</th></tr></thead>
              <tbody>
                {events.map(event => (
                  <tr key={event.id}>
                    <td><time dateTime={event.at}>{event.at}</time></td>
                    <td>{event.kind}</td>
                    <td>{event.tool ?? "—"}</td>
                    <td>{event.inputPreview ?? "—"}</td>
                    <td>{event.outcome ?? "—"}</td>
                    <td>{event.decidedBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div><button type="button" onClick={() => void loadNext()}>Load more</button></div>
      </section>
    </ChromeRoot>
  );
}
