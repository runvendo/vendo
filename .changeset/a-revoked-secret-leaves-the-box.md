---
"@vendoai/apps": patch
---

Security fix — a revoked secret no longer survives inside a box. When an owner
turned a secret grant off, Vendo rebuilt the box's boundary env without that
secret and pushed it to the machine, but the in-box supervisor MERGED the new set
over the box's own process environment, where the value from provisioning still
sat (a sandbox provider applies create-time env box-wide). The revoked key was
simply absent from the new set rather than removed, so every app restart — and
every in-box agent task — kept handing out a credential the owner had taken away,
for the life of the machine. The boundary env now REPLACES the provisioned one:
the app and the agent get exactly what the host injected plus the machine's own
vars (`PATH`, `HOME`, …), so absence means gone.

If you have already revoked a secret, two things are needed. First the box image:
the supervisor is baked into it, so only machines created from a rebuilt template
carry the fix — rebuild it (`packages/apps/box/build-template.mjs`) and point `VENDO_BOX_TEMPLATE`
at the new id if you run your own sandbox account (on Vendo Cloud the image
arrives with the release). Then, per affected app, `machine.destroy` followed by
`machine.provision`: an existing machine's snapshot froze its environment at
provision time and no wake re-sends it, so that snapshot keeps the old value until
the machine is replaced. Nothing is stale on disk — the value only ever lived in
the box's process environment, and the boundary env file the fix now treats as
authoritative is rewritten on every injection, so a re-provisioned app self-heals
with no migration. Rotating the credential is still the only way to invalidate a
value a box has already read.
