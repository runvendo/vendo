---
"@vendoai/vendo": minor
---

`auth` is one door, and you can write it by hand.

`createVendo({ auth })` has always taken a preset's result. It now documents and
scaffolds the other half of the same type: an object you write yourself, when
there is no identity vendor to name.

```ts
export const vendo = createVendo({
  auth: {
    principal: async (req) => {
      const user = await getSession(req);
      return user ? { kind: "user", subject: user.id } : null;
    },
    facts: async (req) => ({ plan: (await getSession(req))?.plan }),
  },
});
```

A preset is a function that returns that object, so nothing is reserved to the
preset path — `facts`, `pools`, `memberships`, `actAs` and `oauth` are all
sibling keys you can fill by hand, and you can spread a preset to change one of
them. `principal` is the only required member.

This closes the hole that made `facts` and `pools` feel arbitrary: they never had
a top-level twin, so a host on the raw `principal:` key could not assert anything
about their users at all. Now they write `auth: { principal, facts }`.

The top-level `principal`, `actAs`, and `oauth` keys are `@deprecated` aliases.
They still work and will keep working — nothing breaks — but each is one seam
with nowhere to grow, and the editor now points at `auth`. Mixing them with
`auth` throws at composition, exactly as before.

`vendo init --auth none` writes the object form, so the file it hands you is the
shape you extend rather than one you outgrow.
