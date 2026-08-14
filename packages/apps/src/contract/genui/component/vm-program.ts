/**
 * The program that runs INSIDE the VM — as source text, because that is the
 * only thing a QuickJS context accepts.
 *
 * Three layers, evaluated in this order by ./boot.ts:
 *
 *   1. {@link sealSource}     — what the VM must not have.
 *   2. {@link SCREEN_RUNTIME} — Preact, a fake host to render into, and the
 *                               recorder that turns a render into data.
 *   3. {@link installSource}  — this screen's data, this screen's component,
 *                               and the first paint.
 *
 * THE RECORDER. Preact needs a DOM. It gets ~60 lines of one (`document`
 * creates plain objects; `insertBefore`/`removeChild` splice arrays) — enough
 * for the differ to commit and reorder, and nothing more. But the emitted tree
 * is read off the committed VNODE tree, not off those objects, because the DOM
 * is the wrong place to read props from: `setAttribute` stringifies, so
 * `amount_cents={4200}` would come back `"4200"`, and Preact deliberately drops
 * a function-valued prop that is not an `on*` event, which is exactly the
 * handler drawer's input. The vnode carries what the component actually wrote.
 *
 * The price is two of Preact's minified internals — `vnode.__k` (children) and
 * `container.__k` (the root) — and the price is affordable because Preact's
 * bytes are VENDORED, verbatim and pinned, in ./preact-source.ts: they cannot
 * move under this file without someone regenerating that one.
 *
 * NO CLOCK, NO TIMERS, NO SCHEDULER. Preact's two scheduling seams —
 * `options.debounceRendering` (state updates) and `options.requestAnimationFrame`
 * (passive effects) — are pointed at one in-VM queue that the host drains, so a
 * `setState` and a `useEffect` both land synchronously and in order, with no
 * `setTimeout` in the VM at all. `act()` in Preact's own test utilities is the
 * same trick.
 */
import { PREACT_HOOKS_SOURCE, PREACT_JSX_RUNTIME_SOURCE, PREACT_SOURCE } from "./preact-source.js";
import { SCREEN_ACTION_COMPONENT } from "./types.js";

/**
 * The names the VM must NOT carry.
 *
 * `Date` and `Math.random` are `$expr`'s two deletions, for `$expr`'s reason: a
 * screen that reads them paints differently on two identical renders. Timers
 * join them here — a screen paints from data and events, and a `setTimeout`
 * inside a VM the host drives by hand is a scheduled event nobody will ever
 * run. Each is REPLACED rather than deleted where a message helps: "not a
 * function" tells whoever repairs the screen nothing.
 *
 * `console` is the exception that is added rather than removed: a stray
 * `console.log` is not a capability, and a bare context has no `console`, so
 * without this one a debug line the model forgot to delete is a ReferenceError
 * that takes the whole screen down.
 */
export function sealSource(now: number | undefined): string {
  const clock = now === undefined
    ? `delete globalThis.Date;`
    : `(function () {
  var Real = Date, frozen = ${JSON.stringify(now)};
  var statics = { now: function () { return frozen; }, parse: Real.parse, UTC: Real.UTC };
  globalThis.Date = new Proxy(Real, {
    construct: function (target, args) { return Reflect.construct(Real, args.length ? args : [frozen]); },
    apply: function () { return new Real(frozen).toString(); },
    get: function (target, key) { return key in statics ? statics[key] : target[key]; },
  });
})();`;
  return `${clock}
Math.random = function () { throw new TypeError("Math.random() is not available here — a screen has to paint the same twice"); };
globalThis.setTimeout = function () { throw new TypeError("setTimeout() is not available in a screen — a screen paints from its query data and from events, never from a clock"); };
globalThis.setInterval = globalThis.setTimeout;
globalThis.clearTimeout = function () {};
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };
0`;
}

/** How deep the emitter walks into one prop's value before it stops. Deeper
 *  than any real prop and shallow enough that a cycle cannot spin. */
