# teable labeling notes

## `ai-expected.json` risk rows verified and LEFT unchanged

- `GET /api/_monitor/healthcheck` stays `read`. The handler builds a payload
  from two env vars and a timestamp and serializes it; nothing is read from or
  written to storage. `apps/nextjs-app/src/pages/api/_monitor/healthcheck.ts:27`:
  `res.status(200).send(JSON.stringify(payload, undefined, 2));`

This repo's AI risk score reads 0% only because the judgment pass returned
unparseable output for its single batch, so no grade was ever applied to compare
against. That is a model/plumbing failure, not a labeling error — the label above
is correct and relabeling cannot move the score.
