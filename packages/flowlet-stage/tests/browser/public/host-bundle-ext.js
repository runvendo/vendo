import i from "react";
import { createRoot as n } from "react-dom/client";
import { jsxs as l, jsx as r } from "react/jsx-runtime";
function c({ title: t, body: o, accountName: d, action: a, __nodeId: e }) {
  return /* @__PURE__ */ l(
    "div",
    {
      "data-testid": "host-card",
      style: {
        background: "var(--brand-surface)",
        color: "var(--brand-text)",
        padding: 16,
        borderRadius: 8
      },
      children: [
        /* @__PURE__ */ r("h3", { style: { color: "var(--brand-primary)" }, children: t }),
        /* @__PURE__ */ r("p", { children: o }),
        d ? /* @__PURE__ */ r("span", { "data-testid": "card-account", children: d }) : null,
        a ? /* @__PURE__ */ r(
          "button",
          {
            "data-testid": "card-btn",
            onClick: () => globalThis.__flowletDispatch(a, e),
            children: a.label
          }
        ) : null
      ]
    }
  );
}
function s() {
  throw new Error("boom");
}
function b({ children: t }) {
  return /* @__PURE__ */ r("div", { "data-testid": "row", children: t });
}
function _({ label: t }) {
  return /* @__PURE__ */ r("span", { "data-prewired": !0, "data-testid": "badge", children: t || "badge" });
}
globalThis.__React = i;
globalThis.__createRoot = n;
globalThis.__FLOWLET_HOST__ = { Card: c, Boom: s, __row: b, __badge: _ };
