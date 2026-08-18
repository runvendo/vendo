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
import { TREE_MAX_NODES } from "@vendoai/core";
import { KIT_SLOT_PROPS } from "../../kit/specs.js";
import { PREACT_HOOKS_SOURCE, PREACT_JSX_RUNTIME_SOURCE, PREACT_SOURCE } from "./preact-source.js";

/**
 * The names the VM must NOT carry — and the two it may hold only from the host.
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
 *
 * The frozen clock and {@link INTL_SOURCE} are the other shape of the same rule:
 * both are things a screen genuinely needs, both would read the machine the VM
 * happens to run on, so both are answered by the HOST instead — the clock as one
 * pinned instant, `Intl` across the wall.
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
${INTL_SOURCE}
0`;
}

/**
 * Real `Intl`, borrowed from the host.
 *
 * QuickJS is built without ICU: there is no `Intl` in here at all, and the
 * `toLocaleString` family it does carry degrades to `toString()`. So the idiom
 * every model was trained on —
 * `cents.toLocaleString("en-US", { style: "currency", currency: "USD" })`,
 * `new Date(row.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })`
 * — painted `4200` and a full ISO stamp where a browser paints `$4,200.00` and
 * `Aug 17`. Every name below therefore exists, and every one of them is answered
 * ACROSS THE WALL by the host's own `Intl` (./boot.ts `answerIntl`) through the
 * same synchronous host function the tool bridge is built from. Formatted text is
 * text, so nothing new crosses.
 *
 * WHAT IS PINNED. A locale or a `timeZone` the screen NAMES is honoured — it wrote
 * it. What it leaves out comes from the host's boot options and never from the
 * machine the VM happens to be running on, so one screen over one set of data
 * prints the same string on a laptop in Cairo and on a worker in Iowa.
 *
 * A VALUE CROSSES AS TEXT. JSON has no `NaN` and no `Infinity`, and `Intl` prints
 * both ("NaN", "∞"); as JSON they would arrive as `null` and format as zero — a
 * date in 1970 where a browser throws. So a value rides as its decimal spelling
 * and the host reads it back with `Number`.
 *
 * THE SURFACE IS THE TYPINGS' SURFACE, EXACTLY. What a screen may write is what
 * `lib.es2020.d.ts` declares (server/checking/screen-typings.ts
 * `COMPONENT_SCREEN_LIB`), so every value-side name in that lib's `Intl` is here
 * and nothing else is: `Collator`, `DateTimeFormat`, `DisplayNames`, `Locale`,
 * `NumberFormat`, `PluralRules`, `RelativeTimeFormat`, `getCanonicalLocales`,
 * each with the methods that lib gives it. A name the lib admits and this file
 * omits is a screen that passes every gate and then dies on its first paint with
 * "not a function" — the pre-bridge trap, reborn on the edges — and a name here
 * that the lib does not declare is unreachable code. `screen-intl-parity.test.ts`
 * walks both sides and refuses any difference, in either direction; `ListFormat`,
 * `Segmenter` and the `formatRange` family are absent here because that lib does
 * not declare them, and adding them means moving the lib pin first.
 */
