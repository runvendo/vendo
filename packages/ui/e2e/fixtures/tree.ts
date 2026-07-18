import type { Tree } from "@vendoai/core";

/** Shared real-browser renderer fixture. */
export const browserTreeFixture: Tree = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  data: { customer: { name: "Ada Lovelace" }, invoice: { total: 4200 } },
  nodes: [
    { id: "root", component: "Stack", props: { gap: 14 }, children: ["heading", "host", "row", "bad", "survivor", "streaming"] },
    { id: "heading", component: "Text", props: { text: "Instant-path invoice", variant: "heading" } },
    {
      id: "host",
      component: "HostCard",
      source: "host",
      props: {
        title: { $path: "/customer/name" },
        total: { $path: "/invoice/total" },
      },
    },
    { id: "row", component: "Row", props: { gap: 10 }, children: ["caption", "divider"] },
    { id: "caption", component: "Text", props: { text: "Primitive sibling", variant: "caption" } },
    { id: "divider", component: "Divider" },
    { id: "bad", component: "Boom", source: "host" },
    { id: "survivor", component: "Text", props: { text: "Sibling survived" } },
    { id: "streaming", component: "Stack", children: ["not-yet-streamed"] },
  ],
};
