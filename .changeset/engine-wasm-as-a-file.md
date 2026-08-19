---
"@vendoai/apps": patch
---

Generated screens render in a production build again. The screen engine and
`$expr` rode the SINGLE-FILE QuickJS build, which carries its WebAssembly as a
raw binary string inside the JavaScript — and that string cannot survive a
modern minifier: the WASM bytes contain a backtick, SWC re-quotes the string
with backticks, and the chunk that comes out opens a template literal whose
`\0` bytes are illegal octal escapes. Turbopack's server, SSR and browser
chunks were all unparseable, so the VM never started and the checks floor
correctly refused every screen. The bytes now travel as a FILE: the wasmfile
build's ten-kilobyte loader, handed the module through `wasmBinary` — read off
disk on Node, fetched as a bundler-emitted asset everywhere else. `@vendoai/apps`
ships `quickjs.wasm` beside its `dist`, and the QuickJS it installs drops from
3.1MB to 1.2MB.

And the variant a host hands `warmScreenEngine` now WINS. It used to be
last-warm-wins, which meant `@vendoai/ui`'s own no-variant re-warm on the first
screen mount silently took the engine back — so the documented hatch existed and
never held, and a venue with no network and no asset URL (an offline
single-bundle page, workerd) could not run screens at all. An explicitly passed
variant is now kept: every later default warm is a no-op, and a default already
in flight lands nowhere.
