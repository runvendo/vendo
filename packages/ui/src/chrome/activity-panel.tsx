import { useState } from "react";
import { useActivity } from "../hooks/use-activity.js";
import { useVendoTools } from "../context.js";
import { ChromeRoot } from "./chrome-root.js";
import { ActivityLedger } from "./activity-ledger.js";

/** 08-ui §4 — self-scoped, user-facing audit transparency. Every row is a
    concrete action taken as the user (a tool call, an approval, a connection…)
    rendered as one icon-ledger line (ui-lane-panels pick B): kind glyph,
    humanized action with the input preview folded in, plain-language result,
    relative timestamp. Pagination ends in an explicit end-of-list marker. */
export function ActivityPanel() {
  const { events, isLoading, hasMore, loadMore } = useActivity();
  const tools = useVendoTools();
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
        {error ? <div role="alert" className="fl-act-err fl-act-row">{error}</div> : null}
        {events.length === 0 ? (
          <p className="fl-act-row fl-act-now">
            {isLoading ? "Loading activity…" : "Nothing has run as you yet"}
          </p>
        ) : (
          <>
            <p className="fl-act-cap" style={{ margin: 0 }}>Actions performed as your account</p>
            <ActivityLedger events={events} tools={tools} />
          </>
        )}
        {events.length > 0 ? (
          <div className="fl-act-foot">
            {hasMore ? (
              <button className="fl-btn" type="button" onClick={() => void loadNext()}>Load more</button>
            ) : (
              <p className="fl-act-end" data-testid="activity-end">You’ve reached the end of your activity.</p>
            )}
          </div>
        ) : null}
      </section>
    </ChromeRoot>
  );
}
