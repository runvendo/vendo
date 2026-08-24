---
"@vendoai/vendo": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
---

Built apps: five fixes found by a live proof against a real box. The build brief now sends the in-box agent to a real disk path, so the bundle it produces is where the host actually reads it — every build previously landed on "the build's own test did not pass" while a working bundle sat on the box. The build watchdog waits longer than the box's own message budget instead of killing real builds at four minutes. An app awaiting the person's yes now reads as pending rather than "This app can't be opened any more". A failed build keeps the app's name instead of renaming it to a cut of the prompt. And a propose that cannot finish takes its standing card back instead of leaving an ask with no build behind it. `@vendoai/harnesses` exports `BOX_WORKSPACE_ROOT` and `MESSAGE_BUDGET_MS`.