const MAX_PROP_DEPTH = 8;

/** Turns of the drain queue one operation may take. A render that schedules a
 *  state update that schedules another is normal; a thousand of them is a loop
 *  the wall-clock budget would otherwise have to catch. */
const MAX_FLUSH_TURNS = 64;

/** The engine, in the VM. Depends on the three Preact globals above it and on
 *  `__vendo_tool`, the host's tool bridge, both of which it captures and then
 *  deletes off the global object so the screen's own code cannot reach them. */
const ENGINE = `(function () {
  var preact = globalThis.preact, hooks = globalThis.preactHooks, jsx = globalThis.jsxRuntime;
  var options = preact.options;
  var callTool = globalThis.__vendo_tool;

  // ── the fake host ─────────────────────────────────────────────────────────
  // Everything Preact 10 touches on a node, and nothing else. Props are read
  // off the vnode (see the header), so setAttribute and addEventListener are
  // deliberately holes: whatever Preact decided to do with a prop, the emitted
  // tree does not read it back.
  function Style() {}
  Style.prototype.setProperty = function () {};
  Style.prototype.removeProperty = function () {};

  function Node(name) {
    this.nodeType = name === "#text" ? 3 : 1;
    this.localName = name;
    this.childNodes = [];
    this.parentNode = null;
    this.data = "";
    this.style = new Style();
  }
  Node.prototype.insertBefore = function (child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    var at = before == null ? -1 : this.childNodes.indexOf(before);
    if (at === -1) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
    return child;
  };
  Node.prototype.appendChild = function (child) { return this.insertBefore(child, null); };
  Node.prototype.removeChild = function (child) {
    var at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  Node.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  // Preact asks this before it moves a node: is the node it means to insert
  // before still under this parent? Without it, inserting a row ABOVE an
  // existing row dies on "not a function" — the initial paint never asks.
  Node.prototype.contains = function (node) {
    for (var at = node; at != null; at = at.parentNode) if (at === this) return true;
    return false;
  };
  // Read off the container to pick the namespace it creates children in, and
  // read off a node only on the hydrate path this engine never takes.
  Node.prototype.namespaceURI = "http://www.w3.org/1999/xhtml";
  Node.prototype.attributes = [];
  Node.prototype.setAttribute = function () {};
  Node.prototype.removeAttribute = function () {};
  Node.prototype.addEventListener = function () {};
  Node.prototype.removeEventListener = function () {};
  Object.defineProperty(Node.prototype, "firstChild", {
    get: function () { return this.childNodes[0] || null; },
  });
  Object.defineProperty(Node.prototype, "nextSibling", {
    get: function () {
      var parent = this.parentNode;
      if (!parent) return null;
      return parent.childNodes[parent.childNodes.indexOf(this) + 1] || null;
    },
  });
  globalThis.document = {
    createElement: function (name) { return new Node(name); },
    createElementNS: function (namespace, name) { return new Node(name); },
    createTextNode: function (text) { var node = new Node("#text"); node.data = String(text); return node; },
  };

  // ── the scheduler ─────────────────────────────────────────────────────────
  var queue = [];
  options.debounceRendering = function (run) { queue.push(run); };
  options.requestAnimationFrame = function (run) { queue.push(run); };

  // ── the emitter ───────────────────────────────────────────────────────────
  // One handler id per (structural path, prop name), minted once and kept
  // forever: a re-render that moves a row does not renumber the rows above it,
  // and a keyed row keeps its handlers even when a row is inserted over it.
  var slots = {}, minted = 0, drawer = {};

  function handlerId(slot) {
    var id = slots[slot];
    if (id === undefined) { id = "h" + ++minted; slots[slot] = id; }
    return id;
  }

  function emitValue(value, slot, depth) {
    if (typeof value === "function") { var id = handlerId(slot); drawer[id] = value; return { $handler: id }; }
    if (value === null || typeof value !== "object") return typeof value === "symbol" ? undefined : value;
    if (preact.isValidElement(value)) return emitNode(value, slot, depth);
    // A frozen-clock screen can hold a real Date. Left to the object walk below
    // it would emit as {} — a Date has no enumerable own properties.
    if (typeof Date !== "undefined" && value instanceof Date) return value.toISOString();
    if (depth >= ${MAX_PROP_DEPTH}) return undefined;
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(emitValue(value[i], slot + "." + i, depth + 1));
      return list;
    }
    var out = {};
    for (var key in value) out[key] = emitValue(value[key], slot + "." + key, depth + 1);
    return out;
  }

  function emitProps(props, slot, depth) {
    var out = {};
    if (props === null || typeof props !== "object") return out;
    for (var key in props) {
      if (key === "children" || key === "key" || key === "ref") continue;
      var value = emitValue(props[key], slot + "#" + key, depth);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  // The children of a vnode: what the differ committed if it has been
  // committed, and what the component wrote if this vnode is only a prop's
  // value and was never rendered at all.
  function childrenOf(vnode) {
    if (vnode.__k != null) return vnode.__k;
    return preact.toChildArray(vnode.props && vnode.props.children);
  }

  function emitNode(vnode, slot, depth) {
    var type = vnode.type;
    if (typeof type !== "string") {
      throw new Error("a component cannot be passed as a prop value (at " + slot + ") — pass it as children, or pass the data it needs");
    }
    var children = [];
    collect(childrenOf(vnode), children, slot, depth);
    var node = { component: type, props: emitProps(vnode.props, slot, depth + 1), children: children };
    if (vnode.key != null) node.key = String(vnode.key);
    return node;
  }

  // A vnode list, flattened onto \`into\`. Components and fragments are
  // transparent: they contribute their own children, never a node, because the
  // host has never heard of them.
  function collect(list, into, parentSlot, depth) {
    if (list == null) return;
    for (var i = 0; i < list.length; i++) {
      var child = list[i];
      if (child == null || child === false || child === true) continue;
      if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
        into.push(String(child));
        continue;
      }
      var type = child.type;
      if (type == null) { into.push(String(child.props)); continue; }
      if (typeof type === "function") { collect(childrenOf(child), into, parentSlot, depth); continue; }
      var slot = parentSlot + "." + (child.key == null ? into.length : type + ":" + child.key);
      into.push(emitNode(child, slot, depth));
    }
  }

  // ── the driver ────────────────────────────────────────────────────────────
  var root = null, component = null, eventPhase = false, failure = null;

  function describe(error) {
    if (error === null || typeof error !== "object") return { message: String(error) };
    return {
      message: typeof error.message === "string" ? error.message : String(error),
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }

  // The React shape trained code reads. A bare value delivered as the event IS
  // the value, so \`fire("h3", "ada")\` reaches \`e.target.value\`.
  function makeEvent(raw) {
    var value;
    var bag = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    if (bag) {
      if ("value" in bag) value = bag.value;
      else if (bag.target !== null && typeof bag.target === "object" && "value" in bag.target) value = bag.target.value;
    } else if (raw !== null && raw !== undefined) value = raw;
    var event = {};
    for (var key in bag) event[key] = bag[key];
    event.target = { value: value };
    if (bag && bag.target !== null && typeof bag.target === "object") {
      for (var inner in bag.target) if (inner !== "value") event.target[inner] = bag.target[inner];
    }
    event.currentTarget = event.target;
    event.value = value;
    event.preventDefault = function () {};
    event.stopPropagation = function () {};
    return event;
  }

  // ── the screen's own surface ──────────────────────────────────────────────
  var tools = (function make(path) {
    return new Proxy(function () {}, {
      get: function (target, key) { return typeof key === "string" ? make(path.concat(key)) : undefined; },
      apply: function (target, self, args) {
        if (path.length === 0) throw new TypeError("tools is not itself a tool — call one on it, like tools.cancel_transfer({ id })");
        if (!eventPhase) {
          throw new Error("tools." + path.join(".") + "() cannot run while the screen renders — tools run inside event handlers, and a screen paints from its useQuery data");
        }
        return callTool(path, args[0]);
      },
    });
  })([]);

  // <${SCREEN_ACTION_COMPONENT}> (./types.ts): a write as one element. It is a
  // Button whose press goes down the handler path unchanged — the same proxy,
  // the same intent — so it adds nothing to trust and inherits the whole story
  // the guard already tells about a press. Every other prop rides through to the
  // Button, so the two agree with the declarations by construction
  // (checking/screen-typings.ts prints Button's own props here, minus its
  // handler slot); \`onClick\` is written LAST, so it is the component's alone.
  function actionButton(props) {
    var button = {};
    for (var key in props) if (key !== "tool" && key !== "args") button[key] = props[key];
    button.onClick = function () { return tools[props.tool](props.args); };
    return preact.createElement("Button", button);
  }

  globalThis.__vendo = {
    tools: tools,
    actionButton: actionButton,

    mount: function (loaded) {
      component = loaded;
      root = new Node("#root");
      eventPhase = false;
      preact.render(preact.createElement(component, null), root);
    },

    fire: function (id, event) {
      var handler = drawer[id];
      eventPhase = true;
      if (typeof handler !== "function") {
        throw new Error('no handler "' + id + '" is on this screen — it named ' + Object.keys(drawer).length + " handler(s) at its last paint; deliver an event from the tree you are showing");
      }
      var returned = handler(makeEvent(event));
      // An async handler's throw lands here, long after the call returned. The
      // host reads it back with takeFailure() once the queues are quiet.
      if (returned !== null && typeof returned === "object" && typeof returned.then === "function") {
        returned.then(null, function (error) { failure = describe(error); });
      }
    },

    /** Everything the screen scheduled: state updates, then passive effects,
     *  in the order Preact queued them. Returns how much ran, so the host
     *  knows whether to look again. */
    flush: function () {
      var ran = 0;
      for (var turn = 0; queue.length > 0 && turn < ${MAX_FLUSH_TURNS}; turn++) {
        var batch = queue;
        queue = [];
        for (var i = 0; i < batch.length; i++) { batch[i](); ran++; }
      }
      if (queue.length > 0) {
        queue = [];
        throw new Error("this screen never stopped re-rendering — a state update during render or inside an effect that sets the same state every time");
      }
      return ran;
    },

    /** Marks the next flush as an event's, so a tool call resumed after an
     *  await is still inside a handler as far as \`tools\` is concerned. */
    resume: function () { eventPhase = true; },

    takeFailure: function () {
      var taken = failure;
      failure = null;
      return taken === null ? "null" : JSON.stringify(taken);
    },

    /** The paint, as JSON. Handlers stay in here; the tree carries their ids. */
    serialize: function () {
      drawer = {};
      var nodes = [];
      collect(root.__k == null ? [] : [root.__k], nodes, "root", 0);
      if (nodes.length === 0) {
        throw new Error("this screen painted nothing — it returned null; a screen always paints, and an empty result is an empty-state component");
      }
      if (nodes.length !== 1 || typeof nodes[0] !== "object") {
        throw new Error("a screen must paint exactly one root element, and this one painted " + nodes.length + " — wrap what it returns in a single container component");
      }
      return JSON.stringify(nodes[0]);
    },
  };

  // ── the modules a screen may import ───────────────────────────────────────
  function copy(from, names, onto) {
    for (var i = 0; i < names.length; i++) if (names[i] in from) onto[names[i]] = from[names[i]];
    return onto;
  }

  // Preact's own surface, minus the four names that would let a screen reach
  // outside itself: render/hydrate (a second root in our fake document) and
  // options (Preact's scheduling seams, which this engine owns).
  var react = copy(preact, ["createElement", "cloneElement", "createContext", "createRef", "isValidElement", "Fragment", "Component", "toChildArray"], {});
  copy(hooks, ["useState", "useReducer", "useEffect", "useLayoutEffect", "useRef", "useImperativeHandle", "useMemo", "useCallback", "useContext", "useDebugValue", "useErrorBoundary", "useId"], react);
  react.StrictMode = preact.Fragment;
  react.memo = function (component) { return component; };
  react.forwardRef = function (render) { return function (props) { return render(props, props.ref); }; };
  react.Children = {
    map: function (children, fn) { return preact.toChildArray(children).map(fn); },
    forEach: function (children, fn) { preact.toChildArray(children).forEach(fn); },
    toArray: preact.toChildArray,
    count: function (children) { return preact.toChildArray(children).length; },
    only: function (children) {
      var one = preact.toChildArray(children);
      if (one.length !== 1) throw new Error("Children.only expected one child");
      return one[0];
    },
  };
  react.default = react;

  var jsxModule = copy(jsx, ["jsx", "jsxs", "jsxDEV", "jsxTemplate", "Fragment"], {});

  globalThis.__vendo_modules = {
    react: react,
    "react/jsx-runtime": jsxModule,
    "react/jsx-dev-runtime": jsxModule,
  };
  globalThis.__vendo_require = function (id) {
    var found = __vendo_modules[id];
    if (found === undefined) {
      throw new Error('a screen cannot import "' + id + '" — the only modules it has are ' + Object.keys(__vendo_modules).join(", "));
    }
    return found;
  };

  // The globals the engine captured are now unreachable from the screen.
  delete globalThis.preact;
  delete globalThis.preactHooks;
  delete globalThis.jsxRuntime;
  delete globalThis.__vendo_tool;
})();
0`;

