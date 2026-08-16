---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The Kit implements the 34 slots the table was shrunk to leave out.

`SLOTS` shipped at what the React Kit actually painted — two of thirty-seven — because a declared slot the component drops is worse than no slot at all: the prompt teaches it, every check admits it, and the person gets a blank. The rest were deferred, not descoped. They land here, table entry and implementation together, and `slot-drift.test.tsx` renders a probe into every one of them and fails unless it finds it in the DOM.

New places to write an element: a `header` and `footer` on Surface, Card and (with `actions`) Form; a `toolbar`, per-row `rowActions` and `empty` on DataTable; `actions` and `empty` on CardList; `empty` on Timeline; `empty`, `legend` and a per-point `tooltip` on LineChart, BarChart and DonutChart; `icon` on Stat; `marker` on Steps; `actions` on Tabs; `prefix`, `suffix` and `hint` on Input; `hint` and a `footer` on Textarea; `hint` on DatePicker; `label` on Divider. Four props widen from a scalar to take an element as well as the value they took before — `Progress.label`, `EmptyState.icon` (still a lucide name when it is a string), `DonutChart.legend` (still `false` to take the built-in key away), and each control's `hint`.

A chart's `tooltip` publishes the hovered point on `RowContext`, so the value components inside name their field exactly as a table cell's do — the cell contract, per point. It renders through a function rather than as a bare element, because recharts clones whatever element it is handed with eighteen of its own internal props and React writes every one of them onto the DOM node.

An `empty` slot replaces the container's dashed box rather than its text: what goes in one is an `EmptyState`, which draws that frame itself, and nested it read as a box inside a box.

Every slot also gets its entry in the component's `props`, the way `Timeline.cell` and `Timeline.marker` already had one. The screen typings and the wire's allowed-prop set are printed from `props` alone, so a slot declared only in `SLOTS` is one the catalog teaches and `components-exist` then refuses by name. **This fixes `Modal.header`, `Modal.footer`, `Sheet.header` and `Sheet.footer`, which are in that state on `main` today** — declared, taught, painted, and blocked at the floor. A new sweep pins the rule for every slot there will ever be.

`Select.hint` is the one slot from the worklist not implemented here.
