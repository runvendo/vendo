/** The published version of every @vendoai/* package (one `fixed` changeset
    group, so one literal serves all of them). It lives HERE because the Cloud
    adapters that stamp it on the wire — the deployment-identity headers — sit
    in core now. Rewritten by scripts/sync-version-constants.mjs on release. */
export const VERSION = "0.24.0";
