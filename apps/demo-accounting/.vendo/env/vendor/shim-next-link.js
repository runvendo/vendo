// ../../packages/vendo-sandbox-shims/dist/next-link.js
import { createElement } from "react";

// ../../packages/vendo-sandbox-shims/dist/dispatch.js
var NAVIGATE_ACTION = "vendo.navigate";
function dispatch(action, payload) {
  const fn = globalThis.__vendoDispatch;
  if (typeof fn === "function") {
    fn({ action, payload });
  } else if (typeof console !== "undefined") {
    console.warn(`[vendo] shim dispatch "${action}" with no bridge \u2014 ignored`);
  }
}
function navigate(href) {
  dispatch(NAVIGATE_ACTION, { href });
}

// ../../packages/vendo-sandbox-shims/dist/next-link.js
function hrefString(href) {
  return typeof href === "string" ? href : href.pathname ?? "";
}
function Link({ href, children, onClick, prefetch: _p, replace: _r, scroll: _s, ...rest }) {
  const target = hrefString(href);
  return createElement("a", {
    ...rest,
    href: target,
    onClick: (event) => {
      event.preventDefault();
      onClick?.(event);
      navigate(target);
    }
  }, children);
}
export {
  Link as default
};
