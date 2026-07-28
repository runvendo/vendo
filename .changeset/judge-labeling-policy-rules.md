---
"@vendoai/vendo": patch
---

Teach the judge three labeling rules the mutation test cannot derive.

The risk section of the judge prompt now states, alongside the mutation test:

- **A catch-all route is graded at its worst operation.** When one URL fronts
  many operations (`[...nextauth]`, `[trpc]`, an upload or OAuth SDK handler),
  which method reaches which operation is decided inside the dependency, not in
  the host's source — so the tool is graded at the most dangerous operation
  reachable behind that URL, and when the source cannot settle it, at the worst
  plausible one, said out loud in the reason.
- **`destructive` needs bulk or irreversible loss.** A hard delete of one easily
  re-created row or object — remove a member, cancel an invite, remove an image
  — is a `write`. If every delete were destructive the top grade would mean
  nothing.
- **An unrecallable outbound effect is a `write` with no row written** — mail or
  SMS sent, a webhook delivered, a payment captured, an external checkout or
  billing-portal session created.

Doctrine is unchanged: hardenings still apply immediately, loosenings still need
the skeptic and a human, and the self-consistency check still drops a grade that
contradicts its own reason.
