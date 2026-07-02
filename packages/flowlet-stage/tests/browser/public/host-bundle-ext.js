import r from "react";
import { createRoot as i } from "react-dom/client";
import { jsxs as c, jsx as t } from "react/jsx-runtime";
function s({ title: e, body: a, accountName: l, action: o, __nodeId: d }) {
  return /* @__PURE__ */ c(
    "div",
    {
      "data-testid": "host-card",
      style: {
        background: "var(--flowlet-surface)",
        color: "var(--flowlet-fg)",
        padding: 16,
        borderRadius: 8
      },
      children: [
        /* @__PURE__ */ t("h3", { style: { color: "var(--flowlet-accent)" }, children: e }),
        /* @__PURE__ */ t("p", { children: a }),
        l ? /* @__PURE__ */ t("span", { "data-testid": "card-account", children: l }) : null,
        o ? /* @__PURE__ */ t(
          "button",
          {
            "data-testid": "card-btn",
            onClick: () => globalThis.__flowletDispatch(o, d),
            children: o.label
          }
        ) : null
      ]
    }
  );
}
function u() {
  throw new Error("boom");
}
function _({ children: e }) {
  return /* @__PURE__ */ t("div", { "data-testid": "row", children: e });
}
function h({ label: e }) {
  return /* @__PURE__ */ t("span", { "data-prewired": !0, "data-testid": "badge", children: e || "badge" });
}
const n = r.createContext(null);
function b() {
  const e = r.useContext(n);
  return /* @__PURE__ */ t("span", { "data-theme-marker": !0, children: (e == null ? void 0 : e.marker) ?? "" });
}
function f() {
  globalThis.__FLOWLET_THEME_WRAP__ = (e, a) => r.createElement(n.Provider, { value: e }, a);
}
globalThis.__React = r;
globalThis.__createRoot = i;
globalThis.__FLOWLET_HOST__ = { Card: s, Boom: u, __row: _, __badge: h, ThemeProbe: b };
f();