const INTL_SOURCE = `(function () {
  var ask = globalThis.__vendo_intl;
  delete globalThis.__vendo_intl;
  // Captured before the screen's own code can reassign either: what the host is
  // asked is what this file said to ask.
  var stringify = JSON.stringify, parse = JSON.parse, isArray = Array.isArray;

  /** A locales argument as the list of TAGS it names. A \`Locale\` from below reads
   *  as its own tag, the way a real one does when it is passed as a locale. */
  function tags(locales) {
    return locales === undefined ? [] : (isArray(locales) ? locales : [locales]).map(String);
  }

  /** The same list, or NOTHING where the screen named no locale at all — what it
   *  left out is the wall's, and an empty list is the machine's default in a
   *  browser, which is the one answer this box may never give. */
  function named(locales) {
    var list = tags(locales);
    return list.length === 0 ? undefined : list;
  }

  // \`unit\` is \`RelativeTimeFormat\`'s alone; \`stringify\` drops it where it is
  // undefined, so every other ask crosses the wall the shape it always did.
  function answer(op, locale, options, value, unit) {
    return ask(stringify({ op: op, locale: named(locale), options: options, value: value, unit: unit }));
  }

  /** The same ask for the formats whose argument is TEXT rather than a number: a
   *  collation's two operands, a display name's code, one locale tag, or the
   *  whole locales list a \`supportedLocalesOf\` is asked about. */
  function about(op, locale, options, text) {
    return ask(stringify({ op: op, locale: named(locale), options: options, text: text }));
  }

  /** Any value as the decimal spelling of a number. A Date reads as its instant,
   *  which is what \`Intl\` does with one too. */
  function spell(value) { return String(Number(value)); }

  /** The instant to format: the one passed, or — where a screen passed none — the
   *  clock, which is the host's frozen instant or, if the host withheld it, the
   *  same ReferenceError every other clock read gets. */
  function when(value) { return value === undefined ? String(Date.now()) : spell(value); }

  // All four are callable with \`new\` and without, the way \`Intl\`'s own
  // declarations describe them: a constructor that returns an object returns that
  // object.
  function NumberFormat(locale, options) {
    return {
      format: function (value) { return answer("number", locale, options, spell(value)); },
      formatToParts: function (value) { return parse(answer("numberParts", locale, options, spell(value))); },
      resolvedOptions: function () { return parse(answer("numberResolved", locale, options)); },
    };
  }
  function DateTimeFormat(locale, options) {
    return {
      format: function (value) { return answer("date", locale, options, when(value)); },
      formatToParts: function (value) { return parse(answer("dateParts", locale, options, when(value))); },
      resolvedOptions: function () { return parse(answer("dateResolved", locale, options)); },
    };
  }
  // "2 hours ago", "in 3 days" — the phrasing a screen writes for a timestamp,
  // and one nobody hand-rolls correctly. The unit rides beside the count because
  // it is the only ask whose format takes two arguments.
  function RelativeTimeFormat(locale, options) {
    return {
      format: function (value, unit) { return answer("relative", locale, options, spell(value), unit); },
      formatToParts: function (value, unit) { return parse(answer("relativeParts", locale, options, spell(value), unit)); },
      resolvedOptions: function () { return parse(answer("relativeResolved", locale, options)); },
    };
  }
  // Which plural form a count takes ("one", "other", and the four more some
  // locales have) — the half of "1 item / 2 items" that an \`=== 1\` gets wrong
  // everywhere but English.
  function PluralRules(locale, options) {
    return {
      select: function (value) { return answer("plural", locale, options, spell(value)); },
      resolvedOptions: function () { return parse(answer("pluralResolved", locale, options)); },
    };
  }
  // Where two strings sort in a locale's own alphabet — the half of an
  // alphabetical list that \`<\` gets wrong the moment a name leaves ASCII ("ä"
  // sorts after "z" by codepoint and beside "a" in German). \`compare\` reads
  // nothing off \`this\`, so \`rows.sort(collator.compare)\` works detached, the way
  // a real one does.
  function Collator(locale, options) {
    return {
      compare: function (x, y) { return Number(about("collate", locale, options, [String(x), String(y)])); },
      resolvedOptions: function () { return parse(answer("collateResolved", locale, options)); },
    };
  }
  // A region, language, script or currency code as the words a person reads:
  // "US" → "United States". \`of\` answers \`undefined\` for a code the locale has no
  // name for, which JSON cannot carry, so \`null\` crosses and reads back as the
  // \`undefined\` the standard promises.
  function DisplayNames(locale, options) {
    return {
      of: function (code) {
        var name = parse(about("display", locale, options, [String(code)]));
        return name === null ? undefined : name;
      },
      resolvedOptions: function () { return parse(answer("displayResolved", locale, options)); },
    };
  }
  // One tag taken apart — the language, region and script a screen reads off it.
  // Resolved by the host in a single ask, \`maximize\`/\`minimize\` included: those
  // two answer out of CLDR's likely-subtags table, which is exactly the data this
  // VM does not carry, so each returns the tag the host resolved rather than a
  // guess made in here.
  function Locale(tag, options) {
    var facts = parse(about("locale", undefined, options, [String(tag)]));
    return {
      baseName: facts.baseName,
      calendar: facts.calendar,
      caseFirst: facts.caseFirst,
      collation: facts.collation,
      hourCycle: facts.hourCycle,
      language: facts.language,
      numberingSystem: facts.numberingSystem,
      numeric: facts.numeric,
      region: facts.region,
      script: facts.script,
      maximize: function () { return Locale(facts.maximized); },
      minimize: function () { return Locale(facts.minimized); },
      toString: function () { return facts.tag; },
    };
  }

  /** \`supportedLocalesOf\`, which every one of these constructors carries. It is
   *  per-constructor because each format has its own locale data — a locale the
   *  host can count in can be one it cannot phrase an interval in. */
  function supported(op) {
    return function (locales, options) { return parse(about(op, undefined, options, tags(locales))); };
  }
  NumberFormat.supportedLocalesOf = supported("numberSupported");
  DateTimeFormat.supportedLocalesOf = supported("dateSupported");
  RelativeTimeFormat.supportedLocalesOf = supported("relativeSupported");
  PluralRules.supportedLocalesOf = supported("pluralSupported");
  Collator.supportedLocalesOf = supported("collateSupported");
  DisplayNames.supportedLocalesOf = supported("displaySupported");

  globalThis.Intl = {
    Collator: Collator,
    DateTimeFormat: DateTimeFormat,
    DisplayNames: DisplayNames,
    Locale: Locale,
    NumberFormat: NumberFormat,
    PluralRules: PluralRules,
    RelativeTimeFormat: RelativeTimeFormat,
    getCanonicalLocales: function (locales) { return parse(about("canonical", undefined, undefined, tags(locales))); },
  };

  Number.prototype.toLocaleString = function (locale, options) {
    return answer("number", locale, options, spell(this));
  };
  // \`Collator\` by another name, and the one every model reaches for to sort a
  // column of names. Unbridged it was WORSE than missing: QuickJS answers it by
  // codepoint, so it returned a number — the wrong one — and painted a list in an
  // order nobody would notice was wrong.
  String.prototype.localeCompare = function (that, locale, options) {
    return Number(about("collate", locale, options, [String(this), String(that)]));
  };
  // Only where the host gave a clock: withheld, \`Date\` was deleted above and
  // there is no prototype left to reach.
  if (typeof Date !== "undefined") {
    Date.prototype.toLocaleDateString = function (locale, options) { return answer("day", locale, options, spell(this)); };
    Date.prototype.toLocaleTimeString = function (locale, options) { return answer("time", locale, options, spell(this)); };
    Date.prototype.toLocaleString = function (locale, options) { return answer("stamp", locale, options, spell(this)); };
  }
})();`;

