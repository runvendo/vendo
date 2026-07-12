/** 08-ui §6 — banner body for an existing chrome theme/style boundary. */
export function PolicyNoticeBody() {
  return (
    <section className="vendo-notice" role="region" aria-label="Vendo is running without a policy">
      <strong>Vendo is running without a policy</strong>
      <div>Actions use the default approval posture. Configure <code>.vendo/policy.json</code>.</div>
    </section>
  );
}