/** Preact, then the engine. One string, evaluated once per screen. */
export const SCREEN_RUNTIME = `${PREACT_SOURCE};
${PREACT_HOOKS_SOURCE};
${PREACT_JSX_RUNTIME_SOURCE};
${ENGINE}`;

export interface InstallInput {
  compiledSource: string;
  queries: Record<string, unknown>;
  catalog: readonly string[];
}

/**
 * This screen: its `@vendo/screen` module, its component, its first paint.
 *
 * The compiled source is evaluated as a CommonJS module body — `require`,
 * `module`, `exports` — because that is what a VM can host without a module
 * loader, and because it is one esbuild flag (`format: "cjs"`) away from the
 * TSX the model wrote. An ES module arriving here is a syntax error; ./boot.ts
 * names that case rather than passing the parser's complaint along.
 */
export function installSource(input: InstallInput): string {
  return `(function () {
  var queries = JSON.parse(${JSON.stringify(JSON.stringify(input.queries))});
  var names = JSON.parse(${JSON.stringify(JSON.stringify(input.catalog))});
  var screen = {
    useQuery: function (tool) {
      if (!Object.prototype.hasOwnProperty.call(queries, tool)) {
        throw new Error('useQuery("' + tool + '") — this screen declared no such query; it has ' + (Object.keys(queries).join(", ") || "none"));
      }
      return queries[tool];
    },
    tools: __vendo.tools,
  };
  for (var i = 0; i < names.length; i++) screen[names[i]] = names[i];
  // After the catalog, so the one component with an implementation cannot be
  // shadowed by a bare name.
  screen[${JSON.stringify(SCREEN_ACTION_COMPONENT)}] = __vendo.actionButton;
  __vendo_modules["@vendo/screen"] = screen;

  var module = { exports: {} };
  (function (require, module, exports) {
${input.compiledSource}
  })(__vendo_require, module, module.exports);

  var loaded = module.exports.default === undefined ? module.exports : module.exports.default;
  if (typeof loaded !== "function") {
    throw new Error("this screen exports no component — a screen is one default-exported React component");
  }
  __vendo.mount(loaded, queries);
})();
0`;
}
