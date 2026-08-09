---
"@vendoai/ui": patch
---

Three pieces of chrome copy no longer name a place the host may not have. The morph toast's fallback subtitle read "Runs as you · recorded in Activity", the approval-required toast hinted "recorded in Activity", and a recurring Slack post was described as "It runs as you, and you can pause it anytime" — all three point at an Activity or automations surface that `@vendoai/ui` ships but cannot know the host mounted. A host that mounts neither (the Maple demo mounts neither) was promising, in its own voice, something it could not honour. Each line now keeps only what is true on every host: the morph toast falls back to the bare "Runs as you" that `venueByline` already uses, the toast hint says what approving means ("Runs as you once approved") instead of where it goes, and the Slack automation sentence ends after "It runs as you." No host is made wrong by the new wording, and none of it invents a destination.
