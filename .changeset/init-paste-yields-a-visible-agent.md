---
"@vendoai/vendo": patch
---

Init's ONE-STEP paste now yields a visible agent: the frame prints
`<VendoOverlay />` inside the provider wrap (annotated for hosts that render
their own surface). The paste used to stop at `<VendoProvider>`, which renders
nothing — a verbatim install completed invisible while doctor E-WIRE-006
hard-failed exactly that state. One paste, one visible result, and the frame
finally agrees with the gate.
