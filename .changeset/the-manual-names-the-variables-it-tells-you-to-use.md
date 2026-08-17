---
"@vendoai/apps": minor
---

The screen manual names every CSS variable it tells a screen to style with, generated from the emitter that sets them.

The manual has always said to style the display tags off the host's own CSS variables, and it named exactly two as examples — `--vendo-color-accent` and `--vendo-density-content-gap`. `themeCssVariables` sets 52. A model reaching for the surface color, a radius, a chart series or any of the thirteen density steps had to guess the name, and a wrong guess is silent: CSS resolves an unknown variable to nothing and the declaration falls back, with no error on any surface.

`references/format.md` now ends with the whole list — each name and a few words of what it is for — walked off `VENDO_THEME_VARIABLE_NAMES`, which is itself read off `themeCssVariables`. The names cannot fall behind a rename or an addition, exactly as the component catalog cannot; only the meanings are written by hand, and a meaning left behind fails a drift test instead of teaching a dead name. Values stay out — they are the host's and per-theme, and the briefing pack already carries them.
