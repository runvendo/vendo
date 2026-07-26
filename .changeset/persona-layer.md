---
"@vendoai/vendo": minor
---

Add a per-user persona layer to the agent.

- A per-subject persona record (how the user works, the tools they reach for, the formats they prefer, durable facts they state) stored as opaque data in a vendo_records collection keyed by subject, so it rides the host's own database with no schema change.
- Two guard-bound, subject-scoped agent tools, vendo_persona_load and vendo_persona_remember, folded into the same registry the app tools use, so persona reads and writes are policed and audited like every other tool.
- distillPersona, which builds or refreshes a subject's persona from their own threads and audit trail, deterministically by default.
- An offline replay harness that measures whether a persona-conditioned turn reproduces a user's held-out decisions.

Generation stays user-blind: the persona reaches the agent prompt only, never a generated document, and no subject boundary is crossed.
