---
"@vendoai/ui": patch
---

A failed slot keeps its headline and its ways out, in whatever box the host sized.
The other slot CTAs are three words over a skeleton, so the overlay carrying them
is positioned absolutely and contributes no height. A failure carries a classified
build reason — real prose — and that overlay is centred, so in a rail-width or
host-sized slot the ghost's `overflow: hidden` sliced "This view didn't build" off
the top and "Try again" / "Clear this slot" off the bottom, leaving a bare
developer sentence with no title and no way out. The DOM held all of it, so
`toBeVisible()` had been calling it visible for as long as the card has existed.

The failure card stacks in flow now, on the same grid cell as the skeleton, so it
grows to its own content instead of being clipped by it; the reason also stops
bleeding past the card's padding. Every other slot state is untouched.
