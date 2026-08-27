---
"@vendoai/store": patch
---

fix: pin the GCM authentication tag at 16 bytes when sealing and opening stored secrets

`createDecipheriv` without `authTagLength` verifies a tag at whatever length the
stored envelope happens to carry, and GCM permits tags as short as 4 bytes — so
an attacker who can write the envelope gets to attack a short tag instead of the
full one. Both the cipher and the decipher now pin 16. Every envelope this code
has ever written already carries Node's default 16-byte tag, so nothing at rest
changes and existing secrets keep decrypting.
