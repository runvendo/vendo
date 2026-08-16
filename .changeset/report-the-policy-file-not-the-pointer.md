---
"@vendoai/vendo": patch
---

The config report ships the policy document, not the pointer to it.

`guard({ policy: { file: ".vendo/policy.json" } })` names a policy document; it is not one. The report sent the knob verbatim, so the console's Policy card showed `{"file":".vendo/policy.json"}` labelled "set in code" and then failed it against the policy schema, which wants a real `vendo/policy@1` document. The pointer is now followed at report time — the path taken exactly as the guard takes it — and the file's own bytes are reported as a file surface. Inline rules, preset names and `profile.policy` are values rather than pointers and still report as code.