/** How deep the emitter walks into one prop's value before it stops. Deeper
 *  than any real prop and shallow enough that a cycle cannot spin. */
const MAX_PROP_DEPTH = 8;

/** Turns of the drain queue one operation may take. A render that schedules a
 *  state update that schedules another is normal; a thousand of them is a loop
 *  the wall-clock budget would otherwise have to catch. */
const MAX_FLUSH_TURNS = 64;

/** How deep the emitted tree may nest. A screen paints sections, not a chain,
 *  and the host walks this tree recursively on the other side. */
const MAX_TREE_DEPTH = 128;

/** How large one paint may be, measured on the JSON string in code units —
 *  which for a tree of component names and props is its byte count. */
const MAX_TREE_BYTES = 512 * 1_024;

/** The engine, in the VM. Depends on the three Preact globals above it and on
 *  `__vendo_tool`, the host's tool bridge, both of which it captures and then
 *  deletes off the global object so the screen's own code cannot reach them. */
const ENGINE = `(function () {
  var preact = globalThis.preact, hooks = globalThis.preactHooks, jsx = globalThis.jsxRuntime;
  var options = preact.options;
  var callTool = globalThis.__vendo_tool;
  // The intrinsics the engine still needs AFTER the screen's own code has run,
  // held where the screen cannot reach them: a screen that assigned
  // JSON.stringify would otherwise hand the host a tree it never painted.
  var stringify = JSON.stringify, keys = Object.keys, isArray = Array.isArray, create = Object.create;

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
  // and a keyed row keeps its handlers even when a row is inserted over it. A
  // per-row slot puts the row's index IN that path, which is the whole of how one
  // slot written once becomes one handler per row (see emitSlot below).
  var slots = {}, minted = 0, drawer = {};

  // A key that would mean the prototype chain rather than data once the host
  // parses this tree back. Never emitted, whatever the screen calls it.
  function unsafe(key) { return key === "__proto__" || key === "prototype" || key === "constructor"; }

  function handlerId(slot) {
    var id = slots[slot];
    if (id === undefined) { id = "h" + ++minted; slots[slot] = id; }
    return id;
  }

  function emitValue(value, slot, depth) {
    if (typeof value === "function") { var id = handlerId(slot); drawer[id] = value; return { $handler: id }; }
    if (value === null || typeof value !== "object") return typeof value === "symbol" ? undefined : value;
    // An element in a PROP reads back as a plain object, indistinguishable from
    // data — so it carries a sigil, as a function does. It is what the renderer
    // builds a component back out of (ui/tree/renderer.tsx bindValue). A tree
    // node is never stamped: it already arrives where a node belongs.
    if (preact.isValidElement(value)) { var element = emitNode(value, slot, depth); element.$element = true; return element; }
    // A frozen-clock screen can hold a real Date. Left to the object walk below
    // it would emit as {} — a Date has no enumerable own properties.
    if (typeof Date !== "undefined" && value instanceof Date) return value.toISOString();
    if (depth >= ${MAX_PROP_DEPTH}) return undefined;
    if (isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(emitValue(value[i], slot + "." + i, depth + 1));
      return list;
    }
    // Own keys onto a bare object: what the screen wrote, and nothing its
    // prototype carries or the host's Object.prototype would answer for.
    var out = create(null), names = keys(value);
    for (var at = 0; at < names.length; at++) {
      var key = names[at];
      if (unsafe(key)) continue;
      out[key] = emitValue(value[key], slot + "." + key, depth + 1);
    }
    return out;
  }

  // The Kit's slot law as data (contract/kit/specs.ts KIT_SLOT_PROPS), onto a bare
  // object so a component NAME can never answer off Object.prototype.
  var SLOT_PROPS = Object.assign(create(null), ${JSON.stringify(KIT_SLOT_PROPS)});

  // A slot written as a FUNCTION returning its element: called HERE, and what it
  // returns is emitted at the slot's own path. No \`rows\` in the declaration means
  // the Kit paints the slot once, so the call takes no arguments; a per-row slot is
  // called once for every row, each call under its OWN path — and distinct paths
  // mint distinct handler ids, which is the whole of what makes a closure over one
  // row a real closure. What comes out then is a list the component matches to its
  // rows.
  function emitSlot(fn, props, declared, slot, depth) {
    if (declared.rows === undefined) return emitValue(fn(), slot, depth);
    var rows = props[declared.rows];
    if (!isArray(rows)) return emitValue(fn(rows, 0), slot, depth);
    var out = [];
    for (var i = 0; i < rows.length; i++) out.push(emitValue(fn(rows[i], i), slot + "[" + i + "]", depth));
    return out;
  }

  // One prop that carries a slot: the slot itself (\`footer\`, \`rowActions\`), or a
  // list of field descriptions each of which may carry one (\`columns[].cell\`).
  // An ELEMENT written in either place still emits as the element it is.
  function emitSlotProp(value, props, declared, slot, depth) {
    var field = declared.field;
    if (field === undefined) {
      return typeof value === "function" ? emitSlot(value, props, declared, slot, depth) : emitValue(value, slot, depth);
    }
    if (!isArray(value)) return emitValue(value, slot, depth);
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var entry = value[i], path = slot + "." + i;
      if (entry === null || typeof entry !== "object" || typeof entry[field] !== "function") {
        out.push(emitValue(entry, path, depth + 1));
        continue;
      }
      var described = create(null), fields = keys(entry);
      for (var at = 0; at < fields.length; at++) {
        var name = fields[at];
        if (unsafe(name)) continue;
        described[name] = name === field
          ? emitSlot(entry[name], props, declared, path + "." + name, depth + 1)
          : emitValue(entry[name], path + "." + name, depth + 1);
      }
      out.push(described);
    }
    return out;
  }

  function emitProps(props, type, slot, depth) {
    var out = create(null);
    if (props === null || typeof props !== "object") return out;
    var slotProps = SLOT_PROPS[type], names = keys(props);
    for (var at = 0; at < names.length; at++) {
      var key = names[at];
      if (key === "children" || key === "key" || key === "ref" || unsafe(key)) continue;
      var declared = slotProps === undefined ? undefined : slotProps[key];
      var path = slot + "#" + key;
      var value = declared === undefined
        ? emitValue(props[key], path, depth)
        : emitSlotProp(props[key], props, declared, path, depth);
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
    var node = { component: type, props: emitProps(vnode.props, type, slot, depth + 1), children: children };
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

  // What the host is about to parse, counted BEFORE it is JSON — the parse on
  // the other side is one parse too late. The node cap is core's TREE_MAX_NODES
  // so the cap in here and the gate out there are one number, and a text child
  // counts as a node because that is what it becomes when the tree is flattened.
  var counted = 0;

  function measure(node, depth) {
    if ((counted += 1) > ${TREE_MAX_NODES}) {
      throw new Error("this screen painted more than ${TREE_MAX_NODES} nodes — paint a page of rows and let an event ask for the next");
    }
    if (depth > ${MAX_TREE_DEPTH}) {
      throw new Error("this screen nested components more than ${MAX_TREE_DEPTH} deep — a screen paints a list of sections, not a chain");
    }
    if (typeof node === "string") return;
    for (var i = 0; i < node.children.length; i++) measure(node.children[i], depth + 1);
  }

  // ── the screen's data ─────────────────────────────────────────────────────
  // Keyed by the tool AND the input, because a screen reads one tool as many
  // times as it has questions — a detail panel beside a list is two reads of the
  // same tool. A key nobody has answered yet is a MISS: the host runs the read
  // and hands the answer to \`supply\`, which re-renders THIS root, so the hooks
  // the first paint set up survive.
  //
  // The host keys its half the same way — \`queryKey\` in ./types.ts. The two
  // copies are one law and must agree.
  var data = create(null), missing = create(null);

  // What a MISS hands back. An OBJECT, never \`undefined\`: react-query's shape is
  // the one trained code knows, and there \`useQuery\` always returns an object
  // whose \`data\` is simply absent until the answer lands. So the first paint's
  // \`rows.data\` is a read that yields undefined rather than a throw on
  // undefined, and \`rows.data ?? []\` and \`rows?.data\` keep meaning what they
  // say. \`undefined\` and not \`[]\`: a screen may not be handed an empty result it
  // would then assert — "no rows yet" is not "no rows".
  //
  // ONE value for every miss, so it is the same object on every render and a
  // \`useMemo\`/\`useEffect\` dependency on a pending read does not churn.
  var MISS = { data: undefined };

  function keyOf(tool, input) { return input === undefined ? tool : tool + " " + stringify(input); }

  function useQuery(tool, input) {
    var key = keyOf(tool, input);
    if (key in data) return data[key];
    missing[key] = { tool: tool, input: input };
    return MISS;
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

  var api = {
    tools: (function make(path) {
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
    })([]),

    useQuery: useQuery,

    mount: function (loaded) {
      component = loaded;
      root = new Node("#root");
      eventPhase = false;
      preact.render(preact.createElement(component, null), root);
    },

    /** The reads this screen asked for and had no answer to, as JSON. TAKEN, not
     *  copied: the host answers them and asks again, and a key the host could not
     *  answer is asked once per round rather than forever. */
    misses: function () {
      var out = [], taken = missing;
      missing = create(null);
      for (var key in taken) out.push(taken[key]);
      return stringify(out);
    },

    /** Answers, keyed the way \`useQuery\` keys its reads, merged in and painted
     *  into the SAME root — a re-render, never a re-boot, so useState survives. */
    supply: function (json) {
      var got = JSON.parse(json);
      for (var key in got) data[key] = got[key];
      if (root !== null) preact.render(preact.createElement(component, null), root);
    },

    fire: function (id, event) {
      var handler = drawer[id];
      eventPhase = true;
      if (typeof handler !== "function") {
        throw new Error('no handler "' + id + '" is on this screen — it named ' + keys(drawer).length + " handler(s) at its last paint; deliver an event from the tree you are showing");
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
      return taken === null ? "null" : stringify(taken);
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
      counted = 0;
      measure(nodes[0], 1);
      var json = stringify(nodes[0]);
      if (json.length > ${MAX_TREE_BYTES}) {
        throw new Error("this paint is too large to hand over at " + json.length + " code units (max ${MAX_TREE_BYTES}) — paint a page of rows and let an event ask for the next");
      }
      return json;
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

  // The module space is the engine's, not a global the screen can extend or
  // swap: ./installSource takes it from here, adds its one module and freezes it.
  api.modules = {
    react: react,
    "react/jsx-runtime": jsxModule,
    "react/jsx-dev-runtime": jsxModule,
  };
  api.require = function (id) {
    var found = api.modules[id];
    if (found === undefined) {
      throw new Error('a screen cannot import "' + id + '" — the only modules it has are ' + keys(api.modules).join(", "));
    }
    return found;
  };

  // Not writable, not configurable, and nothing on it can be replaced — the
  // host calls these by name after the screen's code has run.
  Object.defineProperty(globalThis, "__vendo", { value: Object.freeze(api) });

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
  var names = JSON.parse(${JSON.stringify(JSON.stringify(input.catalog))});
  __vendo.supply(${JSON.stringify(JSON.stringify(input.queries))});
  var screen = { useQuery: __vendo.useQuery, tools: __vendo.tools };
  for (var i = 0; i < names.length; i++) screen[names[i]] = names[i];
  // The last module the space will ever hold. Frozen, and named nowhere the
  // screen's own code can reach, before that code runs.
  var modules = __vendo.modules;
  modules["@vendo/screen"] = screen;
  Object.freeze(modules);

  var module = { exports: {} };
  (function (require, module, exports) {
${input.compiledSource}
  })(__vendo.require, module, module.exports);

  var loaded = module.exports.default === undefined ? module.exports : module.exports.default;
  if (typeof loaded !== "function") {
    throw new Error("this screen exports no component — a screen is one default-exported React component");
  }
  __vendo.mount(loaded);
})();
0`;
}
