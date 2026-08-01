/** A failed refresh must not hide a usable app, but users need an honest way
 * to see that it may be out of date and ask for another refresh. */
export function AppStaleNotice({ error, onRetry }: { error: Error; onRetry(): void }) {
  return (
    <div role="alert" className="fl-error">
      This view may be out of date — {error.message}
      <button type="button" className="fl-error-retry" onClick={onRetry}>Try again</button>
    </div>
  );
}
