---
"@vendoai/core": patch
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

A texted turn authenticates its host calls. `presence: "present"` meant two things at once — "a person is here, so ask them to approve" and "forward the caller's browser credentials" — and a text message satisfies the first without the second: there is no request behind it. So a linked customer's tool call reached the host API carrying nothing, the host answered 401, and the agent apologised for a sign-in problem the person could do nothing about. `RunContext` now carries `channelLink`, the text channel's evidence that this subject authorized this phone, and the actions registry authenticates such calls through the ActAs seam — exactly as it already does for MCP-OAuth users, who have no browser session either. Presence stays `present`, because that is what lets the guard ask for approval on a money-moving call instead of refusing it outright.
