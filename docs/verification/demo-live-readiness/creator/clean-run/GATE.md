# Final self-gate — https://demos.vendo.run/linear-tracker

Verdict: **PASS** — login, scenario cards, and one live generation verified on the deployed demo.

| Step | OK | Detail | Screenshot |
| --- | --- | --- | --- |
| service-up | yes | https://demos.vendo.run/linear-tracker serves HTTP | — |
| open | yes | landed on https://demo-linear-tracker-production.up.railway.app/login | gate-1-product.png |
| login | yes | logged in with the demo password; authenticated on / | gate-2-logged-in.png |
| scenario-cards | yes | all 3 beat cards render | gate-3-panel.png |
| generation-sent | yes | sent the "generate-ui" beat prompt through the composer | gate-4-sent.png |
| generation-complete | yes | a generated Vendo view painted and the turn settled | gate-5-generated.png |
