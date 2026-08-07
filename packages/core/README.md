# @vendoai/core

Defines the shared Vendo types, schemas, format constants, validators, hashes,
and conformance seams used across the block set.

Ships ESM first with a CommonJS `require` condition on both subpaths, so CJS
hosts on Node without `require(esm)` still load it. Component-source caps are
enforced in UTF-8 bytes (64 KB / 256 KB), and the schemas for §15's additive
families (error codes, trigger kinds, run models) tolerate unknown variants.

Read the [architecture overview](https://docs.vendo.run/concepts/architecture).
