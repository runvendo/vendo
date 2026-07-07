# Papermark Layer 3 Worker Report

## What changed

- Added Papermark-specific Layer 3 prep in `corpus/harness/src/e2e-prep.ts`.
- Prep now writes a deterministic Papermark fixture seed, a curated `.vendo/tools.json`, a stable `/corpus-e2e` App Router page, a `/api/corpus-login` session route, and small support shims needed by the pinned Papermark checkout during deep boot.
- Marked Papermark write tools as mutating so create-link, add-to-dataroom, and update-link settings flows surface approval cards instead of executing directly.
- Extended the e2e layer to authenticate Papermark attempts through `/api/corpus-login` and run them on `/corpus-e2e?vendoThread=...`.
- Added unit coverage for Papermark prep, Papermark e2e host authentication/URL restoration, and Papermark's deterministic `vendo init` skip for corpus runs.

## Auth and fixture approach

- The fixture seed creates `e2e@corpus.test`, the `Corpus E2E Team`, three documents, the `Investor Room` dataroom, seeded links, and viewer activity for `analyst@example.test`.
- `/api/corpus-login` uses the pinned app's NextAuth JWT encoder and sets a session cookie for the seeded user.
- The e2e host page avoids Papermark dashboard imports that are not needed for Vendo chat coverage and were brittle in the pinned checkout.
- Dummy Stripe test env values are appended only inside the generated Papermark checkout so server-side route imports can initialize.

## Final Layer 3 result

Exact command:

```sh
while ! mkdir /tmp/vendo-l3-port3000.lock 2>/dev/null; do sleep 30; done
trap 'rmdir /tmp/vendo-l3-port3000.lock 2>/dev/null || true' EXIT
set -a
source apps/demo-bank/.env.local
set +a
pnpm corpus run papermark --layer 3 2>&1 | tee /tmp/l3-papermark-run.log
```

Scorecard:

```text
# Corpus scorecard

Generated: 2026-07-07T04:31:42.922Z

Summary: 3/3 layers passing; 0 hard failures.

| Repo | Layer | Status | Score | Logs |
| --- | --- | --- | --- | --- |
| papermark | Layer 1 structural | PASS | 7/7 | [.repos/.logs/papermark/bootstrap.stdout.log](.repos/.logs/papermark/bootstrap.stdout.log), [.repos/.logs/papermark/bootstrap.stderr.log](.repos/.logs/papermark/bootstrap.stderr.log), [.repos/.logs/papermark/baseline.typecheck.stdout.log](.repos/.logs/papermark/baseline.typecheck.stdout.log), [.repos/.logs/papermark/baseline.typecheck.stderr.log](.repos/.logs/papermark/baseline.typecheck.stderr.log), [.repos/.logs/papermark/baseline.build.stdout.log](.repos/.logs/papermark/baseline.build.stdout.log), [.repos/.logs/papermark/baseline.build.stderr.log](.repos/.logs/papermark/baseline.build.stderr.log), [.repos/.logs/papermark/init.first.log](.repos/.logs/papermark/init.first.log), [.repos/.logs/papermark/init.first.diff](.repos/.logs/papermark/init.first.diff), [.repos/.logs/papermark/init.second.log](.repos/.logs/papermark/init.second.log), [.repos/.logs/papermark/init.second.diff](.repos/.logs/papermark/init.second.diff), [.repos/.logs/papermark/structural.typecheck.stdout.log](.repos/.logs/papermark/structural.typecheck.stdout.log), [.repos/.logs/papermark/structural.typecheck.stderr.log](.repos/.logs/papermark/structural.typecheck.stderr.log), [.repos/.logs/papermark/structural.build.stdout.log](.repos/.logs/papermark/structural.build.stdout.log), [.repos/.logs/papermark/structural.build.stderr.log](.repos/.logs/papermark/structural.build.stderr.log) |
| papermark | Layer 2 scored | PASS | 10/10 |  |
| papermark | Layer 3 e2e | PASS | 5/5 | [.repos/.logs/papermark/bootstrap.stdout.log](.repos/.logs/papermark/bootstrap.stdout.log), [.repos/.logs/papermark/bootstrap.stderr.log](.repos/.logs/papermark/bootstrap.stderr.log), [.repos/.logs/papermark/baseline.typecheck.stdout.log](.repos/.logs/papermark/baseline.typecheck.stdout.log), [.repos/.logs/papermark/baseline.typecheck.stderr.log](.repos/.logs/papermark/baseline.typecheck.stderr.log), [.repos/.logs/papermark/baseline.build.stdout.log](.repos/.logs/papermark/baseline.build.stdout.log), [.repos/.logs/papermark/baseline.build.stderr.log](.repos/.logs/papermark/baseline.build.stderr.log), [.repos/.logs/papermark/init.first.log](.repos/.logs/papermark/init.first.log), [.repos/.logs/papermark/init.first.diff](.repos/.logs/papermark/init.first.diff), [.repos/.logs/papermark/init.second.log](.repos/.logs/papermark/init.second.log), [.repos/.logs/papermark/init.second.diff](.repos/.logs/papermark/init.second.diff), [.repos/.logs/papermark/e2e.prepare.log](.repos/.logs/papermark/e2e.prepare.log), [.repos/.logs/papermark/boot.server.log](.repos/.logs/papermark/boot.server.log), [.repos/.logs/papermark/boot.seed.log](.repos/.logs/papermark/boot.seed.log), [.repos/.logs/papermark/boot.database.log](.repos/.logs/papermark/boot.database.log), [.repos/.logs/papermark/e2e.conversations.json](.repos/.logs/papermark/e2e.conversations.json) |
```

