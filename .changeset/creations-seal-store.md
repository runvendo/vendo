---
"@vendoai/apps": minor
---

seal a built app's bundle as content-addressed blobs: `sealBundleBlobs` freezes one build's files under `apps/<appId>/bundle/<sha256>` and describes them as an `AppBundle`, `readBundleBlob` reads one back by its hash. Keying by content rather than by path is what makes a seal immutable — a reseal mints fresh keys instead of overwriting the bytes an open tab is still rendering, and two concurrent seals cannot collide
