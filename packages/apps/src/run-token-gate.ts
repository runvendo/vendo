/** Anti-replay gate for run tokens (ENG-251, block-plan decision 5).
 *
 * A run token is a bearer credential the sandbox reuses for EVERY proxy callback
 * over the life of one machine run (06-apps §4.2 — "bearer token scoping this
 * run"), so it cannot be single-use per HTTP call without breaking the product.
 * What we CAN do is revoke it the moment its run is torn down: the machine burns
 * the run's `jti` on evict/stop, and the proxy rejects any token whose jti this
 * set holds. That shrinks the replay window a captured token enjoys from the
 * full 15-min TTL down to the live-run window.
 *
 * The set is bounded (insertion-ordered LRU eviction) so a long-lived process
 * churning through many short runs can never grow it without bound. Evicting the
 * oldest burned jti only re-opens replay for a token that (a) is already older
 * than `cap` other torn-down runs and (b) has not yet hit its own 15-min TTL —
 * an acceptable trade for a fixed memory ceiling.
 */
export interface RunTokenGate {
  /** True once this jti's run has been torn down (its token is revoked). */
  isConsumed(jti: string): boolean;
  /** Burn a jti: every later presentation of its token is rejected. Idempotent. */
  consume(jti: string): void;
}

/** Default ceiling: ~4k concurrently-tracked torn-down runs. */
const DEFAULT_CAP = 4096;

export function createRunTokenGate(cap: number = DEFAULT_CAP): RunTokenGate {
  // A Set preserves insertion order, so the first key is the oldest burned jti.
  const consumed = new Set<string>();
  return {
    isConsumed: (jti) => consumed.has(jti),
    consume(jti) {
      if (consumed.has(jti)) return;
      if (consumed.size >= cap) {
        const oldest = consumed.values().next().value;
        if (oldest !== undefined) consumed.delete(oldest);
      }
      consumed.add(jti);
    },
  };
}
