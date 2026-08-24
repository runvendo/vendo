---
"@vendoai/vendo": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
---

Built apps: the build lane. A consented build now runs the person's ask inside a disposable box — npm from the registry, the code written and tested in the box, the files sealed by the host — and the box is handed no store credentials at all. Approving a build card comes straight back instead of holding the request open for the whole build, and a reseal that fails keeps the app it was rebuilding. `@vendoai/harnesses` gains a `./claude-code/box` entry point carrying the box pool and the env/egress it boots with, so composition can reach them without the Agent SDK.