Conversation results from `e2e.conversations.json`:

```text
list-documents: 2/2 attempts passed
document-analytics-summary: 2/2 attempts passed
create-share-link-approval: 2/2 attempts passed
add-document-to-dataroom-approval: 2/2 attempts passed
update-link-settings-approval: 2/2 attempts passed
```

Final pass@2: 5/5 conversations = 1.0, above the 0.8 requirement.

## Flaky conversations and stabilizations

- No conversation was flaky in the final run; all five passed on both attempts.
- Stabilizations were fixture-side and harness-side: deterministic seeded data, a stable authenticated host page, per-attempt thread ids, and curated tool descriptions that direct reads before writes.

## Product or fixture bugs found

- The pinned Papermark checkout needs small OSS/EE support shims for some real team/document APIs to compile in this corpus environment.
- Papermark's route imports require Stripe env values at module initialization even for read-only API flows; dummy test values are now injected into the generated checkout.
- The app dashboard route was too brittle for this harness target, so Layer 3 now uses `/corpus-e2e` as the stable host page while still exercising real Papermark APIs.

## Definition-of-done gates

`pnpm corpus run papermark --layer 3`:

```text
Summary: 3/3 layers passing; 0 hard failures.
| papermark | Layer 1 structural | PASS | 7/7 |
| papermark | Layer 2 scored | PASS | 10/10 |
| papermark | Layer 3 e2e | PASS | 5/5 |
```

`pnpm --filter @vendoai/corpus-harness test`:

```text
 Test Files  13 passed (13)
      Tests  74 passed (74)
   Duration  6.12s
```

`pnpm --filter @vendoai/cli test`:

```text
 Test Files  43 passed (43)
      Tests  425 passed (425)
   Duration  7.07s
```

`pnpm build && pnpm typecheck && pnpm lint`:

```text
build:
 Tasks:    19 successful, 19 total
Cached:    19 cached, 19 total

typecheck:
 Tasks:    30 successful, 30 total
Cached:    29 cached, 30 total

lint:
 Tasks:    2 successful, 2 total
Cached:    2 cached, 2 total
```

Lint exited 0 with existing cached warnings in `demo-bank` and `demo-accounting` for `_prior` unused variables.
