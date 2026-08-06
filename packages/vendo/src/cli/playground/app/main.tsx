/**
 * The CLI IIFE entry: the playground server serves this bundle at
 * `/playground.js` and boots it into `#root`. All the surface logic lives in
 * `./surface.js` — the SAME module `@vendoai/vendo/try-surface` exports, so
 * the CLI bundle and vendo-web build from one source. This file is only the browser bootstrap (it touches
 * the DOM at load, which is why it stays out of the importable module).
 */
import { mount } from "./surface.js";

mount(document.getElementById("root")!);
