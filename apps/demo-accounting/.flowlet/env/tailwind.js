// node_modules/.pnpm/@tailwindcss+browser@4.3.2/node_modules/@tailwindcss/browser/dist/index.global.js
(() => {
  var nr = "4.3.2";
  function Ze(e) {
    let r = [0];
    for (let l = 0; l < e.length; l++) e.charCodeAt(l) === 10 && r.push(l + 1);
    function o(l) {
      let s = 0, a = r.length;
      for (; a > 0; ) {
        let m = (a | 0) >> 1, u = s + m;
        r[u] <= l ? (s = u + 1, a = a - m - 1) : a = m;
      }
      s -= 1;
      let d = l - r[s];
      return { line: s + 1, column: d };
    }
    function t({ line: l, column: s }) {
      l -= 1, l = Math.min(Math.max(l, 0), r.length - 1);
      let a = r[l], d = r[l + 1] ?? a;
      return Math.min(Math.max(a + s, 0), d);
    }
    return { find: o, findOffset: t };
  }
  var Ke = 92, Je = 47, Qe = 42, lr = 34, ar = 39, Go = 58, Xe = 59, se = 10, et = 13, Le = 32, De = 9, sr = 123, $t = 125, Et = 40, ur = 41, Yo = 91, Zo = 93, cr = 45, St = 64, Jo = 33, ue = class e extends Error {
    loc;
    constructor(r, o) {
      if (o) {
        let t = o[0], l = Ze(t.code).find(o[1]);
        r = `${t.file}:${l.line}:${l.column + 1}: ${r}`;
      }
      super(r), this.name = "CssSyntaxError", this.loc = o, Error.captureStackTrace && Error.captureStackTrace(this, e);
    }
  };
  function Ee(e, r) {
    let o = r?.from ? { file: r.from, code: e } : null;
    e[0] === "\uFEFF" && (e = " " + e.slice(1));
    let t = [], l = [], s = [], a = null, d = null, m = "", u = "", h = 0, p;
    for (let f = 0; f < e.length; f++) {
      let v = e.charCodeAt(f);
      if (!(v === et && (p = e.charCodeAt(f + 1), p === se))) if (v === Ke) m === "" && (h = f), m += e.slice(f, f + 2), f += 1;
      else if (v === Je && e.charCodeAt(f + 1) === Qe) {
        let k = f;
        for (let x = f + 2; x < e.length; x++) if (p = e.charCodeAt(x), p === Ke) x += 1;
        else if (p === Qe && e.charCodeAt(x + 1) === Je) {
          f = x + 1;
          break;
        }
        let b = e.slice(k, f + 1);
        if (b.charCodeAt(2) === Jo) {
          let x = tt(b.slice(2, -2));
          l.push(x), o && (x.src = [o, k, f + 1], x.dst = [o, k, f + 1]);
        }
      } else if (v === ar || v === lr) {
        let k = fr(e, f, v, o);
        m += e.slice(f, k + 1), f = k;
      } else {
        if ((v === Le || v === se || v === De) && (p = e.charCodeAt(f + 1)) && (p === Le || p === se || p === De || p === et && (p = e.charCodeAt(f + 2)) && p == se)) continue;
        if (v === se) {
          if (m.length === 0) continue;
          p = m.charCodeAt(m.length - 1), p !== Le && p !== se && p !== De && (m += " ");
        } else if (v === cr && e.charCodeAt(f + 1) === cr && m.length === 0) {
          let k = "", b = f, x = -1;
          for (let C = f + 2; C < e.length; C++) if (p = e.charCodeAt(C), p === Ke) C += 1;
          else if (p === ar || p === lr) C = fr(e, C, p, o);
          else if (p === Je && e.charCodeAt(C + 1) === Qe) {
            for (let y = C + 2; y < e.length; y++) if (p = e.charCodeAt(y), p === Ke) y += 1;
            else if (p === Qe && e.charCodeAt(y + 1) === Je) {
              C = y + 1;
              break;
            }
          } else if (x === -1 && p === Go) x = m.length + C - b;
          else if (p === Xe && k.length === 0) {
            m += e.slice(b, C), f = C;
            break;
          } else if (p === Et) k += ")";
          else if (p === Yo) k += "]";
          else if (p === sr) k += "}";
          else if ((p === $t || e.length - 1 === C) && k.length === 0) {
            f = C - 1, m += e.slice(b, C);
            break;
          } else (p === ur || p === Zo || p === $t) && k.length > 0 && e[C] === k[k.length - 1] && (k = k.slice(0, -1));
          let O = Vt(m, x);
          if (!O) throw new ue("Invalid custom property, expected a value", o ? [o, b, f] : null);
          o && (O.src = [o, b, f], O.dst = [o, b, f]), a ? a.nodes.push(O) : t.push(O), m = "";
        } else if (v === Xe && m.charCodeAt(0) === St) d = Ue(m), o && (d.src = [o, h, f], d.dst = [o, h, f]), a ? a.nodes.push(d) : t.push(d), m = "", d = null;
        else if (v === Xe && u[u.length - 1] !== ")") {
          let k = Vt(m);
          if (!k) {
            if (m.length === 0) continue;
            throw new ue(`Invalid declaration: \`${m.trim()}\``, o ? [o, h, f] : null);
          }
          o && (k.src = [o, h, f], k.dst = [o, h, f]), a ? a.nodes.push(k) : t.push(k), m = "";
        } else if (v === sr && u[u.length - 1] !== ")") u += "}", d = Z(m.trim()), o && (d.src = [o, h, f], d.dst = [o, h, f]), a && a.nodes.push(d), s.push(a), a = d, m = "", d = null;
        else if (v === $t && u[u.length - 1] !== ")") {
          if (u === "") throw new ue("Missing opening {", o ? [o, f, f] : null);
          if (u = u.slice(0, -1), m.length > 0) if (m.charCodeAt(0) === St) d = Ue(m), o && (d.src = [o, h, f], d.dst = [o, h, f]), a ? a.nodes.push(d) : t.push(d), m = "", d = null;
          else {
            let b = m.indexOf(":");
            if (a) {
              let x = Vt(m, b);
              if (!x) throw new ue(`Invalid declaration: \`${m.trim()}\``, o ? [o, h, f] : null);
              o && (x.src = [o, h, f], x.dst = [o, h, f]), a.nodes.push(x);
            }
          }
          let k = s.pop() ?? null;
          k === null && a && t.push(a), a = k, m = "", d = null;
        } else if (v === Et) u += ")", m += "(";
        else if (v === ur) {
          if (u[u.length - 1] !== ")") throw new ue("Missing opening (", o ? [o, f, f] : null);
          u = u.slice(0, -1), m += ")";
        } else {
          if (m.length === 0 && (v === Le || v === se || v === De)) continue;
          m === "" && (h = f), m += String.fromCharCode(v);
        }
      }
    }
    if (m.charCodeAt(0) === St) {
      let f = Ue(m);
      o && (f.src = [o, h, e.length], f.dst = [o, h, e.length]), t.push(f);
    }
    if (u.length > 0 && a) {
      if (a.kind === "rule") throw new ue(`Missing closing } at ${a.selector}`, a.src ? [a.src[0], a.src[1], a.src[1]] : null);
      if (a.kind === "at-rule") throw new ue(`Missing closing } at ${a.name} ${a.params}`, a.src ? [a.src[0], a.src[1], a.src[1]] : null);
    }
    return l.length > 0 ? l.concat(t) : t;
  }
  function Ue(e, r = []) {
    let o = e, t = "";
    for (let l = 5; l < e.length; l++) {
      let s = e.charCodeAt(l);
      if (s === Le || s === De || s === Et) {
        o = e.slice(0, l), t = e.slice(l);
        break;
      }
    }
    return M(o.trim(), t.trim(), r);
  }
  function Vt(e, r = e.indexOf(":")) {
    if (r === -1) return null;
    let o = e.indexOf("!important", r + 1);
    return n(e.slice(0, r).trim(), e.slice(r + 1, o === -1 ? e.length : o).trim(), o !== -1);
  }
  function fr(e, r, o, t = null) {
    let l;
    for (let s = r + 1; s < e.length; s++) if (l = e.charCodeAt(s), l === Ke) s += 1;
    else {
      if (l === o) return s;
      if (l === Xe && (e.charCodeAt(s + 1) === se || e.charCodeAt(s + 1) === et && e.charCodeAt(s + 2) === se)) throw new ue(`Unterminated string: ${e.slice(r, s + 1) + String.fromCharCode(o)}`, t ? [t, r, s + 1] : null);
      if (l === se || l === et && e.charCodeAt(s + 1) === se) throw new ue(`Unterminated string: ${e.slice(r, s) + String.fromCharCode(o)}`, t ? [t, r, s + 1] : null);
    }
    return r;
  }
  function be(e) {
    if (arguments.length === 0) throw new TypeError("`CSS.escape` requires an argument.");
    let r = String(e), o = r.length, t = -1, l, s = "", a = r.charCodeAt(0);
    if (o === 1 && a === 45) return "\\" + r;
    for (; ++t < o; ) {
      if (l = r.charCodeAt(t), l === 0) {
        s += "\uFFFD";
        continue;
      }
      if (l >= 1 && l <= 31 || l === 127 || t === 0 && l >= 48 && l <= 57 || t === 1 && l >= 48 && l <= 57 && a === 45) {
        s += "\\" + l.toString(16) + " ";
        continue;
      }
      if (l >= 128 || l === 45 || l === 95 || l >= 48 && l <= 57 || l >= 65 && l <= 90 || l >= 97 && l <= 122) {
        s += r.charAt(t);
        continue;
      }
      s += "\\" + r.charAt(t);
    }
    return s;
  }
  function me(e) {
    return e.replace(/\\([\dA-Fa-f]{1,6}[\t\n\f\r ]?|[\S\s])/g, (r) => {
      if (r.length <= 2) return r[1];
      let o = Number.parseInt(r.slice(1).trim(), 16);
      return o === 0 || o > 1114111 || o >= 55296 && o <= 57343 ? "\uFFFD" : String.fromCodePoint(o);
    });
  }
  var dr = /* @__PURE__ */ new Map([["--font", ["--font-weight", "--font-size"]], ["--inset", ["--inset-shadow", "--inset-ring"]], ["--text", ["--text-color", "--text-decoration-color", "--text-decoration-thickness", "--text-indent", "--text-shadow", "--text-underline-offset"]], ["--grid-column", ["--grid-column-start", "--grid-column-end"]], ["--grid-row", ["--grid-row-start", "--grid-row-end"]]]);
  function pr(e, r) {
    return (dr.get(r) ?? []).some((o) => e === o || e.startsWith(`${o}-`));
  }
  var rt = class {
    constructor(r = /* @__PURE__ */ new Map(), o = /* @__PURE__ */ new Set([])) {
      this.values = r;
      this.keyframes = o;
    }
    values;
    keyframes;
    prefix = null;
    get size() {
      return this.values.size;
    }
    add(r, o, t = 0, l) {
      if (r.endsWith("-*")) {
        if (o !== "initial") throw new Error(`Invalid theme value \`${o}\` for namespace \`${r}\``);
        r === "--*" ? this.values.clear() : this.clearNamespace(r.slice(0, -2), 0);
      }
      if (t & 4) {
        let s = this.values.get(r);
        if (s && !(s.options & 4)) return;
      }
      o === "initial" ? this.values.delete(r) : this.values.set(r, { value: o, options: t, src: l });
    }
    keysInNamespaces(r) {
      let o = [];
      for (let t of r) {
        let l = `${t}-`;
        for (let s of this.values.keys()) s.startsWith(l) && s.indexOf("--", 2) === -1 && (pr(s, t) || o.push(s.slice(l.length)));
      }
      return o;
    }
    get(r) {
      for (let o of r) {
        let t = this.values.get(o);
        if (t) return t.value;
      }
      return null;
    }
    hasDefault(r) {
      return (this.getOptions(r) & 4) === 4;
    }
    getOptions(r) {
      return r = me(this.#r(r)), this.values.get(r)?.options ?? 0;
    }
    entries() {
      return this.prefix ? Array.from(this.values, (r) => (r[0] = this.prefixKey(r[0]), r)) : this.values.entries();
    }
    prefixKey(r) {
      return this.prefix ? `--${this.prefix}-${r.slice(2)}` : r;
    }
    #r(r) {
      return this.prefix ? `--${r.slice(3 + this.prefix.length)}` : r;
    }
    clearNamespace(r, o) {
      let t = dr.get(r) ?? [];
      e: for (let l of this.values.keys()) if (l.startsWith(r)) {
        if (o !== 0 && (this.getOptions(l) & o) !== o) continue;
        for (let s of t) if (l.startsWith(s)) continue e;
        this.values.delete(l);
      }
    }
    #e(r, o) {
      for (let t of o) {
        let l = r !== null ? `${t}-${r}` : t;
        if (!this.values.has(l)) if (r !== null && r.includes(".")) {
          if (l = `${t}-${r.replaceAll(".", "_")}`, !this.values.has(l)) continue;
        } else continue;
        if (!pr(l, t)) return l;
      }
      return null;
    }
    #t(r) {
      let o = this.values.get(r);
      if (!o) return null;
      let t = null;
      return o.options & 2 && (t = o.value), `var(${be(this.prefixKey(r))}${t ? `, ${t}` : ""})`;
    }
    markUsedVariable(r) {
      let o = me(this.#r(r)), t = this.values.get(o);
      if (!t) return false;
      let l = t.options & 16;
      return t.options |= 16, !l;
    }
    resolve(r, o, t = 0) {
      let l = this.#e(r, o);
      if (!l) return null;
      let s = this.values.get(l);
      return (t | s.options) & 1 ? s.value : this.#t(l);
    }
    resolveValue(r, o) {
      let t = this.#e(r, o);
      return t ? this.values.get(t).value : null;
    }
    resolveWith(r, o, t = []) {
      let l = this.#e(r, o);
      if (!l) return null;
      let s = {};
      for (let d of t) {
        let m = `${l}${d}`, u = this.values.get(m);
        u && (u.options & 1 ? s[d] = u.value : s[d] = this.#t(m));
      }
      let a = this.values.get(l);
      return a.options & 1 ? [a.value, s] : [this.#t(l), s];
    }
    namespace(r) {
      let o = /* @__PURE__ */ new Map(), t = `${r}-`;
      for (let [l, s] of this.values) l === r ? o.set(null, s.value) : l.startsWith(`${t}-`) ? o.set(l.slice(r.length), s.value) : l.startsWith(t) && o.set(l.slice(t.length), s.value);
      return o;
    }
    addKeyframes(r) {
      this.keyframes.add(r);
    }
    getKeyframes() {
      return Array.from(this.keyframes);
    }
  };
  var H = class extends Map {
    constructor(o) {
      super();
      this.factory = o;
    }
    factory;
    get(o) {
      let t = super.get(o);
      return t === void 0 && (t = this.factory(o, this), this.set(o, t)), t;
    }
  };
  function je(e) {
    return { kind: "word", value: e };
  }
  function Qo(e, r) {
    return { kind: "function", value: e, nodes: r };
  }
  function Xo(e) {
    return { kind: "separator", value: e };
  }
  function Y(e) {
    let r = "";
    for (let o of e) switch (o.kind) {
      case "word":
      case "separator": {
        r += o.value;
        break;
      }
      case "function":
        r += o.value + "(" + Y(o.nodes) + ")";
    }
    return r;
  }
  var mr = 92, ei = 41, hr = 58, gr = 44, ti = 34, kr = 61, vr = 62, br = 60, wr = 10, ri = 40, oi = 39, ii = 47, yr = 32, xr = 9;
  function q(e) {
    e = e.replaceAll(`\r
`, `
`);
    let r = [], o = [], t = null, l = "", s;
    for (let a = 0; a < e.length; a++) {
      let d = e.charCodeAt(a);
      switch (d) {
        case mr: {
          l += e[a] + e[a + 1], a++;
          break;
        }
        case ii: {
          if (l.length > 0) {
            let u = je(l);
            t ? t.nodes.push(u) : r.push(u), l = "";
          }
          let m = je(e[a]);
          t ? t.nodes.push(m) : r.push(m);
          break;
        }
        case hr:
        case gr:
        case kr:
        case vr:
        case br:
        case wr:
        case yr:
        case xr: {
          if (l.length > 0) {
            let p = je(l);
            t ? t.nodes.push(p) : r.push(p), l = "";
          }
          let m = a, u = a + 1;
          for (; u < e.length && (s = e.charCodeAt(u), !(s !== hr && s !== gr && s !== kr && s !== vr && s !== br && s !== wr && s !== yr && s !== xr)); u++) ;
          a = u - 1;
          let h = Xo(e.slice(m, u));
          t ? t.nodes.push(h) : r.push(h);
          break;
        }
        case oi:
        case ti: {
          let m = a;
          for (let u = a + 1; u < e.length; u++) if (s = e.charCodeAt(u), s === mr) u += 1;
          else if (s === d) {
            a = u;
            break;
          }
          l += e.slice(m, a + 1);
          break;
        }
        case ri: {
          let m = Qo(l, []);
          l = "", t ? t.nodes.push(m) : r.push(m), o.push(m), t = m;
          break;
        }
        case ei: {
          let m = o.pop();
          if (l.length > 0) {
            let u = je(l);
            m?.nodes.push(u), l = "";
          }
          o.length > 0 ? t = o[o.length - 1] : t = null;
          break;
        }
        default:
          l += String.fromCharCode(d);
      }
    }
    return l.length > 0 && r.push(je(l)), r;
  }
  var Ot = ((a) => (a[a.Continue = 0] = "Continue", a[a.Skip = 1] = "Skip", a[a.Stop = 2] = "Stop", a[a.Replace = 3] = "Replace", a[a.ReplaceSkip = 4] = "ReplaceSkip", a[a.ReplaceStop = 5] = "ReplaceStop", a))(Ot || {}), R = { Continue: { kind: 0 }, Skip: { kind: 1 }, Stop: { kind: 2 }, Replace: (e) => ({ kind: 3, nodes: Array.isArray(e) ? e : [e] }), ReplaceSkip: (e) => ({ kind: 4, nodes: Array.isArray(e) ? e : [e] }), ReplaceStop: (e) => ({ kind: 5, nodes: Array.isArray(e) ? e : [e] }) };
  function _(e, r) {
    typeof r == "function" ? Ar(e, r) : Ar(e, r.enter, r.exit);
  }
  function Ar(e, r = () => R.Continue, o = () => R.Continue) {
    let t = { value: [e, 0, null], prev: null }, l = { parent: null, depth: 0, index: 0, siblings: e, path() {
      let s = [], a = t;
      for (; a; ) {
        let d = a.value[2];
        d && s.push(d), a = a.prev;
      }
      return s.reverse(), s;
    } };
    for (; t !== null; ) {
      let s = t.value, a = s[0], d = s[1], m = s[2];
      if (d >= a.length) {
        t = t.prev, l.depth -= 1;
        continue;
      }
      if (l.parent = m, l.siblings = a, d >= 0) {
        l.index = d;
        let f = a[d], v = r(f, l) ?? R.Continue;
        switch (v.kind) {
          case 0: {
            f.nodes && f.nodes.length > 0 && (l.depth += 1, t = { value: [f.nodes, 0, f], prev: t }), s[1] = ~d;
            continue;
          }
          case 2:
            return;
          case 1: {
            s[1] = ~d;
            continue;
          }
          case 3: {
            a.splice(d, 1, ...v.nodes);
            continue;
          }
          case 5: {
            a.splice(d, 1, ...v.nodes);
            return;
          }
          case 4: {
            a.splice(d, 1, ...v.nodes), s[1] += v.nodes.length;
            continue;
          }
          default:
            throw new Error(`Invalid \`WalkAction.${Ot[v.kind] ?? `Unknown(${v.kind})`}\` in enter.`);
        }
      }
      let u = ~d;
      l.index = u;
      let h = a[u], p = o(h, l) ?? R.Continue;
      switch (p.kind) {
        case 0:
          s[1] = u + 1;
          continue;
        case 2:
          return;
        case 3: {
          a.splice(u, 1, ...p.nodes), s[1] = u + p.nodes.length;
          continue;
        }
        case 5: {
          a.splice(u, 1, ...p.nodes);
          return;
        }
        case 4: {
          a.splice(u, 1, ...p.nodes), s[1] = u + p.nodes.length;
          continue;
        }
        default:
          throw new Error(`Invalid \`WalkAction.${Ot[p.kind] ?? `Unknown(${p.kind})`}\` in exit.`);
      }
    }
  }
  function ot(e) {
    let r = [];
    return _(q(e), (o) => {
      if (!(o.kind !== "function" || o.value !== "var")) return _(o.nodes, (t) => {
        t.kind !== "word" || t.value[0] !== "-" || t.value[1] !== "-" || r.push(t.value);
      }), R.Skip;
    }), r;
  }
  var ni = 64;
  function G(e, r = []) {
    return { kind: "rule", selector: e, nodes: r };
  }
  function M(e, r = "", o = []) {
    return { kind: "at-rule", name: e, params: r, nodes: o };
  }
  function Z(e, r = []) {
    return e.charCodeAt(0) === ni ? Ue(e, r) : G(e, r);
  }
  function n(e, r, o = false) {
    return { kind: "declaration", property: e, value: r, important: o };
  }
  function tt(e) {
    return { kind: "comment", value: e };
  }
  function pe(e, r) {
    return { kind: "context", context: e, nodes: r };
  }
  function F(e) {
    return { kind: "at-root", nodes: e };
  }
  function re(e) {
    switch (e.kind) {
      case "rule":
        return { kind: e.kind, selector: e.selector, nodes: e.nodes.map(re), src: e.src, dst: e.dst };
      case "at-rule":
        return { kind: e.kind, name: e.name, params: e.params, nodes: e.nodes.map(re), src: e.src, dst: e.dst };
      case "at-root":
        return { kind: e.kind, nodes: e.nodes.map(re), src: e.src, dst: e.dst };
      case "context":
        return { kind: e.kind, context: { ...e.context }, nodes: e.nodes.map(re), src: e.src, dst: e.dst };
      case "declaration":
        return { kind: e.kind, property: e.property, value: e.value, important: e.important, src: e.src, dst: e.dst };
      case "comment":
        return { kind: e.kind, value: e.value, src: e.src, dst: e.dst };
      default:
        throw new Error(`Unknown node kind: ${e.kind}`);
    }
  }
  function Ie(e) {
    return { depth: e.depth, index: e.index, siblings: e.siblings, get context() {
      let r = {};
      for (let o of e.path()) o.kind === "context" && Object.assign(r, o.context);
      return Object.defineProperty(this, "context", { value: r }), r;
    }, get parent() {
      let r = this.path().pop() ?? null;
      return Object.defineProperty(this, "parent", { value: r }), r;
    }, path() {
      return e.path().filter((r) => r.kind !== "context");
    } };
  }
  function Ce(e, r, o = 3) {
    let t = [], l = /* @__PURE__ */ new Set(), s = new H(() => /* @__PURE__ */ new Set()), a = new H(() => /* @__PURE__ */ new Set()), d = /* @__PURE__ */ new Set(), m = /* @__PURE__ */ new Set(), u = [], h = [], p = new H(() => /* @__PURE__ */ new Set());
    function f(k, b, x = {}, O = 0) {
      if (k.kind === "declaration") {
        if (k.property === "--tw-sort" || k.value === void 0 || k.value === null) return;
        if (x.theme && k.property[0] === "-" && k.property[1] === "-") {
          if (k.value === "initial") {
            k.value = void 0;
            return;
          }
          x.keyframes || s.get(b).add(k);
        }
        if (k.value.includes("var(")) if (x.theme && k.property[0] === "-" && k.property[1] === "-") for (let C of ot(k.value)) p.get(C).add(k.property);
        else r.trackUsedVariables(k.value);
        if (k.property === "animation") for (let C of Cr(k.value)) m.add(C);
        o & 2 && k.value.includes("color-mix(") && !x.supportsColorMix && !x.keyframes && a.get(b).add(k), b.push(k);
      } else if (k.kind === "rule") {
        let C = [];
        for (let z of k.nodes) f(z, C, x, O + 1);
        let y = {}, D = /* @__PURE__ */ new Set();
        for (let z of C) {
          if (z.kind !== "declaration") continue;
          let K = `${z.property}:${z.value}:${z.important}`;
          y[K] ??= [], y[K].push(z);
        }
        for (let z in y) for (let K = 0; K < y[z].length - 1; ++K) D.add(y[z][K]);
        if (D.size > 0 && (C = C.filter((z) => !D.has(z))), C.length === 0) return;
        k.selector === "&" ? b.push(...C) : b.push({ ...k, nodes: C });
      } else if (k.kind === "at-rule" && k.name === "@property" && O === 0) {
        if (l.has(k.params)) return;
        if (o & 1) {
          let y = k.params, D = null, z = false;
          for (let j of k.nodes) j.kind === "declaration" && (j.property === "initial-value" ? D = j.value : j.property === "inherits" && (z = j.value === "true"));
          let K = n(y, D ?? "initial");
          K.src = k.src, z ? u.push(K) : h.push(K);
        }
        l.add(k.params);
        let C = { ...k, nodes: [] };
        for (let y of k.nodes) f(y, C.nodes, x, O + 1);
        b.push(C);
      } else if (k.kind === "at-rule") {
        k.name === "@keyframes" ? x = { ...x, keyframes: true } : k.name === "@supports" && k.params.includes("color-mix(") && (x = { ...x, supportsColorMix: true });
        let C = { ...k, nodes: [] };
        for (let y of k.nodes) f(y, C.nodes, x, O + 1);
        k.name === "@keyframes" && x.theme && d.add(C), (C.nodes.length > 0 || C.name === "@layer" || C.name === "@charset" || C.name === "@custom-media" || C.name === "@namespace" || C.name === "@import" || C.name === "@apply") && b.push(C);
      } else if (k.kind === "at-root") for (let C of k.nodes) {
        let y = [];
        f(C, y, x, 0);
        for (let D of y) t.push(D);
      }
      else if (k.kind === "context") {
        if (k.context.reference) return;
        for (let C of k.nodes) f(C, b, { ...x, ...k.context }, O);
      } else k.kind === "comment" && b.push(k);
    }
    let v = [];
    for (let k of e) f(k, v, {}, 0);
    e: for (let [k, b] of s) for (let x of b) {
      if (Nr(x.property, r.theme, p)) {
        if (x.property.startsWith(r.theme.prefixKey("--animate-"))) for (let y of Cr(x.value)) m.add(y);
        continue;
      }
      let C = k.indexOf(x);
      if (k.splice(C, 1), k.length === 0) {
        let y = li(v, (D) => D.kind === "rule" && D.nodes === k);
        if (!y || y.length === 0) continue e;
        y.unshift({ kind: "at-root", nodes: v });
        do {
          let D = y.pop();
          if (!D) break;
          let z = y[y.length - 1];
          if (!z || z.kind !== "at-root" && z.kind !== "at-rule") break;
          let K = z.nodes.indexOf(D);
          if (K === -1) break;
          z.nodes.splice(K, 1);
        } while (true);
        continue e;
      }
    }
    for (let k of d) if (!m.has(k.params)) {
      let b = t.indexOf(k);
      t.splice(b, 1);
    }
    if (v = v.concat(t), o & 2) for (let [k, b] of a) for (let x of b) {
      let O = k.indexOf(x);
      if (O === -1 || x.value == null) continue;
      let C = q(x.value), y = false;
      if (_(C, (K) => {
        if (K.kind !== "function" || K.value !== "color-mix") return;
        let j = false, E = false;
        if (_(K.nodes, (U) => {
          if (U.kind == "word" && U.value.toLowerCase() === "currentcolor") {
            E = true, y = true;
            return;
          }
          let B = U, W = null, X = /* @__PURE__ */ new Set();
          do {
            if (B.kind !== "function" || B.value !== "var") return;
            let te = B.nodes[0];
            if (!te || te.kind !== "word") return;
            let i = te.value;
            if (X.has(i)) {
              j = true;
              return;
            }
            if (X.add(i), y = true, W = r.theme.resolveValue(null, [te.value]), !W) {
              j = true;
              return;
            }
            if (W.toLowerCase() === "currentcolor") {
              E = true;
              return;
            }
            W.startsWith("var(") ? B = q(W)[0] : B = null;
          } while (B);
          return R.Replace({ kind: "word", value: W });
        }), j || E) {
          let U = K.nodes.findIndex((W) => W.kind === "separator" && W.value.trim().includes(","));
          if (U === -1) return;
          let B = K.nodes.length > U ? K.nodes[U + 1] : null;
          return B ? R.Replace(B) : void 0;
        } else if (y) {
          let U = K.nodes[2];
          U.kind === "word" && (U.value === "oklab" || U.value === "oklch" || U.value === "lab" || U.value === "lch") && (U.value = "srgb");
        }
      }), !y) continue;
      let D = { ...x, value: Y(C) }, z = Z("@supports (color: color-mix(in lab, red, red))", [x]);
      z.src = x.src, k.splice(O, 1, D, z);
    }
    if (o & 1) {
      let k = [];
      if (u.length > 0) {
        let b = Z(":root, :host", u);
        b.src = u[0].src, k.push(b);
      }
      if (h.length > 0) {
        let b = Z("*, ::before, ::after, ::backdrop", h);
        b.src = h[0].src, k.push(b);
      }
      if (k.length > 0) {
        let b = v.findIndex((C) => !(C.kind === "comment" || C.kind === "at-rule" && (C.name === "@charset" || C.name === "@import"))), x = M("@layer", "properties", []);
        x.src = k[0].src, v.splice(b < 0 ? v.length : b, 0, x);
        let O = Z("@layer properties", [M("@supports", "((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color:rgb(from red r g b))))", k)]);
        O.src = k[0].src, O.nodes[0].src = k[0].src, v.push(O);
      }
    }
    return v;
  }
  function ae(e, r) {
    let o = 0, t = { file: null, code: "" };
    function l(a, d = 0) {
      let m = "", u = "  ".repeat(d);
      if (a.kind === "declaration") {
        if (m += `${u}${a.property}: ${a.value}${a.important ? " !important" : ""};
`, r) {
          o += u.length;
          let h = o;
          o += a.property.length, o += 2, o += a.value?.length ?? 0, a.important && (o += 11);
          let p = o;
          o += 2, a.dst = [t, h, p];
        }
      } else if (a.kind === "rule") {
        if (m += `${u}${a.selector} {
`, r) {
          o += u.length;
          let h = o;
          o += a.selector.length, o += 1;
          let p = o;
          a.dst = [t, h, p], o += 2;
        }
        for (let h of a.nodes) m += l(h, d + 1);
        m += `${u}}
`, r && (o += u.length, o += 2);
      } else if (a.kind === "at-rule") {
        if (a.nodes.length === 0) {
          let h = `${u}${a.name} ${a.params};
`;
          if (r) {
            o += u.length;
            let p = o;
            o += a.name.length, o += 1, o += a.params.length;
            let f = o;
            o += 2, a.dst = [t, p, f];
          }
          return h;
        }
        if (m += `${u}${a.name}${a.params ? ` ${a.params} ` : " "}{
`, r) {
          o += u.length;
          let h = o;
          o += a.name.length, a.params && (o += 1, o += a.params.length), o += 1;
          let p = o;
          a.dst = [t, h, p], o += 2;
        }
        for (let h of a.nodes) m += l(h, d + 1);
        m += `${u}}
`, r && (o += u.length, o += 2);
      } else if (a.kind === "comment") {
        if (m += `${u}/*${a.value}*/
`, r) {
          o += u.length;
          let h = o;
          o += 2 + a.value.length + 2;
          let p = o;
          a.dst = [t, h, p], o += 1;
        }
      } else if (a.kind === "context" || a.kind === "at-root") return "";
      return m;
    }
    let s = "";
    for (let a of e) s += l(a, 0);
    return t.code = s, s;
  }
  function li(e, r) {
    let o = [];
    return _(e, (t, l) => {
      if (r(t)) return o = l.path(), o.push(t), R.Stop;
    }), o;
  }
  function Nr(e, r, o, t = /* @__PURE__ */ new Set()) {
    if (t.has(e) || (t.add(e), r.getOptions(e) & 24)) return true;
    {
      let s = o.get(e) ?? [];
      for (let a of s) if (Nr(a, r, o, t)) return true;
    }
    return false;
  }
  function Cr(e) {
    return e.split(/[\s,]+/);
  }
  var Pt = ["calc", "min", "max", "clamp", "mod", "rem", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow", "sqrt", "hypot", "log", "exp", "round"];
  function Fe(e) {
    return e.indexOf("(") !== -1 && Pt.some((r) => e.includes(`${r}(`));
  }
  function nt(e) {
    if (!Pt.some((s) => e.includes(s))) return e;
    let r = "", o = [], t = null, l = null;
    for (let s = 0; s < e.length; s++) {
      let a = e.charCodeAt(s);
      if (a >= 48 && a <= 57 || t !== null && (a === 37 || a >= 97 && a <= 122 || a >= 65 && a <= 90) ? t = s : (l = t, t = null), a === 40) {
        r += e[s];
        let d = s;
        for (let u = s - 1; u >= 0; u--) {
          let h = e.charCodeAt(u);
          if (h >= 48 && h <= 57) d = u;
          else if (h >= 97 && h <= 122) d = u;
          else break;
        }
        let m = e.slice(d, s);
        if (Pt.includes(m)) {
          o.unshift(true);
          continue;
        } else if (o[0] && m === "") {
          o.unshift(true);
          continue;
        }
        o.unshift(false);
        continue;
      } else if (a === 41) r += e[s], o.shift();
      else if (a === 44 && o[0]) {
        r += ", ";
        continue;
      } else {
        if (a === 32 && o[0] && r.charCodeAt(r.length - 1) === 32) continue;
        if ((a === 43 || a === 42 || a === 47 || a === 45) && o[0]) {
          let d = r.trimEnd(), m = d.charCodeAt(d.length - 1), u = d.charCodeAt(d.length - 2), h = e.charCodeAt(s + 1);
          if ((m === 101 || m === 69) && u >= 48 && u <= 57) {
            r += e[s];
            continue;
          } else if (m === 43 || m === 42 || m === 47 || m === 45) {
            r += e[s];
            continue;
          } else if (m === 40 || m === 44) {
            r += e[s];
            continue;
          } else e.charCodeAt(s - 1) === 32 ? r += `${e[s]} ` : m >= 48 && m <= 57 || h >= 48 && h <= 57 || m === 41 || h === 40 || h === 43 || h === 42 || h === 47 || h === 45 || l !== null && l === s - 1 ? r += ` ${e[s]} ` : r += e[s];
        } else r += e[s];
      }
    }
    return r;
  }
  function we(e) {
    if (e.indexOf("(") === -1) return Re(e);
    let r = q(e);
    return zt(r), e = Y(r), e = nt(e), e;
  }
  function Re(e, r = false) {
    let o = "";
    for (let t = 0; t < e.length; t++) {
      let l = e[t];
      l === "\\" && e[t + 1] === "_" ? (o += "_", t += 1) : l === "_" && !r ? o += " " : o += l;
    }
    return o;
  }
  function zt(e) {
    for (let r of e) switch (r.kind) {
      case "function": {
        if (r.value === "url" || r.value.endsWith("_url")) {
          r.value = Re(r.value);
          break;
        }
        if (r.value === "var" || r.value.endsWith("_var") || r.value === "theme" || r.value.endsWith("_theme")) {
          r.value = Re(r.value);
          for (let o = 0; o < r.nodes.length; o++) {
            if (o == 0 && r.nodes[o].kind === "word") {
              r.nodes[o].value = Re(r.nodes[o].value, true);
              continue;
            }
            zt([r.nodes[o]]);
          }
          break;
        }
        r.value = Re(r.value), zt(r.nodes);
        break;
      }
      case "separator":
      case "word": {
        r.value = Re(r.value);
        break;
      }
      default:
        si(r);
    }
  }
  function si(e) {
    throw new Error(`Unexpected value: ${e}`);
  }
  var _t = new Uint8Array(256);
  function ge(e) {
    let r = 0, o = e.length;
    for (let t = 0; t < o; t++) {
      let l = e.charCodeAt(t);
      switch (l) {
        case 92:
          t += 1;
          break;
        case 39:
        case 34:
          for (; ++t < o; ) {
            let s = e.charCodeAt(t);
            if (s === 92) {
              t += 1;
              continue;
            }
            if (s === l) break;
          }
          break;
        case 40:
          _t[r] = 41, r++;
          break;
        case 91:
          _t[r] = 93, r++;
          break;
        case 123:
          break;
        case 93:
        case 125:
        case 41:
          if (r === 0) return false;
          r > 0 && l === _t[r - 1] && r--;
          break;
        case 59:
          if (r === 0) return false;
          break;
      }
    }
    return true;
  }
  var lt = new Uint8Array(256);
  function L(e, r) {
    let o = 0, t = [], l = 0, s = e.length, a = r.charCodeAt(0);
    for (let d = 0; d < s; d++) {
      let m = e.charCodeAt(d);
      if (o === 0 && m === a) {
        t.push(e.slice(l, d)), l = d + 1;
        continue;
      }
      switch (m) {
        case 92:
          d += 1;
          break;
        case 39:
        case 34:
          for (; ++d < s; ) {
            let u = e.charCodeAt(d);
            if (u === 92) {
              d += 1;
              continue;
            }
            if (u === m) break;
          }
          break;
        case 40:
          lt[o] = 41, o++;
          break;
        case 91:
          lt[o] = 93, o++;
          break;
        case 123:
          lt[o] = 125, o++;
          break;
        case 93:
        case 125:
        case 41:
          o > 0 && m === lt[o - 1] && o--;
          break;
      }
    }
    return t.push(e.slice(l)), t;
  }
  var ui = 58, Tr = 45, $r = 97, Sr = 122, Dt = /^[a-zA-Z0-9_.%-]+$/;
  function* Vr(e, r) {
    let o = L(e, ":");
    if (r.theme.prefix) {
      if (o.length === 1 || o[0] !== r.theme.prefix) return null;
      o.shift();
    }
    let t = o.pop(), l = [];
    for (let p = o.length - 1; p >= 0; --p) {
      let f = r.parseVariant(o[p]);
      if (f === null) return;
      l.push(f);
    }
    let s = false;
    t[t.length - 1] === "!" ? (s = true, t = t.slice(0, -1)) : t[0] === "!" && (s = true, t = t.slice(1)), r.utilities.has(t, "static") && !t.includes("[") && (yield { kind: "static", root: t, variants: l, important: s, raw: e });
    let [a, d = null, m] = L(t, "/");
    if (m) return;
    let u = d === null ? null : Kt(d);
    if (d !== null && u === null) return;
    if (a[0] === "[") {
      if (a[a.length - 1] !== "]") return;
      let p = a.charCodeAt(1);
      if (p !== Tr && !(p >= $r && p <= Sr)) return;
      a = a.slice(1, -1);
      let f = a.indexOf(":");
      if (f === -1 || f === 0 || f === a.length - 1) return;
      let v = a.slice(0, f), k = we(a.slice(f + 1));
      if (!ge(k)) return;
      yield { kind: "arbitrary", property: v, value: k, modifier: u, variants: l, important: s, raw: e };
      return;
    }
    let h;
    if (a[a.length - 1] === "]") {
      let p = a.indexOf("-[");
      if (p === -1) return;
      let f = a.slice(0, p);
      if (!r.utilities.has(f, "functional")) return;
      let v = a.slice(p + 1);
      h = [[f, v]];
    } else if (a[a.length - 1] === ")") {
      let p = a.indexOf("-(");
      if (p === -1) return;
      let f = a.slice(0, p);
      if (!r.utilities.has(f, "functional")) return;
      let v = a.slice(p + 2, -1), k = L(v, ":"), b = null;
      if (k.length === 2 && (b = k[0], v = k[1]), v[0] !== "-" || v[1] !== "-" || !ge(v)) return;
      h = [[f, b === null ? `[var(${v})]` : `[${b}:var(${v})]`]];
    } else h = Rr(a, (p) => r.utilities.has(p, "functional"));
    for (let [p, f] of h) {
      let v = { kind: "functional", root: p, modifier: u, value: null, variants: l, important: s, raw: e };
      if (f === null) {
        yield v;
        continue;
      }
      {
        let k = f.indexOf("[");
        if (k !== -1) {
          if (f[f.length - 1] !== "]") return;
          let x = we(f.slice(k + 1, -1));
          if (!ge(x)) continue;
          let O = null;
          for (let C = 0; C < x.length; C++) {
            let y = x.charCodeAt(C);
            if (y === ui) {
              O = x.slice(0, C), x = x.slice(C + 1);
              break;
            }
            if (!(y === Tr || y >= $r && y <= Sr)) break;
          }
          if (x.length === 0 || x.trim().length === 0 || O === "") continue;
          v.value = { kind: "arbitrary", dataType: O || null, value: x };
        } else {
          let x = d === null || v.modifier?.kind === "arbitrary" ? null : `${f}/${d}`;
          if (!Dt.test(f)) continue;
          v.value = { kind: "named", value: f, fraction: x };
        }
      }
      yield v;
    }
  }
  function Kt(e) {
    if (e[0] === "[" && e[e.length - 1] === "]") {
      let r = we(e.slice(1, -1));
      return !ge(r) || r.length === 0 || r.trim().length === 0 ? null : { kind: "arbitrary", value: r };
    }
    return e[0] === "(" && e[e.length - 1] === ")" ? (e = e.slice(1, -1), e[0] !== "-" || e[1] !== "-" || !ge(e) ? null : (e = `var(${e})`, { kind: "arbitrary", value: we(e) })) : Dt.test(e) ? { kind: "named", value: e } : null;
  }
  function Er(e, r) {
    if (e[0] === "[" && e[e.length - 1] === "]") {
      if (e[1] === "@" && e.includes("&")) return null;
      let o = we(e.slice(1, -1));
      if (!ge(o) || o.length === 0 || o.trim().length === 0) return null;
      let t = o[0] === ">" || o[0] === "+" || o[0] === "~";
      return !t && o[0] !== "@" && !o.includes("&") && (o = `&:is(${o})`), { kind: "arbitrary", selector: o, relative: t };
    }
    {
      let [o, t = null, l] = L(e, "/");
      if (l) return null;
      let s = Rr(o, (a) => r.variants.has(a));
      for (let [a, d] of s) switch (r.variants.kind(a)) {
        case "static":
          return d !== null || t !== null ? null : { kind: "static", root: a };
        case "functional": {
          let m = t === null ? null : Kt(t);
          if (t !== null && m === null) return null;
          if (d === null) return { kind: "functional", root: a, modifier: m, value: null };
          if (d[d.length - 1] === "]") {
            if (d[0] !== "[") continue;
            let u = we(d.slice(1, -1));
            return !ge(u) || u.length === 0 || u.trim().length === 0 ? null : { kind: "functional", root: a, modifier: m, value: { kind: "arbitrary", value: u } };
          }
          if (d[d.length - 1] === ")") {
            if (d[0] !== "(") continue;
            let u = we(d.slice(1, -1));
            return !ge(u) || u.length === 0 || u.trim().length === 0 || u[0] !== "-" || u[1] !== "-" ? null : { kind: "functional", root: a, modifier: m, value: { kind: "arbitrary", value: `var(${u})` } };
          }
          if (!Dt.test(d)) continue;
          return { kind: "functional", root: a, modifier: m, value: { kind: "named", value: d } };
        }
        case "compound": {
          if (d === null) return null;
          t && (a === "not" || a === "has" || a === "in") && (d = `${d}/${t}`, t = null);
          let m = r.parseVariant(d);
          if (m === null || !r.variants.compoundsWith(a, m)) return null;
          let u = t === null ? null : Kt(t);
          return t !== null && u === null ? null : { kind: "compound", root: a, modifier: u, variant: m };
        }
      }
    }
    return null;
  }
  function* Rr(e, r) {
    r(e) && (yield [e, null]);
    let o = e.lastIndexOf("-");
    for (; o > 0; ) {
      let t = e.slice(0, o);
      if (r(t)) {
        let l = [t, e.slice(o + 1)];
        if (l[1] === "" || l[0] === "@" && r("@") && e[o] === "-") break;
        yield l;
      }
      o = e.lastIndexOf("-", o - 1);
    }
    e[0] === "@" && r("@") && (yield ["@", e.slice(1)]);
  }
  function Or(e, r) {
    let o = [];
    for (let l of r.variants) o.unshift(at(l));
    e.theme.prefix && o.unshift(e.theme.prefix);
    let t = "";
    if (r.kind === "static" && (t += r.root), r.kind === "functional" && (t += r.root, r.value)) if (r.value.kind === "arbitrary") {
      if (r.value !== null) {
        let l = Ut(r.value.value), s = l ? r.value.value.slice(4, -1) : r.value.value, [a, d] = l ? ["(", ")"] : ["[", "]"];
        r.value.dataType ? t += `-${a}${r.value.dataType}:${Oe(s)}${d}` : t += `-${a}${Oe(s)}${d}`;
      }
    } else r.value.kind === "named" && (t += `-${r.value.value}`);
    return r.kind === "arbitrary" && (t += `[${r.property}:${Oe(r.value)}]`), (r.kind === "arbitrary" || r.kind === "functional") && (t += Pr(r.modifier)), r.important && (t += "!"), o.push(t), o.join(":");
  }
  function Pr(e) {
    if (e === null) return "";
    let r = Ut(e.value), o = r ? e.value.slice(4, -1) : e.value, [t, l] = r ? ["(", ")"] : ["[", "]"];
    return e.kind === "arbitrary" ? `/${t}${Oe(o)}${l}` : e.kind === "named" ? `/${e.value}` : "";
  }
  function at(e) {
    if (e.kind === "static") return e.root;
    if (e.kind === "arbitrary") return `[${Oe(pi(e.selector))}]`;
    let r = "";
    if (e.kind === "functional") {
      r += e.root;
      let o = e.root !== "@";
      if (e.value) if (e.value.kind === "arbitrary") {
        let t = Ut(e.value.value), l = t ? e.value.value.slice(4, -1) : e.value.value, [s, a] = t ? ["(", ")"] : ["[", "]"];
        r += `${o ? "-" : ""}${s}${Oe(l)}${a}`;
      } else e.value.kind === "named" && (r += `${o ? "-" : ""}${e.value.value}`);
    }
    return e.kind === "compound" && (r += e.root, r += "-", r += at(e.variant)), (e.kind === "functional" || e.kind === "compound") && (r += Pr(e.modifier)), r;
  }
  var ci = new H((e) => {
    let r = q(e), o = /* @__PURE__ */ new Set(), t = /* @__PURE__ */ new Set(["~", ">", "+", "-", "*", "/"]);
    return _(r, (l, s) => {
      if (l.kind === "word" && t.has(l.value)) {
        let a = s.index;
        if (a === -1) return;
        let d = s.siblings[a - 1];
        if (d?.kind !== "separator" || d.value !== " ") return;
        let m = s.siblings[a + 1];
        if (m?.kind !== "separator" || m.value !== " ") return;
        let u = s.siblings[a - 2];
        if (u && t.has(u.value)) return;
        let h = s.siblings[a + 2];
        if (h && t.has(h.value)) return;
        o.add(d), o.add(m);
      } else if (l.kind === "separator" && l.value.length > 0 && l.value.trim() === "") (s.siblings[0] === l || s.siblings[s.siblings.length - 1] === l) && o.add(l);
      else if (l.kind === "separator" && l.value.trim() === ",") l.value = ",";
      else if (l.kind === "function" && l.value.startsWith("--")) {
        let a = s.index;
        if (a <= 0) return;
        let d = s.siblings[a - 1];
        if (d?.kind === "separator" && d.value === ",") return;
        let m = s.siblings[a - 2];
        return m && !t.has(m.value) ? void 0 : R.ReplaceSkip({ kind: "function", value: "", nodes: [l] });
      }
    }), o.size > 0 && _(r, (l) => {
      if (o.has(l)) return o.delete(l), R.ReplaceSkip([]);
    }), Lt(r), Y(r);
  });
  function Oe(e) {
    return ci.get(e);
  }
  var fi = new H((e) => {
    let r = q(e);
    return r.length === 3 && r[0].kind === "word" && r[0].value === "&" && r[1].kind === "separator" && r[1].value === ":" && r[2].kind === "function" && r[2].value === "is" ? Y(r[2].nodes) : e;
  });
  function pi(e) {
    return fi.get(e);
  }
  function Lt(e) {
    for (let r of e) switch (r.kind) {
      case "function": {
        if (r.value === "url" || r.value.endsWith("_url")) {
          r.value = Me(r.value);
          break;
        }
        if (r.value === "var" || r.value.endsWith("_var") || r.value === "theme" || r.value.endsWith("_theme")) {
          r.value = Me(r.value);
          for (let o = 0; o < r.nodes.length; o++) Lt([r.nodes[o]]);
          break;
        }
        r.value = Me(r.value), Lt(r.nodes);
        break;
      }
      case "separator":
        r.value = Me(r.value);
        break;
      case "word": {
        (r.value[0] !== "-" || r.value[1] !== "-") && (r.value = Me(r.value));
        break;
      }
      default:
        mi(r);
    }
  }
  var di = new H((e) => {
    let r = q(e);
    return r.length === 1 && r[0].kind === "function" && r[0].value === "var";
  });
  function Ut(e) {
    return di.get(e);
  }
  function mi(e) {
    throw new Error(`Unexpected value: ${e}`);
  }
  function Me(e) {
    return e.replaceAll("_", String.raw`\_`).replaceAll(" ", "_");
  }
  function Ne(e, r, o) {
    if (e === r) return 0;
    let t = e.indexOf("("), l = r.indexOf("("), s = t === -1 ? e.replace(/[\d.]+/g, "") : e.slice(0, t), a = l === -1 ? r.replace(/[\d.]+/g, "") : r.slice(0, l), d = (s === a ? 0 : s < a ? -1 : 1) || (o === "asc" ? parseInt(e) - parseInt(r) : parseInt(r) - parseInt(e));
    return Number.isNaN(d) ? e < r ? -1 : 1 : d;
  }
  var hi = /^(?<value>[-+]?(?:\d*\.)?\d+)(?<unit>[a-z]+|%)?$/i, We = new H((e) => {
    let r = hi.exec(e);
    if (!r) return null;
    let o = r.groups?.value;
    if (o === void 0) return null;
    let t = Number(o);
    if (Number.isNaN(t)) return null;
    let l = r.groups?.unit;
    return l === void 0 ? [t, null] : [t, l];
  });
  var zr = /* @__PURE__ */ new Set(["black", "silver", "gray", "white", "maroon", "red", "purple", "fuchsia", "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua", "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen", "transparent", "currentcolor", "canvas", "canvastext", "linktext", "visitedtext", "activetext", "buttonface", "buttontext", "buttonborder", "field", "fieldtext", "highlight", "highlighttext", "selecteditem", "selecteditemtext", "mark", "marktext", "graytext", "accentcolor", "accentcolortext"]), gi = /^(rgba?|hsla?|hwb|color|(ok)?(lab|lch)|light-dark|color-mix|--alpha)\(/i;
  function _r(e) {
    return e.charCodeAt(0) === 35 || gi.test(e) || zr.has(e.toLowerCase());
  }
  function Kr(e) {
    return zr.has(e.toLowerCase());
  }
  var ki = { color: _r, length: Te, percentage: jt, ratio: Ei, number: Dr, integer: V, url: Lr, position: zi, "bg-size": _i, "line-width": bi, image: xi, "family-name": Ci, "generic-name": Ai, "absolute-size": Ni, "relative-size": Ti, angle: Di, vector: ji };
  function J(e, r) {
    if (e.startsWith("var(")) return null;
    for (let o of r) if (ki[o]?.(e)) return o;
    return null;
  }
  var vi = /^url\(.*\)$/;
  function Lr(e) {
    return vi.test(e);
  }
  function bi(e) {
    return L(e, " ").every((r) => Te(r) || Dr(r) || r === "thin" || r === "medium" || r === "thick");
  }
  var wi = /^(?:element|image|cross-fade|image-set)\(/, yi = /^(repeating-)?(conic|linear|radial)-gradient\(/;
  function xi(e) {
    let r = 0;
    for (let o of L(e, ",")) if (!o.startsWith("var(")) {
      if (Lr(o)) {
        r += 1;
        continue;
      }
      if (yi.test(o)) {
        r += 1;
        continue;
      }
      if (wi.test(o)) {
        r += 1;
        continue;
      }
      return false;
    }
    return r > 0;
  }
  function Ai(e) {
    return e === "serif" || e === "sans-serif" || e === "monospace" || e === "cursive" || e === "fantasy" || e === "system-ui" || e === "ui-serif" || e === "ui-sans-serif" || e === "ui-monospace" || e === "ui-rounded" || e === "math" || e === "emoji" || e === "fangsong";
  }
  function Ci(e) {
    let r = 0;
    for (let o of L(e, ",")) {
      let t = o.charCodeAt(0);
      if (t >= 48 && t <= 57) return false;
      o.startsWith("var(") || (r += 1);
    }
    return r > 0;
  }
  function Ni(e) {
    return e === "xx-small" || e === "x-small" || e === "small" || e === "medium" || e === "large" || e === "x-large" || e === "xx-large" || e === "xxx-large";
  }
  function Ti(e) {
    return e === "larger" || e === "smaller";
  }
  var ke = /[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/, $i = new RegExp(`^${ke.source}$`);
  function Dr(e) {
    return $i.test(e) || Fe(e);
  }
  var Si = new RegExp(`^${ke.source}%$`);
  function jt(e) {
    return Si.test(e) || Fe(e);
  }
  var Vi = new RegExp(`^${ke.source}\\s*/\\s*${ke.source}$`);
  function Ei(e) {
    return Vi.test(e) || Fe(e);
  }
  var Ri = ["cm", "mm", "Q", "in", "pc", "pt", "px", "em", "ex", "ch", "rem", "lh", "rlh", "vw", "vh", "vmin", "vmax", "vb", "vi", "svw", "svh", "lvw", "lvh", "dvw", "dvh", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax"], Oi = new RegExp(`^${ke.source}(${Ri.join("|")})$`), Pi = /^(--spacing)\(/i;
  function Te(e) {
    return Oi.test(e) || Pi.test(e) || Fe(e);
  }
  function zi(e) {
    let r = 0;
    for (let o of L(e, " ")) {
      if (o === "center" || o === "top" || o === "right" || o === "bottom" || o === "left") {
        r += 1;
        continue;
      }
      if (!o.startsWith("var(")) {
        if (Te(o) || jt(o)) {
          r += 1;
          continue;
        }
        return false;
      }
    }
    return r > 0;
  }
  function _i(e) {
    let r = 0;
    for (let o of L(e, ",")) {
      if (o === "cover" || o === "contain") {
        r += 1;
        continue;
      }
      let t = L(o, " ");
      if (t.length !== 1 && t.length !== 2) return false;
      if (t.every((l) => l === "auto" || Te(l) || jt(l))) {
        r += 1;
        continue;
      }
    }
    return r > 0;
  }
  var Ki = ["deg", "rad", "grad", "turn"], Li = new RegExp(`^${ke.source}(${Ki.join("|")})$`);
  function Di(e) {
    return Li.test(e);
  }
  var Ui = new RegExp(`^${ke.source} +${ke.source} +${ke.source}$`);
  function ji(e) {
    return Ui.test(e);
  }
  function V(e) {
    let r = Number(e);
    return Number.isInteger(r) && r >= 0 && String(r) === String(e);
  }
  function It(e) {
    let r = Number(e);
    return Number.isInteger(r) && r > 0 && String(r) === String(e);
  }
  function le(e) {
    return Ur(e, 0.25);
  }
  function st(e) {
    return Ur(e, 0.25);
  }
  function Ur(e, r) {
    let o = Number(e);
    return o >= 0 && o % r === 0 && String(o) === String(e);
  }
  var Ii = /* @__PURE__ */ new Set(["inset", "inherit", "initial", "revert", "unset"]), Fi = /* @__PURE__ */ new Set(["calc", "clamp", "max", "min", "--spacing"]), Mi = /* @__PURE__ */ new Set(["color", "color-mix", "contrast-color", "device-cmyk", "hsl", "hsla", "hwb", "lab", "lch", "light-dark", "oklab", "oklch", "rgb", "rgba", "--alpha"]), Wi = /^-?(\d+|\.\d+)(.*?)$/;
  function Be(e, r) {
    function o(l) {
      let s = Y([l]), a = r(s);
      return q(a);
    }
    return L(e, ",").map((l) => {
      l = l.trim();
      let s = q(l), a = null, d = 0, m = 0, u = false;
      return _(s, (h) => {
        switch (h.kind) {
          case "word": {
            if (Ii.has(h.value.toLowerCase())) return R.Continue;
            if (Wi.test(h.value.toLowerCase())) return m++, R.Continue;
            if (h.value[0] === "#" || Kr(h.value)) return u = true, R.ReplaceStop(o(h));
            a = h, d++;
            break;
          }
          case "function":
            return Mi.has(h.value.toLowerCase()) ? (u = true, R.ReplaceStop(o(h))) : Fi.has(h.value.toLowerCase()) ? (m++, R.Skip) : (a = h, d++, R.Skip);
          case "separator":
            return R.Continue;
          default:
        }
      }), u ? Y(s) : m < 2 ? l : d === 0 ? `${l} ${r("currentcolor")}` : (d === 1 && _(s, (h) => h === a ? (u = true, R.ReplaceStop(o(h))) : R.Skip), u ? Y(s) : l);
    }).join(", ");
  }
  var pt = ["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6", "7", "8", "9", "10", "11", "12", "14", "16", "20", "24", "28", "32", "36", "40", "44", "48", "52", "56", "60", "64", "72", "80", "96"], Ft = class {
    utilities = new H(() => []);
    completions = /* @__PURE__ */ new Map();
    static(r, o) {
      this.utilities.get(r).push({ kind: "static", compileFn: o });
    }
    functional(r, o, t) {
      this.utilities.get(r).push({ kind: "functional", compileFn: o, options: t });
    }
    has(r, o) {
      return this.utilities.has(r) && this.utilities.get(r).some((t) => t.kind === o);
    }
    get(r) {
      return this.utilities.has(r) ? this.utilities.get(r) : [];
    }
    getCompletions(r) {
      return this.has(r, "static") ? this.completions.get(r)?.() ?? [{ supportsNegative: false, values: [], modifiers: [] }] : this.completions.get(r)?.() ?? [];
    }
    suggest(r, o) {
      let t = this.completions.get(r);
      t ? this.completions.set(r, () => [...t?.(), ...o?.()]) : this.completions.set(r, o);
    }
    keys(r) {
      let o = [];
      for (let [t, l] of this.utilities.entries()) for (let s of l) if (s.kind === r) {
        o.push(t);
        break;
      }
      return o;
    }
  };
  function N(e, r, o) {
    return M("@property", e, [n("syntax", o ? `"${o}"` : '"*"'), n("inherits", "false"), ...r ? [n("initial-value", r)] : []]);
  }
  function Q(e, r) {
    if (r === null) return e;
    let o = Number(r);
    return Number.isNaN(o) || (r = `${o * 100}%`), r === "100%" ? e : `color-mix(in oklab, ${e} ${r}, transparent)`;
  }
  function Ir(e, r) {
    let o = Number(r);
    return Number.isNaN(o) || (r = `${o * 100}%`), `oklab(from ${e} l a b / ${r})`;
  }
  function ee(e, r, o) {
    if (!r) return e;
    if (r.kind === "arbitrary") return Q(e, r.value);
    let t = o.resolve(r.value, ["--opacity"]);
    return t ? Q(e, t) : st(r.value) ? Q(e, `${r.value}%`) : null;
  }
  function oe(e, r, o) {
    let t = null;
    switch (e.value.value) {
      case "inherit": {
        t = "inherit";
        break;
      }
      case "transparent": {
        t = "transparent";
        break;
      }
      case "current": {
        t = "currentcolor";
        break;
      }
      default: {
        t = r.resolve(e.value.value, o);
        break;
      }
    }
    return t ? ee(t, e.modifier, r) : null;
  }
  var Fr = /(\d+)_(\d+)/g;
  function Mr(e) {
    let r = new Ft();
    function o(i, c) {
      function* g(w) {
        for (let T of e.keysInNamespaces(w)) yield T.replace(Fr, (P, $, S) => `${$}.${S}`);
      }
      let A = ["1/2", "1/3", "2/3", "1/4", "2/4", "3/4", "1/5", "2/5", "3/5", "4/5", "1/6", "2/6", "3/6", "4/6", "5/6", "1/12", "2/12", "3/12", "4/12", "5/12", "6/12", "7/12", "8/12", "9/12", "10/12", "11/12"];
      r.suggest(i, () => {
        let w = [];
        for (let T of c()) {
          if (typeof T == "string") {
            w.push({ values: [T], modifiers: [] });
            continue;
          }
          let P = [...T.values ?? [], ...g(T.valueThemeKeys ?? [])], $ = [...T.modifiers ?? [], ...g(T.modifierThemeKeys ?? [])];
          T.supportsFractions && P.push(...A), T.hasDefaultValue && P.unshift(null), w.push({ supportsNegative: T.supportsNegative, values: P, modifiers: $ });
        }
        return w;
      });
    }
    function t(i, c) {
      r.static(i, () => c.map((g) => typeof g == "function" ? g() : n(g[0], g[1])));
    }
    function l(i, c) {
      c.staticValues && (c.staticValues = Object.assign(/* @__PURE__ */ Object.create(null), c.staticValues));
      function g({ negative: A }) {
        return (w) => {
          let T = null, P = null;
          if (w.value) if (w.value.kind === "arbitrary") {
            if (w.modifier) return;
            T = w.value.value, P = w.value.dataType;
          } else {
            if (T = e.resolve(w.value.fraction ?? w.value.value, c.themeKeys ?? []), T === null && c.supportsFractions && w.value.fraction) {
              let [$, S] = L(w.value.fraction, "/");
              if (!V($) || !V(S)) return;
              T = `calc(${$} / ${S} * 100%)`;
            }
            if (T === null && A && c.handleNegativeBareValue) {
              if (T = c.handleNegativeBareValue(w.value), !T?.includes("/") && w.modifier) return;
              if (T !== null) return c.handle(T, null);
            }
            if (T === null && c.handleBareValue && (T = c.handleBareValue(w.value), !T?.includes("/") && w.modifier)) return;
            if (T === null && !A && c.staticValues && !w.modifier) {
              let $ = c.staticValues[w.value.value];
              if ($) return $.map(re);
            }
          }
          else {
            if (w.modifier) return;
            T = c.defaultValue !== void 0 ? c.defaultValue : e.resolve(null, c.themeKeys ?? []);
          }
          if (T !== null) return c.handle(A ? nt(`calc(${T} * -1)`) : T, P);
        };
      }
      if (c.supportsNegative && r.functional(`-${i}`, g({ negative: true })), r.functional(i, g({ negative: false })), o(i, () => [{ supportsNegative: c.supportsNegative, valueThemeKeys: c.themeKeys ?? [], hasDefaultValue: c.defaultValue !== void 0 && c.defaultValue !== null, supportsFractions: c.supportsFractions }]), c.staticValues && Object.keys(c.staticValues).length > 0) {
        let A = Object.keys(c.staticValues);
        o(i, () => [{ values: A }]);
      }
    }
    function s(i, c) {
      r.functional(i, (g) => {
        if (!g.value) return;
        let A = null;
        if (g.value.kind === "arbitrary" ? (A = g.value.value, A = ee(A, g.modifier, e)) : A = oe(g, e, c.themeKeys), A !== null) return c.handle(A);
      }), o(i, () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: c.themeKeys, modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (g, A) => `${A * 5}`) }]);
    }
    function a(i, c, g, { supportsNegative: A = false, supportsFractions: w = false, staticValues: T } = {}) {
      A && r.static(`-${i}-px`, () => g("-1px")), r.static(`${i}-px`, () => g("1px")), l(i, { themeKeys: c, supportsFractions: w, supportsNegative: A, defaultValue: null, handleBareValue: ({ value: P }) => !e.resolve(null, ["--spacing"]) || !le(P) ? null : `--spacing(${P})`, handleNegativeBareValue: ({ value: P }) => !e.resolve(null, ["--spacing"]) || !le(P) ? null : `--spacing(-${P})`, handle: g, staticValues: T }), o(i, () => [{ values: e.get(["--spacing"]) ? pt : [], supportsNegative: A, supportsFractions: w, valueThemeKeys: c }]);
    }
    t("sr-only", [["position", "absolute"], ["width", "1px"], ["height", "1px"], ["padding", "0"], ["margin", "-1px"], ["overflow", "hidden"], ["clip-path", "inset(50%)"], ["white-space", "nowrap"], ["border-width", "0"]]), t("not-sr-only", [["position", "static"], ["width", "auto"], ["height", "auto"], ["padding", "0"], ["margin", "0"], ["overflow", "visible"], ["clip-path", "none"], ["white-space", "normal"]]), t("pointer-events-none", [["pointer-events", "none"]]), t("pointer-events-auto", [["pointer-events", "auto"]]), t("visible", [["visibility", "visible"]]), t("invisible", [["visibility", "hidden"]]), t("collapse", [["visibility", "collapse"]]), t("static", [["position", "static"]]), t("fixed", [["position", "fixed"]]), t("absolute", [["position", "absolute"]]), t("relative", [["position", "relative"]]), t("sticky", [["position", "sticky"]]);
    for (let [i, c] of [["inset", "inset"], ["inset-x", "inset-inline"], ["inset-y", "inset-block"], ["inset-s", "inset-inline-start"], ["inset-e", "inset-inline-end"], ["inset-bs", "inset-block-start"], ["inset-be", "inset-block-end"], ["top", "top"], ["right", "right"], ["bottom", "bottom"], ["left", "left"]]) t(`${i}-auto`, [[c, "auto"]]), t(`${i}-full`, [[c, "100%"]]), t(`-${i}-full`, [[c, "-100%"]]), a(i, ["--inset", "--spacing"], (g) => [n(c, g)], { supportsNegative: true, supportsFractions: true });
    t("isolate", [["isolation", "isolate"]]), t("isolation-auto", [["isolation", "auto"]]), l("z", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--z-index"], handle: (i) => [n("z-index", i)], staticValues: { auto: [n("z-index", "auto")] } }), o("z", () => [{ supportsNegative: true, values: ["0", "10", "20", "30", "40", "50"], valueThemeKeys: ["--z-index"] }]), l("order", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--order"], handle: (i) => [n("order", i)], staticValues: { first: [n("order", "-9999")], last: [n("order", "9999")] } }), o("order", () => [{ supportsNegative: true, values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--order"] }]), l("col", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-column"], handle: (i) => [n("grid-column", i)], staticValues: { auto: [n("grid-column", "auto")] } }), l("col-span", { handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("grid-column", `span ${i} / span ${i}`)], staticValues: { full: [n("grid-column", "1 / -1")] } }), l("col-start", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-column-start"], handle: (i) => [n("grid-column-start", i)], staticValues: { auto: [n("grid-column-start", "auto")] } }), l("col-end", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-column-end"], handle: (i) => [n("grid-column-end", i)], staticValues: { auto: [n("grid-column-end", "auto")] } }), o("col-span", () => [{ values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: [] }]), o("col-start", () => [{ supportsNegative: true, values: Array.from({ length: 13 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-column-start"] }]), o("col-end", () => [{ supportsNegative: true, values: Array.from({ length: 13 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-column-end"] }]), l("row", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-row"], handle: (i) => [n("grid-row", i)], staticValues: { auto: [n("grid-row", "auto")] } }), l("row-span", { themeKeys: [], handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("grid-row", `span ${i} / span ${i}`)], staticValues: { full: [n("grid-row", "1 / -1")] } }), l("row-start", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-row-start"], handle: (i) => [n("grid-row-start", i)], staticValues: { auto: [n("grid-row-start", "auto")] } }), l("row-end", { supportsNegative: true, handleBareValue: ({ value: i }) => V(i) ? i : null, themeKeys: ["--grid-row-end"], handle: (i) => [n("grid-row-end", i)], staticValues: { auto: [n("grid-row-end", "auto")] } }), o("row-span", () => [{ values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: [] }]), o("row-start", () => [{ supportsNegative: true, values: Array.from({ length: 13 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-row-start"] }]), o("row-end", () => [{ supportsNegative: true, values: Array.from({ length: 13 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-row-end"] }]), t("float-start", [["float", "inline-start"]]), t("float-end", [["float", "inline-end"]]), t("float-right", [["float", "right"]]), t("float-left", [["float", "left"]]), t("float-none", [["float", "none"]]), t("clear-start", [["clear", "inline-start"]]), t("clear-end", [["clear", "inline-end"]]), t("clear-right", [["clear", "right"]]), t("clear-left", [["clear", "left"]]), t("clear-both", [["clear", "both"]]), t("clear-none", [["clear", "none"]]);
    for (let [i, c] of [["m", "margin"], ["mx", "margin-inline"], ["my", "margin-block"], ["ms", "margin-inline-start"], ["me", "margin-inline-end"], ["mbs", "margin-block-start"], ["mbe", "margin-block-end"], ["mt", "margin-top"], ["mr", "margin-right"], ["mb", "margin-bottom"], ["ml", "margin-left"]]) t(`${i}-auto`, [[c, "auto"]]), a(i, ["--margin", "--spacing"], (g) => [n(c, g)], { supportsNegative: true });
    t("box-border", [["box-sizing", "border-box"]]), t("box-content", [["box-sizing", "content-box"]]), l("line-clamp", { themeKeys: ["--line-clamp"], handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("overflow", "hidden"), n("display", "-webkit-box"), n("-webkit-box-orient", "vertical"), n("-webkit-line-clamp", i)], staticValues: { none: [n("overflow", "visible"), n("display", "block"), n("-webkit-box-orient", "horizontal"), n("-webkit-line-clamp", "unset")] } }), o("line-clamp", () => [{ values: ["1", "2", "3", "4", "5", "6"], valueThemeKeys: ["--line-clamp"] }]), t("block", [["display", "block"]]), t("inline-block", [["display", "inline-block"]]), t("inline", [["display", "inline"]]), t("hidden", [["display", "none"]]), t("inline-flex", [["display", "inline-flex"]]), t("table", [["display", "table"]]), t("inline-table", [["display", "inline-table"]]), t("table-caption", [["display", "table-caption"]]), t("table-cell", [["display", "table-cell"]]), t("table-column", [["display", "table-column"]]), t("table-column-group", [["display", "table-column-group"]]), t("table-footer-group", [["display", "table-footer-group"]]), t("table-header-group", [["display", "table-header-group"]]), t("table-row-group", [["display", "table-row-group"]]), t("table-row", [["display", "table-row"]]), t("flow-root", [["display", "flow-root"]]), t("flex", [["display", "flex"]]), t("grid", [["display", "grid"]]), t("inline-grid", [["display", "inline-grid"]]), t("contents", [["display", "contents"]]), t("list-item", [["display", "list-item"]]), t("field-sizing-content", [["field-sizing", "content"]]), t("field-sizing-fixed", [["field-sizing", "fixed"]]), l("aspect", { themeKeys: ["--aspect"], handleBareValue: ({ fraction: i }) => {
      if (i === null) return null;
      let [c, g] = L(i, "/");
      return !le(c) || !le(g) ? null : i;
    }, handle: (i) => [n("aspect-ratio", i)], staticValues: { auto: [n("aspect-ratio", "auto")], square: [n("aspect-ratio", "1 / 1")] } });
    for (let [i, c] of [["full", "100%"], ["svw", "100svw"], ["lvw", "100lvw"], ["dvw", "100dvw"], ["svh", "100svh"], ["lvh", "100lvh"], ["dvh", "100dvh"], ["min", "min-content"], ["max", "max-content"], ["fit", "fit-content"]]) t(`size-${i}`, [["--tw-sort", "size"], ["width", c], ["height", c]]), t(`w-${i}`, [["width", c]]), t(`h-${i}`, [["height", c]]), t(`min-w-${i}`, [["min-width", c]]), t(`min-h-${i}`, [["min-height", c]]), t(`max-w-${i}`, [["max-width", c]]), t(`max-h-${i}`, [["max-height", c]]);
    t("size-auto", [["--tw-sort", "size"], ["width", "auto"], ["height", "auto"]]), t("w-auto", [["width", "auto"]]), t("h-auto", [["height", "auto"]]), t("min-w-auto", [["min-width", "auto"]]), t("min-h-auto", [["min-height", "auto"]]), t("h-lh", [["height", "1lh"]]), t("min-h-lh", [["min-height", "1lh"]]), t("max-h-lh", [["max-height", "1lh"]]), t("w-screen", [["width", "100vw"]]), t("min-w-screen", [["min-width", "100vw"]]), t("max-w-screen", [["max-width", "100vw"]]), t("h-screen", [["height", "100vh"]]), t("min-h-screen", [["min-height", "100vh"]]), t("max-h-screen", [["max-height", "100vh"]]), t("max-w-none", [["max-width", "none"]]), t("max-h-none", [["max-height", "none"]]), a("size", ["--size", "--spacing"], (i) => [n("--tw-sort", "size"), n("width", i), n("height", i)], { supportsFractions: true });
    for (let [i, c, g] of [["w", ["--width", "--spacing", "--container"], "width"], ["min-w", ["--min-width", "--spacing", "--container"], "min-width"], ["max-w", ["--max-width", "--spacing", "--container"], "max-width"], ["h", ["--height", "--spacing"], "height"], ["min-h", ["--min-height", "--height", "--spacing"], "min-height"], ["max-h", ["--max-height", "--height", "--spacing"], "max-height"]]) a(i, c, (A) => [n(g, A)], { supportsFractions: true });
    for (let [i, c] of [["full", "100%"], ["min", "min-content"], ["max", "max-content"], ["fit", "fit-content"]]) t(`inline-${i}`, [["inline-size", c]]), t(`block-${i}`, [["block-size", c]]), t(`min-inline-${i}`, [["min-inline-size", c]]), t(`min-block-${i}`, [["min-block-size", c]]), t(`max-inline-${i}`, [["max-inline-size", c]]), t(`max-block-${i}`, [["max-block-size", c]]);
    for (let [i, c] of [["svw", "100svw"], ["lvw", "100lvw"], ["dvw", "100dvw"]]) t(`inline-${i}`, [["inline-size", c]]), t(`min-inline-${i}`, [["min-inline-size", c]]), t(`max-inline-${i}`, [["max-inline-size", c]]);
    for (let [i, c] of [["svh", "100svh"], ["lvh", "100lvh"], ["dvh", "100dvh"]]) t(`block-${i}`, [["block-size", c]]), t(`min-block-${i}`, [["min-block-size", c]]), t(`max-block-${i}`, [["max-block-size", c]]);
    t("inline-auto", [["inline-size", "auto"]]), t("block-auto", [["block-size", "auto"]]), t("min-inline-auto", [["min-inline-size", "auto"]]), t("min-block-auto", [["min-block-size", "auto"]]), t("block-lh", [["block-size", "1lh"]]), t("min-block-lh", [["min-block-size", "1lh"]]), t("max-block-lh", [["max-block-size", "1lh"]]), t("inline-screen", [["inline-size", "100vw"]]), t("min-inline-screen", [["min-inline-size", "100vw"]]), t("max-inline-screen", [["max-inline-size", "100vw"]]), t("block-screen", [["block-size", "100vh"]]), t("min-block-screen", [["min-block-size", "100vh"]]), t("max-block-screen", [["max-block-size", "100vh"]]), t("max-inline-none", [["max-inline-size", "none"]]), t("max-block-none", [["max-block-size", "none"]]);
    for (let [i, c, g] of [["inline", ["--spacing", "--container"], "inline-size"], ["min-inline", ["--spacing", "--container"], "min-inline-size"], ["max-inline", ["--spacing", "--container"], "max-inline-size"], ["block", ["--spacing"], "block-size"], ["min-block", ["--spacing"], "min-block-size"], ["max-block", ["--spacing"], "max-block-size"]]) a(i, c, (A) => [n(g, A)], { supportsFractions: true });
    r.static("container", () => {
      let i = [...e.namespace("--breakpoint").values()];
      i.sort((g, A) => Ne(g, A, "asc"));
      let c = [n("--tw-sort", "--tw-container-component"), n("width", "100%")];
      for (let g of i) c.push(M("@media", `(width >= ${g})`, [n("max-width", g)]));
      return c;
    }), t("flex-auto", [["flex", "auto"]]), t("flex-initial", [["flex", "0 auto"]]), t("flex-none", [["flex", "none"]]), r.functional("flex", (i) => {
      if (i.value) {
        if (i.value.kind === "arbitrary") return i.modifier ? void 0 : [n("flex", i.value.value)];
        if (i.value.fraction) {
          let [c, g] = L(i.value.fraction, "/");
          return !V(c) || !V(g) ? void 0 : [n("flex", `calc(${i.value.fraction} * 100%)`)];
        }
        if (V(i.value.value)) return i.modifier ? void 0 : [n("flex", i.value.value)];
      }
    }), o("flex", () => [{ supportsFractions: true }, { values: Array.from({ length: 12 }, (i, c) => `${c + 1}`) }]), l("shrink", { defaultValue: "1", handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("flex-shrink", i)] }), l("grow", { defaultValue: "1", handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("flex-grow", i)] }), o("shrink", () => [{ values: ["0"], valueThemeKeys: [], hasDefaultValue: true }]), o("grow", () => [{ values: ["0"], valueThemeKeys: [], hasDefaultValue: true }]), t("basis-auto", [["flex-basis", "auto"]]), t("basis-full", [["flex-basis", "100%"]]), a("basis", ["--flex-basis", "--spacing", "--container"], (i) => [n("flex-basis", i)], { supportsFractions: true }), t("table-auto", [["table-layout", "auto"]]), t("table-fixed", [["table-layout", "fixed"]]), t("caption-top", [["caption-side", "top"]]), t("caption-bottom", [["caption-side", "bottom"]]), t("border-collapse", [["border-collapse", "collapse"]]), t("border-separate", [["border-collapse", "separate"]]);
    let d = () => F([N("--tw-border-spacing-x", "0", "<length>"), N("--tw-border-spacing-y", "0", "<length>")]);
    a("border-spacing", ["--border-spacing", "--spacing"], (i) => [d(), n("--tw-border-spacing-x", i), n("--tw-border-spacing-y", i), n("border-spacing", "var(--tw-border-spacing-x) var(--tw-border-spacing-y)")]), a("border-spacing-x", ["--border-spacing", "--spacing"], (i) => [d(), n("--tw-border-spacing-x", i), n("border-spacing", "var(--tw-border-spacing-x) var(--tw-border-spacing-y)")]), a("border-spacing-y", ["--border-spacing", "--spacing"], (i) => [d(), n("--tw-border-spacing-y", i), n("border-spacing", "var(--tw-border-spacing-x) var(--tw-border-spacing-y)")]), l("origin", { themeKeys: ["--transform-origin"], handle: (i) => [n("transform-origin", i)], staticValues: { center: [n("transform-origin", "center")], top: [n("transform-origin", "top")], "top-right": [n("transform-origin", "100% 0")], right: [n("transform-origin", "100%")], "bottom-right": [n("transform-origin", "100% 100%")], bottom: [n("transform-origin", "bottom")], "bottom-left": [n("transform-origin", "0 100%")], left: [n("transform-origin", "0")], "top-left": [n("transform-origin", "0 0")] } }), l("perspective-origin", { themeKeys: ["--perspective-origin"], handle: (i) => [n("perspective-origin", i)], staticValues: { center: [n("perspective-origin", "center")], top: [n("perspective-origin", "top")], "top-right": [n("perspective-origin", "100% 0")], right: [n("perspective-origin", "100%")], "bottom-right": [n("perspective-origin", "100% 100%")], bottom: [n("perspective-origin", "bottom")], "bottom-left": [n("perspective-origin", "0 100%")], left: [n("perspective-origin", "0")], "top-left": [n("perspective-origin", "0 0")] } }), l("perspective", { themeKeys: ["--perspective"], handle: (i) => [n("perspective", i)], staticValues: { none: [n("perspective", "none")] } });
    let m = () => F([N("--tw-translate-x", "0"), N("--tw-translate-y", "0"), N("--tw-translate-z", "0")]);
    t("translate-none", [["translate", "none"]]), t("-translate-full", [m, ["--tw-translate-x", "-100%"], ["--tw-translate-y", "-100%"], ["translate", "var(--tw-translate-x) var(--tw-translate-y)"]]), t("translate-full", [m, ["--tw-translate-x", "100%"], ["--tw-translate-y", "100%"], ["translate", "var(--tw-translate-x) var(--tw-translate-y)"]]), a("translate", ["--translate", "--spacing"], (i) => [m(), n("--tw-translate-x", i), n("--tw-translate-y", i), n("translate", "var(--tw-translate-x) var(--tw-translate-y)")], { supportsNegative: true, supportsFractions: true });
    for (let i of ["x", "y"]) t(`-translate-${i}-full`, [m, [`--tw-translate-${i}`, "-100%"], ["translate", "var(--tw-translate-x) var(--tw-translate-y)"]]), t(`translate-${i}-full`, [m, [`--tw-translate-${i}`, "100%"], ["translate", "var(--tw-translate-x) var(--tw-translate-y)"]]), a(`translate-${i}`, ["--translate", "--spacing"], (c) => [m(), n(`--tw-translate-${i}`, c), n("translate", "var(--tw-translate-x) var(--tw-translate-y)")], { supportsNegative: true, supportsFractions: true });
    a("translate-z", ["--translate", "--spacing"], (i) => [m(), n("--tw-translate-z", i), n("translate", "var(--tw-translate-x) var(--tw-translate-y) var(--tw-translate-z)")], { supportsNegative: true }), t("translate-3d", [m, ["translate", "var(--tw-translate-x) var(--tw-translate-y) var(--tw-translate-z)"]]);
    let u = () => F([N("--tw-scale-x", "1"), N("--tw-scale-y", "1"), N("--tw-scale-z", "1")]);
    t("scale-none", [["scale", "none"]]);
    function h({ negative: i }) {
      return (c) => {
        if (!c.value || c.modifier) return;
        let g;
        return c.value.kind === "arbitrary" ? (g = c.value.value, g = i ? `calc(${g} * -1)` : g, [n("scale", g)]) : (g = e.resolve(c.value.value, ["--scale"]), !g && V(c.value.value) && (g = `${c.value.value}%`), g ? (g = i ? `calc(${g} * -1)` : g, [u(), n("--tw-scale-x", g), n("--tw-scale-y", g), n("--tw-scale-z", g), n("scale", "var(--tw-scale-x) var(--tw-scale-y)")]) : void 0);
      };
    }
    r.functional("-scale", h({ negative: true })), r.functional("scale", h({ negative: false })), o("scale", () => [{ supportsNegative: true, values: ["0", "50", "75", "90", "95", "100", "105", "110", "125", "150", "200"], valueThemeKeys: ["--scale"] }]);
    for (let i of ["x", "y", "z"]) l(`scale-${i}`, { supportsNegative: true, themeKeys: ["--scale"], handleBareValue: ({ value: c }) => V(c) ? `${c}%` : null, handle: (c) => [u(), n(`--tw-scale-${i}`, c), n("scale", `var(--tw-scale-x) var(--tw-scale-y)${i === "z" ? " var(--tw-scale-z)" : ""}`)] }), o(`scale-${i}`, () => [{ supportsNegative: true, values: ["0", "50", "75", "90", "95", "100", "105", "110", "125", "150", "200"], valueThemeKeys: ["--scale"] }]);
    t("scale-3d", [u, ["scale", "var(--tw-scale-x) var(--tw-scale-y) var(--tw-scale-z)"]]), t("rotate-none", [["rotate", "none"]]);
    function p({ negative: i }) {
      return (c) => {
        if (!c.value || c.modifier) return;
        let g;
        if (c.value.kind === "arbitrary") {
          g = c.value.value;
          let A = c.value.dataType ?? J(g, ["angle", "vector"]);
          if (A === "vector") return [n("rotate", `${g} var(--tw-rotate)`)];
          if (A !== "angle") return [n("rotate", i ? `calc(${g} * -1)` : g)];
        } else if (g = e.resolve(c.value.value, ["--rotate"]), !g && V(c.value.value) && (g = `${c.value.value}deg`), !g) return;
        return [n("rotate", i ? `calc(${g} * -1)` : g)];
      };
    }
    r.functional("-rotate", p({ negative: true })), r.functional("rotate", p({ negative: false })), o("rotate", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12", "45", "90", "180"], valueThemeKeys: ["--rotate"] }]);
    {
      let i = ["var(--tw-rotate-x,)", "var(--tw-rotate-y,)", "var(--tw-rotate-z,)", "var(--tw-skew-x,)", "var(--tw-skew-y,)"].join(" "), c = () => F([N("--tw-rotate-x"), N("--tw-rotate-y"), N("--tw-rotate-z"), N("--tw-skew-x"), N("--tw-skew-y")]);
      for (let g of ["x", "y", "z"]) l(`rotate-${g}`, { supportsNegative: true, themeKeys: ["--rotate"], handleBareValue: ({ value: A }) => V(A) ? `${A}deg` : null, handle: (A) => [c(), n(`--tw-rotate-${g}`, `rotate${g.toUpperCase()}(${A})`), n("transform", i)] }), o(`rotate-${g}`, () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12", "45", "90", "180"], valueThemeKeys: ["--rotate"] }]);
      l("skew", { supportsNegative: true, themeKeys: ["--skew"], handleBareValue: ({ value: g }) => V(g) ? `${g}deg` : null, handle: (g) => [c(), n("--tw-skew-x", `skewX(${g})`), n("--tw-skew-y", `skewY(${g})`), n("transform", i)] }), l("skew-x", { supportsNegative: true, themeKeys: ["--skew"], handleBareValue: ({ value: g }) => V(g) ? `${g}deg` : null, handle: (g) => [c(), n("--tw-skew-x", `skewX(${g})`), n("transform", i)] }), l("skew-y", { supportsNegative: true, themeKeys: ["--skew"], handleBareValue: ({ value: g }) => V(g) ? `${g}deg` : null, handle: (g) => [c(), n("--tw-skew-y", `skewY(${g})`), n("transform", i)] }), o("skew", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12"], valueThemeKeys: ["--skew"] }]), o("skew-x", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12"], valueThemeKeys: ["--skew"] }]), o("skew-y", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12"], valueThemeKeys: ["--skew"] }]), r.functional("transform", (g) => {
        if (g.modifier) return;
        let A = null;
        if (g.value ? g.value.kind === "arbitrary" && (A = g.value.value) : A = i, A !== null) return [c(), n("transform", A)];
      }), o("transform", () => [{ hasDefaultValue: true }]), t("transform-cpu", [["transform", i]]), t("transform-gpu", [["transform", `translateZ(0) ${i}`]]), t("transform-none", [["transform", "none"]]);
    }
    l("zoom", { handleBareValue: ({ value: i }) => V(i) ? `${i}%` : null, handle: (i) => [n("zoom", i)] }), o("zoom", () => [{ values: ["50", "75", "90", "95", "100", "105", "110", "125", "150", "200"] }]), t("transform-flat", [["transform-style", "flat"]]), t("transform-3d", [["transform-style", "preserve-3d"]]), t("transform-content", [["transform-box", "content-box"]]), t("transform-border", [["transform-box", "border-box"]]), t("transform-fill", [["transform-box", "fill-box"]]), t("transform-stroke", [["transform-box", "stroke-box"]]), t("transform-view", [["transform-box", "view-box"]]), t("backface-visible", [["backface-visibility", "visible"]]), t("backface-hidden", [["backface-visibility", "hidden"]]);
    for (let i of ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out"]) t(`cursor-${i}`, [["cursor", i]]);
    l("cursor", { themeKeys: ["--cursor"], handle: (i) => [n("cursor", i)] });
    for (let i of ["auto", "none", "manipulation"]) t(`touch-${i}`, [["touch-action", i]]);
    let f = () => F([N("--tw-pan-x"), N("--tw-pan-y"), N("--tw-pinch-zoom")]);
    for (let i of ["x", "left", "right"]) t(`touch-pan-${i}`, [f, ["--tw-pan-x", `pan-${i}`], ["touch-action", "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"]]);
    for (let i of ["y", "up", "down"]) t(`touch-pan-${i}`, [f, ["--tw-pan-y", `pan-${i}`], ["touch-action", "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"]]);
    t("touch-pinch-zoom", [f, ["--tw-pinch-zoom", "pinch-zoom"], ["touch-action", "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"]]);
    for (let i of ["none", "text", "all", "auto"]) t(`select-${i}`, [["-webkit-user-select", i], ["user-select", i]]);
    t("resize-none", [["resize", "none"]]), t("resize-x", [["resize", "horizontal"]]), t("resize-y", [["resize", "vertical"]]), t("resize", [["resize", "both"]]), t("snap-none", [["scroll-snap-type", "none"]]);
    let v = () => F([N("--tw-scroll-snap-strictness", "proximity", "*")]);
    for (let i of ["x", "y", "both"]) t(`snap-${i}`, [v, ["scroll-snap-type", `${i} var(--tw-scroll-snap-strictness)`]]);
    t("snap-mandatory", [v, ["--tw-scroll-snap-strictness", "mandatory"]]), t("snap-proximity", [v, ["--tw-scroll-snap-strictness", "proximity"]]), t("snap-align-none", [["scroll-snap-align", "none"]]), t("snap-start", [["scroll-snap-align", "start"]]), t("snap-end", [["scroll-snap-align", "end"]]), t("snap-center", [["scroll-snap-align", "center"]]), t("snap-normal", [["scroll-snap-stop", "normal"]]), t("snap-always", [["scroll-snap-stop", "always"]]);
    for (let [i, c] of [["scroll-m", "scroll-margin"], ["scroll-mx", "scroll-margin-inline"], ["scroll-my", "scroll-margin-block"], ["scroll-ms", "scroll-margin-inline-start"], ["scroll-me", "scroll-margin-inline-end"], ["scroll-mbs", "scroll-margin-block-start"], ["scroll-mbe", "scroll-margin-block-end"], ["scroll-mt", "scroll-margin-top"], ["scroll-mr", "scroll-margin-right"], ["scroll-mb", "scroll-margin-bottom"], ["scroll-ml", "scroll-margin-left"]]) a(i, ["--scroll-margin", "--spacing"], (g) => [n(c, g)], { supportsNegative: true });
    for (let [i, c] of [["scroll-p", "scroll-padding"], ["scroll-px", "scroll-padding-inline"], ["scroll-py", "scroll-padding-block"], ["scroll-ps", "scroll-padding-inline-start"], ["scroll-pe", "scroll-padding-inline-end"], ["scroll-pbs", "scroll-padding-block-start"], ["scroll-pbe", "scroll-padding-block-end"], ["scroll-pt", "scroll-padding-top"], ["scroll-pr", "scroll-padding-right"], ["scroll-pb", "scroll-padding-bottom"], ["scroll-pl", "scroll-padding-left"]]) a(i, ["--scroll-padding", "--spacing"], (g) => [n(c, g)]);
    t("list-inside", [["list-style-position", "inside"]]), t("list-outside", [["list-style-position", "outside"]]), l("list", { themeKeys: ["--list-style-type"], handle: (i) => [n("list-style-type", i)], staticValues: { none: [n("list-style-type", "none")], disc: [n("list-style-type", "disc")], decimal: [n("list-style-type", "decimal")] } }), l("list-image", { themeKeys: ["--list-style-image"], handle: (i) => [n("list-style-image", i)], staticValues: { none: [n("list-style-image", "none")] } }), t("appearance-none", [["appearance", "none"]]), t("appearance-auto", [["appearance", "auto"]]), t("scheme-normal", [["color-scheme", "normal"]]), t("scheme-dark", [["color-scheme", "dark"]]), t("scheme-light", [["color-scheme", "light"]]), t("scheme-light-dark", [["color-scheme", "light dark"]]), t("scheme-only-dark", [["color-scheme", "only dark"]]), t("scheme-only-light", [["color-scheme", "only light"]]), l("columns", { themeKeys: ["--columns", "--container"], handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("columns", i)], staticValues: { auto: [n("columns", "auto")] } }), o("columns", () => [{ values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--columns", "--container"] }]);
    for (let i of ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"]) t(`break-before-${i}`, [["break-before", i]]);
    for (let i of ["auto", "avoid", "avoid-page", "avoid-column"]) t(`break-inside-${i}`, [["break-inside", i]]);
    for (let i of ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"]) t(`break-after-${i}`, [["break-after", i]]);
    t("grid-flow-row", [["grid-auto-flow", "row"]]), t("grid-flow-col", [["grid-auto-flow", "column"]]), t("grid-flow-dense", [["grid-auto-flow", "dense"]]), t("grid-flow-row-dense", [["grid-auto-flow", "row dense"]]), t("grid-flow-col-dense", [["grid-auto-flow", "column dense"]]), l("auto-cols", { themeKeys: ["--grid-auto-columns"], handleBareValue: ({ value: i }) => !e.resolve(null, ["--spacing"]) || !le(i) ? null : `--spacing(${i})`, handle: (i) => [n("grid-auto-columns", i)], staticValues: { auto: [n("grid-auto-columns", "auto")], min: [n("grid-auto-columns", "min-content")], max: [n("grid-auto-columns", "max-content")], fr: [n("grid-auto-columns", "minmax(0, 1fr)")] } }), l("auto-rows", { themeKeys: ["--grid-auto-rows"], handleBareValue: ({ value: i }) => !e.resolve(null, ["--spacing"]) || !le(i) ? null : `--spacing(${i})`, handle: (i) => [n("grid-auto-rows", i)], staticValues: { auto: [n("grid-auto-rows", "auto")], min: [n("grid-auto-rows", "min-content")], max: [n("grid-auto-rows", "max-content")], fr: [n("grid-auto-rows", "minmax(0, 1fr)")] } }), l("grid-cols", { themeKeys: ["--grid-template-columns"], handleBareValue: ({ value: i }) => It(i) ? `repeat(${i}, minmax(0, 1fr))` : null, handle: (i) => [n("grid-template-columns", i)], staticValues: { none: [n("grid-template-columns", "none")], subgrid: [n("grid-template-columns", "subgrid")] } }), l("grid-rows", { themeKeys: ["--grid-template-rows"], handleBareValue: ({ value: i }) => It(i) ? `repeat(${i}, minmax(0, 1fr))` : null, handle: (i) => [n("grid-template-rows", i)], staticValues: { none: [n("grid-template-rows", "none")], subgrid: [n("grid-template-rows", "subgrid")] } }), o("grid-cols", () => [{ values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-template-columns"] }]), o("grid-rows", () => [{ values: Array.from({ length: 12 }, (i, c) => `${c + 1}`), valueThemeKeys: ["--grid-template-rows"] }]), t("flex-row", [["flex-direction", "row"]]), t("flex-row-reverse", [["flex-direction", "row-reverse"]]), t("flex-col", [["flex-direction", "column"]]), t("flex-col-reverse", [["flex-direction", "column-reverse"]]), t("flex-wrap", [["flex-wrap", "wrap"]]), t("flex-nowrap", [["flex-wrap", "nowrap"]]), t("flex-wrap-reverse", [["flex-wrap", "wrap-reverse"]]), t("place-content-center", [["place-content", "center"]]), t("place-content-start", [["place-content", "start"]]), t("place-content-end", [["place-content", "end"]]), t("place-content-center-safe", [["place-content", "safe center"]]), t("place-content-end-safe", [["place-content", "safe end"]]), t("place-content-between", [["place-content", "space-between"]]), t("place-content-around", [["place-content", "space-around"]]), t("place-content-evenly", [["place-content", "space-evenly"]]), t("place-content-baseline", [["place-content", "baseline"]]), t("place-content-stretch", [["place-content", "stretch"]]), t("place-items-center", [["place-items", "center"]]), t("place-items-start", [["place-items", "start"]]), t("place-items-end", [["place-items", "end"]]), t("place-items-center-safe", [["place-items", "safe center"]]), t("place-items-end-safe", [["place-items", "safe end"]]), t("place-items-baseline", [["place-items", "baseline"]]), t("place-items-stretch", [["place-items", "stretch"]]), t("content-normal", [["align-content", "normal"]]), t("content-center", [["align-content", "center"]]), t("content-start", [["align-content", "flex-start"]]), t("content-end", [["align-content", "flex-end"]]), t("content-center-safe", [["align-content", "safe center"]]), t("content-end-safe", [["align-content", "safe flex-end"]]), t("content-between", [["align-content", "space-between"]]), t("content-around", [["align-content", "space-around"]]), t("content-evenly", [["align-content", "space-evenly"]]), t("content-baseline", [["align-content", "baseline"]]), t("content-stretch", [["align-content", "stretch"]]), t("items-center", [["align-items", "center"]]), t("items-start", [["align-items", "flex-start"]]), t("items-end", [["align-items", "flex-end"]]), t("items-center-safe", [["align-items", "safe center"]]), t("items-end-safe", [["align-items", "safe flex-end"]]), t("items-baseline", [["align-items", "baseline"]]), t("items-baseline-last", [["align-items", "last baseline"]]), t("items-stretch", [["align-items", "stretch"]]), t("justify-normal", [["justify-content", "normal"]]), t("justify-center", [["justify-content", "center"]]), t("justify-start", [["justify-content", "flex-start"]]), t("justify-end", [["justify-content", "flex-end"]]), t("justify-center-safe", [["justify-content", "safe center"]]), t("justify-end-safe", [["justify-content", "safe flex-end"]]), t("justify-between", [["justify-content", "space-between"]]), t("justify-around", [["justify-content", "space-around"]]), t("justify-evenly", [["justify-content", "space-evenly"]]), t("justify-baseline", [["justify-content", "baseline"]]), t("justify-stretch", [["justify-content", "stretch"]]), t("justify-items-normal", [["justify-items", "normal"]]), t("justify-items-center", [["justify-items", "center"]]), t("justify-items-start", [["justify-items", "start"]]), t("justify-items-end", [["justify-items", "end"]]), t("justify-items-center-safe", [["justify-items", "safe center"]]), t("justify-items-end-safe", [["justify-items", "safe end"]]), t("justify-items-stretch", [["justify-items", "stretch"]]), a("gap", ["--gap", "--spacing"], (i) => [n("gap", i)]), a("gap-x", ["--gap", "--spacing"], (i) => [n("column-gap", i)]), a("gap-y", ["--gap", "--spacing"], (i) => [n("row-gap", i)]), a("space-x", ["--space", "--spacing"], (i) => {
      let c = (() => {
        if (i === "--spacing(0)" || i === "--spacing(-0)") return true;
        let g = We.get(i);
        return !!(g && g[0] === 0 && (g[1] === null || Te(i)));
      })();
      return [F([N("--tw-space-x-reverse", "0")]), G(":where(& > :not(:last-child))", [n("--tw-sort", "row-gap"), n("--tw-space-x-reverse", "0"), n("margin-inline-start", c ? "0" : `calc(${i} * var(--tw-space-x-reverse))`), n("margin-inline-end", c ? "0" : `calc(${i} * calc(1 - var(--tw-space-x-reverse)))`)])];
    }, { supportsNegative: true }), a("space-y", ["--space", "--spacing"], (i) => {
      let c = (() => {
        if (i === "--spacing(0)" || i === "--spacing(-0)") return true;
        let g = We.get(i);
        return !!(g && g[0] === 0 && (g[1] === null || Te(i)));
      })();
      return [F([N("--tw-space-y-reverse", "0")]), G(":where(& > :not(:last-child))", [n("--tw-sort", "column-gap"), n("--tw-space-y-reverse", "0"), n("margin-block-start", c ? "0" : `calc(${i} * var(--tw-space-y-reverse))`), n("margin-block-end", c ? "0" : `calc(${i} * calc(1 - var(--tw-space-y-reverse)))`)])];
    }, { supportsNegative: true }), t("space-x-reverse", [() => F([N("--tw-space-x-reverse", "0")]), () => G(":where(& > :not(:last-child))", [n("--tw-sort", "row-gap"), n("--tw-space-x-reverse", "1")])]), t("space-y-reverse", [() => F([N("--tw-space-y-reverse", "0")]), () => G(":where(& > :not(:last-child))", [n("--tw-sort", "column-gap"), n("--tw-space-y-reverse", "1")])]), t("accent-auto", [["accent-color", "auto"]]), s("accent", { themeKeys: ["--accent-color", "--color"], handle: (i) => [n("accent-color", i)] }), s("caret", { themeKeys: ["--caret-color", "--color"], handle: (i) => [n("caret-color", i)] }), s("divide", { themeKeys: ["--divide-color", "--border-color", "--color"], handle: (i) => [G(":where(& > :not(:last-child))", [n("--tw-sort", "divide-color"), n("border-color", i)])] }), t("place-self-auto", [["place-self", "auto"]]), t("place-self-start", [["place-self", "start"]]), t("place-self-end", [["place-self", "end"]]), t("place-self-center", [["place-self", "center"]]), t("place-self-end-safe", [["place-self", "safe end"]]), t("place-self-center-safe", [["place-self", "safe center"]]), t("place-self-stretch", [["place-self", "stretch"]]), t("self-auto", [["align-self", "auto"]]), t("self-start", [["align-self", "flex-start"]]), t("self-end", [["align-self", "flex-end"]]), t("self-center", [["align-self", "center"]]), t("self-end-safe", [["align-self", "safe flex-end"]]), t("self-center-safe", [["align-self", "safe center"]]), t("self-stretch", [["align-self", "stretch"]]), t("self-baseline", [["align-self", "baseline"]]), t("self-baseline-last", [["align-self", "last baseline"]]), t("justify-self-auto", [["justify-self", "auto"]]), t("justify-self-start", [["justify-self", "flex-start"]]), t("justify-self-end", [["justify-self", "flex-end"]]), t("justify-self-center", [["justify-self", "center"]]), t("justify-self-end-safe", [["justify-self", "safe flex-end"]]), t("justify-self-center-safe", [["justify-self", "safe center"]]), t("justify-self-stretch", [["justify-self", "stretch"]]);
    for (let i of ["auto", "hidden", "clip", "visible", "scroll"]) t(`overflow-${i}`, [["overflow", i]]), t(`overflow-x-${i}`, [["overflow-x", i]]), t(`overflow-y-${i}`, [["overflow-y", i]]);
    for (let i of ["auto", "contain", "none"]) t(`overscroll-${i}`, [["overscroll-behavior", i]]), t(`overscroll-x-${i}`, [["overscroll-behavior-x", i]]), t(`overscroll-y-${i}`, [["overscroll-behavior-y", i]]);
    t("scroll-auto", [["scroll-behavior", "auto"]]), t("scroll-smooth", [["scroll-behavior", "smooth"]]), t("scrollbar-auto", [["scrollbar-width", "auto"]]), t("scrollbar-thin", [["scrollbar-width", "thin"]]), t("scrollbar-none", [["scrollbar-width", "none"]]);
    {
      let i = () => F([N("--tw-scrollbar-thumb", "#0000", "<color>"), N("--tw-scrollbar-track", "#0000", "<color>")]);
      s("scrollbar-thumb", { themeKeys: ["--color"], handle: (c) => [i(), n("--tw-scrollbar-thumb", c), n("scrollbar-color", "var(--tw-scrollbar-thumb) var(--tw-scrollbar-track)")] }), s("scrollbar-track", { themeKeys: ["--color"], handle: (c) => [i(), n("--tw-scrollbar-track", c), n("scrollbar-color", "var(--tw-scrollbar-thumb) var(--tw-scrollbar-track)")] });
    }
    t("scrollbar-gutter-auto", [["scrollbar-gutter", "auto"]]), t("scrollbar-gutter-stable", [["scrollbar-gutter", "stable"]]), t("scrollbar-gutter-both", [["scrollbar-gutter", "stable both-edges"]]), t("truncate", [["overflow", "hidden"], ["text-overflow", "ellipsis"], ["white-space", "nowrap"]]), t("text-ellipsis", [["text-overflow", "ellipsis"]]), t("text-clip", [["text-overflow", "clip"]]), t("hyphens-none", [["-webkit-hyphens", "none"], ["hyphens", "none"]]), t("hyphens-manual", [["-webkit-hyphens", "manual"], ["hyphens", "manual"]]), t("hyphens-auto", [["-webkit-hyphens", "auto"], ["hyphens", "auto"]]), t("whitespace-normal", [["white-space", "normal"]]), t("whitespace-nowrap", [["white-space", "nowrap"]]), t("whitespace-pre", [["white-space", "pre"]]), t("whitespace-pre-line", [["white-space", "pre-line"]]), t("whitespace-pre-wrap", [["white-space", "pre-wrap"]]), t("whitespace-break-spaces", [["white-space", "break-spaces"]]), l("tab", { handleBareValue: ({ value: i }) => V(i) ? i : null, handle: (i) => [n("tab-size", i)] }), o("tab", () => [{ values: ["2", "4", "8"] }]), t("text-wrap", [["text-wrap", "wrap"]]), t("text-nowrap", [["text-wrap", "nowrap"]]), t("text-balance", [["text-wrap", "balance"]]), t("text-pretty", [["text-wrap", "pretty"]]), t("break-normal", [["overflow-wrap", "normal"], ["word-break", "normal"]]), t("break-all", [["word-break", "break-all"]]), t("break-keep", [["word-break", "keep-all"]]), t("wrap-anywhere", [["overflow-wrap", "anywhere"]]), t("wrap-break-word", [["overflow-wrap", "break-word"]]), t("wrap-normal", [["overflow-wrap", "normal"]]);
    for (let [i, c] of [["rounded", ["border-radius"]], ["rounded-s", ["border-start-start-radius", "border-end-start-radius"]], ["rounded-e", ["border-start-end-radius", "border-end-end-radius"]], ["rounded-t", ["border-top-left-radius", "border-top-right-radius"]], ["rounded-r", ["border-top-right-radius", "border-bottom-right-radius"]], ["rounded-b", ["border-bottom-right-radius", "border-bottom-left-radius"]], ["rounded-l", ["border-top-left-radius", "border-bottom-left-radius"]], ["rounded-ss", ["border-start-start-radius"]], ["rounded-se", ["border-start-end-radius"]], ["rounded-ee", ["border-end-end-radius"]], ["rounded-es", ["border-end-start-radius"]], ["rounded-tl", ["border-top-left-radius"]], ["rounded-tr", ["border-top-right-radius"]], ["rounded-br", ["border-bottom-right-radius"]], ["rounded-bl", ["border-bottom-left-radius"]]]) l(i, { themeKeys: ["--radius"], handle: (g) => c.map((A) => n(A, g)), staticValues: { none: c.map((g) => n(g, "0")), full: c.map((g) => n(g, "calc(infinity * 1px)")) } });
    t("border-solid", [["--tw-border-style", "solid"], ["border-style", "solid"]]), t("border-dashed", [["--tw-border-style", "dashed"], ["border-style", "dashed"]]), t("border-dotted", [["--tw-border-style", "dotted"], ["border-style", "dotted"]]), t("border-double", [["--tw-border-style", "double"], ["border-style", "double"]]), t("border-hidden", [["--tw-border-style", "hidden"], ["border-style", "hidden"]]), t("border-none", [["--tw-border-style", "none"], ["border-style", "none"]]);
    {
      let c = function(g, A) {
        r.functional(g, (w) => {
          if (!w.value) {
            if (w.modifier) return;
            let T = e.get(["--default-border-width"]) ?? "1px", P = A.width(T);
            return P ? [i(), ...P] : void 0;
          }
          if (w.value.kind === "arbitrary") {
            let T = w.value.value;
            switch (w.value.dataType ?? J(T, ["color", "line-width", "length"])) {
              case "line-width":
              case "length": {
                if (w.modifier) return;
                let $ = A.width(T);
                return $ ? [i(), ...$] : void 0;
              }
              default:
                return T = ee(T, w.modifier, e), T === null ? void 0 : A.color(T);
            }
          }
          {
            let T = oe(w, e, ["--border-color", "--color"]);
            if (T) return A.color(T);
          }
          {
            if (w.modifier) return;
            let T = e.resolve(w.value.value, ["--border-width"]);
            if (T) {
              let P = A.width(T);
              return P ? [i(), ...P] : void 0;
            }
            if (V(w.value.value)) {
              let P = A.width(`${w.value.value}px`);
              return P ? [i(), ...P] : void 0;
            }
          }
        }), o(g, () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--border-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (w, T) => `${T * 5}`), hasDefaultValue: true }, { values: ["0", "2", "4", "8"], valueThemeKeys: ["--border-width"] }]);
      };
      var E = c;
      let i = () => F([N("--tw-border-style", "solid")]);
      c("border", { width: (g) => [n("border-style", "var(--tw-border-style)"), n("border-width", g)], color: (g) => [n("border-color", g)] }), c("border-x", { width: (g) => [n("border-inline-style", "var(--tw-border-style)"), n("border-inline-width", g)], color: (g) => [n("border-inline-color", g)] }), c("border-y", { width: (g) => [n("border-block-style", "var(--tw-border-style)"), n("border-block-width", g)], color: (g) => [n("border-block-color", g)] }), c("border-s", { width: (g) => [n("border-inline-start-style", "var(--tw-border-style)"), n("border-inline-start-width", g)], color: (g) => [n("border-inline-start-color", g)] }), c("border-e", { width: (g) => [n("border-inline-end-style", "var(--tw-border-style)"), n("border-inline-end-width", g)], color: (g) => [n("border-inline-end-color", g)] }), c("border-bs", { width: (g) => [n("border-block-start-style", "var(--tw-border-style)"), n("border-block-start-width", g)], color: (g) => [n("border-block-start-color", g)] }), c("border-be", { width: (g) => [n("border-block-end-style", "var(--tw-border-style)"), n("border-block-end-width", g)], color: (g) => [n("border-block-end-color", g)] }), c("border-t", { width: (g) => [n("border-top-style", "var(--tw-border-style)"), n("border-top-width", g)], color: (g) => [n("border-top-color", g)] }), c("border-r", { width: (g) => [n("border-right-style", "var(--tw-border-style)"), n("border-right-width", g)], color: (g) => [n("border-right-color", g)] }), c("border-b", { width: (g) => [n("border-bottom-style", "var(--tw-border-style)"), n("border-bottom-width", g)], color: (g) => [n("border-bottom-color", g)] }), c("border-l", { width: (g) => [n("border-left-style", "var(--tw-border-style)"), n("border-left-width", g)], color: (g) => [n("border-left-color", g)] }), l("divide-x", { defaultValue: e.get(["--default-border-width"]) ?? "1px", themeKeys: ["--divide-width", "--border-width"], handleBareValue: ({ value: g }) => V(g) ? `${g}px` : null, handle: (g) => [F([N("--tw-divide-x-reverse", "0")]), G(":where(& > :not(:last-child))", [n("--tw-sort", "divide-x-width"), i(), n("--tw-divide-x-reverse", "0"), n("border-inline-style", "var(--tw-border-style)"), n("border-inline-start-width", `calc(${g} * var(--tw-divide-x-reverse))`), n("border-inline-end-width", `calc(${g} * calc(1 - var(--tw-divide-x-reverse)))`)])] }), l("divide-y", { defaultValue: e.get(["--default-border-width"]) ?? "1px", themeKeys: ["--divide-width", "--border-width"], handleBareValue: ({ value: g }) => V(g) ? `${g}px` : null, handle: (g) => [F([N("--tw-divide-y-reverse", "0")]), G(":where(& > :not(:last-child))", [n("--tw-sort", "divide-y-width"), i(), n("--tw-divide-y-reverse", "0"), n("border-bottom-style", "var(--tw-border-style)"), n("border-top-style", "var(--tw-border-style)"), n("border-top-width", `calc(${g} * var(--tw-divide-y-reverse))`), n("border-bottom-width", `calc(${g} * calc(1 - var(--tw-divide-y-reverse)))`)])] }), o("divide-x", () => [{ values: ["0", "2", "4", "8"], valueThemeKeys: ["--divide-width", "--border-width"], hasDefaultValue: true }]), o("divide-y", () => [{ values: ["0", "2", "4", "8"], valueThemeKeys: ["--divide-width", "--border-width"], hasDefaultValue: true }]), t("divide-x-reverse", [() => F([N("--tw-divide-x-reverse", "0")]), () => G(":where(& > :not(:last-child))", [n("--tw-divide-x-reverse", "1")])]), t("divide-y-reverse", [() => F([N("--tw-divide-y-reverse", "0")]), () => G(":where(& > :not(:last-child))", [n("--tw-divide-y-reverse", "1")])]);
      for (let g of ["solid", "dashed", "dotted", "double", "none"]) t(`divide-${g}`, [() => G(":where(& > :not(:last-child))", [n("--tw-sort", "divide-style"), n("--tw-border-style", g), n("border-style", g)])]);
    }
    t("bg-auto", [["background-size", "auto"]]), t("bg-cover", [["background-size", "cover"]]), t("bg-contain", [["background-size", "contain"]]), l("bg-size", { handle(i) {
      if (i) return [n("background-size", i)];
    } }), t("bg-fixed", [["background-attachment", "fixed"]]), t("bg-local", [["background-attachment", "local"]]), t("bg-scroll", [["background-attachment", "scroll"]]), t("bg-top", [["background-position", "top"]]), t("bg-top-left", [["background-position", "left top"]]), t("bg-top-right", [["background-position", "right top"]]), t("bg-bottom", [["background-position", "bottom"]]), t("bg-bottom-left", [["background-position", "left bottom"]]), t("bg-bottom-right", [["background-position", "right bottom"]]), t("bg-left", [["background-position", "left"]]), t("bg-right", [["background-position", "right"]]), t("bg-center", [["background-position", "center"]]), l("bg-position", { handle(i) {
      if (i) return [n("background-position", i)];
    } }), t("bg-repeat", [["background-repeat", "repeat"]]), t("bg-no-repeat", [["background-repeat", "no-repeat"]]), t("bg-repeat-x", [["background-repeat", "repeat-x"]]), t("bg-repeat-y", [["background-repeat", "repeat-y"]]), t("bg-repeat-round", [["background-repeat", "round"]]), t("bg-repeat-space", [["background-repeat", "space"]]), t("bg-none", [["background-image", "none"]]);
    {
      let g = function(T) {
        let P = "in oklab";
        if (T?.kind === "named") switch (T.value) {
          case "longer":
          case "shorter":
          case "increasing":
          case "decreasing":
            P = `in oklch ${T.value} hue`;
            break;
          default:
            P = `in ${T.value}`;
        }
        else T?.kind === "arbitrary" && (P = T.value);
        return P;
      }, A = function({ negative: T }) {
        return (P) => {
          if (!P.value) return;
          if (P.value.kind === "arbitrary") {
            if (P.modifier) return;
            let I = P.value.value;
            return (P.value.dataType ?? J(I, ["angle"])) === "angle" ? (I = T ? `calc(${I} * -1)` : `${I}`, [n("--tw-gradient-position", I), n("background-image", `linear-gradient(var(--tw-gradient-stops,${I}))`)]) : T ? void 0 : [n("--tw-gradient-position", I), n("background-image", `linear-gradient(var(--tw-gradient-stops,${I}))`)];
          }
          let $ = P.value.value;
          if (!T && c.has($)) $ = c.get($);
          else if (V($)) $ = T ? `calc(${$}deg * -1)` : `${$}deg`;
          else return;
          let S = g(P.modifier);
          return [n("--tw-gradient-position", `${$}`), Z("@supports (background-image: linear-gradient(in lab, red, red))", [n("--tw-gradient-position", `${$} ${S}`)]), n("background-image", "linear-gradient(var(--tw-gradient-stops))")];
        };
      }, w = function({ negative: T }) {
        return (P) => {
          if (P.value?.kind === "arbitrary") {
            if (P.modifier) return;
            let I = P.value.value;
            return [n("--tw-gradient-position", I), n("background-image", `conic-gradient(var(--tw-gradient-stops,${I}))`)];
          }
          let $ = g(P.modifier);
          if (!P.value) return [n("--tw-gradient-position", $), n("background-image", "conic-gradient(var(--tw-gradient-stops))")];
          let S = P.value.value;
          if (V(S)) return S = T ? `calc(${S}deg * -1)` : `${S}deg`, [n("--tw-gradient-position", `from ${S} ${$}`), n("background-image", "conic-gradient(var(--tw-gradient-stops))")];
        };
      };
      var U = g, B = A, W = w;
      let i = ["oklab", "oklch", "srgb", "hsl", "longer", "shorter", "increasing", "decreasing"], c = /* @__PURE__ */ new Map([["to-t", "to top"], ["to-tr", "to top right"], ["to-r", "to right"], ["to-br", "to bottom right"], ["to-b", "to bottom"], ["to-bl", "to bottom left"], ["to-l", "to left"], ["to-tl", "to top left"]]);
      r.functional("-bg-linear", A({ negative: true })), r.functional("bg-linear", A({ negative: false })), o("bg-linear", () => [{ values: [...c.keys()], modifiers: i }, { values: ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"], supportsNegative: true, modifiers: i }]), r.functional("-bg-conic", w({ negative: true })), r.functional("bg-conic", w({ negative: false })), o("bg-conic", () => [{ hasDefaultValue: true, modifiers: i }, { values: ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"], supportsNegative: true, modifiers: i }]), r.functional("bg-radial", (T) => {
        if (!T.value) {
          let P = g(T.modifier);
          return [n("--tw-gradient-position", P), n("background-image", "radial-gradient(var(--tw-gradient-stops))")];
        }
        if (T.value.kind === "arbitrary") {
          if (T.modifier) return;
          let P = T.value.value;
          return [n("--tw-gradient-position", P), n("background-image", `radial-gradient(var(--tw-gradient-stops,${P}))`)];
        }
      }), o("bg-radial", () => [{ hasDefaultValue: true, modifiers: i }]);
    }
    r.functional("bg", (i) => {
      if (i.value) {
        if (i.value.kind === "arbitrary") {
          let c = i.value.value;
          switch (i.value.dataType ?? J(c, ["image", "color", "percentage", "position", "bg-size", "length", "url"])) {
            case "percentage":
            case "position":
              return i.modifier ? void 0 : [n("background-position", c)];
            case "bg-size":
            case "length":
            case "size":
              return i.modifier ? void 0 : [n("background-size", c)];
            case "image":
            case "url":
              return i.modifier ? void 0 : [n("background-image", c)];
            default:
              return c = ee(c, i.modifier, e), c === null ? void 0 : [n("background-color", c)];
          }
        }
        {
          let c = oe(i, e, ["--background-color", "--color"]);
          if (c) return [n("background-color", c)];
        }
        {
          if (i.modifier) return;
          let c = e.resolve(i.value.value, ["--background-image"]);
          if (c) return [n("background-image", c)];
        }
      }
    }), o("bg", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--background-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: [], valueThemeKeys: ["--background-image"] }]);
    let k = () => F([N("--tw-gradient-position"), N("--tw-gradient-from", "#0000", "<color>"), N("--tw-gradient-via", "#0000", "<color>"), N("--tw-gradient-to", "#0000", "<color>"), N("--tw-gradient-stops"), N("--tw-gradient-via-stops"), N("--tw-gradient-from-position", "0%", "<length-percentage>"), N("--tw-gradient-via-position", "50%", "<length-percentage>"), N("--tw-gradient-to-position", "100%", "<length-percentage>")]);
    function b(i, c) {
      r.functional(i, (g) => {
        if (g.value) {
          if (g.value.kind === "arbitrary") {
            let A = g.value.value;
            switch (g.value.dataType ?? J(A, ["color", "length", "percentage"])) {
              case "length":
              case "percentage":
                return g.modifier ? void 0 : c.position(A);
              default:
                return A = ee(A, g.modifier, e), A === null ? void 0 : c.color(A);
            }
          }
          {
            let A = oe(g, e, ["--background-color", "--color"]);
            if (A) return c.color(A);
          }
          {
            if (g.modifier) return;
            let A = e.resolve(g.value.value, ["--gradient-color-stop-positions"]);
            if (A) return c.position(A);
            if (g.value.value[g.value.value.length - 1] === "%" && V(g.value.value.slice(0, -1))) return c.position(g.value.value);
          }
        }
      }), o(i, () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--background-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (g, A) => `${A * 5}`) }, { values: Array.from({ length: 21 }, (g, A) => `${A * 5}%`), valueThemeKeys: ["--gradient-color-stop-positions"] }]);
    }
    b("from", { color: (i) => [k(), n("--tw-sort", "--tw-gradient-from"), n("--tw-gradient-from", i), n("--tw-gradient-stops", "var(--tw-gradient-via-stops, var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))")], position: (i) => [k(), n("--tw-gradient-from-position", i)] }), t("via-none", [["--tw-gradient-via-stops", "initial"]]), b("via", { color: (i) => [k(), n("--tw-sort", "--tw-gradient-via"), n("--tw-gradient-via", i), n("--tw-gradient-via-stops", "var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-via) var(--tw-gradient-via-position), var(--tw-gradient-to) var(--tw-gradient-to-position)"), n("--tw-gradient-stops", "var(--tw-gradient-via-stops)")], position: (i) => [k(), n("--tw-gradient-via-position", i)] }), b("to", { color: (i) => [k(), n("--tw-sort", "--tw-gradient-to"), n("--tw-gradient-to", i), n("--tw-gradient-stops", "var(--tw-gradient-via-stops, var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))")], position: (i) => [k(), n("--tw-gradient-to-position", i)] }), t("mask-none", [["mask-image", "none"]]), r.functional("mask", (i) => {
      if (!i.value || i.modifier || i.value.kind !== "arbitrary") return;
      let c = i.value.value;
      switch (i.value.dataType ?? J(c, ["image", "percentage", "position", "bg-size", "length", "url"])) {
        case "percentage":
        case "position":
          return i.modifier ? void 0 : [n("mask-position", c)];
        case "bg-size":
        case "length":
        case "size":
          return [n("mask-size", c)];
        default:
          return [n("mask-image", c)];
      }
    }), t("mask-add", [["mask-composite", "add"]]), t("mask-subtract", [["mask-composite", "subtract"]]), t("mask-intersect", [["mask-composite", "intersect"]]), t("mask-exclude", [["mask-composite", "exclude"]]), t("mask-alpha", [["mask-mode", "alpha"]]), t("mask-luminance", [["mask-mode", "luminance"]]), t("mask-match", [["mask-mode", "match-source"]]), t("mask-type-alpha", [["mask-type", "alpha"]]), t("mask-type-luminance", [["mask-type", "luminance"]]), t("mask-auto", [["mask-size", "auto"]]), t("mask-cover", [["mask-size", "cover"]]), t("mask-contain", [["mask-size", "contain"]]), l("mask-size", { handle(i) {
      if (i) return [n("mask-size", i)];
    } }), t("mask-top", [["mask-position", "top"]]), t("mask-top-left", [["mask-position", "left top"]]), t("mask-top-right", [["mask-position", "right top"]]), t("mask-bottom", [["mask-position", "bottom"]]), t("mask-bottom-left", [["mask-position", "left bottom"]]), t("mask-bottom-right", [["mask-position", "right bottom"]]), t("mask-left", [["mask-position", "left"]]), t("mask-right", [["mask-position", "right"]]), t("mask-center", [["mask-position", "center"]]), l("mask-position", { handle(i) {
      if (i) return [n("mask-position", i)];
    } }), t("mask-repeat", [["mask-repeat", "repeat"]]), t("mask-no-repeat", [["mask-repeat", "no-repeat"]]), t("mask-repeat-x", [["mask-repeat", "repeat-x"]]), t("mask-repeat-y", [["mask-repeat", "repeat-y"]]), t("mask-repeat-round", [["mask-repeat", "round"]]), t("mask-repeat-space", [["mask-repeat", "space"]]), t("mask-clip-border", [["mask-clip", "border-box"]]), t("mask-clip-padding", [["mask-clip", "padding-box"]]), t("mask-clip-content", [["mask-clip", "content-box"]]), t("mask-clip-fill", [["mask-clip", "fill-box"]]), t("mask-clip-stroke", [["mask-clip", "stroke-box"]]), t("mask-clip-view", [["mask-clip", "view-box"]]), t("mask-no-clip", [["mask-clip", "no-clip"]]), t("mask-origin-border", [["mask-origin", "border-box"]]), t("mask-origin-padding", [["mask-origin", "padding-box"]]), t("mask-origin-content", [["mask-origin", "content-box"]]), t("mask-origin-fill", [["mask-origin", "fill-box"]]), t("mask-origin-stroke", [["mask-origin", "stroke-box"]]), t("mask-origin-view", [["mask-origin", "view-box"]]);
    let x = () => F([N("--tw-mask-linear", "linear-gradient(#fff, #fff)"), N("--tw-mask-radial", "linear-gradient(#fff, #fff)"), N("--tw-mask-conic", "linear-gradient(#fff, #fff)")]);
    function O(i, c) {
      r.functional(i, (g) => {
        if (g.value) {
          if (g.value.kind === "arbitrary") {
            let A = g.value.value;
            switch (g.value.dataType ?? J(A, ["length", "percentage", "color"])) {
              case "color":
                return A = ee(A, g.modifier, e), A === null ? void 0 : c.color(A);
              case "percentage":
                return g.modifier || !V(A.slice(0, -1)) ? void 0 : c.position(A);
              default:
                return g.modifier ? void 0 : c.position(A);
            }
          }
          {
            let A = oe(g, e, ["--background-color", "--color"]);
            if (A) return c.color(A);
          }
          {
            if (g.modifier) return;
            let A = J(g.value.value, ["number", "percentage"]);
            if (!A) return;
            switch (A) {
              case "number":
                return !e.resolve(null, ["--spacing"]) || !le(g.value.value) ? void 0 : c.position(`--spacing(${g.value.value})`);
              case "percentage":
                return V(g.value.value.slice(0, -1)) ? c.position(g.value.value) : void 0;
              default:
                return;
            }
          }
        }
      }), o(i, () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--background-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (g, A) => `${A * 5}`) }, { values: Array.from({ length: 21 }, (g, A) => `${A * 5}%`), valueThemeKeys: ["--gradient-color-stop-positions"] }]), o(i, () => [{ values: Array.from({ length: 21 }, (g, A) => `${A * 5}%`) }, { values: e.get(["--spacing"]) ? pt : [] }, { values: ["current", "inherit", "transparent"], valueThemeKeys: ["--background-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (g, A) => `${A * 5}`) }]);
    }
    let C = () => F([N("--tw-mask-left", "linear-gradient(#fff, #fff)"), N("--tw-mask-right", "linear-gradient(#fff, #fff)"), N("--tw-mask-bottom", "linear-gradient(#fff, #fff)"), N("--tw-mask-top", "linear-gradient(#fff, #fff)")]);
    function y(i, c, g) {
      O(i, { color(A) {
        let w = [x(), C(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear", "var(--tw-mask-left), var(--tw-mask-right), var(--tw-mask-bottom), var(--tw-mask-top)")];
        for (let T of ["top", "right", "bottom", "left"]) g[T] && (w.push(n(`--tw-mask-${T}`, `linear-gradient(to ${T}, var(--tw-mask-${T}-from-color) var(--tw-mask-${T}-from-position), var(--tw-mask-${T}-to-color) var(--tw-mask-${T}-to-position))`)), w.push(F([N(`--tw-mask-${T}-from-position`, "0%"), N(`--tw-mask-${T}-to-position`, "100%"), N(`--tw-mask-${T}-from-color`, "black"), N(`--tw-mask-${T}-to-color`, "transparent")])), w.push(n(`--tw-mask-${T}-${c}-color`, A)));
        return w;
      }, position(A) {
        let w = [x(), C(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear", "var(--tw-mask-left), var(--tw-mask-right), var(--tw-mask-bottom), var(--tw-mask-top)")];
        for (let T of ["top", "right", "bottom", "left"]) g[T] && (w.push(n(`--tw-mask-${T}`, `linear-gradient(to ${T}, var(--tw-mask-${T}-from-color) var(--tw-mask-${T}-from-position), var(--tw-mask-${T}-to-color) var(--tw-mask-${T}-to-position))`)), w.push(F([N(`--tw-mask-${T}-from-position`, "0%"), N(`--tw-mask-${T}-to-position`, "100%"), N(`--tw-mask-${T}-from-color`, "black"), N(`--tw-mask-${T}-to-color`, "transparent")])), w.push(n(`--tw-mask-${T}-${c}-position`, A)));
        return w;
      } });
    }
    y("mask-x-from", "from", { top: false, right: true, bottom: false, left: true }), y("mask-x-to", "to", { top: false, right: true, bottom: false, left: true }), y("mask-y-from", "from", { top: true, right: false, bottom: true, left: false }), y("mask-y-to", "to", { top: true, right: false, bottom: true, left: false }), y("mask-t-from", "from", { top: true, right: false, bottom: false, left: false }), y("mask-t-to", "to", { top: true, right: false, bottom: false, left: false }), y("mask-r-from", "from", { top: false, right: true, bottom: false, left: false }), y("mask-r-to", "to", { top: false, right: true, bottom: false, left: false }), y("mask-b-from", "from", { top: false, right: false, bottom: true, left: false }), y("mask-b-to", "to", { top: false, right: false, bottom: true, left: false }), y("mask-l-from", "from", { top: false, right: false, bottom: false, left: true }), y("mask-l-to", "to", { top: false, right: false, bottom: false, left: true });
    let D = () => F([N("--tw-mask-linear-position", "0deg"), N("--tw-mask-linear-from-position", "0%"), N("--tw-mask-linear-to-position", "100%"), N("--tw-mask-linear-from-color", "black"), N("--tw-mask-linear-to-color", "transparent")]);
    l("mask-linear", { defaultValue: null, supportsNegative: true, supportsFractions: false, handleBareValue({ value: i }) {
      if (!V(i)) return null;
      let c = Number(i);
      return c === 0 ? "0deg" : c === 1 ? "1deg" : `calc(1deg * ${i})`;
    }, handleNegativeBareValue({ value: i }) {
      if (!V(i)) return null;
      let c = Number(i);
      return c === 0 ? "0deg" : c === 1 ? "-1deg" : `calc(1deg * -${i})`;
    }, handle: (i) => [x(), D(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear", "linear-gradient(var(--tw-mask-linear-stops, var(--tw-mask-linear-position)))"), n("--tw-mask-linear-position", i)] }), o("mask-linear", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12", "45", "90", "180"] }]), O("mask-linear-from", { color: (i) => [x(), D(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear-stops", "var(--tw-mask-linear-position), var(--tw-mask-linear-from-color) var(--tw-mask-linear-from-position), var(--tw-mask-linear-to-color) var(--tw-mask-linear-to-position)"), n("--tw-mask-linear", "linear-gradient(var(--tw-mask-linear-stops))"), n("--tw-mask-linear-from-color", i)], position: (i) => [x(), D(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear-stops", "var(--tw-mask-linear-position), var(--tw-mask-linear-from-color) var(--tw-mask-linear-from-position), var(--tw-mask-linear-to-color) var(--tw-mask-linear-to-position)"), n("--tw-mask-linear", "linear-gradient(var(--tw-mask-linear-stops))"), n("--tw-mask-linear-from-position", i)] }), O("mask-linear-to", { color: (i) => [x(), D(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear-stops", "var(--tw-mask-linear-position), var(--tw-mask-linear-from-color) var(--tw-mask-linear-from-position), var(--tw-mask-linear-to-color) var(--tw-mask-linear-to-position)"), n("--tw-mask-linear", "linear-gradient(var(--tw-mask-linear-stops))"), n("--tw-mask-linear-to-color", i)], position: (i) => [x(), D(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-linear-stops", "var(--tw-mask-linear-position), var(--tw-mask-linear-from-color) var(--tw-mask-linear-from-position), var(--tw-mask-linear-to-color) var(--tw-mask-linear-to-position)"), n("--tw-mask-linear", "linear-gradient(var(--tw-mask-linear-stops))"), n("--tw-mask-linear-to-position", i)] });
    let z = () => F([N("--tw-mask-radial-from-position", "0%"), N("--tw-mask-radial-to-position", "100%"), N("--tw-mask-radial-from-color", "black"), N("--tw-mask-radial-to-color", "transparent"), N("--tw-mask-radial-shape", "ellipse"), N("--tw-mask-radial-size", "farthest-corner"), N("--tw-mask-radial-position", "center")]);
    t("mask-circle", [["--tw-mask-radial-shape", "circle"]]), t("mask-ellipse", [["--tw-mask-radial-shape", "ellipse"]]), t("mask-radial-closest-side", [["--tw-mask-radial-size", "closest-side"]]), t("mask-radial-farthest-side", [["--tw-mask-radial-size", "farthest-side"]]), t("mask-radial-closest-corner", [["--tw-mask-radial-size", "closest-corner"]]), t("mask-radial-farthest-corner", [["--tw-mask-radial-size", "farthest-corner"]]), t("mask-radial-at-top", [["--tw-mask-radial-position", "top"]]), t("mask-radial-at-top-left", [["--tw-mask-radial-position", "top left"]]), t("mask-radial-at-top-right", [["--tw-mask-radial-position", "top right"]]), t("mask-radial-at-bottom", [["--tw-mask-radial-position", "bottom"]]), t("mask-radial-at-bottom-left", [["--tw-mask-radial-position", "bottom left"]]), t("mask-radial-at-bottom-right", [["--tw-mask-radial-position", "bottom right"]]), t("mask-radial-at-left", [["--tw-mask-radial-position", "left"]]), t("mask-radial-at-right", [["--tw-mask-radial-position", "right"]]), t("mask-radial-at-center", [["--tw-mask-radial-position", "center"]]), l("mask-radial-at", { defaultValue: null, supportsNegative: false, supportsFractions: false, handle: (i) => [n("--tw-mask-radial-position", i)] }), l("mask-radial", { defaultValue: null, supportsNegative: false, supportsFractions: false, handle: (i) => [x(), z(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-radial", "radial-gradient(var(--tw-mask-radial-stops, var(--tw-mask-radial-size)))"), n("--tw-mask-radial-size", i)] }), O("mask-radial-from", { color: (i) => [x(), z(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-radial-stops", "var(--tw-mask-radial-shape) var(--tw-mask-radial-size) at var(--tw-mask-radial-position), var(--tw-mask-radial-from-color) var(--tw-mask-radial-from-position), var(--tw-mask-radial-to-color) var(--tw-mask-radial-to-position)"), n("--tw-mask-radial", "radial-gradient(var(--tw-mask-radial-stops))"), n("--tw-mask-radial-from-color", i)], position: (i) => [x(), z(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-radial-stops", "var(--tw-mask-radial-shape) var(--tw-mask-radial-size) at var(--tw-mask-radial-position), var(--tw-mask-radial-from-color) var(--tw-mask-radial-from-position), var(--tw-mask-radial-to-color) var(--tw-mask-radial-to-position)"), n("--tw-mask-radial", "radial-gradient(var(--tw-mask-radial-stops))"), n("--tw-mask-radial-from-position", i)] }), O("mask-radial-to", { color: (i) => [x(), z(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-radial-stops", "var(--tw-mask-radial-shape) var(--tw-mask-radial-size) at var(--tw-mask-radial-position), var(--tw-mask-radial-from-color) var(--tw-mask-radial-from-position), var(--tw-mask-radial-to-color) var(--tw-mask-radial-to-position)"), n("--tw-mask-radial", "radial-gradient(var(--tw-mask-radial-stops))"), n("--tw-mask-radial-to-color", i)], position: (i) => [x(), z(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-radial-stops", "var(--tw-mask-radial-shape) var(--tw-mask-radial-size) at var(--tw-mask-radial-position), var(--tw-mask-radial-from-color) var(--tw-mask-radial-from-position), var(--tw-mask-radial-to-color) var(--tw-mask-radial-to-position)"), n("--tw-mask-radial", "radial-gradient(var(--tw-mask-radial-stops))"), n("--tw-mask-radial-to-position", i)] });
    let K = () => F([N("--tw-mask-conic-position", "0deg"), N("--tw-mask-conic-from-position", "0%"), N("--tw-mask-conic-to-position", "100%"), N("--tw-mask-conic-from-color", "black"), N("--tw-mask-conic-to-color", "transparent")]);
    l("mask-conic", { defaultValue: null, supportsNegative: true, supportsFractions: false, handleBareValue({ value: i }) {
      if (!V(i)) return null;
      let c = Number(i);
      return c === 0 ? "0deg" : c === 1 ? "1deg" : `calc(1deg * ${i})`;
    }, handleNegativeBareValue({ value: i }) {
      if (!V(i)) return null;
      let c = Number(i);
      return c === 0 ? "0deg" : c === 1 ? "-1deg" : `calc(1deg * -${i})`;
    }, handle: (i) => [x(), K(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-conic", "conic-gradient(var(--tw-mask-conic-stops, var(--tw-mask-conic-position)))"), n("--tw-mask-conic-position", i)] }), o("mask-conic", () => [{ supportsNegative: true, values: ["0", "1", "2", "3", "6", "12", "45", "90", "180"] }]), O("mask-conic-from", { color: (i) => [x(), K(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-conic-stops", "from var(--tw-mask-conic-position), var(--tw-mask-conic-from-color) var(--tw-mask-conic-from-position), var(--tw-mask-conic-to-color) var(--tw-mask-conic-to-position)"), n("--tw-mask-conic", "conic-gradient(var(--tw-mask-conic-stops))"), n("--tw-mask-conic-from-color", i)], position: (i) => [x(), K(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-conic-stops", "from var(--tw-mask-conic-position), var(--tw-mask-conic-from-color) var(--tw-mask-conic-from-position), var(--tw-mask-conic-to-color) var(--tw-mask-conic-to-position)"), n("--tw-mask-conic", "conic-gradient(var(--tw-mask-conic-stops))"), n("--tw-mask-conic-from-position", i)] }), O("mask-conic-to", { color: (i) => [x(), K(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-conic-stops", "from var(--tw-mask-conic-position), var(--tw-mask-conic-from-color) var(--tw-mask-conic-from-position), var(--tw-mask-conic-to-color) var(--tw-mask-conic-to-position)"), n("--tw-mask-conic", "conic-gradient(var(--tw-mask-conic-stops))"), n("--tw-mask-conic-to-color", i)], position: (i) => [x(), K(), n("mask-image", "var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic)"), n("mask-composite", "intersect"), n("--tw-mask-conic-stops", "from var(--tw-mask-conic-position), var(--tw-mask-conic-from-color) var(--tw-mask-conic-from-position), var(--tw-mask-conic-to-color) var(--tw-mask-conic-to-position)"), n("--tw-mask-conic", "conic-gradient(var(--tw-mask-conic-stops))"), n("--tw-mask-conic-to-position", i)] }), t("box-decoration-slice", [["-webkit-box-decoration-break", "slice"], ["box-decoration-break", "slice"]]), t("box-decoration-clone", [["-webkit-box-decoration-break", "clone"], ["box-decoration-break", "clone"]]), t("bg-clip-text", [["background-clip", "text"]]), t("bg-clip-border", [["background-clip", "border-box"]]), t("bg-clip-padding", [["background-clip", "padding-box"]]), t("bg-clip-content", [["background-clip", "content-box"]]), t("bg-origin-border", [["background-origin", "border-box"]]), t("bg-origin-padding", [["background-origin", "padding-box"]]), t("bg-origin-content", [["background-origin", "content-box"]]);
    for (let i of ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]) t(`bg-blend-${i}`, [["background-blend-mode", i]]), t(`mix-blend-${i}`, [["mix-blend-mode", i]]);
    t("mix-blend-plus-darker", [["mix-blend-mode", "plus-darker"]]), t("mix-blend-plus-lighter", [["mix-blend-mode", "plus-lighter"]]), t("fill-none", [["fill", "none"]]), r.functional("fill", (i) => {
      if (!i.value) return;
      if (i.value.kind === "arbitrary") {
        let g = ee(i.value.value, i.modifier, e);
        return g === null ? void 0 : [n("fill", g)];
      }
      let c = oe(i, e, ["--fill", "--color"]);
      if (c) return [n("fill", c)];
    }), o("fill", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--fill", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }]), t("stroke-none", [["stroke", "none"]]), r.functional("stroke", (i) => {
      if (i.value) {
        if (i.value.kind === "arbitrary") {
          let c = i.value.value;
          switch (i.value.dataType ?? J(c, ["color", "number", "length", "percentage"])) {
            case "number":
            case "length":
            case "percentage":
              return i.modifier ? void 0 : [n("stroke-width", c)];
            default:
              return c = ee(i.value.value, i.modifier, e), c === null ? void 0 : [n("stroke", c)];
          }
        }
        {
          let c = oe(i, e, ["--stroke", "--color"]);
          if (c) return [n("stroke", c)];
        }
        {
          let c = e.resolve(i.value.value, ["--stroke-width"]);
          if (c) return [n("stroke-width", c)];
          if (V(i.value.value)) return [n("stroke-width", i.value.value)];
        }
      }
    }), o("stroke", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--stroke", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: ["0", "1", "2", "3"], valueThemeKeys: ["--stroke-width"] }]), t("object-contain", [["object-fit", "contain"]]), t("object-cover", [["object-fit", "cover"]]), t("object-fill", [["object-fit", "fill"]]), t("object-none", [["object-fit", "none"]]), t("object-scale-down", [["object-fit", "scale-down"]]), l("object", { themeKeys: ["--object-position"], handle: (i) => [n("object-position", i)], staticValues: { top: [n("object-position", "top")], "top-left": [n("object-position", "left top")], "top-right": [n("object-position", "right top")], bottom: [n("object-position", "bottom")], "bottom-left": [n("object-position", "left bottom")], "bottom-right": [n("object-position", "right bottom")], left: [n("object-position", "left")], right: [n("object-position", "right")], center: [n("object-position", "center")] } });
    for (let [i, c] of [["p", "padding"], ["px", "padding-inline"], ["py", "padding-block"], ["ps", "padding-inline-start"], ["pe", "padding-inline-end"], ["pbs", "padding-block-start"], ["pbe", "padding-block-end"], ["pt", "padding-top"], ["pr", "padding-right"], ["pb", "padding-bottom"], ["pl", "padding-left"]]) a(i, ["--padding", "--spacing"], (g) => [n(c, g)]);
    t("text-left", [["text-align", "left"]]), t("text-center", [["text-align", "center"]]), t("text-right", [["text-align", "right"]]), t("text-justify", [["text-align", "justify"]]), t("text-start", [["text-align", "start"]]), t("text-end", [["text-align", "end"]]), a("indent", ["--text-indent", "--spacing"], (i) => [n("text-indent", i)], { supportsNegative: true }), t("align-baseline", [["vertical-align", "baseline"]]), t("align-top", [["vertical-align", "top"]]), t("align-middle", [["vertical-align", "middle"]]), t("align-bottom", [["vertical-align", "bottom"]]), t("align-text-top", [["vertical-align", "text-top"]]), t("align-text-bottom", [["vertical-align", "text-bottom"]]), t("align-sub", [["vertical-align", "sub"]]), t("align-super", [["vertical-align", "super"]]), l("align", { themeKeys: [], handle: (i) => [n("vertical-align", i)] }), r.functional("font", (i) => {
      if (!(!i.value || i.modifier)) {
        if (i.value.kind === "arbitrary") {
          let c = i.value.value;
          switch (i.value.dataType ?? J(c, ["number", "generic-name", "family-name"])) {
            case "generic-name":
            case "family-name":
              return [n("font-family", c)];
            default:
              return [F([N("--tw-font-weight")]), n("--tw-font-weight", c), n("font-weight", c)];
          }
        }
        {
          let c = e.resolveWith(i.value.value, ["--font"], ["--font-feature-settings", "--font-variation-settings"]);
          if (c) {
            let [g, A = {}] = c;
            return [n("font-family", g), n("font-feature-settings", A["--font-feature-settings"]), n("font-variation-settings", A["--font-variation-settings"])];
          }
        }
        {
          let c = e.resolve(i.value.value, ["--font-weight"]);
          if (c) return [F([N("--tw-font-weight")]), n("--tw-font-weight", c), n("font-weight", c)];
        }
      }
    }), o("font", () => [{ values: [], valueThemeKeys: ["--font"] }, { values: [], valueThemeKeys: ["--font-weight"] }]), l("font-features", { themeKeys: [], handle: (i) => [n("font-feature-settings", i)] }), t("uppercase", [["text-transform", "uppercase"]]), t("lowercase", [["text-transform", "lowercase"]]), t("capitalize", [["text-transform", "capitalize"]]), t("normal-case", [["text-transform", "none"]]), t("italic", [["font-style", "italic"]]), t("not-italic", [["font-style", "normal"]]), t("underline", [["text-decoration-line", "underline"]]), t("overline", [["text-decoration-line", "overline"]]), t("line-through", [["text-decoration-line", "line-through"]]), t("no-underline", [["text-decoration-line", "none"]]), t("font-stretch-normal", [["font-stretch", "normal"]]), t("font-stretch-ultra-condensed", [["font-stretch", "ultra-condensed"]]), t("font-stretch-extra-condensed", [["font-stretch", "extra-condensed"]]), t("font-stretch-condensed", [["font-stretch", "condensed"]]), t("font-stretch-semi-condensed", [["font-stretch", "semi-condensed"]]), t("font-stretch-semi-expanded", [["font-stretch", "semi-expanded"]]), t("font-stretch-expanded", [["font-stretch", "expanded"]]), t("font-stretch-extra-expanded", [["font-stretch", "extra-expanded"]]), t("font-stretch-ultra-expanded", [["font-stretch", "ultra-expanded"]]), l("font-stretch", { handleBareValue: ({ value: i }) => {
      if (!i.endsWith("%")) return null;
      let c = Number(i.slice(0, -1));
      return !V(c) || Number.isNaN(c) || c < 50 || c > 200 ? null : i;
    }, handle: (i) => [n("font-stretch", i)] }), o("font-stretch", () => [{ values: ["50%", "75%", "90%", "95%", "100%", "105%", "110%", "125%", "150%", "200%"] }]), s("placeholder", { themeKeys: ["--placeholder-color", "--color"], handle: (i) => [G("&::placeholder", [n("--tw-sort", "placeholder-color"), n("color", i)])] }), t("decoration-solid", [["text-decoration-style", "solid"]]), t("decoration-double", [["text-decoration-style", "double"]]), t("decoration-dotted", [["text-decoration-style", "dotted"]]), t("decoration-dashed", [["text-decoration-style", "dashed"]]), t("decoration-wavy", [["text-decoration-style", "wavy"]]), t("decoration-auto", [["text-decoration-thickness", "auto"]]), t("decoration-from-font", [["text-decoration-thickness", "from-font"]]), r.functional("decoration", (i) => {
      if (i.value) {
        if (i.value.kind === "arbitrary") {
          let c = i.value.value;
          switch (i.value.dataType ?? J(c, ["color", "length", "percentage"])) {
            case "length":
            case "percentage":
              return i.modifier ? void 0 : [n("text-decoration-thickness", c)];
            default:
              return c = ee(c, i.modifier, e), c === null ? void 0 : [n("text-decoration-color", c)];
          }
        }
        {
          let c = e.resolve(i.value.value, ["--text-decoration-thickness"]);
          if (c) return i.modifier ? void 0 : [n("text-decoration-thickness", c)];
          if (V(i.value.value)) return i.modifier ? void 0 : [n("text-decoration-thickness", `${i.value.value}px`)];
        }
        {
          let c = oe(i, e, ["--text-decoration-color", "--color"]);
          if (c) return [n("text-decoration-color", c)];
        }
      }
    }), o("decoration", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--text-decoration-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: ["0", "1", "2"], valueThemeKeys: ["--text-decoration-thickness"] }]), l("animate", { themeKeys: ["--animate"], handle: (i) => [n("animation", i)], staticValues: { none: [n("animation", "none")] } });
    {
      let i = ["var(--tw-blur,)", "var(--tw-brightness,)", "var(--tw-contrast,)", "var(--tw-grayscale,)", "var(--tw-hue-rotate,)", "var(--tw-invert,)", "var(--tw-saturate,)", "var(--tw-sepia,)", "var(--tw-drop-shadow,)"].join(" "), c = ["var(--tw-backdrop-blur,)", "var(--tw-backdrop-brightness,)", "var(--tw-backdrop-contrast,)", "var(--tw-backdrop-grayscale,)", "var(--tw-backdrop-hue-rotate,)", "var(--tw-backdrop-invert,)", "var(--tw-backdrop-opacity,)", "var(--tw-backdrop-saturate,)", "var(--tw-backdrop-sepia,)"].join(" "), g = () => F([N("--tw-blur"), N("--tw-brightness"), N("--tw-contrast"), N("--tw-grayscale"), N("--tw-hue-rotate"), N("--tw-invert"), N("--tw-opacity"), N("--tw-saturate"), N("--tw-sepia"), N("--tw-drop-shadow"), N("--tw-drop-shadow-color"), N("--tw-drop-shadow-alpha", "100%", "<percentage>"), N("--tw-drop-shadow-size")]), A = () => F([N("--tw-backdrop-blur"), N("--tw-backdrop-brightness"), N("--tw-backdrop-contrast"), N("--tw-backdrop-grayscale"), N("--tw-backdrop-hue-rotate"), N("--tw-backdrop-invert"), N("--tw-backdrop-opacity"), N("--tw-backdrop-saturate"), N("--tw-backdrop-sepia")]);
      r.functional("filter", (w) => {
        if (!w.modifier) {
          if (w.value === null) return [g(), n("filter", i)];
          if (w.value.kind === "arbitrary") return [n("filter", w.value.value)];
          if (w.value.value === "none") return [n("filter", "none")];
        }
      }), r.functional("backdrop-filter", (w) => {
        if (!w.modifier) {
          if (w.value === null) return [A(), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)];
          if (w.value.kind === "arbitrary") return [n("-webkit-backdrop-filter", w.value.value), n("backdrop-filter", w.value.value)];
          if (w.value.value === "none") return [n("-webkit-backdrop-filter", "none"), n("backdrop-filter", "none")];
        }
      }), l("blur", { themeKeys: ["--blur"], handle: (w) => [g(), n("--tw-blur", `blur(${w})`), n("filter", i)], staticValues: { none: [g(), n("--tw-blur", " "), n("filter", i)] } }), l("backdrop-blur", { themeKeys: ["--backdrop-blur", "--blur"], handle: (w) => [A(), n("--tw-backdrop-blur", `blur(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)], staticValues: { none: [A(), n("--tw-backdrop-blur", " "), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] } }), l("brightness", { themeKeys: ["--brightness"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [g(), n("--tw-brightness", `brightness(${w})`), n("filter", i)] }), l("backdrop-brightness", { themeKeys: ["--backdrop-brightness", "--brightness"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [A(), n("--tw-backdrop-brightness", `brightness(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("brightness", () => [{ values: ["0", "50", "75", "90", "95", "100", "105", "110", "125", "150", "200"], valueThemeKeys: ["--brightness"] }]), o("backdrop-brightness", () => [{ values: ["0", "50", "75", "90", "95", "100", "105", "110", "125", "150", "200"], valueThemeKeys: ["--backdrop-brightness", "--brightness"] }]), l("contrast", { themeKeys: ["--contrast"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [g(), n("--tw-contrast", `contrast(${w})`), n("filter", i)] }), l("backdrop-contrast", { themeKeys: ["--backdrop-contrast", "--contrast"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [A(), n("--tw-backdrop-contrast", `contrast(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("contrast", () => [{ values: ["0", "50", "75", "100", "125", "150", "200"], valueThemeKeys: ["--contrast"] }]), o("backdrop-contrast", () => [{ values: ["0", "50", "75", "100", "125", "150", "200"], valueThemeKeys: ["--backdrop-contrast", "--contrast"] }]), l("grayscale", { themeKeys: ["--grayscale"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [g(), n("--tw-grayscale", `grayscale(${w})`), n("filter", i)] }), l("backdrop-grayscale", { themeKeys: ["--backdrop-grayscale", "--grayscale"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [A(), n("--tw-backdrop-grayscale", `grayscale(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("grayscale", () => [{ values: ["0", "25", "50", "75", "100"], valueThemeKeys: ["--grayscale"], hasDefaultValue: true }]), o("backdrop-grayscale", () => [{ values: ["0", "25", "50", "75", "100"], valueThemeKeys: ["--backdrop-grayscale", "--grayscale"], hasDefaultValue: true }]), l("hue-rotate", { supportsNegative: true, themeKeys: ["--hue-rotate"], handleBareValue: ({ value: w }) => V(w) ? `${w}deg` : null, handle: (w) => [g(), n("--tw-hue-rotate", `hue-rotate(${w})`), n("filter", i)] }), l("backdrop-hue-rotate", { supportsNegative: true, themeKeys: ["--backdrop-hue-rotate", "--hue-rotate"], handleBareValue: ({ value: w }) => V(w) ? `${w}deg` : null, handle: (w) => [A(), n("--tw-backdrop-hue-rotate", `hue-rotate(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("hue-rotate", () => [{ values: ["0", "15", "30", "60", "90", "180"], valueThemeKeys: ["--hue-rotate"] }]), o("backdrop-hue-rotate", () => [{ values: ["0", "15", "30", "60", "90", "180"], valueThemeKeys: ["--backdrop-hue-rotate", "--hue-rotate"] }]), l("invert", { themeKeys: ["--invert"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [g(), n("--tw-invert", `invert(${w})`), n("filter", i)] }), l("backdrop-invert", { themeKeys: ["--backdrop-invert", "--invert"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [A(), n("--tw-backdrop-invert", `invert(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("invert", () => [{ values: ["0", "25", "50", "75", "100"], valueThemeKeys: ["--invert"], hasDefaultValue: true }]), o("backdrop-invert", () => [{ values: ["0", "25", "50", "75", "100"], valueThemeKeys: ["--backdrop-invert", "--invert"], hasDefaultValue: true }]), l("saturate", { themeKeys: ["--saturate"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [g(), n("--tw-saturate", `saturate(${w})`), n("filter", i)] }), l("backdrop-saturate", { themeKeys: ["--backdrop-saturate", "--saturate"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, handle: (w) => [A(), n("--tw-backdrop-saturate", `saturate(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("saturate", () => [{ values: ["0", "50", "100", "150", "200"], valueThemeKeys: ["--saturate"] }]), o("backdrop-saturate", () => [{ values: ["0", "50", "100", "150", "200"], valueThemeKeys: ["--backdrop-saturate", "--saturate"] }]), l("sepia", { themeKeys: ["--sepia"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [g(), n("--tw-sepia", `sepia(${w})`), n("filter", i)] }), l("backdrop-sepia", { themeKeys: ["--backdrop-sepia", "--sepia"], handleBareValue: ({ value: w }) => V(w) ? `${w}%` : null, defaultValue: "100%", handle: (w) => [A(), n("--tw-backdrop-sepia", `sepia(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("sepia", () => [{ values: ["0", "50", "100"], valueThemeKeys: ["--sepia"], hasDefaultValue: true }]), o("backdrop-sepia", () => [{ values: ["0", "50", "100"], valueThemeKeys: ["--backdrop-sepia", "--sepia"], hasDefaultValue: true }]), t("drop-shadow-none", [g, ["--tw-drop-shadow", " "], ["filter", i]]), r.functional("drop-shadow", (w) => {
        let T;
        if (w.modifier && (w.modifier.kind === "arbitrary" ? T = w.modifier.value : V(w.modifier.value) && (T = `${w.modifier.value}%`)), !w.value) {
          let P = e.get(["--drop-shadow"]), $ = e.resolve(null, ["--drop-shadow"]);
          return P === null || $ === null ? void 0 : [g(), n("--tw-drop-shadow-alpha", T), ...ut("--tw-drop-shadow-size", P, T, (S) => `var(--tw-drop-shadow-color, ${S})`), n("--tw-drop-shadow", L($, ",").map((S) => `drop-shadow(${S})`).join(" ")), n("filter", i)];
        }
        if (w.value.kind === "arbitrary") {
          let P = w.value.value;
          return (w.value.dataType ?? J(P, ["color"])) === "color" ? (P = ee(P, w.modifier, e), P === null ? void 0 : [g(), n("--tw-drop-shadow-color", Q(P, "var(--tw-drop-shadow-alpha)")), n("--tw-drop-shadow", "var(--tw-drop-shadow-size)")]) : w.modifier && !T ? void 0 : [g(), n("--tw-drop-shadow-alpha", T), ...ut("--tw-drop-shadow-size", P, T, (S) => `var(--tw-drop-shadow-color, ${S})`), n("--tw-drop-shadow", "var(--tw-drop-shadow-size)"), n("filter", i)];
        }
        {
          let P = e.get([`--drop-shadow-${w.value.value}`]), $ = e.resolve(w.value.value, ["--drop-shadow"]);
          if (P && $) return w.modifier && !T ? void 0 : T ? [g(), n("--tw-drop-shadow-alpha", T), ...ut("--tw-drop-shadow-size", P, T, (S) => `var(--tw-drop-shadow-color, ${S})`), n("--tw-drop-shadow", "var(--tw-drop-shadow-size)"), n("filter", i)] : [g(), n("--tw-drop-shadow-alpha", T), ...ut("--tw-drop-shadow-size", P, T, (S) => `var(--tw-drop-shadow-color, ${S})`), n("--tw-drop-shadow", L($, ",").map((S) => `drop-shadow(${S})`).join(" ")), n("filter", i)];
        }
        {
          let P = oe(w, e, ["--drop-shadow-color", "--color"]);
          if (P) return P === "inherit" ? [g(), n("--tw-drop-shadow-color", "inherit"), n("--tw-drop-shadow", "var(--tw-drop-shadow-size)")] : [g(), n("--tw-drop-shadow-color", Q(P, "var(--tw-drop-shadow-alpha)")), n("--tw-drop-shadow", "var(--tw-drop-shadow-size)")];
        }
      }), o("drop-shadow", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--drop-shadow-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (w, T) => `${T * 5}`) }, { valueThemeKeys: ["--drop-shadow"] }]), l("backdrop-opacity", { themeKeys: ["--backdrop-opacity", "--opacity"], handleBareValue: ({ value: w }) => st(w) ? `${w}%` : null, handle: (w) => [A(), n("--tw-backdrop-opacity", `opacity(${w})`), n("-webkit-backdrop-filter", c), n("backdrop-filter", c)] }), o("backdrop-opacity", () => [{ values: Array.from({ length: 21 }, (w, T) => `${T * 5}`), valueThemeKeys: ["--backdrop-opacity", "--opacity"] }]);
    }
    {
      let i = `var(--tw-ease, ${e.resolve(null, ["--default-transition-timing-function"]) ?? "ease"})`, c = `var(--tw-duration, ${e.resolve(null, ["--default-transition-duration"]) ?? "0s"})`;
      l("transition", { defaultValue: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events", themeKeys: ["--transition-property"], handle: (g) => [n("transition-property", g), n("transition-timing-function", i), n("transition-duration", c)], staticValues: { none: [n("transition-property", "none")], all: [n("transition-property", "all"), n("transition-timing-function", i), n("transition-duration", c)], colors: [n("transition-property", "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to"), n("transition-timing-function", i), n("transition-duration", c)], opacity: [n("transition-property", "opacity"), n("transition-timing-function", i), n("transition-duration", c)], shadow: [n("transition-property", "box-shadow"), n("transition-timing-function", i), n("transition-duration", c)], transform: [n("transition-property", "transform, translate, scale, rotate"), n("transition-timing-function", i), n("transition-duration", c)] } }), t("transition-discrete", [["transition-behavior", "allow-discrete"]]), t("transition-normal", [["transition-behavior", "normal"]]), l("delay", { handleBareValue: ({ value: g }) => V(g) ? `${g}ms` : null, themeKeys: ["--transition-delay"], handle: (g) => [n("transition-delay", g)] });
      {
        let g = () => F([N("--tw-duration")]);
        t("duration-initial", [g, ["--tw-duration", "initial"]]), r.functional("duration", (A) => {
          if (A.modifier || !A.value) return;
          let w = null;
          if (A.value.kind === "arbitrary" ? w = A.value.value : (w = e.resolve(A.value.fraction ?? A.value.value, ["--transition-duration"]), w === null && V(A.value.value) && (w = `${A.value.value}ms`)), w !== null) return [g(), n("--tw-duration", w), n("transition-duration", w)];
        });
      }
      o("delay", () => [{ values: ["75", "100", "150", "200", "300", "500", "700", "1000"], valueThemeKeys: ["--transition-delay"] }]), o("duration", () => [{ values: ["75", "100", "150", "200", "300", "500", "700", "1000"], valueThemeKeys: ["--transition-duration"] }]);
    }
    {
      let i = () => F([N("--tw-ease")]);
      l("ease", { themeKeys: ["--ease"], handle: (c) => [i(), n("--tw-ease", c), n("transition-timing-function", c)], staticValues: { initial: [i(), n("--tw-ease", "initial")], linear: [i(), n("--tw-ease", "linear"), n("transition-timing-function", "linear")] } });
    }
    t("will-change-auto", [["will-change", "auto"]]), t("will-change-scroll", [["will-change", "scroll-position"]]), t("will-change-contents", [["will-change", "contents"]]), t("will-change-transform", [["will-change", "transform"]]), l("will-change", { themeKeys: [], handle: (i) => [n("will-change", i)] }), t("content-none", [["--tw-content", "none"], ["content", "none"]]), l("content", { themeKeys: ["--content"], handle: (i) => [F([N("--tw-content", '""')]), n("--tw-content", i), n("content", "var(--tw-content)")] });
    {
      let i = "var(--tw-contain-size,) var(--tw-contain-layout,) var(--tw-contain-paint,) var(--tw-contain-style,)", c = () => F([N("--tw-contain-size"), N("--tw-contain-layout"), N("--tw-contain-paint"), N("--tw-contain-style")]);
      t("contain-none", [["contain", "none"]]), t("contain-content", [["contain", "content"]]), t("contain-strict", [["contain", "strict"]]), t("contain-size", [c, ["--tw-contain-size", "size"], ["contain", i]]), t("contain-inline-size", [c, ["--tw-contain-size", "inline-size"], ["contain", i]]), t("contain-layout", [c, ["--tw-contain-layout", "layout"], ["contain", i]]), t("contain-paint", [c, ["--tw-contain-paint", "paint"], ["contain", i]]), t("contain-style", [c, ["--tw-contain-style", "style"], ["contain", i]]), l("contain", { themeKeys: [], handle: (g) => [n("contain", g)] });
    }
    t("forced-color-adjust-none", [["forced-color-adjust", "none"]]), t("forced-color-adjust-auto", [["forced-color-adjust", "auto"]]), a("leading", ["--leading", "--spacing"], (i) => [F([N("--tw-leading")]), n("--tw-leading", i), n("line-height", i)], { staticValues: { none: [F([N("--tw-leading")]), n("--tw-leading", "1"), n("line-height", "1")] } }), l("tracking", { supportsNegative: true, themeKeys: ["--tracking"], handle: (i) => [F([N("--tw-tracking")]), n("--tw-tracking", i), n("letter-spacing", i)] }), t("antialiased", [["-webkit-font-smoothing", "antialiased"], ["-moz-osx-font-smoothing", "grayscale"]]), t("subpixel-antialiased", [["-webkit-font-smoothing", "auto"], ["-moz-osx-font-smoothing", "auto"]]);
    {
      let i = "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)", c = () => F([N("--tw-ordinal"), N("--tw-slashed-zero"), N("--tw-numeric-figure"), N("--tw-numeric-spacing"), N("--tw-numeric-fraction")]);
      t("normal-nums", [["font-variant-numeric", "normal"]]), t("ordinal", [c, ["--tw-ordinal", "ordinal"], ["font-variant-numeric", i]]), t("slashed-zero", [c, ["--tw-slashed-zero", "slashed-zero"], ["font-variant-numeric", i]]), t("lining-nums", [c, ["--tw-numeric-figure", "lining-nums"], ["font-variant-numeric", i]]), t("oldstyle-nums", [c, ["--tw-numeric-figure", "oldstyle-nums"], ["font-variant-numeric", i]]), t("proportional-nums", [c, ["--tw-numeric-spacing", "proportional-nums"], ["font-variant-numeric", i]]), t("tabular-nums", [c, ["--tw-numeric-spacing", "tabular-nums"], ["font-variant-numeric", i]]), t("diagonal-fractions", [c, ["--tw-numeric-fraction", "diagonal-fractions"], ["font-variant-numeric", i]]), t("stacked-fractions", [c, ["--tw-numeric-fraction", "stacked-fractions"], ["font-variant-numeric", i]]);
    }
    {
      let i = () => F([N("--tw-outline-style", "solid")]);
      r.static("outline-hidden", () => [n("--tw-outline-style", "none"), n("outline-style", "none"), M("@media", "(forced-colors: active)", [n("outline", "2px solid transparent"), n("outline-offset", "2px")])]), t("outline-none", [["--tw-outline-style", "none"], ["outline-style", "none"]]), t("outline-solid", [["--tw-outline-style", "solid"], ["outline-style", "solid"]]), t("outline-dashed", [["--tw-outline-style", "dashed"], ["outline-style", "dashed"]]), t("outline-dotted", [["--tw-outline-style", "dotted"], ["outline-style", "dotted"]]), t("outline-double", [["--tw-outline-style", "double"], ["outline-style", "double"]]), r.functional("outline", (c) => {
        if (c.value === null) {
          if (c.modifier) return;
          let g = e.get(["--default-outline-width"]) ?? "1px";
          return [i(), n("outline-style", "var(--tw-outline-style)"), n("outline-width", g)];
        }
        if (c.value.kind === "arbitrary") {
          let g = c.value.value;
          switch (c.value.dataType ?? J(g, ["color", "length", "number", "percentage"])) {
            case "length":
            case "number":
            case "percentage":
              return c.modifier ? void 0 : [i(), n("outline-style", "var(--tw-outline-style)"), n("outline-width", g)];
            default:
              return g = ee(g, c.modifier, e), g === null ? void 0 : [n("outline-color", g)];
          }
        }
        {
          let g = oe(c, e, ["--outline-color", "--color"]);
          if (g) return [n("outline-color", g)];
        }
        {
          if (c.modifier) return;
          let g = e.resolve(c.value.value, ["--outline-width"]);
          if (g) return [i(), n("outline-style", "var(--tw-outline-style)"), n("outline-width", g)];
          if (V(c.value.value)) return [i(), n("outline-style", "var(--tw-outline-style)"), n("outline-width", `${c.value.value}px`)];
        }
      }), o("outline", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--outline-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (c, g) => `${g * 5}`), hasDefaultValue: true }, { values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--outline-width"] }]), l("outline-offset", { supportsNegative: true, themeKeys: ["--outline-offset"], handleBareValue: ({ value: c }) => V(c) ? `${c}px` : null, handle: (c) => [n("outline-offset", c)] }), o("outline-offset", () => [{ supportsNegative: true, values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--outline-offset"] }]);
    }
    l("opacity", { themeKeys: ["--opacity"], handleBareValue: ({ value: i }) => st(i) ? `${i}%` : null, handle: (i) => [n("opacity", i)] }), o("opacity", () => [{ values: Array.from({ length: 21 }, (i, c) => `${c * 5}`), valueThemeKeys: ["--opacity"] }]), l("underline-offset", { supportsNegative: true, themeKeys: ["--text-underline-offset"], handleBareValue: ({ value: i }) => V(i) ? `${i}px` : null, handle: (i) => [n("text-underline-offset", i)], staticValues: { auto: [n("text-underline-offset", "auto")] } }), o("underline-offset", () => [{ supportsNegative: true, values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--text-underline-offset"] }]), r.functional("text", (i) => {
      if (i.value) {
        if (i.value.kind === "arbitrary") {
          let c = i.value.value;
          switch (i.value.dataType ?? J(c, ["color", "length", "percentage", "absolute-size", "relative-size"])) {
            case "size":
            case "length":
            case "percentage":
            case "absolute-size":
            case "relative-size": {
              if (i.modifier) {
                let A = i.modifier.kind === "arbitrary" ? i.modifier.value : e.resolve(i.modifier.value, ["--leading"]);
                if (!A && le(i.modifier.value)) {
                  if (!e.resolve(null, ["--spacing"])) return null;
                  A = `--spacing(${i.modifier.value})`;
                }
                return !A && i.modifier.value === "none" && (A = "1"), A ? [n("font-size", c), n("line-height", A)] : null;
              }
              return [n("font-size", c)];
            }
            default:
              return c = ee(c, i.modifier, e), c === null ? void 0 : [n("color", c)];
          }
        }
        {
          let c = oe(i, e, ["--text-color", "--color"]);
          if (c) return [n("color", c)];
        }
        {
          let c = e.resolveWith(i.value.value, ["--text"], ["--line-height", "--letter-spacing", "--font-weight"]);
          if (c) {
            let [g, A = {}] = Array.isArray(c) ? c : [c];
            if (i.modifier) {
              let w = i.modifier.kind === "arbitrary" ? i.modifier.value : e.resolve(i.modifier.value, ["--leading"]);
              if (!w && le(i.modifier.value)) {
                if (!e.resolve(null, ["--spacing"])) return null;
                w = `--spacing(${i.modifier.value})`;
              }
              if (!w && i.modifier.value === "none" && (w = "1"), !w) return null;
              let T = [n("font-size", g)];
              return w && T.push(n("line-height", w)), T;
            }
            return typeof A == "string" ? [n("font-size", g), n("line-height", A)] : [n("font-size", g), n("line-height", A["--line-height"] ? `var(--tw-leading, ${A["--line-height"]})` : void 0), n("letter-spacing", A["--letter-spacing"] ? `var(--tw-tracking, ${A["--letter-spacing"]})` : void 0), n("font-weight", A["--font-weight"] ? `var(--tw-font-weight, ${A["--font-weight"]})` : void 0)];
          }
        }
      }
    }), o("text", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--text-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: [], valueThemeKeys: ["--text"], modifiers: [], modifierThemeKeys: ["--leading"] }]);
    let j = () => F([N("--tw-text-shadow-color"), N("--tw-text-shadow-alpha", "100%", "<percentage>")]);
    t("text-shadow-initial", [j, ["--tw-text-shadow-color", "initial"]]), r.functional("text-shadow", (i) => {
      let c;
      if (i.modifier && (i.modifier.kind === "arbitrary" ? c = i.modifier.value : V(i.modifier.value) && (c = `${i.modifier.value}%`)), !i.value) {
        let g = e.get(["--text-shadow"]);
        return g === null ? void 0 : [j(), n("--tw-text-shadow-alpha", c), ...ve("text-shadow", g, c, (A) => `var(--tw-text-shadow-color, ${A})`)];
      }
      if (i.value.kind === "arbitrary") {
        let g = i.value.value;
        return (i.value.dataType ?? J(g, ["color"])) === "color" ? (g = ee(g, i.modifier, e), g === null ? void 0 : [j(), n("--tw-text-shadow-color", Q(g, "var(--tw-text-shadow-alpha)"))]) : [j(), n("--tw-text-shadow-alpha", c), ...ve("text-shadow", g, c, (w) => `var(--tw-text-shadow-color, ${w})`)];
      }
      switch (i.value.value) {
        case "none":
          return i.modifier ? void 0 : [j(), n("text-shadow", "none")];
        case "inherit":
          return i.modifier ? void 0 : [j(), n("--tw-text-shadow-color", "inherit")];
      }
      {
        let g = e.get([`--text-shadow-${i.value.value}`]);
        if (g) return [j(), n("--tw-text-shadow-alpha", c), ...ve("text-shadow", g, c, (A) => `var(--tw-text-shadow-color, ${A})`)];
      }
      {
        let g = oe(i, e, ["--text-shadow-color", "--color"]);
        if (g) return [j(), n("--tw-text-shadow-color", Q(g, "var(--tw-text-shadow-alpha)"))];
      }
    }), o("text-shadow", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--text-shadow-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: ["none"] }, { valueThemeKeys: ["--text-shadow"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`), hasDefaultValue: e.get(["--text-shadow"]) !== null }]);
    {
      let w = function($) {
        return `var(--tw-ring-inset,) 0 0 0 calc(${$} + var(--tw-ring-offset-width)) var(--tw-ring-color, ${A})`;
      }, T = function($) {
        return `inset 0 0 0 ${$} var(--tw-inset-ring-color, currentcolor)`;
      };
      var X = w, te = T;
      let i = ["var(--tw-inset-shadow)", "var(--tw-inset-ring-shadow)", "var(--tw-ring-offset-shadow)", "var(--tw-ring-shadow)", "var(--tw-shadow)"].join(", "), c = "0 0 #0000", g = () => F([N("--tw-shadow", c), N("--tw-shadow-color"), N("--tw-shadow-alpha", "100%", "<percentage>"), N("--tw-inset-shadow", c), N("--tw-inset-shadow-color"), N("--tw-inset-shadow-alpha", "100%", "<percentage>"), N("--tw-ring-color"), N("--tw-ring-shadow", c), N("--tw-inset-ring-color"), N("--tw-inset-ring-shadow", c), N("--tw-ring-inset"), N("--tw-ring-offset-width", "0px", "<length>"), N("--tw-ring-offset-color", "#fff"), N("--tw-ring-offset-shadow", c)]);
      t("shadow-initial", [g, ["--tw-shadow-color", "initial"]]), r.functional("shadow", ($) => {
        let S;
        if ($.modifier && ($.modifier.kind === "arbitrary" ? S = $.modifier.value : V($.modifier.value) && (S = `${$.modifier.value}%`)), !$.value) {
          let I = e.get(["--shadow"]);
          return I === null ? void 0 : [g(), n("--tw-shadow-alpha", S), ...ve("--tw-shadow", I, S, (fe) => `var(--tw-shadow-color, ${fe})`), n("box-shadow", i)];
        }
        if ($.value.kind === "arbitrary") {
          let I = $.value.value;
          return ($.value.dataType ?? J(I, ["color"])) === "color" ? (I = ee(I, $.modifier, e), I === null ? void 0 : [g(), n("--tw-shadow-color", Q(I, "var(--tw-shadow-alpha)"))]) : [g(), n("--tw-shadow-alpha", S), ...ve("--tw-shadow", I, S, (Tt) => `var(--tw-shadow-color, ${Tt})`), n("box-shadow", i)];
        }
        switch ($.value.value) {
          case "none":
            return $.modifier ? void 0 : [g(), n("--tw-shadow", c), n("box-shadow", i)];
          case "inherit":
            return $.modifier ? void 0 : [g(), n("--tw-shadow-color", "inherit")];
        }
        {
          let I = e.get([`--shadow-${$.value.value}`]);
          if (I) return [g(), n("--tw-shadow-alpha", S), ...ve("--tw-shadow", I, S, (fe) => `var(--tw-shadow-color, ${fe})`), n("box-shadow", i)];
        }
        {
          let I = oe($, e, ["--box-shadow-color", "--color"]);
          if (I) return [g(), n("--tw-shadow-color", Q(I, "var(--tw-shadow-alpha)"))];
        }
      }), o("shadow", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--box-shadow-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`) }, { values: ["none"] }, { valueThemeKeys: ["--shadow"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`), hasDefaultValue: e.get(["--shadow"]) !== null }]), t("inset-shadow-initial", [g, ["--tw-inset-shadow-color", "initial"]]), r.functional("inset-shadow", ($) => {
        let S;
        if ($.modifier && ($.modifier.kind === "arbitrary" ? S = $.modifier.value : V($.modifier.value) && (S = `${$.modifier.value}%`)), !$.value) {
          let I = e.get(["--inset-shadow"]);
          return I === null ? void 0 : [g(), n("--tw-inset-shadow-alpha", S), ...ve("--tw-inset-shadow", I, S, (fe) => `var(--tw-inset-shadow-color, ${fe})`), n("box-shadow", i)];
        }
        if ($.value.kind === "arbitrary") {
          let I = $.value.value;
          return ($.value.dataType ?? J(I, ["color"])) === "color" ? (I = ee(I, $.modifier, e), I === null ? void 0 : [g(), n("--tw-inset-shadow-color", Q(I, "var(--tw-inset-shadow-alpha)"))]) : [g(), n("--tw-inset-shadow-alpha", S), ...ve("--tw-inset-shadow", I, S, (Tt) => `var(--tw-inset-shadow-color, ${Tt})`, "inset"), n("box-shadow", i)];
        }
        switch ($.value.value) {
          case "none":
            return $.modifier ? void 0 : [g(), n("--tw-inset-shadow", `inset ${c}`), n("box-shadow", i)];
          case "inherit":
            return $.modifier ? void 0 : [g(), n("--tw-inset-shadow-color", "inherit")];
        }
        {
          let I = e.get([`--inset-shadow-${$.value.value}`]);
          if (I) return [g(), n("--tw-inset-shadow-alpha", S), ...ve("--tw-inset-shadow", I, S, (fe) => `var(--tw-inset-shadow-color, ${fe})`), n("box-shadow", i)];
        }
        {
          let I = oe($, e, ["--box-shadow-color", "--color"]);
          if (I) return [g(), n("--tw-inset-shadow-color", Q(I, "var(--tw-inset-shadow-alpha)"))];
        }
      }), o("inset-shadow", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--box-shadow-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`) }, { values: ["none"] }, { valueThemeKeys: ["--inset-shadow"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`), hasDefaultValue: e.get(["--inset-shadow"]) !== null }]), t("ring-inset", [g, ["--tw-ring-inset", "inset"]]);
      let A = e.get(["--default-ring-color"]) ?? "currentcolor";
      r.functional("ring", ($) => {
        if (!$.value) {
          if ($.modifier) return;
          let S = e.get(["--default-ring-width"]) ?? "1px";
          return [g(), n("--tw-ring-shadow", w(S)), n("box-shadow", i)];
        }
        if ($.value.kind === "arbitrary") {
          let S = $.value.value;
          return ($.value.dataType ?? J(S, ["color", "length"])) === "length" ? $.modifier ? void 0 : [g(), n("--tw-ring-shadow", w(S)), n("box-shadow", i)] : (S = ee(S, $.modifier, e), S === null ? void 0 : [n("--tw-ring-color", S)]);
        }
        {
          let S = oe($, e, ["--ring-color", "--color"]);
          if (S) return [n("--tw-ring-color", S)];
        }
        {
          if ($.modifier) return;
          let S = e.resolve($.value.value, ["--ring-width"]);
          if (S === null && V($.value.value) && (S = `${$.value.value}px`), S) return [g(), n("--tw-ring-shadow", w(S)), n("box-shadow", i)];
        }
      }), o("ring", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--ring-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`) }, { values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--ring-width"], hasDefaultValue: true }]), r.functional("inset-ring", ($) => {
        if (!$.value) return $.modifier ? void 0 : [g(), n("--tw-inset-ring-shadow", T("1px")), n("box-shadow", i)];
        if ($.value.kind === "arbitrary") {
          let S = $.value.value;
          return ($.value.dataType ?? J(S, ["color", "length"])) === "length" ? $.modifier ? void 0 : [g(), n("--tw-inset-ring-shadow", T(S)), n("box-shadow", i)] : (S = ee(S, $.modifier, e), S === null ? void 0 : [n("--tw-inset-ring-color", S)]);
        }
        {
          let S = oe($, e, ["--ring-color", "--color"]);
          if (S) return [n("--tw-inset-ring-color", S)];
        }
        {
          if ($.modifier) return;
          let S = e.resolve($.value.value, ["--ring-width"]);
          if (S === null && V($.value.value) && (S = `${$.value.value}px`), S) return [g(), n("--tw-inset-ring-shadow", T(S)), n("box-shadow", i)];
        }
      }), o("inset-ring", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--ring-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, ($, S) => `${S * 5}`) }, { values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--ring-width"], hasDefaultValue: true }]);
      let P = "var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color)";
      r.functional("ring-offset", ($) => {
        if ($.value) {
          if ($.value.kind === "arbitrary") {
            let S = $.value.value;
            return ($.value.dataType ?? J(S, ["color", "length"])) === "length" ? $.modifier ? void 0 : [n("--tw-ring-offset-width", S), n("--tw-ring-offset-shadow", P)] : (S = ee(S, $.modifier, e), S === null ? void 0 : [n("--tw-ring-offset-color", S)]);
          }
          {
            let S = e.resolve($.value.value, ["--ring-offset-width"]);
            if (S) return $.modifier ? void 0 : [n("--tw-ring-offset-width", S), n("--tw-ring-offset-shadow", P)];
            if (V($.value.value)) return $.modifier ? void 0 : [n("--tw-ring-offset-width", `${$.value.value}px`), n("--tw-ring-offset-shadow", P)];
          }
          {
            let S = oe($, e, ["--ring-offset-color", "--color"]);
            if (S) return [n("--tw-ring-offset-color", S)];
          }
        }
      });
    }
    return o("ring-offset", () => [{ values: ["current", "inherit", "transparent"], valueThemeKeys: ["--ring-offset-color", "--color"], modifierThemeKeys: ["--opacity"], modifiers: Array.from({ length: 21 }, (i, c) => `${c * 5}`) }, { values: ["0", "1", "2", "4", "8"], valueThemeKeys: ["--ring-offset-width"] }]), r.functional("@container", (i) => {
      let c = null;
      if (i.value === null ? c = "inline-size" : i.value.kind === "arbitrary" ? c = i.value.value : i.value.kind === "named" && i.value.value === "normal" ? c = "normal" : i.value.kind === "named" && i.value.value === "size" && (c = "size"), c !== null) return i.modifier ? [n("container-type", c), n("container-name", i.modifier.value)] : [n("container-type", c)];
    }), o("@container", () => [{ values: ["normal"], valueThemeKeys: [], hasDefaultValue: true }]), r;
  }
  var Mt = ["number", "integer", "ratio", "percentage"];
  function Wr(e) {
    let r = me(e.params);
    return tn(r) ? (o) => {
      let t = { "--value": { usedSpacingInteger: false, usedSpacingNumber: false, themeKeys: /* @__PURE__ */ new Set(), literals: /* @__PURE__ */ new Set() }, "--modifier": { usedSpacingInteger: false, usedSpacingNumber: false, themeKeys: /* @__PURE__ */ new Set(), literals: /* @__PURE__ */ new Set() } };
      _(e.nodes, (l) => {
        if (l.kind !== "declaration" || !l.value || !l.value.includes("--value(") && !l.value.includes("--modifier(")) return;
        let s = q(l.value);
        _(s, (a) => {
          if (a.kind !== "function") return;
          if (a.value === "--spacing" && !(t["--modifier"].usedSpacingNumber && t["--value"].usedSpacingNumber)) return _(a.nodes, (m) => {
            if (m.kind !== "function" || m.value !== "--value" && m.value !== "--modifier") return;
            let u = m.value;
            for (let h of m.nodes) if (h.kind === "word") {
              if (h.value === "integer") t[u].usedSpacingInteger ||= true;
              else if (h.value === "number" && (t[u].usedSpacingNumber ||= true, t["--modifier"].usedSpacingNumber && t["--value"].usedSpacingNumber)) return R.Stop;
            }
          }), R.Continue;
          if (a.value !== "--value" && a.value !== "--modifier") return;
          let d = L(Y(a.nodes), ",");
          for (let [m, u] of d.entries()) u = u.replace(/\\\*/g, "*"), u = u.replace(/--(.*?)\s--(.*?)/g, "--$1-*--$2"), u = u.replace(/\s+/g, ""), u = u.replace(/(-\*){2,}/g, "-*"), u[0] === "-" && u[1] === "-" && !u.includes("(") && !u.includes("-*") && (u += "-*"), d[m] = u;
          a.nodes = q(d.join(","));
          for (let m of a.nodes) if (m.kind === "word" && (m.value[0] === '"' || m.value[0] === "'") && m.value[0] === m.value[m.value.length - 1]) {
            let u = m.value.slice(1, -1);
            t[a.value].literals.add(u);
          } else if (m.kind === "word" && m.value[0] === "-" && m.value[1] === "-") {
            let u = m.value.replace(/-\*.*$/g, "");
            t[a.value].themeKeys.add(u);
          } else if (m.kind === "word" && !(m.value[0] === "[" && m.value[m.value.length - 1] === "]") && !Mt.includes(m.value)) {
            console.warn(`Unsupported bare value data type: "${m.value}".
Only valid data types are: ${Mt.map((b) => `"${b}"`).join(", ")}.
`);
            let u = m.value, h = structuredClone(a), p = "\xB6";
            _(h.nodes, (b) => {
              if (b.kind === "word" && b.value === u) return R.ReplaceSkip({ kind: "word", value: p });
            });
            let f = "^".repeat(Y([m]).length), v = Y([h]).indexOf(p), k = ["```css", Y([a]), " ".repeat(v) + f, "```"].join(`
`);
            console.warn(k);
          }
        }), l.value = Y(s);
      }), o.utilities.functional(r.slice(0, -2), (l) => {
        let s = re(e), a = l.value, d = l.modifier, m = false, u = false, h = false, p = false, f = /* @__PURE__ */ new Map(), v = false;
        if (_([s], (k, b) => {
          let x = b.parent;
          if (x?.kind !== "rule" && x?.kind !== "at-rule" || k.kind !== "declaration" || !k.value) return;
          let O = false, C = q(k.value);
          if (_(C, (y) => {
            if (y.kind === "function") {
              if (y.value === "--value") {
                m = true;
                let D = jr(a, y, o);
                return D ? (u = true, D.ratio ? v = true : f.set(k, x), R.ReplaceSkip(D.nodes)) : (O = true, R.Stop);
              } else if (y.value === "--modifier") {
                h = true;
                let D = jr(d, y, o);
                return D ? (p = true, R.ReplaceSkip(D.nodes)) : (O = true, R.Stop);
              }
            }
          }), O) return R.ReplaceSkip([]);
          k.value = Y(C);
        }), !m || !u || h && !p && d !== null || v && p || d && !v && !p) return null;
        if (v) for (let [k, b] of f) {
          let x = b.nodes.indexOf(k);
          x !== -1 && b.nodes.splice(x, 1);
        }
        return s.nodes;
      }), o.utilities.suggest(r.slice(0, -2), () => {
        let l = [], s = [];
        for (let [a, { literals: d, usedSpacingNumber: m, usedSpacingInteger: u, themeKeys: h }] of [[l, t["--value"]], [s, t["--modifier"]]]) {
          for (let p of d) a.push(p);
          if (m) a.push(...pt);
          else if (u) for (let p of pt) V(p) && a.push(p);
          for (let p of o.theme.keysInNamespaces(h)) a.push(p.replace(Fr, (f, v, k) => `${v}.${k}`));
        }
        return [{ values: l, modifiers: s }];
      });
    } : en(r) ? (o) => {
      o.utilities.static(r, () => e.nodes.map(re));
    } : null;
  }
  function jr(e, r, o) {
    if (e === null) {
      for (let t of r.nodes) if (t.kind === "function" && t.value === "--default") return { nodes: t.nodes };
      return;
    }
    for (let t of r.nodes) {
      if (e.kind === "named" && t.kind === "word" && (t.value[0] === "'" || t.value[0] === '"') && t.value[t.value.length - 1] === t.value[0] && t.value.slice(1, -1) === e.value) return { nodes: q(e.value) };
      if (e.kind === "named" && t.kind === "word" && t.value[0] === "-" && t.value[1] === "-") {
        let l = t.value;
        if (l.endsWith("-*")) {
          l = l.slice(0, -2);
          let s = o.theme.resolve(e.value, [l]);
          if (s) return { nodes: q(s) };
        } else {
          let s = l.split("-*");
          if (s.length <= 1) continue;
          let a = [s.shift()], d = o.theme.resolveWith(e.value, a, s);
          if (d) {
            let [, m = {}] = d;
            {
              let u = m[s.pop()];
              if (u) return { nodes: q(u) };
            }
          }
        }
      } else if (e.kind === "named" && t.kind === "word") {
        if (!Mt.includes(t.value)) continue;
        let l = t.value === "ratio" && "fraction" in e ? e.fraction : e.value;
        if (!l) continue;
        let s = J(l, [t.value]);
        if (s === null) continue;
        if (s === "ratio") {
          let [a, d] = L(l, "/").map(Number);
          if (!V(a) || !V(d)) continue;
        } else {
          if (s === "number" && !le(l)) continue;
          if (s === "percentage" && !V(l.slice(0, -1))) continue;
        }
        if (s === "ratio") {
          let [a, d] = L(l, "/");
          return { nodes: q(`${a.trim()} / ${d.trim()}`), ratio: true };
        }
        return { nodes: q(l), ratio: false };
      } else if (e.kind === "arbitrary" && t.kind === "word" && t.value[0] === "[" && t.value[t.value.length - 1] === "]") {
        let l = t.value.slice(1, -1);
        if (l === "*") return { nodes: q(e.value) };
        if ("dataType" in e && e.dataType && e.dataType !== l) continue;
        if ("dataType" in e && e.dataType) return { nodes: q(e.value) };
        if (J(e.value, [l]) !== null) return { nodes: q(e.value) };
      }
    }
  }
  function ve(e, r, o, t, l = "") {
    let s = false, a = Be(r, (m) => o == null ? t(m) : m.startsWith("current") ? t(Q(m, o)) : ((m.startsWith("var(") || o.startsWith("var(")) && (s = true), t(Ir(m, o))));
    function d(m) {
      return l ? L(m, ",").map((u) => l.trim() + " " + u.trim()).join(", ") : m;
    }
    return s ? [n(e, d(Be(r, t))), Z("@supports (color: lab(from red l a b))", [n(e, d(a))])] : [n(e, d(a))];
  }
  function ut(e, r, o, t, l = "") {
    let s = false, a = L(r, ",").map((d) => Be(d, (m) => o == null ? t(m) : m.startsWith("current") ? t(Q(m, o)) : ((m.startsWith("var(") || o.startsWith("var(")) && (s = true), t(Ir(m, o))))).map((d) => `drop-shadow(${d})`).join(" ");
    return s ? [n(e, l + L(r, ",").map((d) => `drop-shadow(${Be(d, t)})`).join(" ")), Z("@supports (color: lab(from red l a b))", [n(e, l + a)])] : [n(e, l + a)];
  }
  var Br = /^-?[a-z][a-zA-Z0-9_-]*/, Bi = 37, qi = 47, Hi = 46, Gi = 97, Yi = 122, Zi = 65, Ji = 90, ct = 48, ft = 57, Qi = 95, Xi = 45;
  function en(e) {
    let r = Br.exec(e);
    if (r === null) return false;
    let o = r[0], t = e.slice(o.length);
    if (t.length === 0 && o.endsWith("-")) return false;
    if (t.length === 0) return true;
    let l = false;
    for (let s = 0; s < t.length; s++) {
      let a = t.charCodeAt(s);
      switch (a) {
        case Bi: {
          if (s !== t.length - 1) return false;
          let m = (t[s - 1] || o[o.length - 1] || "").charCodeAt(0);
          if (m < ct || m > ft) return false;
          break;
        }
        case qi: {
          if (s === t.length - 1 || l) return false;
          l = true;
          break;
        }
        case Hi: {
          let m = (t[s - 1] || o[o.length - 1] || "").charCodeAt(0);
          if (m < ct || m > ft) return false;
          let h = (t[s + 1] || "").charCodeAt(0);
          if (h < ct || h > ft) return false;
          break;
        }
        case Qi:
        case Xi:
          continue;
        default: {
          if (a >= Gi && a <= Yi || a >= Zi && a <= Ji || a >= ct && a <= ft) continue;
          return false;
        }
      }
    }
    return true;
  }
  function tn(e) {
    if (!e.endsWith("-*")) return false;
    e = e.slice(0, -2);
    let r = Br.exec(e);
    if (r === null) return false;
    let o = r[0];
    return e.slice(o.length).length === 0;
  }
  var Wt = { "--alpha": rn, "--spacing": on, "--theme": nn, theme: ln };
  function rn(e, r, o, ...t) {
    let [l, s] = L(o, "/").map((a) => a.trim());
    if (!l || !s) throw new Error(`The --alpha(\u2026) function requires a color and an alpha value, e.g.: \`--alpha(${l || "var(--my-color)"} / ${s || "50%"})\``);
    if (t.length > 0) throw new Error(`The --alpha(\u2026) function only accepts one argument, e.g.: \`--alpha(${l || "var(--my-color)"} / ${s || "50%"})\``);
    return Q(l, s);
  }
  function on(e, r, o, ...t) {
    if (!o) throw new Error("The --spacing(\u2026) function requires an argument, but received none.");
    if (t.length > 0) throw new Error(`The --spacing(\u2026) function only accepts a single argument, but received ${t.length + 1}.`);
    let l = e.theme.resolve(null, ["--spacing"]);
    if (!l) throw new Error("The --spacing(\u2026) function requires that the `--spacing` theme variable exists, but it was not found.");
    let s = We.get(o);
    if (s) {
      if (s[0] === 0) return "0";
      if (s[0] === 1) return l;
    }
    return `calc(${l} * ${o})`;
  }
  function nn(e, r, o, ...t) {
    if (!o.startsWith("--")) throw new Error("The --theme(\u2026) function can only be used with CSS variables from your theme.");
    let l = false;
    o.endsWith(" inline") && (l = true, o = o.slice(0, -7)), r.kind === "at-rule" && (l = true);
    let s = e.resolveThemeValue(o, l);
    if (!s) {
      if (t.length > 0) return t.join(", ");
      throw new Error(`Could not resolve value for theme function: \`theme(${o})\`. Consider checking if the variable name is correct or provide a fallback value to silence this error.`);
    }
    if (t.length === 0) return s;
    let a = t.join(", ");
    if (a === "initial") return s;
    if (s === "initial") return a;
    if (s.startsWith("var(") || s.startsWith("theme(") || s.startsWith("--theme(")) {
      let d = q(s);
      return sn(d, a), Y(d);
    }
    return s;
  }
  function ln(e, r, o, ...t) {
    o = an(o);
    let l = e.resolveThemeValue(o);
    if (!l && t.length > 0) return t.join(", ");
    if (!l) throw new Error(`Could not resolve value for theme function: \`theme(${o})\`. Consider checking if the path is correct or provide a fallback value to silence this error.`);
    return l;
  }
  var qr = new RegExp(Object.keys(Wt).map((e) => `${e}\\(`).join("|"));
  function Pe(e, r) {
    let o = 0;
    return _(e, (t) => {
      if (t.kind === "declaration" && t.value && qr.test(t.value)) {
        o |= 8, t.value = Hr(t.value, t, r);
        return;
      }
      t.kind === "at-rule" && (t.name === "@media" || t.name === "@custom-media" || t.name === "@container" || t.name === "@supports") && qr.test(t.params) && (o |= 8, t.params = Hr(t.params, t, r));
    }), o;
  }
  function Hr(e, r, o) {
    let t = q(e);
    return _(t, (l) => {
      if (l.kind === "function" && l.value in Wt) {
        let s = L(Y(l.nodes).trim(), ",").map((d) => d.trim()), a = Wt[l.value](o, r, ...s);
        return R.Replace(q(a));
      }
    }), Y(t);
  }
  function an(e) {
    if (e[0] !== "'" && e[0] !== '"') return e;
    let r = "", o = e[0];
    for (let t = 1; t < e.length - 1; t++) {
      let l = e[t], s = e[t + 1];
      l === "\\" && (s === o || s === "\\") ? (r += s, t++) : r += l;
    }
    return r;
  }
  function sn(e, r) {
    _(e, (o) => {
      if (o.kind === "function" && !(o.value !== "var" && o.value !== "theme" && o.value !== "--theme")) if (o.nodes.length === 1) o.nodes.push({ kind: "word", value: `, ${r}` });
      else {
        let t = o.nodes[o.nodes.length - 1];
        t.kind === "word" && t.value === "initial" && (t.value = r);
      }
    });
  }
  function Gr() {
    return [];
  }
  function Yr() {
    return [];
  }
  function Zr() {
    return [];
  }
  function Jr(e, r) {
    let { astNodes: o, nodeSorting: t } = ye(Array.from(r), e), l = new Map(r.map((a) => [a, null])), s = 0n;
    for (let a of o) {
      let d = t.get(a)?.candidate;
      d && l.set(d, l.get(d) ?? s++);
    }
    return r.map((a) => [a, l.get(a) ?? null]);
  }
  var mt = /^@?[a-z0-9][a-zA-Z0-9_-]*(?<![_-])$/;
  var Bt = class {
    compareFns = /* @__PURE__ */ new Map();
    variants = /* @__PURE__ */ new Map();
    completions = /* @__PURE__ */ new Map();
    groupOrder = null;
    lastOrder = 0;
    static(r, o, { compounds: t, order: l } = {}) {
      this.set(r, { kind: "static", applyFn: o, compoundsWith: 0, compounds: t ?? 2, order: l });
    }
    fromAst(r, o, t) {
      let l = [], s = false;
      _(o, (a) => {
        a.kind === "rule" ? l.push(a.selector) : a.kind === "at-rule" && a.name === "@variant" ? s = true : a.kind === "at-rule" && a.name !== "@slot" && l.push(`${a.name} ${a.params}`);
      }), this.static(r, (a) => {
        let d = o.map(re);
        s && qe(d, t), qt(d, a.nodes), a.nodes = d;
      }, { compounds: $e(l) });
    }
    functional(r, o, { compounds: t, order: l } = {}) {
      this.set(r, { kind: "functional", applyFn: o, compoundsWith: 0, compounds: t ?? 2, order: l });
    }
    compound(r, o, t, { compounds: l, order: s } = {}) {
      this.set(r, { kind: "compound", applyFn: t, compoundsWith: o, compounds: l ?? 2, order: s });
    }
    group(r, o) {
      this.groupOrder = this.nextOrder(), o && this.compareFns.set(this.groupOrder, o), r(), this.groupOrder = null;
    }
    has(r) {
      return this.variants.has(r);
    }
    get(r) {
      return this.variants.get(r);
    }
    kind(r) {
      return this.variants.get(r)?.kind;
    }
    compoundsWith(r, o) {
      let t = this.variants.get(r), l = typeof o == "string" ? this.variants.get(o) : o.kind === "arbitrary" ? { compounds: $e([o.selector]) } : this.variants.get(o.root);
      return !(!t || !l || t.kind !== "compound" || l.compounds === 0 || t.compoundsWith === 0 || (t.compoundsWith & l.compounds) === 0);
    }
    suggest(r, o) {
      this.completions.set(r, o);
    }
    getCompletions(r) {
      return this.completions.get(r)?.() ?? [];
    }
    compare(r, o) {
      if (r === o) return 0;
      if (r === null) return -1;
      if (o === null) return 1;
      if (r.kind === "arbitrary" && o.kind === "arbitrary") return r.selector < o.selector ? -1 : 1;
      if (r.kind === "arbitrary") return 1;
      if (o.kind === "arbitrary") return -1;
      let t = this.variants.get(r.root).order, l = this.variants.get(o.root).order, s = t - l;
      if (s !== 0) return s;
      if (r.kind === "compound" && o.kind === "compound") {
        let u = this.compare(r.variant, o.variant);
        return u !== 0 ? u : r.modifier && o.modifier ? r.modifier.value < o.modifier.value ? -1 : 1 : r.modifier ? 1 : o.modifier ? -1 : 0;
      }
      let a = this.compareFns.get(t);
      if (a !== void 0) return a(r, o);
      if (r.root !== o.root) return r.root < o.root ? -1 : 1;
      let d = r.value, m = o.value;
      return d === null ? -1 : m === null || d.kind === "arbitrary" && m.kind !== "arbitrary" ? 1 : d.kind !== "arbitrary" && m.kind === "arbitrary" || d.value < m.value ? -1 : 1;
    }
    keys() {
      return this.variants.keys();
    }
    entries() {
      return this.variants.entries();
    }
    set(r, { kind: o, applyFn: t, compounds: l, compoundsWith: s, order: a }) {
      let d = this.variants.get(r);
      d ? Object.assign(d, { kind: o, applyFn: t, compounds: l }) : (a === void 0 && (this.lastOrder = this.nextOrder(), a = this.lastOrder), this.variants.set(r, { kind: o, applyFn: t, order: a, compoundsWith: s, compounds: l }));
    }
    nextOrder() {
      return this.groupOrder ?? this.lastOrder + 1;
    }
  };
  function $e(e) {
    let r = 0;
    for (let o of e) {
      if (o[0] === "@") {
        if (!o.startsWith("@media") && !o.startsWith("@supports") && !o.startsWith("@container")) return 0;
        r |= 1;
        continue;
      }
      if (o.includes("::")) return 0;
      r |= 2;
    }
    return r;
  }
  function Xr(e) {
    let r = new Bt();
    function o(u, h, { compounds: p } = {}) {
      p = p ?? $e(h), r.static(u, (f) => {
        f.nodes = h.map((v) => Z(v, f.nodes));
      }, { compounds: p });
    }
    o("*", [":is(& > *)"], { compounds: 0 }), o("**", [":is(& *)"], { compounds: 0 });
    function t(u, h) {
      return h.map((p) => {
        if (u === "@container") {
          let f = q(p.trim());
          return f.length >= 1 && f[0].kind === "function" ? `not ${p}` : f.length >= 3 && f[0].kind === "word" && f[0].value === "not" && f[2].kind === "function" ? (f.splice(0, 2), Y(f)) : f.length >= 5 && f[0].kind === "word" && f[2].kind === "word" && f[2].value === "not" && f[4].kind === "function" ? (f.splice(2, 2), Y(f)) : f.length >= 3 && f[0].kind === "word" && f[0].value !== "not" && f[2].kind === "function" ? (f.splice(1, 0, { kind: "separator", value: " " }, { kind: "word", value: "not" }), Y(f)) : `not ${p}`;
        } else {
          p = p.trim();
          let f = L(p, " ");
          return f[0] === "not" ? f.slice(1).join(" ") : `not ${p}`;
        }
      });
    }
    let l = ["@media", "@supports", "@container"];
    function s(u) {
      for (let h of l) {
        if (h !== u.name) continue;
        let p = L(u.params, ",");
        return p.length > 1 ? null : (p = t(u.name, p), M(u.name, p.join(", ")));
      }
      return null;
    }
    function a(u) {
      return u.includes("::") ? null : `&:not(${L(u, ",").map((p) => (p = p.replaceAll("&", "*"), p)).join(", ")})`;
    }
    r.compound("not", 3, (u, h) => {
      if (h.variant.kind === "arbitrary" && h.variant.relative || h.modifier) return null;
      let p = false;
      if (_([u], (f, v) => {
        if (f.kind !== "rule" && f.kind !== "at-rule") return R.Continue;
        if (f.nodes.length > 0) return R.Continue;
        let k = [], b = [], x = v.path();
        x.push(f);
        for (let C of x) C.kind === "at-rule" ? k.push(C) : C.kind === "rule" && b.push(C);
        if (k.length > 1) return R.Stop;
        if (b.length > 1) return R.Stop;
        let O = [];
        for (let C of b) {
          let y = a(C.selector);
          if (!y) return p = false, R.Stop;
          O.push(G(y, []));
        }
        for (let C of k) {
          let y = s(C);
          if (!y) return p = false, R.Stop;
          O.push(y);
        }
        return Object.assign(u, G("&", O)), p = true, R.Skip;
      }), u.kind === "rule" && u.selector === "&" && u.nodes.length === 1 && Object.assign(u, u.nodes[0]), !p) return null;
    }), r.suggest("not", () => Array.from(r.keys()).filter((u) => r.compoundsWith("not", u))), r.compound("group", 2, (u, h) => {
      if (h.variant.kind === "arbitrary" && h.variant.relative) return null;
      let p = h.modifier ? `:where(.${e.prefix ? `${e.prefix}\\:` : ""}group\\/${h.modifier.value})` : `:where(.${e.prefix ? `${e.prefix}\\:` : ""}group)`, f = false;
      if (_([u], (v, k) => {
        if (v.kind !== "rule") return R.Continue;
        for (let x of k.path()) if (x.kind === "rule") return f = false, R.Stop;
        let b = v.selector.replaceAll("&", p);
        L(b, ",").length > 1 && (b = `:is(${b})`), v.selector = `&:is(${b} *)`, f = true;
      }), !f) return null;
    }), r.suggest("group", () => Array.from(r.keys()).filter((u) => r.compoundsWith("group", u))), r.compound("peer", 2, (u, h) => {
      if (h.variant.kind === "arbitrary" && h.variant.relative) return null;
      let p = h.modifier ? `:where(.${e.prefix ? `${e.prefix}\\:` : ""}peer\\/${h.modifier.value})` : `:where(.${e.prefix ? `${e.prefix}\\:` : ""}peer)`, f = false;
      if (_([u], (v, k) => {
        if (v.kind !== "rule") return R.Continue;
        for (let x of k.path()) if (x.kind === "rule") return f = false, R.Stop;
        let b = v.selector.replaceAll("&", p);
        L(b, ",").length > 1 && (b = `:is(${b})`), v.selector = `&:is(${b} ~ *)`, f = true;
      }), !f) return null;
    }), r.suggest("peer", () => Array.from(r.keys()).filter((u) => r.compoundsWith("peer", u))), o("first-letter", ["&::first-letter"]), o("first-line", ["&::first-line"]), o("marker", ["& *::marker", "&::marker", "& *::-webkit-details-marker", "&::-webkit-details-marker"]), o("selection", ["& *::selection", "&::selection"]), o("file", ["&::file-selector-button"]), o("placeholder", ["&::placeholder"]), o("backdrop", ["&::backdrop"]), o("details-content", ["&::details-content"]);
    {
      let u = function() {
        return F([M("@property", "--tw-content", [n("syntax", '"*"'), n("initial-value", '""'), n("inherits", "false")])]);
      };
      var d = u;
      r.static("before", (h) => {
        h.nodes = [G("&::before", [u(), n("content", "var(--tw-content)"), ...h.nodes])];
      }, { compounds: 0 }), r.static("after", (h) => {
        h.nodes = [G("&::after", [u(), n("content", "var(--tw-content)"), ...h.nodes])];
      }, { compounds: 0 });
    }
    o("first", ["&:first-child"]), o("last", ["&:last-child"]), o("only", ["&:only-child"]), o("odd", ["&:nth-child(odd)"]), o("even", ["&:nth-child(even)"]), o("first-of-type", ["&:first-of-type"]), o("last-of-type", ["&:last-of-type"]), o("only-of-type", ["&:only-of-type"]), o("visited", ["&:visited"]), o("target", ["&:target"]), o("open", ["&:is([open], :popover-open, :open)"]), o("default", ["&:default"]), o("checked", ["&:checked"]), o("indeterminate", ["&:indeterminate"]), o("placeholder-shown", ["&:placeholder-shown"]), o("autofill", ["&:autofill"]), o("optional", ["&:optional"]), o("required", ["&:required"]), o("valid", ["&:valid"]), o("invalid", ["&:invalid"]), o("user-valid", ["&:user-valid"]), o("user-invalid", ["&:user-invalid"]), o("in-range", ["&:in-range"]), o("out-of-range", ["&:out-of-range"]), o("read-only", ["&:read-only"]), o("empty", ["&:empty"]), o("focus-within", ["&:focus-within"]), r.static("hover", (u) => {
      u.nodes = [G("&:hover", [M("@media", "(hover: hover)", u.nodes)])];
    }), o("focus", ["&:focus"]), o("focus-visible", ["&:focus-visible"]), o("active", ["&:active"]), o("enabled", ["&:enabled"]), o("disabled", ["&:disabled"]), o("inert", ["&:is([inert], [inert] *)"]), r.compound("in", 2, (u, h) => {
      if (h.modifier) return null;
      let p = false;
      if (_([u], (f, v) => {
        if (f.kind !== "rule") return R.Continue;
        for (let k of v.path()) if (k.kind === "rule") return p = false, R.Stop;
        f.selector = `:where(${f.selector.replaceAll("&", "*")}) &`, p = true;
      }), !p) return null;
    }), r.suggest("in", () => Array.from(r.keys()).filter((u) => r.compoundsWith("in", u))), r.compound("has", 2, (u, h) => {
      if (h.modifier) return null;
      let p = false;
      if (_([u], (f, v) => {
        if (f.kind !== "rule") return R.Continue;
        for (let k of v.path()) if (k.kind === "rule") return p = false, R.Stop;
        f.selector = `&:has(${f.selector.replaceAll("&", "*")})`, p = true;
      }), !p) return null;
    }), r.suggest("has", () => Array.from(r.keys()).filter((u) => r.compoundsWith("has", u))), r.functional("aria", (u, h) => {
      if (!h.value || h.modifier) return null;
      h.value.kind === "arbitrary" ? u.nodes = [G(`&[aria-${Qr(h.value.value)}]`, u.nodes)] : u.nodes = [G(`&[aria-${h.value.value}="true"]`, u.nodes)];
    }), r.suggest("aria", () => ["busy", "checked", "disabled", "expanded", "hidden", "pressed", "readonly", "required", "selected"]), r.functional("data", (u, h) => {
      if (!h.value || h.modifier) return null;
      u.nodes = [G(`&[data-${Qr(h.value.value)}]`, u.nodes)];
    }), r.functional("nth", (u, h) => {
      if (!h.value || h.modifier || h.value.kind === "named" && !V(h.value.value)) return null;
      u.nodes = [G(`&:nth-child(${h.value.value})`, u.nodes)];
    }), r.functional("nth-last", (u, h) => {
      if (!h.value || h.modifier || h.value.kind === "named" && !V(h.value.value)) return null;
      u.nodes = [G(`&:nth-last-child(${h.value.value})`, u.nodes)];
    }), r.functional("nth-of-type", (u, h) => {
      if (!h.value || h.modifier || h.value.kind === "named" && !V(h.value.value)) return null;
      u.nodes = [G(`&:nth-of-type(${h.value.value})`, u.nodes)];
    }), r.functional("nth-last-of-type", (u, h) => {
      if (!h.value || h.modifier || h.value.kind === "named" && !V(h.value.value)) return null;
      u.nodes = [G(`&:nth-last-of-type(${h.value.value})`, u.nodes)];
    }), r.functional("supports", (u, h) => {
      if (!h.value || h.modifier) return null;
      let p = h.value.value;
      if (p === null) return null;
      if (/^[\w-]*\s*\(/.test(p)) {
        let f = p.replace(/\b(and|or|not)\b/g, " $1 ");
        u.nodes = [M("@supports", f, u.nodes)];
        return;
      }
      p.includes(":") || (p = `${p}: var(--tw)`), (p[0] !== "(" || p[p.length - 1] !== ")") && (p = `(${p})`), u.nodes = [M("@supports", p, u.nodes)];
    }, { compounds: 1 }), o("motion-safe", ["@media (prefers-reduced-motion: no-preference)"]), o("motion-reduce", ["@media (prefers-reduced-motion: reduce)"]), o("contrast-more", ["@media (prefers-contrast: more)"]), o("contrast-less", ["@media (prefers-contrast: less)"]);
    {
      let u = function(h, p, f, v) {
        if (h === p) return 0;
        let k = v.get(h);
        if (k === null) return f === "asc" ? -1 : 1;
        let b = v.get(p);
        return b === null ? f === "asc" ? 1 : -1 : Ne(k, b, f);
      };
      var m = u;
      {
        let h = e.namespace("--breakpoint"), p = new H((f) => {
          switch (f.kind) {
            case "static":
              return e.resolveValue(f.root, ["--breakpoint"]) ?? null;
            case "functional": {
              if (!f.value || f.modifier) return null;
              let v = null;
              return f.value.kind === "arbitrary" ? v = f.value.value : f.value.kind === "named" && (v = e.resolveValue(f.value.value, ["--breakpoint"])), !v || v.includes("var(") ? null : v;
            }
            case "arbitrary":
            case "compound":
              return null;
          }
        });
        r.group(() => {
          r.functional("max", (f, v) => {
            if (v.modifier) return null;
            let k = p.get(v);
            if (k === null) return null;
            f.nodes = [M("@media", `(width < ${k})`, f.nodes)];
          }, { compounds: 1 });
        }, (f, v) => u(f, v, "desc", p)), r.suggest("max", () => Array.from(h.keys()).filter((f) => f !== null)), r.group(() => {
          for (let [f, v] of e.namespace("--breakpoint")) f !== null && r.static(f, (k) => {
            k.nodes = [M("@media", `(width >= ${v})`, k.nodes)];
          }, { compounds: 1 });
          r.functional("min", (f, v) => {
            if (v.modifier) return null;
            let k = p.get(v);
            if (k === null) return null;
            f.nodes = [M("@media", `(width >= ${k})`, f.nodes)];
          }, { compounds: 1 });
        }, (f, v) => u(f, v, "asc", p)), r.suggest("min", () => Array.from(h.keys()).filter((f) => f !== null));
      }
      {
        let h = e.namespace("--container"), p = new H((f) => {
          switch (f.kind) {
            case "functional": {
              if (f.value === null) return null;
              let v = null;
              return f.value.kind === "arbitrary" ? v = f.value.value : f.value.kind === "named" && (v = e.resolveValue(f.value.value, ["--container"])), !v || v.includes("var(") ? null : v;
            }
            case "static":
            case "arbitrary":
            case "compound":
              return null;
          }
        });
        r.group(() => {
          r.functional("@max", (f, v) => {
            let k = p.get(v);
            if (k === null) return null;
            f.nodes = [M("@container", v.modifier ? `${v.modifier.value} (width < ${k})` : `(width < ${k})`, f.nodes)];
          }, { compounds: 1 });
        }, (f, v) => u(f, v, "desc", p)), r.suggest("@max", () => Array.from(h.keys()).filter((f) => f !== null)), r.group(() => {
          r.functional("@", (f, v) => {
            let k = p.get(v);
            if (k === null) return null;
            f.nodes = [M("@container", v.modifier ? `${v.modifier.value} (width >= ${k})` : `(width >= ${k})`, f.nodes)];
          }, { compounds: 1 }), r.functional("@min", (f, v) => {
            let k = p.get(v);
            if (k === null) return null;
            f.nodes = [M("@container", v.modifier ? `${v.modifier.value} (width >= ${k})` : `(width >= ${k})`, f.nodes)];
          }, { compounds: 1 });
        }, (f, v) => u(f, v, "asc", p)), r.suggest("@min", () => Array.from(h.keys()).filter((f) => f !== null)), r.suggest("@", () => Array.from(h.keys()).filter((f) => f !== null));
      }
    }
    return o("portrait", ["@media (orientation: portrait)"]), o("landscape", ["@media (orientation: landscape)"]), o("ltr", ['&:where(:dir(ltr), [dir="ltr"], [dir="ltr"] *)']), o("rtl", ['&:where(:dir(rtl), [dir="rtl"], [dir="rtl"] *)']), o("dark", ["@media (prefers-color-scheme: dark)"]), o("starting", ["@starting-style"]), o("print", ["@media print"]), o("forced-colors", ["@media (forced-colors: active)"]), o("inverted-colors", ["@media (inverted-colors: inverted)"]), o("pointer-none", ["@media (pointer: none)"]), o("pointer-coarse", ["@media (pointer: coarse)"]), o("pointer-fine", ["@media (pointer: fine)"]), o("any-pointer-none", ["@media (any-pointer: none)"]), o("any-pointer-coarse", ["@media (any-pointer: coarse)"]), o("any-pointer-fine", ["@media (any-pointer: fine)"]), o("noscript", ["@media (scripting: none)"]), r;
  }
  function Qr(e) {
    if (e.includes("=")) {
      let [r, ...o] = L(e, "="), t = o.join("=").trim();
      if (t[0] === "'" || t[0] === '"') return e;
      if (t.length > 1) {
        let l = t[t.length - 1];
        if (t[t.length - 2] === " " && (l === "i" || l === "I" || l === "s" || l === "S")) return `${r}="${t.slice(0, -2)}" ${l}`;
      }
      return `${r}="${t}"`;
    }
    return e;
  }
  function qt(e, r) {
    _(e, (o) => {
      if (o.kind === "at-rule" && o.name === "@slot") return R.ReplaceSkip(r);
      if (o.kind === "at-rule" && (o.name === "@keyframes" || o.name === "@property")) return Object.assign(o, F([M(o.name, o.params, o.nodes)])), R.Skip;
    });
  }
  function qe(e, r) {
    let o = 0;
    return _(e, (t) => {
      if (t.kind !== "at-rule" || t.name !== "@variant") return;
      let l = [], s = L(t.params, ",");
      for (let [a, d] of s.entries()) {
        let m = G("&", a === s.length - 1 ? t.nodes : t.nodes.map(re)), u = L(d, ":");
        for (let h = u.length - 1; h >= 0; --h) {
          let p = u[h].trim();
          if (!p) throw new Error("Cannot use `@variant` with empty variant");
          let f = r.parseVariant(p);
          if (f === null) throw new Error(`Cannot use \`@variant\` with unknown variant: ${p}`);
          if (ht(m, f, r.variants) === null) throw new Error(`Cannot use \`@variant\` with variant: ${p}`);
        }
        l.push(m);
      }
      return o |= 32, R.Replace(l);
    }), o;
  }
  function eo(e, r) {
    let o = Mr(e), t = Xr(e), l = new H((p) => Er(p, h)), s = new H((p) => Array.from(Vr(p, h))), a = new H((p) => new H((f) => {
      let v = to(f, h, p);
      try {
        let k = v.map((b) => b.node);
        Pe(k, h), qe(k, h);
      } catch {
        return [];
      }
      return v;
    })), d = new H((p) => {
      for (let f of ot(p)) e.markUsedVariable(f);
    });
    function m(p) {
      let f = [];
      for (let v of p) {
        let k = true, { astNodes: b } = ye([v], h, { onInvalidCandidate() {
          k = false;
        } });
        r && _(b, (x) => (x.src ??= r, R.Continue)), b = Ce(b, h, 0), f.push(k ? b : []);
      }
      return f;
    }
    function u(p) {
      return m(p).map((f) => f.length > 0 ? ae(f) : null);
    }
    let h = { theme: e, utilities: o, variants: t, invalidCandidates: /* @__PURE__ */ new Set(), important: false, candidatesToCss: u, candidatesToAst: m, getClassOrder(p) {
      return Jr(this, p);
    }, getClassList() {
      return Gr(this);
    }, getVariants() {
      return Yr(this);
    }, parseCandidate(p) {
      return s.get(p);
    }, parseVariant(p) {
      return l.get(p);
    }, compileAstNodes(p, f = 1) {
      return a.get(f).get(p);
    }, printCandidate(p) {
      return Or(h, p);
    }, printVariant(p) {
      return at(p);
    }, getVariantOrder() {
      let p = Array.from(l.values());
      p.sort((b, x) => this.variants.compare(b, x));
      let f = /* @__PURE__ */ new Map(), v, k = 0;
      for (let b of p) b !== null && (v !== void 0 && this.variants.compare(v, b) !== 0 && k++, f.set(b, k), v = b);
      return f;
    }, resolveThemeValue(p, f = true) {
      let v = p.lastIndexOf("/"), k = null;
      v !== -1 && (k = p.slice(v + 1).trim(), p = p.slice(0, v).trim());
      let b = e.resolve(null, [p], f ? 1 : 0) ?? void 0;
      return k && b ? Q(b, k) : b;
    }, trackUsedVariables(p) {
      d.get(p);
    }, canonicalizeCandidates(p, f) {
      return Zr(this, p, f);
    }, storage: {} };
    return h;
  }
  var Ht = ["container-type", "pointer-events", "visibility", "position", "inset", "inset-inline", "inset-block", "inset-inline-start", "inset-inline-end", "inset-block-start", "inset-block-end", "top", "right", "bottom", "left", "isolation", "z-index", "order", "grid-column", "grid-column-start", "grid-column-end", "grid-row", "grid-row-start", "grid-row-end", "float", "clear", "--tw-container-component", "margin", "margin-inline", "margin-block", "margin-inline-start", "margin-inline-end", "margin-block-start", "margin-block-end", "margin-top", "margin-right", "margin-bottom", "margin-left", "box-sizing", "display", "field-sizing", "aspect-ratio", "height", "max-height", "min-height", "width", "max-width", "min-width", "flex", "flex-shrink", "flex-grow", "flex-basis", "table-layout", "caption-side", "border-collapse", "border-spacing", "transform-origin", "translate", "--tw-translate-x", "--tw-translate-y", "--tw-translate-z", "scale", "--tw-scale-x", "--tw-scale-y", "--tw-scale-z", "rotate", "--tw-rotate-x", "--tw-rotate-y", "--tw-rotate-z", "--tw-skew-x", "--tw-skew-y", "transform", "zoom", "animation", "cursor", "touch-action", "--tw-pan-x", "--tw-pan-y", "--tw-pinch-zoom", "resize", "scroll-snap-type", "--tw-scroll-snap-strictness", "scroll-snap-align", "scroll-snap-stop", "scroll-margin", "scroll-margin-inline", "scroll-margin-block", "scroll-margin-inline-start", "scroll-margin-inline-end", "scroll-margin-block-start", "scroll-margin-block-end", "scroll-margin-top", "scroll-margin-right", "scroll-margin-bottom", "scroll-margin-left", "scroll-padding", "scroll-padding-inline", "scroll-padding-block", "scroll-padding-inline-start", "scroll-padding-inline-end", "scroll-padding-block-start", "scroll-padding-block-end", "scroll-padding-top", "scroll-padding-right", "scroll-padding-bottom", "scroll-padding-left", "scrollbar-width", "scrollbar-color", "scrollbar-gutter", "list-style-position", "list-style-type", "list-style-image", "appearance", "columns", "break-before", "break-inside", "break-after", "grid-auto-columns", "grid-auto-flow", "grid-auto-rows", "grid-template-columns", "grid-template-rows", "flex-direction", "flex-wrap", "place-content", "place-items", "align-content", "align-items", "justify-content", "justify-items", "gap", "column-gap", "row-gap", "--tw-space-x-reverse", "--tw-space-y-reverse", "divide-x-width", "divide-y-width", "--tw-divide-y-reverse", "divide-style", "divide-color", "place-self", "align-self", "justify-self", "overflow", "overflow-x", "overflow-y", "overscroll-behavior", "overscroll-behavior-x", "overscroll-behavior-y", "scroll-behavior", "border-radius", "border-start-radius", "border-end-radius", "border-top-radius", "border-right-radius", "border-bottom-radius", "border-left-radius", "border-start-start-radius", "border-start-end-radius", "border-end-end-radius", "border-end-start-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "border-width", "border-inline-width", "border-block-width", "border-inline-start-width", "border-inline-end-width", "border-block-start-width", "border-block-end-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-style", "border-inline-style", "border-block-style", "border-inline-start-style", "border-inline-end-style", "border-block-start-style", "border-block-end-style", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style", "border-color", "border-inline-color", "border-block-color", "border-inline-start-color", "border-inline-end-color", "border-block-start-color", "border-block-end-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "background-color", "background-image", "--tw-gradient-position", "--tw-gradient-stops", "--tw-gradient-via-stops", "--tw-gradient-from", "--tw-gradient-from-position", "--tw-gradient-via", "--tw-gradient-via-position", "--tw-gradient-to", "--tw-gradient-to-position", "mask-image", "--tw-mask-top", "--tw-mask-top-from-color", "--tw-mask-top-from-position", "--tw-mask-top-to-color", "--tw-mask-top-to-position", "--tw-mask-right", "--tw-mask-right-from-color", "--tw-mask-right-from-position", "--tw-mask-right-to-color", "--tw-mask-right-to-position", "--tw-mask-bottom", "--tw-mask-bottom-from-color", "--tw-mask-bottom-from-position", "--tw-mask-bottom-to-color", "--tw-mask-bottom-to-position", "--tw-mask-left", "--tw-mask-left-from-color", "--tw-mask-left-from-position", "--tw-mask-left-to-color", "--tw-mask-left-to-position", "--tw-mask-linear", "--tw-mask-linear-position", "--tw-mask-linear-from-color", "--tw-mask-linear-from-position", "--tw-mask-linear-to-color", "--tw-mask-linear-to-position", "--tw-mask-radial", "--tw-mask-radial-shape", "--tw-mask-radial-size", "--tw-mask-radial-position", "--tw-mask-radial-from-color", "--tw-mask-radial-from-position", "--tw-mask-radial-to-color", "--tw-mask-radial-to-position", "--tw-mask-conic", "--tw-mask-conic-position", "--tw-mask-conic-from-color", "--tw-mask-conic-from-position", "--tw-mask-conic-to-color", "--tw-mask-conic-to-position", "box-decoration-break", "background-size", "background-attachment", "background-clip", "background-position", "background-repeat", "background-origin", "mask-composite", "mask-mode", "mask-type", "mask-size", "mask-clip", "mask-position", "mask-repeat", "mask-origin", "fill", "stroke", "stroke-width", "object-fit", "object-position", "padding", "padding-inline", "padding-block", "padding-inline-start", "padding-inline-end", "padding-block-start", "padding-block-end", "padding-top", "padding-right", "padding-bottom", "padding-left", "text-align", "text-indent", "vertical-align", "font-family", "font-feature-settings", "font-size", "line-height", "font-weight", "letter-spacing", "text-wrap", "overflow-wrap", "word-break", "text-overflow", "hyphens", "white-space", "tab-size", "color", "text-transform", "font-style", "font-stretch", "font-variant-numeric", "text-decoration-line", "text-decoration-color", "text-decoration-style", "text-decoration-thickness", "text-underline-offset", "-webkit-font-smoothing", "placeholder-color", "caret-color", "accent-color", "color-scheme", "opacity", "background-blend-mode", "mix-blend-mode", "box-shadow", "--tw-shadow", "--tw-shadow-color", "--tw-ring-shadow", "--tw-ring-color", "--tw-inset-shadow", "--tw-inset-shadow-color", "--tw-inset-ring-shadow", "--tw-inset-ring-color", "--tw-ring-offset-width", "--tw-ring-offset-color", "outline", "outline-width", "outline-offset", "outline-color", "--tw-blur", "--tw-brightness", "--tw-contrast", "--tw-drop-shadow", "--tw-grayscale", "--tw-hue-rotate", "--tw-invert", "--tw-saturate", "--tw-sepia", "filter", "--tw-backdrop-blur", "--tw-backdrop-brightness", "--tw-backdrop-contrast", "--tw-backdrop-grayscale", "--tw-backdrop-hue-rotate", "--tw-backdrop-invert", "--tw-backdrop-opacity", "--tw-backdrop-saturate", "--tw-backdrop-sepia", "backdrop-filter", "transition-property", "transition-behavior", "transition-delay", "transition-duration", "transition-timing-function", "will-change", "contain", "content", "forced-color-adjust"];
  function ro(e, r) {
    let o = e.length, t = r.length, l = o < t ? o : t;
    for (let s = 0; s < l; s++) {
      let a = e.charCodeAt(s), d = r.charCodeAt(s);
      if (a >= 48 && a <= 57 && d >= 48 && d <= 57) {
        let m = s, u = s + 1, h = s, p = s + 1;
        for (a = e.charCodeAt(u); a >= 48 && a <= 57; ) a = e.charCodeAt(++u);
        for (d = r.charCodeAt(p); d >= 48 && d <= 57; ) d = r.charCodeAt(++p);
        let f = e.slice(m, u), v = r.slice(h, p), k = Number(f) - Number(v);
        if (k) return k;
        if (f < v) return -1;
        if (f > v) return 1;
        continue;
      }
      if (a !== d) return a - d;
    }
    return e.length - r.length;
  }
  function ye(e, r, { onInvalidCandidate: o, respectImportant: t } = {}) {
    let l = /* @__PURE__ */ new Map(), s = [], a = /* @__PURE__ */ new Map();
    for (let u of e) {
      if (r.invalidCandidates.has(u)) {
        o?.(u);
        continue;
      }
      let h = r.parseCandidate(u);
      if (h.length === 0) {
        o?.(u);
        continue;
      }
      a.set(u, h);
    }
    let d = 0;
    (t ?? true) && (d |= 1);
    let m = r.getVariantOrder();
    for (let [u, h] of a) {
      let p = false;
      for (let f of h) {
        let v = r.compileAstNodes(f, d);
        if (v.length !== 0) {
          p = true;
          for (let { node: k, propertySort: b } of v) {
            let x = 0n;
            for (let O of f.variants) x |= 1n << BigInt(m.get(O));
            l.set(k, { properties: b, variants: x, candidate: u }), s.push(k);
          }
        }
      }
      p || o?.(u);
    }
    return s.sort((u, h) => {
      let p = l.get(u), f = l.get(h);
      if (p.variants - f.variants !== 0n) return Number(p.variants - f.variants);
      let v = 0;
      for (; v < p.properties.order.length && v < f.properties.order.length && p.properties.order[v] === f.properties.order[v]; ) v += 1;
      return (p.properties.order[v] ?? 1 / 0) - (f.properties.order[v] ?? 1 / 0) || f.properties.count - p.properties.count || ro(p.candidate, f.candidate);
    }), { astNodes: s, nodeSorting: l };
  }
  function to(e, r, o) {
    let t = un(e, r);
    if (t.length === 0) return [];
    let l = r.important && !!(o & 1), s = [], a = `.${be(e.raw)}`;
    for (let d of t) {
      let m = cn(d);
      (e.important || l) && io(d);
      let u = { kind: "rule", selector: a, nodes: d };
      for (let h of e.variants) if (ht(u, h, r.variants) === null) return [];
      s.push({ node: u, propertySort: m });
    }
    return s;
  }
  function ht(e, r, o, t = 0) {
    if (r.kind === "arbitrary") {
      if (r.relative && t === 0) return null;
      e.nodes = [Z(r.selector, e.nodes)];
      return;
    }
    let { applyFn: l } = o.get(r.root);
    if (r.kind === "compound") {
      let a = M("@slot");
      if (ht(a, r.variant, o, t + 1) === null || r.root === "not" && a.nodes.length > 1) return null;
      for (let m of a.nodes) if (m.kind !== "rule" && m.kind !== "at-rule" || l(m, r) === null) return null;
      _(a.nodes, (m) => {
        if ((m.kind === "rule" || m.kind === "at-rule") && m.nodes.length <= 0) return m.nodes = e.nodes, R.Skip;
      }), e.nodes = a.nodes;
      return;
    }
    if (l(e, r) === null) return null;
  }
  function oo(e) {
    let r = e.options?.types ?? [];
    return r.length > 1 && r.includes("any");
  }
  function un(e, r) {
    if (e.kind === "arbitrary") {
      let a = e.value;
      return e.modifier && (a = ee(a, e.modifier, r.theme)), a === null ? [] : [[n(e.property, a)]];
    }
    let o = r.utilities.get(e.root) ?? [], t = [], l = o.filter((a) => !oo(a));
    for (let a of l) {
      if (a.kind !== e.kind) continue;
      let d = a.compileFn(e);
      if (d !== void 0) {
        if (d === null) {
          if (a.options?.types?.length) return t;
          continue;
        }
        t.push(d);
      }
    }
    if (t.length > 0) return t;
    let s = o.filter((a) => oo(a));
    for (let a of s) {
      if (a.kind !== e.kind) continue;
      let d = a.compileFn(e);
      if (d !== void 0) {
        if (d === null) {
          if (a.options?.types?.length) return t;
          continue;
        }
        t.push(d);
      }
    }
    return t;
  }
  function io(e) {
    for (let r of e) r.kind !== "at-root" && (r.kind === "declaration" ? r.important = true : (r.kind === "rule" || r.kind === "at-rule") && io(r.nodes));
  }
  function cn(e) {
    let r = /* @__PURE__ */ new Set(), o = 0, t = e.slice(), l = false;
    for (; t.length > 0; ) {
      let s = t.shift();
      if (s.kind === "declaration") {
        if (s.value === void 0 || (o++, l)) continue;
        if (s.property === "--tw-sort") {
          let d = Ht.indexOf(s.value ?? "");
          if (d !== -1) {
            r.add(d), l = true;
            continue;
          }
        }
        let a = Ht.indexOf(s.property);
        a !== -1 && r.add(a);
      } else if (s.kind === "rule" || s.kind === "at-rule") for (let a of s.nodes) t.push(a);
    }
    return { order: Array.from(r).sort((s, a) => s - a), count: o };
  }
  function He(e, r) {
    let o = 0, t = Z("&", e), l = /* @__PURE__ */ new Set(), s = new H(() => /* @__PURE__ */ new Set()), a = new H(() => /* @__PURE__ */ new Set());
    _([t], (p, f) => {
      if (p.kind === "at-rule") {
        if (p.name === "@keyframes") return _(p.nodes, (v) => {
          if (v.kind === "at-rule" && v.name === "@apply") throw new Error("You cannot use `@apply` inside `@keyframes`.");
        }), R.Skip;
        if (p.name === "@utility") {
          let v = p.params.replace(/-\*$/, "");
          a.get(v).add(p), _(p.nodes, (k) => {
            if (!(k.kind !== "at-rule" || k.name !== "@apply")) {
              l.add(p);
              for (let b of no(k, r)) s.get(p).add(b);
            }
          });
          return;
        }
        if (p.name === "@apply") {
          if (f.parent === null) return;
          o |= 1, l.add(f.parent);
          for (let v of no(p, r)) for (let k of f.path()) l.has(k) && s.get(k).add(v);
        }
      }
    });
    let d = /* @__PURE__ */ new Set(), m = [], u = /* @__PURE__ */ new Set();
    function h(p, f = []) {
      if (!d.has(p)) {
        if (u.has(p)) {
          let v = f[(f.indexOf(p) + 1) % f.length];
          throw p.kind === "at-rule" && p.name === "@utility" && v.kind === "at-rule" && v.name === "@utility" && _(p.nodes, (k) => {
            if (k.kind !== "at-rule" || k.name !== "@apply") return;
            let b = k.params.split(/\s+/g);
            for (let x of b) for (let O of r.parseCandidate(x)) switch (O.kind) {
              case "arbitrary":
                break;
              case "static":
              case "functional":
                if (v.params.replace(/-\*$/, "") === O.root) throw new Error(`You cannot \`@apply\` the \`${x}\` utility here because it creates a circular dependency.`);
                break;
              default:
            }
          }), new Error(`Circular dependency detected:

${ae([p])}
Relies on:

${ae([v])}`);
        }
        u.add(p);
        for (let v of s.get(p)) for (let k of a.get(v)) f.push(p), h(k, f), f.pop();
        d.add(p), u.delete(p), m.push(p);
      }
    }
    for (let p of l) h(p);
    for (let p of m) "nodes" in p && _(p.nodes, (f) => {
      if (f.kind !== "at-rule" || f.name !== "@apply") return;
      let v = f.params.split(/(\s+)/g), k = {}, b = [], x = [], O = 0;
      for (let [y, D] of v.entries()) y % 2 === 0 && (D[0] === "-" && D[1] === "-" ? x.push(D) : b.push(D), k[D] = O), O += D.length;
      if (x.length) {
        if (b.length === 0) return R.Skip;
        let y = x.join(" ");
        throw new Error(`You cannot use \`@apply\` with both mixins and utilities. Please move \`@apply ${y}\` into a separate rule.`);
      }
      if (f.nodes.length > 0 && b.length) {
        let y = b.join(" ");
        throw new Error(`The rule \`@apply ${y}\` must not have a body.`);
      }
      {
        let y = Object.keys(k), D = ye(y, r, { respectImportant: false, onInvalidCandidate: (E) => {
          if (r.theme.prefix && !E.startsWith(r.theme.prefix)) throw new Error(`Cannot apply unprefixed utility class \`${E}\`. Did you mean \`${r.theme.prefix}:${E}\`?`);
          if (r.invalidCandidates.has(E)) throw new Error(`Cannot apply utility class \`${E}\` because it has been explicitly disabled: https://tailwindcss.com/docs/detecting-classes-in-source-files#explicitly-excluding-classes`);
          let U = L(E, ":");
          if (U.length > 1) {
            let B = U.pop();
            if (r.candidatesToCss([B])[0]) {
              let W = r.candidatesToCss(U.map((te) => `${te}:[--tw-variant-check:1]`)), X = U.filter((te, i) => W[i] === null);
              if (X.length > 0) {
                if (X.length === 1) throw new Error(`Cannot apply utility class \`${E}\` because the ${X.map((te) => `\`${te}\``)} variant does not exist.`);
                {
                  let te = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
                  throw new Error(`Cannot apply utility class \`${E}\` because the ${te.format(X.map((i) => `\`${i}\``))} variants do not exist.`);
                }
              }
            }
          }
          throw r.theme.size === 0 ? new Error(`Cannot apply unknown utility class \`${E}\`. Are you using CSS modules or similar and missing \`@reference\`? https://tailwindcss.com/docs/functions-and-directives#reference-directive`) : new Error(`Cannot apply unknown utility class \`${E}\``);
        } }), z = f.src, K = D.astNodes.map((E) => {
          let U = D.nodeSorting.get(E)?.candidate, B = U ? k[U] : void 0;
          if (E = re(E), !z || !U || B === void 0) return _([E], (X) => {
            X.src = z;
          }), E;
          let W = [z[0], z[1], z[2]];
          return W[1] += 7 + B, W[2] = W[1] + U.length, _([E], (X) => {
            X.src = W;
          }), E;
        }), j = [];
        for (let E of K) if (E.kind === "rule") for (let U of E.nodes) j.push(U);
        else j.push(E);
        return R.Replace(j);
      }
    });
    return o;
  }
  function* no(e, r) {
    for (let o of e.params.split(/\s+/g)) for (let t of r.parseCandidate(o)) switch (t.kind) {
      case "arbitrary":
        break;
      case "static":
      case "functional":
        yield t.root;
        break;
      default:
    }
  }
  async function Gt(e, r, o, t = 0, l = false) {
    let s = 0, a = [];
    return _(e, (d) => {
      if (d.kind === "at-rule" && (d.name === "@import" || d.name === "@reference")) {
        let m = fn(q(d.params));
        if (m === null) return;
        d.name === "@reference" && (m.media = "reference"), s |= 2;
        let { uri: u, layer: h, media: p, supports: f } = m;
        if (u.startsWith("data:") || u.startsWith("http://") || u.startsWith("https://")) return;
        let v = pe({}, []);
        return a.push((async () => {
          if (t > 100) throw new Error(`Exceeded maximum recursion depth while resolving \`${u}\` in \`${r}\`)`);
          let k = await o(u, r), b = Ee(k.content, { from: l ? k.path : void 0 });
          await Gt(b, k.base, o, t + 1, l), v.nodes = pn(d, [pe({ base: k.base }, b)], h, p, f);
        })()), R.ReplaceSkip(v);
      }
    }), a.length > 0 && await Promise.all(a), s;
  }
  function fn(e) {
    let r, o = null, t = null, l = null;
    for (let s = 0; s < e.length; s++) {
      let a = e[s];
      if (a.kind !== "separator") {
        if (a.kind === "word" && !r) {
          if (!a.value || a.value[0] !== '"' && a.value[0] !== "'") return null;
          r = a.value.slice(1, -1);
          continue;
        }
        if (a.kind === "function" && a.value.toLowerCase() === "url" || !r) return null;
        if ((a.kind === "word" || a.kind === "function") && a.value.toLowerCase() === "layer") {
          if (o) return null;
          if (l) throw new Error("`layer(\u2026)` in an `@import` should come before any other functions or conditions");
          "nodes" in a ? o = Y(a.nodes) : o = "";
          continue;
        }
        if (a.kind === "function" && a.value.toLowerCase() === "supports") {
          if (l) return null;
          l = Y(a.nodes);
          continue;
        }
        t = Y(e.slice(s));
        break;
      }
    }
    return r ? { uri: r, layer: o, media: t, supports: l } : null;
  }
  function pn(e, r, o, t, l) {
    let s = r;
    if (o !== null) {
      let a = M("@layer", o, s);
      a.src = e.src, s = [a];
    }
    if (t !== null) {
      let a = M("@media", t, s);
      a.src = e.src, s = [a];
    }
    if (l !== null) {
      let a = M("@supports", l[0] === "(" ? l : `(${l})`, s);
      a.src = e.src, s = [a];
    }
    return s;
  }
  function ze(e, r = null) {
    return Array.isArray(e) && e.length === 2 && typeof e[1] == "object" && typeof e[1] !== null ? r ? e[1][r] ?? null : e[0] : Array.isArray(e) && r === null ? e.join(", ") : typeof e == "string" && r === null ? e : null;
  }
  function lo(e, { theme: r }, o) {
    for (let t of o) {
      let l = gt([t]);
      l && e.theme.clearNamespace(`--${l}`, 4);
    }
    for (let [t, l] of dn(r)) {
      if (typeof l != "string" && typeof l != "number") continue;
      if (typeof l == "string" && (l = l.replace(/<alpha-value>/g, "1")), t[0] === "opacity" && (typeof l == "number" || typeof l == "string")) {
        let a = typeof l == "string" ? parseFloat(l) : l;
        a >= 0 && a <= 1 && (l = a * 100 + "%");
      }
      let s = gt(t);
      s && e.theme.add(`--${s}`, "" + l, 7);
    }
    if (Object.hasOwn(r, "fontFamily")) {
      let t = 5;
      {
        let l = ze(r.fontFamily.sans);
        l && e.theme.hasDefault("--font-sans") && (e.theme.add("--default-font-family", l, t), e.theme.add("--default-font-feature-settings", ze(r.fontFamily.sans, "fontFeatureSettings") ?? "normal", t), e.theme.add("--default-font-variation-settings", ze(r.fontFamily.sans, "fontVariationSettings") ?? "normal", t));
      }
      {
        let l = ze(r.fontFamily.mono);
        l && e.theme.hasDefault("--font-mono") && (e.theme.add("--default-mono-font-family", l, t), e.theme.add("--default-mono-font-feature-settings", ze(r.fontFamily.mono, "fontFeatureSettings") ?? "normal", t), e.theme.add("--default-mono-font-variation-settings", ze(r.fontFamily.mono, "fontVariationSettings") ?? "normal", t));
      }
    }
    return r;
  }
  function dn(e) {
    let r = [];
    return ao(e, [], (o, t) => {
      if (kn(o)) return r.push([t, o]), 1;
      if (vn(o)) {
        r.push([t, o[0]]);
        for (let l of Reflect.ownKeys(o[1])) r.push([[...t, `-${l}`], o[1][l]]);
        return 1;
      }
      if (Array.isArray(o) && o.every((l) => typeof l == "string")) return t[0] === "fontSize" ? (r.push([t, o[0]]), o.length >= 2 && r.push([[...t, "-line-height"], o[1]])) : r.push([t, o.join(", ")]), 1;
    }), r;
  }
  var mn = { borderWidth: "border-width", outlineWidth: "outline-width", ringColor: "ring-color", ringWidth: "ring-width", transitionDuration: "transition-duration", transitionTimingFunction: "transition-timing-function" }, hn = { animation: "animate", aspectRatio: "aspect", borderRadius: "radius", boxShadow: "shadow", colors: "color", containers: "container", fontFamily: "font", fontSize: "text", letterSpacing: "tracking", lineHeight: "leading", maxWidth: "container", screens: "breakpoint", transitionTimingFunction: "ease" }, gn = /^[a-zA-Z0-9-_%/.]+$/;
  function gt(e) {
    let r = mn[e[0]];
    if (r && e[1] === "DEFAULT") return `default-${r}`;
    if (e[0] === "container") return null;
    for (let t of e) if (!gn.test(t)) return null;
    let o = hn[e[0]];
    return o && (e = e.slice(), e[0] = o), e.map((t, l, s) => t === "1" && l !== s.length - 1 ? "" : t).map((t, l) => (t = t.replaceAll(".", "_"), (l === 0 || t.startsWith("-") || t === "lineHeight") && (t = t.replace(/([a-z])([A-Z])/g, (a, d, m) => `${d}-${m.toLowerCase()}`)), t)).filter((t, l) => t !== "DEFAULT" || l !== e.length - 1).join("-");
  }
  function kn(e) {
    return typeof e == "number" || typeof e == "string";
  }
  function vn(e) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] != "string" && typeof e[0] != "number" || e[1] === void 0 || e[1] === null || typeof e[1] != "object") return false;
    for (let r of Reflect.ownKeys(e[1])) if (typeof r != "string" || typeof e[1][r] != "string" && typeof e[1][r] != "number") return false;
    return true;
  }
  function ao(e, r = [], o) {
    for (let t of Reflect.ownKeys(e)) {
      let l = e[t];
      if (l == null) continue;
      let s = [...r, t], a = o(l, s) ?? 0;
      if (a !== 1) {
        if (a === 2) return 2;
        if (!(!Array.isArray(l) && typeof l != "object") && ao(l, s, o) === 2) return 2;
      }
    }
  }
  function bn(e) {
    return { kind: "combinator", value: e };
  }
  function Yt(e) {
    return { kind: "complex", nodes: e };
  }
  function so(e) {
    return { kind: "compound", nodes: e };
  }
  function wn(e, r) {
    return { kind: "function", value: e, nodes: r };
  }
  function yn(e) {
    return { kind: "list", nodes: e };
  }
  function xe(e) {
    return { kind: "selector", value: e };
  }
  function xn(e) {
    return { kind: "value", value: e };
  }
  function Se(e, r = false) {
    let o = "";
    for (let t of e) switch (t.kind) {
      case "selector":
      case "value": {
        o += t.value;
        break;
      }
      case "combinator": {
        r || t.value === " " ? o += t.value : o += ` ${t.value} `;
        break;
      }
      case "function": {
        o += `${t.value}(${Se(t.nodes, r)})`;
        break;
      }
      case "complex":
      case "compound": {
        o += Se(t.nodes, r);
        break;
      }
      case "list": {
        o += t.nodes.map((l) => Se([l], r)).join(r ? "," : ", ");
        break;
      }
    }
    return o;
  }
  var uo = 92, An = 93, co = 41, fo = 58, po = 44, Cn = 34, Nn = 46, mo = 62, Zt = 10, Tn = 35, ho = 91, go = 40, ko = 43, $n = 39, Jt = 32, Qt = 9, vo = 126, Sn = 38, Vn = 42;
  function kt(e) {
    e = e.replaceAll(`\r
`, `
`);
    let r = [], o = r, t = false, l = [], s = null, a = "", d;
    function m(h = o) {
      return h.length === 1 ? h[0] : t ? Yt(h) : so(h);
    }
    function u(h) {
      let p = o[o.length - 1];
      p?.kind === "compound" ? p.nodes.push(h) : p && p.kind !== "list" && p.kind !== "combinator" ? o[o.length - 1] = so([p, h]) : o.push(h);
    }
    for (let h = 0; h < e.length; h++) {
      let p = e.charCodeAt(h);
      switch (p) {
        case po: {
          for (a.length > 0 && (u(xe(a)), a = ""); h + 1 < e.length && (d = e.charCodeAt(h + 1), !(d !== Zt && d !== Jt && d !== Qt)); h++) ;
          if (s) s.nodes.push(m()), o = [], t = false;
          else {
            let f = o.splice(0), v = m(f), k = yn([v]);
            o.push(k), s = k, o = [], t = false;
          }
          break;
        }
        case mo:
        case Zt:
        case Jt:
        case ko:
        case Qt:
        case vo: {
          a.length > 0 && (u(xe(a)), a = "");
          let f = h, v = h + 1;
          for (; v < e.length && (d = e.charCodeAt(v), !(d !== mo && d !== Zt && d !== Jt && d !== ko && d !== Qt && d !== vo)); v++) ;
          h = v - 1;
          let k = e.slice(f, v).trim();
          if (k === "" && (o.length === 0 || v >= e.length || e.charCodeAt(v) === po)) break;
          o.push(bn(k === "" ? " " : k)), t = true;
          break;
        }
        case go: {
          let f = wn(a, []);
          if (a = "", f.value !== ":not" && f.value !== ":where" && f.value !== ":has" && f.value !== ":is") {
            let v = h + 1, k = 0;
            for (let x = h + 1; x < e.length; x++) {
              if (d = e.charCodeAt(x), d === go) {
                k++;
                continue;
              }
              if (d === co) {
                if (k === 0) {
                  h = x;
                  break;
                }
                k--;
              }
            }
            let b = h;
            f.nodes.push(xn(e.slice(v, b))), a = "", h = b, u(f);
            break;
          }
          u(f), l.push({ target: o, currentList: s, containsCombinator: t }), o = f.nodes, t = false, s = null;
          break;
        }
        case co: {
          a.length > 0 && (u(xe(a)), a = ""), s ? s.nodes.push(m()) : t && o.splice(0, o.length, Yt(o.splice(0)));
          let f = l.pop();
          o = f?.target ?? r, s = f?.currentList ?? null, t = f?.containsCombinator ?? false;
          break;
        }
        case Nn:
        case fo:
        case Tn: {
          if (p === fo && a === ":") {
            a += e[h];
            break;
          }
          a.length > 0 && u(xe(a)), a = e[h];
          break;
        }
        case ho: {
          a.length > 0 && u(xe(a)), a = "";
          let f = h, v = 0;
          for (let k = h + 1; k < e.length; k++) {
            if (d = e.charCodeAt(k), d === ho) {
              v++;
              continue;
            }
            if (d === An) {
              if (v === 0) {
                h = k;
                break;
              }
              v--;
            }
          }
          a += e.slice(f, h + 1);
          break;
        }
        case $n:
        case Cn: {
          let f = h;
          for (let v = h + 1; v < e.length; v++) if (d = e.charCodeAt(v), d === uo) v += 1;
          else if (d === p) {
            h = v;
            break;
          }
          a += e.slice(f, h + 1);
          break;
        }
        case Sn:
        case Vn: {
          a.length > 0 && (u(xe(a)), a = ""), u(xe(e[h]));
          break;
        }
        case uo: {
          a += e[h] + e[h + 1], h += 1;
          break;
        }
        default:
          a += e[h];
      }
    }
    return a.length > 0 && u(xe(a)), s ? s.nodes.push(m()) : t && o.splice(0, o.length, Yt(o.splice(0))), r;
  }
  function vt(e) {
    let r = [];
    for (let o of L(e, ".")) {
      if (!o.includes("[")) {
        r.push(o);
        continue;
      }
      let t = 0;
      for (; ; ) {
        let l = o.indexOf("[", t), s = o.indexOf("]", l);
        if (l === -1 || s === -1) break;
        l > t && r.push(o.slice(t, l)), r.push(o.slice(l + 1, s)), t = s + 1;
      }
      t <= o.length - 1 && r.push(o.slice(t));
    }
    return r;
  }
  function _e(e) {
    if (Object.prototype.toString.call(e) !== "[object Object]") return false;
    let r = Object.getPrototypeOf(e);
    return r === null || Object.getPrototypeOf(r) === null;
  }
  function Ge(e, r, o, t = []) {
    for (let l of r) if (l != null) for (let s of Reflect.ownKeys(l)) {
      t.push(s);
      let a = o(e[s], l[s], t);
      a !== void 0 ? e[s] = a : !_e(e[s]) || !_e(l[s]) ? e[s] = l[s] : e[s] = Ge({}, [e[s], l[s]], o, t), t.pop();
    }
    return e;
  }
  function bt(e, r, o) {
    return function(l, s) {
      let a = l.lastIndexOf("/"), d = null;
      a !== -1 && (d = l.slice(a + 1).trim(), l = l.slice(0, a).trim());
      let m = (() => {
        let u = vt(l), [h, p] = Rn(e.theme, u), f = o(bo(r() ?? {}, u) ?? null);
        if (typeof f == "string" && (f = f.replace("<alpha-value>", "1")), typeof h != "object") return typeof p != "object" && p & 4 ? f ?? h : h;
        if (f !== null && typeof f == "object" && !Array.isArray(f)) {
          let v = Ge({}, [f], (k, b) => b);
          if (h === null && Object.hasOwn(f, "__CSS_VALUES__")) {
            let k = {};
            for (let b in f.__CSS_VALUES__) k[b] = f[b], delete v[b];
            h = k;
          }
          for (let k in h) k !== "__CSS_VALUES__" && (f?.__CSS_VALUES__?.[k] & 4 && bo(v, k.split("-")) !== void 0 || (v[me(k)] = h[k]));
          return v;
        }
        if (Array.isArray(h) && Array.isArray(p) && Array.isArray(f)) {
          let v = h[0], k = h[1];
          p[0] & 4 && (v = f[0] ?? v);
          for (let b of Object.keys(k)) p[1][b] & 4 && (k[b] = f[1][b] ?? k[b]);
          return [v, k];
        }
        return h ?? f;
      })();
      return d && typeof m == "string" && (m = Q(m, d)), m ?? s;
    };
  }
  function Rn(e, r) {
    if (r.length === 1 && r[0].startsWith("--")) return [e.get([r[0]]), e.getOptions(r[0])];
    let o = gt(r), t = /* @__PURE__ */ new Map(), l = new H(() => /* @__PURE__ */ new Map()), s = e.namespace(`--${o}`);
    if (s.size === 0) return [null, 0];
    let a = /* @__PURE__ */ new Map();
    for (let [h, p] of s) {
      if (!h || !h.includes("--")) {
        t.set(h, p), a.set(h, e.getOptions(h ? `--${o}-${h}` : `--${o}`));
        continue;
      }
      let f = h.indexOf("--"), v = h.slice(0, f), k = h.slice(f + 2);
      k = k.replace(/-([a-z])/g, (b, x) => x.toUpperCase()), l.get(v === "" ? null : v).set(k, [p, e.getOptions(`--${o}${h}`)]);
    }
    let d = e.getOptions(`--${o}`);
    for (let [h, p] of l) {
      let f = t.get(h);
      if (typeof f != "string") continue;
      let v = {}, k = {};
      for (let [b, [x, O]] of p) v[b] = x, k[b] = O;
      t.set(h, [f, v]), a.set(h, [d, k]);
    }
    let m = {}, u = {};
    for (let [h, p] of t) wo(m, [h ?? "DEFAULT"], p);
    for (let [h, p] of a) wo(u, [h ?? "DEFAULT"], p);
    return r[r.length - 1] === "DEFAULT" ? [m?.DEFAULT ?? null, u.DEFAULT ?? 0] : "DEFAULT" in m && Object.keys(m).length === 1 ? [m.DEFAULT, u.DEFAULT ?? 0] : (m.__CSS_VALUES__ = u, [m, u]);
  }
  function bo(e, r) {
    for (let o = 0; o < r.length; ++o) {
      let t = r[o];
      if (e == null || typeof e != "object" || !Object.hasOwn(e, t)) {
        if (r[o + 1] === void 0) return;
        r[o + 1] = `${t}-${r[o + 1]}`;
        continue;
      }
      e = e[t];
    }
    return e;
  }
  function wo(e, r, o) {
    for (let t of r.slice(0, -1)) e[t] === void 0 && (e[t] = {}), e = e[t];
    e[r[r.length - 1]] = o;
  }
  var yo = /^[a-z@][a-zA-Z0-9/%._-]*$/;
  function Xt({ designSystem: e, ast: r, resolvedConfig: o, featuresRef: t, referenceMode: l, src: s }) {
    let a = { addBase(d) {
      if (l) return;
      let m = de(d);
      t.current |= Pe(m, e);
      let u = M("@layer", "base", m);
      _([u], (h) => {
        h.src = s;
      }), r.push(u);
    }, addVariant(d, m) {
      if (!mt.test(d)) throw new Error(`\`addVariant('${d}')\` defines an invalid variant name. Variants should only contain alphanumeric, dashes, or underscore characters and start with a lowercase letter or number.`);
      if (typeof m == "string") {
        if (m.includes(":merge(")) return;
      } else if (Array.isArray(m)) {
        if (m.some((h) => h.includes(":merge("))) return;
      } else if (typeof m == "object") {
        let h = function(p, f) {
          return Object.entries(p).some(([v, k]) => v.includes(f) || typeof k == "object" && h(k, f));
        };
        var u = h;
        if (h(m, ":merge(")) return;
      }
      typeof m == "string" || Array.isArray(m) ? e.variants.static(d, (h) => {
        h.nodes = xo(m, h.nodes);
      }, { compounds: $e(typeof m == "string" ? [m] : m) }) : typeof m == "object" && e.variants.fromAst(d, de(m), e);
    }, matchVariant(d, m, u) {
      function h(f, v, k) {
        let b = m(f, { modifier: v?.value ?? null });
        return xo(b, k);
      }
      try {
        let f = m("a", { modifier: null });
        if (typeof f == "string" && f.includes(":merge(")) return;
        if (Array.isArray(f) && f.some((v) => v.includes(":merge("))) return;
      } catch {
      }
      let p = Object.keys(u?.values ?? {});
      e.variants.group(() => {
        e.variants.functional(d, (f, v) => {
          if (!v.value) {
            if (u?.values && "DEFAULT" in u.values) {
              f.nodes = h(u.values.DEFAULT, v.modifier, f.nodes);
              return;
            }
            return null;
          }
          if (v.value.kind === "arbitrary") f.nodes = h(v.value.value, v.modifier, f.nodes);
          else if (v.value.kind === "named" && u?.values) {
            if (!Object.hasOwn(u.values, v.value.value)) return null;
            let k = u.values[v.value.value];
            if (typeof k != "string") return null;
            f.nodes = h(k, v.modifier, f.nodes);
          } else return null;
        });
      }, (f, v) => {
        if (f.kind !== "functional" || v.kind !== "functional") return 0;
        let k = f.value ? f.value.value : "DEFAULT", b = v.value ? v.value.value : "DEFAULT", x = (u?.values && Object.hasOwn(u.values, k) ? u.values[k] : void 0) ?? k, O = (u?.values && Object.hasOwn(u.values, b) ? u.values[b] : void 0) ?? b;
        if (u && typeof u.sort == "function") return u.sort({ value: x, modifier: f.modifier?.value ?? null }, { value: O, modifier: v.modifier?.value ?? null });
        let C = p.indexOf(k), y = p.indexOf(b);
        return C = C === -1 ? p.length : C, y = y === -1 ? p.length : y, C !== y ? C - y : x < O ? -1 : 1;
      }), e.variants.suggest(d, () => Object.keys(u?.values ?? {}).filter((f) => f !== "DEFAULT"));
    }, addUtilities(d) {
      d = Array.isArray(d) ? d : [d];
      let m = d.flatMap((h) => Object.entries(h));
      m = m.flatMap(([h, p]) => L(h, ",").map((f) => [f.trim(), p]));
      let u = new H(() => []);
      for (let [h, p] of m) {
        if (h.startsWith("@keyframes ")) {
          if (!l) {
            let k = Z(h, de(p));
            _([k], (b) => {
              b.src = s;
            }), r.push(k);
          }
          continue;
        }
        let f = kt(h), v = false;
        if (_(f, (k) => {
          if (k.kind === "selector" && k.value[0] === "." && yo.test(k.value.slice(1))) {
            let b = k.value;
            k.value = "&";
            let x = Se(f), O = b.slice(1), C = x === "&" ? de(p) : [Z(x, de(p))];
            u.get(O).push(...C), v = true, k.value = b;
            return;
          }
          if (k.kind === "function" && k.value === ":not") return R.Skip;
        }), !v) throw new Error(`\`addUtilities({ '${h}' : \u2026 })\` defines an invalid utility selector. Utilities must be a single class name and start with a lowercase letter, eg. \`.scrollbar-none\`.`);
      }
      for (let [h, p] of u) e.theme.prefix && _(p, (f) => {
        if (f.kind === "rule") {
          let v = kt(f.selector);
          _(v, (k) => {
            k.kind === "selector" && k.value[0] === "." && (k.value = `.${e.theme.prefix}\\:${k.value.slice(1)}`);
          }), f.selector = Se(v);
        }
      }), e.utilities.static(h, (f) => {
        let v = p.map(re);
        return Ao(v, h, f.raw), t.current |= He(v, e), v;
      });
    }, matchUtilities(d, m) {
      let u = m?.type ? Array.isArray(m?.type) ? m.type : [m.type] : ["any"];
      for (let [p, f] of Object.entries(d)) {
        let v = function({ negative: k }) {
          return (b) => {
            if (b.value?.kind === "arbitrary" && u.length > 0 && !u.includes("any") && (b.value.dataType && !u.includes(b.value.dataType) || !b.value.dataType && !J(b.value.value, u))) return;
            let x = u.includes("color"), O = null, C = false;
            {
              let z = m?.values ?? {};
              x && (z = Object.assign({ inherit: "inherit", transparent: "transparent", current: "currentcolor" }, z)), b.value ? b.value.kind === "arbitrary" ? O = b.value.value : b.value.fraction && Object.hasOwn(z, b.value.fraction) ? (O = z[b.value.fraction], C = true) : Object.hasOwn(z, b.value.value) ? O = z[b.value.value] : z.__BARE_VALUE__ && (O = z.__BARE_VALUE__(b.value) ?? null, C = (b.value.fraction !== null && O?.includes("/")) ?? false) : O = z.DEFAULT ?? null;
            }
            if (O === null) return;
            let y;
            {
              let z = m?.modifiers ?? null;
              b.modifier ? z === "any" || b.modifier.kind === "arbitrary" ? y = b.modifier.value : z && Object.hasOwn(z, b.modifier.value) ? y = z[b.modifier.value] : x && !Number.isNaN(Number(b.modifier.value)) ? y = `${b.modifier.value}%` : y = null : y = null;
            }
            if (b.modifier && y === null && !C) return b.value?.kind === "arbitrary" ? null : void 0;
            x && y !== null && (O = Q(O, y)), k && (O = `calc(${O} * -1)`);
            let D = de(f(O, { modifier: y }));
            return Ao(D, p, b.raw), t.current |= He(D, e), D;
          };
        };
        var h = v;
        if (!yo.test(p)) throw new Error(`\`matchUtilities({ '${p}' : \u2026 })\` defines an invalid utility name. Utilities should be alphanumeric and start with a lowercase letter, eg. \`scrollbar\`.`);
        m?.supportsNegativeValues && e.utilities.functional(`-${p}`, v({ negative: true }), { types: u }), e.utilities.functional(p, v({ negative: false }), { types: u }), e.utilities.suggest(p, () => {
          let k = m?.values ?? {}, b = new Set(Object.keys(k));
          b.delete("__BARE_VALUE__"), b.delete("__CSS_VALUES__"), b.has("DEFAULT") && (b.delete("DEFAULT"), b.add(null));
          let x = m?.modifiers ?? {}, O = x === "any" ? [] : Object.keys(x);
          return [{ supportsNegative: m?.supportsNegativeValues ?? false, values: Array.from(b), modifiers: O }];
        });
      }
    }, addComponents(d, m) {
      this.addUtilities(d, m);
    }, matchComponents(d, m) {
      this.matchUtilities(d, m);
    }, theme: bt(e, () => o.theme ?? {}, (d) => d), prefix(d) {
      return d;
    }, config(d, m) {
      let u = o;
      if (!d) return u;
      let h = vt(d);
      for (let p = 0; p < h.length; ++p) {
        let f = h[p];
        if (u[f] === void 0) return m;
        u = u[f];
      }
      return u ?? m;
    } };
    return a.addComponents = a.addComponents.bind(a), a.matchComponents = a.matchComponents.bind(a), a;
  }
  function de(e) {
    let r = [];
    e = Array.isArray(e) ? e : [e];
    let o = e.flatMap((t) => Object.entries(t));
    for (let [t, l] of o) if (l != null && l !== false) if (typeof l != "object") {
      if (!t.startsWith("--")) {
        if (l === "@slot") {
          r.push(Z(t, [M("@slot")]));
          continue;
        }
        t = t.replace(/([A-Z])/g, "-$1").toLowerCase();
      }
      r.push(n(t, String(l)));
    } else if (Array.isArray(l)) for (let s of l) typeof s == "string" ? r.push(n(t, s)) : r.push(Z(t, de(s)));
    else r.push(Z(t, de(l)));
    return r;
  }
  function xo(e, r) {
    return (typeof e == "string" ? [e] : e).flatMap((t) => {
      if (t.trim().endsWith("}")) {
        let l = t.replace("}", "{@slot}}"), s = Ee(l);
        return qt(s, r), s;
      } else return Z(t, r);
    });
  }
  function Ao(e, r, o) {
    _(e, (t) => {
      if (t.kind === "rule") {
        let l = kt(t.selector);
        _(l, (s) => {
          s.kind === "selector" && s.value === `.${r}` && (s.value = `.${be(o)}`);
        }), t.selector = Se(l);
      }
    });
  }
  function Co(e, r) {
    for (let o of On(r)) e.theme.addKeyframes(o);
  }
  function On(e) {
    let r = [];
    if ("keyframes" in e.theme) for (let [o, t] of Object.entries(e.theme.keyframes)) r.push(M("@keyframes", o, de(t)));
    return r;
  }
  var wt = { inherit: "inherit", current: "currentcolor", transparent: "transparent", black: "#000", white: "#fff", slate: { 50: "oklch(98.4% 0.003 247.858)", 100: "oklch(96.8% 0.007 247.896)", 200: "oklch(92.9% 0.013 255.508)", 300: "oklch(86.9% 0.022 252.894)", 400: "oklch(70.4% 0.04 256.788)", 500: "oklch(55.4% 0.046 257.417)", 600: "oklch(44.6% 0.043 257.281)", 700: "oklch(37.2% 0.044 257.287)", 800: "oklch(27.9% 0.041 260.031)", 900: "oklch(20.8% 0.042 265.755)", 950: "oklch(12.9% 0.042 264.695)" }, gray: { 50: "oklch(98.5% 0.002 247.839)", 100: "oklch(96.7% 0.003 264.542)", 200: "oklch(92.8% 0.006 264.531)", 300: "oklch(87.2% 0.01 258.338)", 400: "oklch(70.7% 0.022 261.325)", 500: "oklch(55.1% 0.027 264.364)", 600: "oklch(44.6% 0.03 256.802)", 700: "oklch(37.3% 0.034 259.733)", 800: "oklch(27.8% 0.033 256.848)", 900: "oklch(21% 0.034 264.665)", 950: "oklch(13% 0.028 261.692)" }, zinc: { 50: "oklch(98.5% 0 0)", 100: "oklch(96.7% 0.001 286.375)", 200: "oklch(92% 0.004 286.32)", 300: "oklch(87.1% 0.006 286.286)", 400: "oklch(70.5% 0.015 286.067)", 500: "oklch(55.2% 0.016 285.938)", 600: "oklch(44.2% 0.017 285.786)", 700: "oklch(37% 0.013 285.805)", 800: "oklch(27.4% 0.006 286.033)", 900: "oklch(21% 0.006 285.885)", 950: "oklch(14.1% 0.005 285.823)" }, neutral: { 50: "oklch(98.5% 0 0)", 100: "oklch(97% 0 0)", 200: "oklch(92.2% 0 0)", 300: "oklch(87% 0 0)", 400: "oklch(70.8% 0 0)", 500: "oklch(55.6% 0 0)", 600: "oklch(43.9% 0 0)", 700: "oklch(37.1% 0 0)", 800: "oklch(26.9% 0 0)", 900: "oklch(20.5% 0 0)", 950: "oklch(14.5% 0 0)" }, stone: { 50: "oklch(98.5% 0.001 106.423)", 100: "oklch(97% 0.001 106.424)", 200: "oklch(92.3% 0.003 48.717)", 300: "oklch(86.9% 0.005 56.366)", 400: "oklch(70.9% 0.01 56.259)", 500: "oklch(55.3% 0.013 58.071)", 600: "oklch(44.4% 0.011 73.639)", 700: "oklch(37.4% 0.01 67.558)", 800: "oklch(26.8% 0.007 34.298)", 900: "oklch(21.6% 0.006 56.043)", 950: "oklch(14.7% 0.004 49.25)" }, mauve: { 50: "oklch(98.5% 0 0)", 100: "oklch(96% 0.003 325.6)", 200: "oklch(92.2% 0.005 325.62)", 300: "oklch(86.5% 0.012 325.68)", 400: "oklch(71.1% 0.019 323.02)", 500: "oklch(54.2% 0.034 322.5)", 600: "oklch(43.5% 0.029 321.78)", 700: "oklch(36.4% 0.029 323.89)", 800: "oklch(26.3% 0.024 320.12)", 900: "oklch(21.2% 0.019 322.12)", 950: "oklch(14.5% 0.008 326)" }, olive: { 50: "oklch(98.8% 0.003 106.5)", 100: "oklch(96.6% 0.005 106.5)", 200: "oklch(93% 0.007 106.5)", 300: "oklch(88% 0.011 106.6)", 400: "oklch(73.7% 0.021 106.9)", 500: "oklch(58% 0.031 107.3)", 600: "oklch(46.6% 0.025 107.3)", 700: "oklch(39.4% 0.023 107.4)", 800: "oklch(28.6% 0.016 107.4)", 900: "oklch(22.8% 0.013 107.4)", 950: "oklch(15.3% 0.006 107.1)" }, mist: { 50: "oklch(98.7% 0.002 197.1)", 100: "oklch(96.3% 0.002 197.1)", 200: "oklch(92.5% 0.005 214.3)", 300: "oklch(87.2% 0.007 219.6)", 400: "oklch(72.3% 0.014 214.4)", 500: "oklch(56% 0.021 213.5)", 600: "oklch(45% 0.017 213.2)", 700: "oklch(37.8% 0.015 216)", 800: "oklch(27.5% 0.011 216.9)", 900: "oklch(21.8% 0.008 223.9)", 950: "oklch(14.8% 0.004 228.8)" }, taupe: { 50: "oklch(98.6% 0.002 67.8)", 100: "oklch(96% 0.002 17.2)", 200: "oklch(92.2% 0.005 34.3)", 300: "oklch(86.8% 0.007 39.5)", 400: "oklch(71.4% 0.014 41.2)", 500: "oklch(54.7% 0.021 43.1)", 600: "oklch(43.8% 0.017 39.3)", 700: "oklch(36.7% 0.016 35.7)", 800: "oklch(26.8% 0.011 36.5)", 900: "oklch(21.4% 0.009 43.1)", 950: "oklch(14.7% 0.004 49.3)" }, red: { 50: "oklch(97.1% 0.013 17.38)", 100: "oklch(93.6% 0.032 17.717)", 200: "oklch(88.5% 0.062 18.334)", 300: "oklch(80.8% 0.114 19.571)", 400: "oklch(70.4% 0.191 22.216)", 500: "oklch(63.7% 0.237 25.331)", 600: "oklch(57.7% 0.245 27.325)", 700: "oklch(50.5% 0.213 27.518)", 800: "oklch(44.4% 0.177 26.899)", 900: "oklch(39.6% 0.141 25.723)", 950: "oklch(25.8% 0.092 26.042)" }, orange: { 50: "oklch(98% 0.016 73.684)", 100: "oklch(95.4% 0.038 75.164)", 200: "oklch(90.1% 0.076 70.697)", 300: "oklch(83.7% 0.128 66.29)", 400: "oklch(75% 0.183 55.934)", 500: "oklch(70.5% 0.213 47.604)", 600: "oklch(64.6% 0.222 41.116)", 700: "oklch(55.3% 0.195 38.402)", 800: "oklch(47% 0.157 37.304)", 900: "oklch(40.8% 0.123 38.172)", 950: "oklch(26.6% 0.079 36.259)" }, amber: { 50: "oklch(98.7% 0.022 95.277)", 100: "oklch(96.2% 0.059 95.617)", 200: "oklch(92.4% 0.12 95.746)", 300: "oklch(87.9% 0.169 91.605)", 400: "oklch(82.8% 0.189 84.429)", 500: "oklch(76.9% 0.188 70.08)", 600: "oklch(66.6% 0.179 58.318)", 700: "oklch(55.5% 0.163 48.998)", 800: "oklch(47.3% 0.137 46.201)", 900: "oklch(41.4% 0.112 45.904)", 950: "oklch(27.9% 0.077 45.635)" }, yellow: { 50: "oklch(98.7% 0.026 102.212)", 100: "oklch(97.3% 0.071 103.193)", 200: "oklch(94.5% 0.129 101.54)", 300: "oklch(90.5% 0.182 98.111)", 400: "oklch(85.2% 0.199 91.936)", 500: "oklch(79.5% 0.184 86.047)", 600: "oklch(68.1% 0.162 75.834)", 700: "oklch(55.4% 0.135 66.442)", 800: "oklch(47.6% 0.114 61.907)", 900: "oklch(42.1% 0.095 57.708)", 950: "oklch(28.6% 0.066 53.813)" }, lime: { 50: "oklch(98.6% 0.031 120.757)", 100: "oklch(96.7% 0.067 122.328)", 200: "oklch(93.8% 0.127 124.321)", 300: "oklch(89.7% 0.196 126.665)", 400: "oklch(84.1% 0.238 128.85)", 500: "oklch(76.8% 0.233 130.85)", 600: "oklch(64.8% 0.2 131.684)", 700: "oklch(53.2% 0.157 131.589)", 800: "oklch(45.3% 0.124 130.933)", 900: "oklch(40.5% 0.101 131.063)", 950: "oklch(27.4% 0.072 132.109)" }, green: { 50: "oklch(98.2% 0.018 155.826)", 100: "oklch(96.2% 0.044 156.743)", 200: "oklch(92.5% 0.084 155.995)", 300: "oklch(87.1% 0.15 154.449)", 400: "oklch(79.2% 0.209 151.711)", 500: "oklch(72.3% 0.219 149.579)", 600: "oklch(62.7% 0.194 149.214)", 700: "oklch(52.7% 0.154 150.069)", 800: "oklch(44.8% 0.119 151.328)", 900: "oklch(39.3% 0.095 152.535)", 950: "oklch(26.6% 0.065 152.934)" }, emerald: { 50: "oklch(97.9% 0.021 166.113)", 100: "oklch(95% 0.052 163.051)", 200: "oklch(90.5% 0.093 164.15)", 300: "oklch(84.5% 0.143 164.978)", 400: "oklch(76.5% 0.177 163.223)", 500: "oklch(69.6% 0.17 162.48)", 600: "oklch(59.6% 0.145 163.225)", 700: "oklch(50.8% 0.118 165.612)", 800: "oklch(43.2% 0.095 166.913)", 900: "oklch(37.8% 0.077 168.94)", 950: "oklch(26.2% 0.051 172.552)" }, teal: { 50: "oklch(98.4% 0.014 180.72)", 100: "oklch(95.3% 0.051 180.801)", 200: "oklch(91% 0.096 180.426)", 300: "oklch(85.5% 0.138 181.071)", 400: "oklch(77.7% 0.152 181.912)", 500: "oklch(70.4% 0.14 182.503)", 600: "oklch(60% 0.118 184.704)", 700: "oklch(51.1% 0.096 186.391)", 800: "oklch(43.7% 0.078 188.216)", 900: "oklch(38.6% 0.063 188.416)", 950: "oklch(27.7% 0.046 192.524)" }, cyan: { 50: "oklch(98.4% 0.019 200.873)", 100: "oklch(95.6% 0.045 203.388)", 200: "oklch(91.7% 0.08 205.041)", 300: "oklch(86.5% 0.127 207.078)", 400: "oklch(78.9% 0.154 211.53)", 500: "oklch(71.5% 0.143 215.221)", 600: "oklch(60.9% 0.126 221.723)", 700: "oklch(52% 0.105 223.128)", 800: "oklch(45% 0.085 224.283)", 900: "oklch(39.8% 0.07 227.392)", 950: "oklch(30.2% 0.056 229.695)" }, sky: { 50: "oklch(97.7% 0.013 236.62)", 100: "oklch(95.1% 0.026 236.824)", 200: "oklch(90.1% 0.058 230.902)", 300: "oklch(82.8% 0.111 230.318)", 400: "oklch(74.6% 0.16 232.661)", 500: "oklch(68.5% 0.169 237.323)", 600: "oklch(58.8% 0.158 241.966)", 700: "oklch(50% 0.134 242.749)", 800: "oklch(44.3% 0.11 240.79)", 900: "oklch(39.1% 0.09 240.876)", 950: "oklch(29.3% 0.066 243.157)" }, blue: { 50: "oklch(97% 0.014 254.604)", 100: "oklch(93.2% 0.032 255.585)", 200: "oklch(88.2% 0.059 254.128)", 300: "oklch(80.9% 0.105 251.813)", 400: "oklch(70.7% 0.165 254.624)", 500: "oklch(62.3% 0.214 259.815)", 600: "oklch(54.6% 0.245 262.881)", 700: "oklch(48.8% 0.243 264.376)", 800: "oklch(42.4% 0.199 265.638)", 900: "oklch(37.9% 0.146 265.522)", 950: "oklch(28.2% 0.091 267.935)" }, indigo: { 50: "oklch(96.2% 0.018 272.314)", 100: "oklch(93% 0.034 272.788)", 200: "oklch(87% 0.065 274.039)", 300: "oklch(78.5% 0.115 274.713)", 400: "oklch(67.3% 0.182 276.935)", 500: "oklch(58.5% 0.233 277.117)", 600: "oklch(51.1% 0.262 276.966)", 700: "oklch(45.7% 0.24 277.023)", 800: "oklch(39.8% 0.195 277.366)", 900: "oklch(35.9% 0.144 278.697)", 950: "oklch(25.7% 0.09 281.288)" }, violet: { 50: "oklch(96.9% 0.016 293.756)", 100: "oklch(94.3% 0.029 294.588)", 200: "oklch(89.4% 0.057 293.283)", 300: "oklch(81.1% 0.111 293.571)", 400: "oklch(70.2% 0.183 293.541)", 500: "oklch(60.6% 0.25 292.717)", 600: "oklch(54.1% 0.281 293.009)", 700: "oklch(49.1% 0.27 292.581)", 800: "oklch(43.2% 0.232 292.759)", 900: "oklch(38% 0.189 293.745)", 950: "oklch(28.3% 0.141 291.089)" }, purple: { 50: "oklch(97.7% 0.014 308.299)", 100: "oklch(94.6% 0.033 307.174)", 200: "oklch(90.2% 0.063 306.703)", 300: "oklch(82.7% 0.119 306.383)", 400: "oklch(71.4% 0.203 305.504)", 500: "oklch(62.7% 0.265 303.9)", 600: "oklch(55.8% 0.288 302.321)", 700: "oklch(49.6% 0.265 301.924)", 800: "oklch(43.8% 0.218 303.724)", 900: "oklch(38.1% 0.176 304.987)", 950: "oklch(29.1% 0.149 302.717)" }, fuchsia: { 50: "oklch(97.7% 0.017 320.058)", 100: "oklch(95.2% 0.037 318.852)", 200: "oklch(90.3% 0.076 319.62)", 300: "oklch(83.3% 0.145 321.434)", 400: "oklch(74% 0.238 322.16)", 500: "oklch(66.7% 0.295 322.15)", 600: "oklch(59.1% 0.293 322.896)", 700: "oklch(51.8% 0.253 323.949)", 800: "oklch(45.2% 0.211 324.591)", 900: "oklch(40.1% 0.17 325.612)", 950: "oklch(29.3% 0.136 325.661)" }, pink: { 50: "oklch(97.1% 0.014 343.198)", 100: "oklch(94.8% 0.028 342.258)", 200: "oklch(89.9% 0.061 343.231)", 300: "oklch(82.3% 0.12 346.018)", 400: "oklch(71.8% 0.202 349.761)", 500: "oklch(65.6% 0.241 354.308)", 600: "oklch(59.2% 0.249 0.584)", 700: "oklch(52.5% 0.223 3.958)", 800: "oklch(45.9% 0.187 3.815)", 900: "oklch(40.8% 0.153 2.432)", 950: "oklch(28.4% 0.109 3.907)" }, rose: { 50: "oklch(96.9% 0.015 12.422)", 100: "oklch(94.1% 0.03 12.58)", 200: "oklch(89.2% 0.058 10.001)", 300: "oklch(81% 0.117 11.638)", 400: "oklch(71.2% 0.194 13.428)", 500: "oklch(64.5% 0.246 16.439)", 600: "oklch(58.6% 0.253 17.585)", 700: "oklch(51.4% 0.222 16.935)", 800: "oklch(45.5% 0.188 13.697)", 900: "oklch(41% 0.159 10.272)", 950: "oklch(27.1% 0.105 12.094)" } };
  function Ve(e) {
    return { __BARE_VALUE__: e };
  }
  var ce = Ve((e) => {
    if (V(e.value)) return e.value;
  }), ne = Ve((e) => {
    if (V(e.value)) return `${e.value}%`;
  }), Ae = Ve((e) => {
    if (V(e.value)) return `${e.value}px`;
  }), No = Ve((e) => {
    if (V(e.value)) return `${e.value}ms`;
  }), yt = Ve((e) => {
    if (V(e.value)) return `${e.value}deg`;
  }), Pn = Ve((e) => {
    if (e.fraction === null) return;
    let [r, o] = L(e.fraction, "/");
    if (!(!V(r) || !V(o))) return e.fraction;
  }), To = Ve((e) => {
    if (V(Number(e.value))) return `repeat(${e.value}, minmax(0, 1fr))`;
  }), $o = { accentColor: ({ theme: e }) => e("colors"), animation: { none: "none", spin: "spin 1s linear infinite", ping: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite", pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite", bounce: "bounce 1s infinite" }, aria: { busy: 'busy="true"', checked: 'checked="true"', disabled: 'disabled="true"', expanded: 'expanded="true"', hidden: 'hidden="true"', pressed: 'pressed="true"', readonly: 'readonly="true"', required: 'required="true"', selected: 'selected="true"' }, aspectRatio: { auto: "auto", square: "1 / 1", video: "16 / 9", ...Pn }, backdropBlur: ({ theme: e }) => e("blur"), backdropBrightness: ({ theme: e }) => ({ ...e("brightness"), ...ne }), backdropContrast: ({ theme: e }) => ({ ...e("contrast"), ...ne }), backdropGrayscale: ({ theme: e }) => ({ ...e("grayscale"), ...ne }), backdropHueRotate: ({ theme: e }) => ({ ...e("hueRotate"), ...yt }), backdropInvert: ({ theme: e }) => ({ ...e("invert"), ...ne }), backdropOpacity: ({ theme: e }) => ({ ...e("opacity"), ...ne }), backdropSaturate: ({ theme: e }) => ({ ...e("saturate"), ...ne }), backdropSepia: ({ theme: e }) => ({ ...e("sepia"), ...ne }), backgroundColor: ({ theme: e }) => e("colors"), backgroundImage: { none: "none", "gradient-to-t": "linear-gradient(to top, var(--tw-gradient-stops))", "gradient-to-tr": "linear-gradient(to top right, var(--tw-gradient-stops))", "gradient-to-r": "linear-gradient(to right, var(--tw-gradient-stops))", "gradient-to-br": "linear-gradient(to bottom right, var(--tw-gradient-stops))", "gradient-to-b": "linear-gradient(to bottom, var(--tw-gradient-stops))", "gradient-to-bl": "linear-gradient(to bottom left, var(--tw-gradient-stops))", "gradient-to-l": "linear-gradient(to left, var(--tw-gradient-stops))", "gradient-to-tl": "linear-gradient(to top left, var(--tw-gradient-stops))" }, backgroundOpacity: ({ theme: e }) => e("opacity"), backgroundPosition: { bottom: "bottom", center: "center", left: "left", "left-bottom": "left bottom", "left-top": "left top", right: "right", "right-bottom": "right bottom", "right-top": "right top", top: "top" }, backgroundSize: { auto: "auto", cover: "cover", contain: "contain" }, blur: { 0: "0", none: "", sm: "4px", DEFAULT: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "40px", "3xl": "64px" }, borderColor: ({ theme: e }) => ({ DEFAULT: "currentcolor", ...e("colors") }), borderOpacity: ({ theme: e }) => e("opacity"), borderRadius: { none: "0px", sm: "0.125rem", DEFAULT: "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", full: "9999px" }, borderSpacing: ({ theme: e }) => e("spacing"), borderWidth: { DEFAULT: "1px", 0: "0px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, boxShadow: { sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)", DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)", md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)", lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)", xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)", "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)", inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)", none: "none" }, boxShadowColor: ({ theme: e }) => e("colors"), brightness: { 0: "0", 50: ".5", 75: ".75", 90: ".9", 95: ".95", 100: "1", 105: "1.05", 110: "1.1", 125: "1.25", 150: "1.5", 200: "2", ...ne }, caretColor: ({ theme: e }) => e("colors"), colors: () => ({ ...wt }), columns: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", "3xs": "16rem", "2xs": "18rem", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem", ...ce }, container: {}, content: { none: "none" }, contrast: { 0: "0", 50: ".5", 75: ".75", 100: "1", 125: "1.25", 150: "1.5", 200: "2", ...ne }, cursor: { auto: "auto", default: "default", pointer: "pointer", wait: "wait", text: "text", move: "move", help: "help", "not-allowed": "not-allowed", none: "none", "context-menu": "context-menu", progress: "progress", cell: "cell", crosshair: "crosshair", "vertical-text": "vertical-text", alias: "alias", copy: "copy", "no-drop": "no-drop", grab: "grab", grabbing: "grabbing", "all-scroll": "all-scroll", "col-resize": "col-resize", "row-resize": "row-resize", "n-resize": "n-resize", "e-resize": "e-resize", "s-resize": "s-resize", "w-resize": "w-resize", "ne-resize": "ne-resize", "nw-resize": "nw-resize", "se-resize": "se-resize", "sw-resize": "sw-resize", "ew-resize": "ew-resize", "ns-resize": "ns-resize", "nesw-resize": "nesw-resize", "nwse-resize": "nwse-resize", "zoom-in": "zoom-in", "zoom-out": "zoom-out" }, divideColor: ({ theme: e }) => e("borderColor"), divideOpacity: ({ theme: e }) => e("borderOpacity"), divideWidth: ({ theme: e }) => ({ ...e("borderWidth"), ...Ae }), dropShadow: { sm: "0 1px 1px rgb(0 0 0 / 0.05)", DEFAULT: ["0 1px 2px rgb(0 0 0 / 0.1)", "0 1px 1px rgb(0 0 0 / 0.06)"], md: ["0 4px 3px rgb(0 0 0 / 0.07)", "0 2px 2px rgb(0 0 0 / 0.06)"], lg: ["0 10px 8px rgb(0 0 0 / 0.04)", "0 4px 3px rgb(0 0 0 / 0.1)"], xl: ["0 20px 13px rgb(0 0 0 / 0.03)", "0 8px 5px rgb(0 0 0 / 0.08)"], "2xl": "0 25px 25px rgb(0 0 0 / 0.15)", none: "0 0 #0000" }, fill: ({ theme: e }) => e("colors"), flex: { 1: "1 1 0%", auto: "1 1 auto", initial: "0 1 auto", none: "none" }, flexBasis: ({ theme: e }) => ({ auto: "auto", "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%", "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%", "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%", "10/12": "83.333333%", "11/12": "91.666667%", full: "100%", ...e("spacing") }), flexGrow: { 0: "0", DEFAULT: "1", ...ce }, flexShrink: { 0: "0", DEFAULT: "1", ...ce }, fontFamily: { sans: ["ui-sans-serif", "system-ui", "sans-serif", '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'], serif: ["ui-serif", "Georgia", "Cambria", '"Times New Roman"', "Times", "serif"], mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", '"Liberation Mono"', '"Courier New"', "monospace"] }, fontSize: { xs: ["0.75rem", { lineHeight: "1rem" }], sm: ["0.875rem", { lineHeight: "1.25rem" }], base: ["1rem", { lineHeight: "1.5rem" }], lg: ["1.125rem", { lineHeight: "1.75rem" }], xl: ["1.25rem", { lineHeight: "1.75rem" }], "2xl": ["1.5rem", { lineHeight: "2rem" }], "3xl": ["1.875rem", { lineHeight: "2.25rem" }], "4xl": ["2.25rem", { lineHeight: "2.5rem" }], "5xl": ["3rem", { lineHeight: "1" }], "6xl": ["3.75rem", { lineHeight: "1" }], "7xl": ["4.5rem", { lineHeight: "1" }], "8xl": ["6rem", { lineHeight: "1" }], "9xl": ["8rem", { lineHeight: "1" }] }, fontWeight: { thin: "100", extralight: "200", light: "300", normal: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900" }, gap: ({ theme: e }) => e("spacing"), gradientColorStops: ({ theme: e }) => e("colors"), gradientColorStopPositions: { "0%": "0%", "5%": "5%", "10%": "10%", "15%": "15%", "20%": "20%", "25%": "25%", "30%": "30%", "35%": "35%", "40%": "40%", "45%": "45%", "50%": "50%", "55%": "55%", "60%": "60%", "65%": "65%", "70%": "70%", "75%": "75%", "80%": "80%", "85%": "85%", "90%": "90%", "95%": "95%", "100%": "100%", ...ne }, grayscale: { 0: "0", DEFAULT: "100%", ...ne }, gridAutoColumns: { auto: "auto", min: "min-content", max: "max-content", fr: "minmax(0, 1fr)" }, gridAutoRows: { auto: "auto", min: "min-content", max: "max-content", fr: "minmax(0, 1fr)" }, gridColumn: { auto: "auto", "span-1": "span 1 / span 1", "span-2": "span 2 / span 2", "span-3": "span 3 / span 3", "span-4": "span 4 / span 4", "span-5": "span 5 / span 5", "span-6": "span 6 / span 6", "span-7": "span 7 / span 7", "span-8": "span 8 / span 8", "span-9": "span 9 / span 9", "span-10": "span 10 / span 10", "span-11": "span 11 / span 11", "span-12": "span 12 / span 12", "span-full": "1 / -1" }, gridColumnEnd: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", ...ce }, gridColumnStart: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", ...ce }, gridRow: { auto: "auto", "span-1": "span 1 / span 1", "span-2": "span 2 / span 2", "span-3": "span 3 / span 3", "span-4": "span 4 / span 4", "span-5": "span 5 / span 5", "span-6": "span 6 / span 6", "span-7": "span 7 / span 7", "span-8": "span 8 / span 8", "span-9": "span 9 / span 9", "span-10": "span 10 / span 10", "span-11": "span 11 / span 11", "span-12": "span 12 / span 12", "span-full": "1 / -1" }, gridRowEnd: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", ...ce }, gridRowStart: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", ...ce }, gridTemplateColumns: { none: "none", subgrid: "subgrid", 1: "repeat(1, minmax(0, 1fr))", 2: "repeat(2, minmax(0, 1fr))", 3: "repeat(3, minmax(0, 1fr))", 4: "repeat(4, minmax(0, 1fr))", 5: "repeat(5, minmax(0, 1fr))", 6: "repeat(6, minmax(0, 1fr))", 7: "repeat(7, minmax(0, 1fr))", 8: "repeat(8, minmax(0, 1fr))", 9: "repeat(9, minmax(0, 1fr))", 10: "repeat(10, minmax(0, 1fr))", 11: "repeat(11, minmax(0, 1fr))", 12: "repeat(12, minmax(0, 1fr))", ...To }, gridTemplateRows: { none: "none", subgrid: "subgrid", 1: "repeat(1, minmax(0, 1fr))", 2: "repeat(2, minmax(0, 1fr))", 3: "repeat(3, minmax(0, 1fr))", 4: "repeat(4, minmax(0, 1fr))", 5: "repeat(5, minmax(0, 1fr))", 6: "repeat(6, minmax(0, 1fr))", 7: "repeat(7, minmax(0, 1fr))", 8: "repeat(8, minmax(0, 1fr))", 9: "repeat(9, minmax(0, 1fr))", 10: "repeat(10, minmax(0, 1fr))", 11: "repeat(11, minmax(0, 1fr))", 12: "repeat(12, minmax(0, 1fr))", ...To }, height: ({ theme: e }) => ({ auto: "auto", "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", full: "100%", screen: "100vh", svh: "100svh", lvh: "100lvh", dvh: "100dvh", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), hueRotate: { 0: "0deg", 15: "15deg", 30: "30deg", 60: "60deg", 90: "90deg", 180: "180deg", ...yt }, inset: ({ theme: e }) => ({ auto: "auto", "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", full: "100%", ...e("spacing") }), invert: { 0: "0", DEFAULT: "100%", ...ne }, keyframes: { spin: { to: { transform: "rotate(360deg)" } }, ping: { "75%, 100%": { transform: "scale(2)", opacity: "0" } }, pulse: { "50%": { opacity: ".5" } }, bounce: { "0%, 100%": { transform: "translateY(-25%)", animationTimingFunction: "cubic-bezier(0.8,0,1,1)" }, "50%": { transform: "none", animationTimingFunction: "cubic-bezier(0,0,0.2,1)" } } }, letterSpacing: { tighter: "-0.05em", tight: "-0.025em", normal: "0em", wide: "0.025em", wider: "0.05em", widest: "0.1em" }, lineHeight: { none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2", 3: ".75rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 7: "1.75rem", 8: "2rem", 9: "2.25rem", 10: "2.5rem" }, listStyleType: { none: "none", disc: "disc", decimal: "decimal" }, listStyleImage: { none: "none" }, margin: ({ theme: e }) => ({ auto: "auto", ...e("spacing") }), lineClamp: { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", ...ce }, maxHeight: ({ theme: e }) => ({ none: "none", full: "100%", screen: "100vh", svh: "100svh", lvh: "100lvh", dvh: "100dvh", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), maxWidth: ({ theme: e }) => ({ none: "none", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem", full: "100%", min: "min-content", max: "max-content", fit: "fit-content", prose: "65ch", ...e("spacing") }), minHeight: ({ theme: e }) => ({ full: "100%", screen: "100vh", svh: "100svh", lvh: "100lvh", dvh: "100dvh", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), minWidth: ({ theme: e }) => ({ full: "100%", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), objectPosition: { bottom: "bottom", center: "center", left: "left", "left-bottom": "left bottom", "left-top": "left top", right: "right", "right-bottom": "right bottom", "right-top": "right top", top: "top" }, opacity: { 0: "0", 5: "0.05", 10: "0.1", 15: "0.15", 20: "0.2", 25: "0.25", 30: "0.3", 35: "0.35", 40: "0.4", 45: "0.45", 50: "0.5", 55: "0.55", 60: "0.6", 65: "0.65", 70: "0.7", 75: "0.75", 80: "0.8", 85: "0.85", 90: "0.9", 95: "0.95", 100: "1", ...ne }, order: { first: "-9999", last: "9999", none: "0", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", ...ce }, outlineColor: ({ theme: e }) => e("colors"), outlineOffset: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, outlineWidth: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, padding: ({ theme: e }) => e("spacing"), placeholderColor: ({ theme: e }) => e("colors"), placeholderOpacity: ({ theme: e }) => e("opacity"), ringColor: ({ theme: e }) => ({ DEFAULT: "currentcolor", ...e("colors") }), ringOffsetColor: ({ theme: e }) => e("colors"), ringOffsetWidth: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, ringOpacity: ({ theme: e }) => ({ DEFAULT: "0.5", ...e("opacity") }), ringWidth: { DEFAULT: "3px", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, rotate: { 0: "0deg", 1: "1deg", 2: "2deg", 3: "3deg", 6: "6deg", 12: "12deg", 45: "45deg", 90: "90deg", 180: "180deg", ...yt }, saturate: { 0: "0", 50: ".5", 100: "1", 150: "1.5", 200: "2", ...ne }, scale: { 0: "0", 50: ".5", 75: ".75", 90: ".9", 95: ".95", 100: "1", 105: "1.05", 110: "1.1", 125: "1.25", 150: "1.5", ...ne }, screens: { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" }, scrollMargin: ({ theme: e }) => e("spacing"), scrollPadding: ({ theme: e }) => e("spacing"), sepia: { 0: "0", DEFAULT: "100%", ...ne }, skew: { 0: "0deg", 1: "1deg", 2: "2deg", 3: "3deg", 6: "6deg", 12: "12deg", ...yt }, space: ({ theme: e }) => e("spacing"), spacing: { px: "1px", 0: "0px", 0.5: "0.125rem", 1: "0.25rem", 1.5: "0.375rem", 2: "0.5rem", 2.5: "0.625rem", 3: "0.75rem", 3.5: "0.875rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 7: "1.75rem", 8: "2rem", 9: "2.25rem", 10: "2.5rem", 11: "2.75rem", 12: "3rem", 14: "3.5rem", 16: "4rem", 20: "5rem", 24: "6rem", 28: "7rem", 32: "8rem", 36: "9rem", 40: "10rem", 44: "11rem", 48: "12rem", 52: "13rem", 56: "14rem", 60: "15rem", 64: "16rem", 72: "18rem", 80: "20rem", 96: "24rem" }, stroke: ({ theme: e }) => ({ none: "none", ...e("colors") }), strokeWidth: { 0: "0", 1: "1", 2: "2", ...ce }, supports: {}, data: {}, textColor: ({ theme: e }) => e("colors"), textDecorationColor: ({ theme: e }) => e("colors"), textDecorationThickness: { auto: "auto", "from-font": "from-font", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, textIndent: ({ theme: e }) => e("spacing"), textOpacity: ({ theme: e }) => e("opacity"), textUnderlineOffset: { auto: "auto", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px", ...Ae }, transformOrigin: { center: "center", top: "top", "top-right": "top right", right: "right", "bottom-right": "bottom right", bottom: "bottom", "bottom-left": "bottom left", left: "left", "top-left": "top left" }, transitionDelay: { 0: "0s", 75: "75ms", 100: "100ms", 150: "150ms", 200: "200ms", 300: "300ms", 500: "500ms", 700: "700ms", 1e3: "1000ms", ...No }, transitionDuration: { DEFAULT: "150ms", 0: "0s", 75: "75ms", 100: "100ms", 150: "150ms", 200: "200ms", 300: "300ms", 500: "500ms", 700: "700ms", 1e3: "1000ms", ...No }, transitionProperty: { none: "none", all: "all", DEFAULT: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter", colors: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke", opacity: "opacity", shadow: "box-shadow", transform: "transform" }, transitionTimingFunction: { DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)", linear: "linear", in: "cubic-bezier(0.4, 0, 1, 1)", out: "cubic-bezier(0, 0, 0.2, 1)", "in-out": "cubic-bezier(0.4, 0, 0.2, 1)" }, translate: ({ theme: e }) => ({ "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", full: "100%", ...e("spacing") }), size: ({ theme: e }) => ({ auto: "auto", "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%", "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%", "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%", "10/12": "83.333333%", "11/12": "91.666667%", full: "100%", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), width: ({ theme: e }) => ({ auto: "auto", "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%", "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%", "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%", "10/12": "83.333333%", "11/12": "91.666667%", full: "100%", screen: "100vw", svw: "100svw", lvw: "100lvw", dvw: "100dvw", min: "min-content", max: "max-content", fit: "fit-content", ...e("spacing") }), willChange: { auto: "auto", scroll: "scroll-position", contents: "contents", transform: "transform" }, zIndex: { auto: "auto", 0: "0", 10: "10", 20: "20", 30: "30", 40: "40", 50: "50", ...ce } };
  function So(e) {
    return { theme: { ...$o, colors: ({ theme: r }) => r("color", {}), extend: { fontSize: ({ theme: r }) => ({ ...r("text", {}) }), boxShadow: ({ theme: r }) => ({ ...r("shadow", {}) }), animation: ({ theme: r }) => ({ ...r("animate", {}) }), aspectRatio: ({ theme: r }) => ({ ...r("aspect", {}) }), borderRadius: ({ theme: r }) => ({ ...r("radius", {}) }), screens: ({ theme: r }) => ({ ...r("breakpoint", {}) }), letterSpacing: ({ theme: r }) => ({ ...r("tracking", {}) }), lineHeight: ({ theme: r }) => ({ ...r("leading", {}) }), transitionDuration: { DEFAULT: e.get(["--default-transition-duration"]) ?? null }, transitionTimingFunction: { DEFAULT: e.get(["--default-transition-timing-function"]) ?? null }, maxWidth: ({ theme: r }) => ({ ...r("container", {}) }) } } };
  }
  var zn = { blocklist: [], future: {}, experimental: {}, prefix: "", important: false, darkMode: null, theme: {}, plugins: [], content: { files: [] } };
  function tr(e, r) {
    let o = { design: e, configs: [], plugins: [], content: { files: [] }, theme: {}, extend: {}, result: structuredClone(zn) };
    for (let l of r) er(o, l);
    for (let l of o.configs) "darkMode" in l && l.darkMode !== void 0 && (o.result.darkMode = l.darkMode ?? null), "prefix" in l && l.prefix !== void 0 && (o.result.prefix = l.prefix ?? ""), "blocklist" in l && l.blocklist !== void 0 && (o.result.blocklist = l.blocklist ?? []), "important" in l && l.important !== void 0 && (o.result.important = l.important ?? false);
    let t = Kn(o);
    return { resolvedConfig: { ...o.result, content: o.content, theme: o.theme, plugins: o.plugins }, replacedThemeKeys: t };
  }
  function _n(e, r) {
    if (Array.isArray(e) && _e(e[0])) return e.concat(r);
    if (Array.isArray(r) && _e(r[0]) && _e(e)) return [e, ...r];
    if (Array.isArray(r)) return r;
  }
  function er(e, { config: r, base: o, path: t, reference: l, src: s }) {
    let a = [];
    for (let u of r.plugins ?? []) "__isOptionsFunction" in u ? a.push({ ...u(), reference: l, src: s }) : "handler" in u ? a.push({ ...u, reference: l, src: s }) : a.push({ handler: u, reference: l, src: s });
    if (Array.isArray(r.presets) && r.presets.length === 0) throw new Error("Error in the config file/plugin/preset. An empty preset (`preset: []`) is not currently supported.");
    for (let u of r.presets ?? []) er(e, { path: t, base: o, config: u, reference: l, src: s });
    for (let u of a) e.plugins.push(u), u.config && er(e, { path: t, base: o, config: u.config, reference: !!u.reference, src: u.src ?? s });
    let d = r.content ?? [], m = Array.isArray(d) ? d : d.files;
    for (let u of m) e.content.files.push(typeof u == "object" ? u : { base: o, pattern: u });
    e.configs.push(r);
  }
  function Kn(e) {
    let r = /* @__PURE__ */ new Set(), o = bt(e.design, () => e.theme, l), t = Object.assign(o, { theme: o, colors: wt });
    function l(s) {
      return typeof s == "function" ? s(t) ?? null : s ?? null;
    }
    for (let s of e.configs) {
      let a = s.theme ?? {}, d = a.extend ?? {};
      for (let m in a) m !== "extend" && r.add(m);
      Object.assign(e.theme, a);
      for (let m in d) e.extend[m] ??= [], e.extend[m].push(d[m]);
    }
    delete e.theme.extend;
    for (let s in e.extend) {
      let a = [e.theme[s], ...e.extend[s]];
      e.theme[s] = () => {
        let d = a.map(l);
        return Ge({}, d, _n);
      };
    }
    for (let s in e.theme) e.theme[s] = l(e.theme[s]);
    if (e.theme.screens && typeof e.theme.screens == "object") for (let s of Object.keys(e.theme.screens)) {
      let a = e.theme.screens[s];
      a && typeof a == "object" && ("raw" in a || "max" in a || "min" in a && (e.theme.screens[s] = a.min));
    }
    return r;
  }
  function Vo(e, r) {
    let o = e.theme.container || {};
    if (typeof o != "object" || o === null) return;
    let t = Ln(o, r);
    t.length !== 0 && r.utilities.static("container", () => t.map(re));
  }
  function Ln({ center: e, padding: r, screens: o }, t) {
    let l = [], s = null;
    if (e && l.push(n("margin-inline", "auto")), (typeof r == "string" || typeof r == "object" && r !== null && "DEFAULT" in r) && l.push(n("padding-inline", typeof r == "string" ? r : r.DEFAULT)), typeof o == "object" && o !== null) {
      s = /* @__PURE__ */ new Map();
      let a = Array.from(t.theme.namespace("--breakpoint").entries());
      if (a.sort((d, m) => Ne(d[1], m[1], "asc")), a.length > 0) {
        let [d] = a[0];
        l.push(M("@media", `(width >= --theme(--breakpoint-${d}))`, [n("max-width", "none")]));
      }
      for (let [d, m] of Object.entries(o)) {
        if (typeof m == "object") if ("min" in m) m = m.min;
        else continue;
        s.set(d, M("@media", `(width >= ${m})`, [n("max-width", m)]));
      }
    }
    if (typeof r == "object" && r !== null) {
      let a = Object.entries(r).filter(([d]) => d !== "DEFAULT").map(([d, m]) => [d, t.theme.resolveValue(d, ["--breakpoint"]), m]).filter(Boolean);
      a.sort((d, m) => Ne(d[1], m[1], "asc"));
      for (let [d, , m] of a) if (s && s.has(d)) s.get(d).nodes.push(n("padding-inline", m));
      else {
        if (s) continue;
        l.push(M("@media", `(width >= theme(--breakpoint-${d}))`, [n("padding-inline", m)]));
      }
    }
    if (s) for (let [, a] of s) l.push(a);
    return l;
  }
  function Eo({ addVariant: e, config: r }) {
    let o = r("darkMode", null), [t, l = ".dark"] = Array.isArray(o) ? o : [o];
    if (t === "variant") {
      let s;
      if (Array.isArray(l) || typeof l == "function" ? s = l : typeof l == "string" && (s = [l]), Array.isArray(s)) for (let a of s) a === ".dark" ? (t = false, console.warn('When using `variant` for `darkMode`, you must provide a selector.\nExample: `darkMode: ["variant", ".your-selector &"]`')) : a.includes("&") || (t = false, console.warn('When using `variant` for `darkMode`, your selector must contain `&`.\nExample `darkMode: ["variant", ".your-selector &"]`'));
      l = s;
    }
    t === null || (t === "selector" ? e("dark", `&:where(${l}, ${l} *)`) : t === "media" ? e("dark", "@media (prefers-color-scheme: dark)") : t === "variant" ? e("dark", l) : t === "class" && e("dark", `&:is(${l} *)`));
  }
  function Ro(e) {
    for (let [o, t] of [["t", "top"], ["tr", "top right"], ["r", "right"], ["br", "bottom right"], ["b", "bottom"], ["bl", "bottom left"], ["l", "left"], ["tl", "top left"]]) e.utilities.suggest(`bg-gradient-to-${o}`, () => []), e.utilities.static(`bg-gradient-to-${o}`, () => [n("--tw-gradient-position", `to ${t} in oklab`), n("background-image", "linear-gradient(var(--tw-gradient-stops))")]);
    e.utilities.suggest("bg-left-top", () => []), e.utilities.static("bg-left-top", () => [n("background-position", "left top")]), e.utilities.suggest("bg-right-top", () => []), e.utilities.static("bg-right-top", () => [n("background-position", "right top")]), e.utilities.suggest("bg-left-bottom", () => []), e.utilities.static("bg-left-bottom", () => [n("background-position", "left bottom")]), e.utilities.suggest("bg-right-bottom", () => []), e.utilities.static("bg-right-bottom", () => [n("background-position", "right bottom")]), e.utilities.suggest("object-left-top", () => []), e.utilities.static("object-left-top", () => [n("object-position", "left top")]), e.utilities.suggest("object-right-top", () => []), e.utilities.static("object-right-top", () => [n("object-position", "right top")]), e.utilities.suggest("object-left-bottom", () => []), e.utilities.static("object-left-bottom", () => [n("object-position", "left bottom")]), e.utilities.suggest("object-right-bottom", () => []), e.utilities.static("object-right-bottom", () => [n("object-position", "right bottom")]), e.utilities.suggest("max-w-screen", () => []), e.utilities.functional("max-w-screen", (o) => {
      if (!o.value || o.value.kind === "arbitrary") return;
      let t = e.theme.resolve(o.value.value, ["--breakpoint"]);
      if (t) return [n("max-width", t)];
    }), e.utilities.suggest("overflow-ellipsis", () => []), e.utilities.static("overflow-ellipsis", () => [n("text-overflow", "ellipsis")]), e.utilities.suggest("decoration-slice", () => []), e.utilities.static("decoration-slice", () => [n("-webkit-box-decoration-break", "slice"), n("box-decoration-break", "slice")]), e.utilities.suggest("decoration-clone", () => []), e.utilities.static("decoration-clone", () => [n("-webkit-box-decoration-break", "clone"), n("box-decoration-break", "clone")]), e.utilities.suggest("flex-shrink", () => []), e.utilities.functional("flex-shrink", (o) => {
      if (!o.modifier) {
        if (!o.value) return [n("flex-shrink", "1")];
        if (o.value.kind === "arbitrary") return [n("flex-shrink", o.value.value)];
        if (V(o.value.value)) return [n("flex-shrink", o.value.value)];
      }
    }), e.utilities.suggest("flex-grow", () => []), e.utilities.functional("flex-grow", (o) => {
      if (!o.modifier) {
        if (!o.value) return [n("flex-grow", "1")];
        if (o.value.kind === "arbitrary") return [n("flex-grow", o.value.value)];
        if (V(o.value.value)) return [n("flex-grow", o.value.value)];
      }
    }), e.utilities.suggest("order-none", () => []), e.utilities.static("order-none", () => [n("order", "0")]), e.utilities.suggest("break-words", () => []), e.utilities.static("break-words", () => [n("overflow-wrap", "break-word")]);
    for (let [o, t] of [["start", "inset-inline-start"], ["end", "inset-inline-end"]]) {
      let l = function({ negative: s }) {
        return (a) => {
          if (a.value === null) return;
          if (a.value.kind === "arbitrary") {
            if (a.modifier) return;
            let m = a.value.value;
            return [n(t, s ? `calc(${m} * -1)` : m)];
          }
          let d = e.theme.resolve(a.value.fraction ?? a.value.value, ["--inset", "--spacing"]);
          if (d === null && a.value.fraction) {
            let [m, u] = L(a.value.fraction, "/");
            if (!V(m) || !V(u)) return;
            d = `calc(${a.value.fraction} * 100%)`;
          }
          if (d === null && s) {
            let m = e.theme.resolve(null, ["--spacing"]);
            if (m && le(a.value.value) && (d = `calc(${m} * -${a.value.value})`, d !== null)) return [n(t, d)];
          }
          if (d === null) {
            let m = e.theme.resolve(null, ["--spacing"]);
            m && le(a.value.value) && (d = `calc(${m} * ${a.value.value})`);
          }
          if (d !== null) return [n(t, s ? `calc(${d} * -1)` : d)];
        };
      };
      var r = l;
      e.utilities.static(`${o}-auto`, () => [n(t, "auto")]), e.utilities.static(`${o}-full`, () => [n(t, "100%")]), e.utilities.static(`-${o}-full`, () => [n(t, "-100%")]), e.utilities.static(`${o}-px`, () => [n(t, "1px")]), e.utilities.static(`-${o}-px`, () => [n(t, "-1px")]), e.utilities.functional(`-${o}`, l({ negative: true })), e.utilities.functional(o, l({ negative: false }));
    }
  }
  function Oo(e, r) {
    let o = e.theme.screens || {}, t = r.variants.get("min")?.order ?? 0, l = [];
    for (let [a, d] of Object.entries(o)) {
      let f = function(v) {
        r.variants.static(a, (k) => {
          k.nodes = [M("@media", p, k.nodes)];
        }, { order: v });
      };
      var s = f;
      let m = r.variants.get(a), u = r.theme.resolveValue(a, ["--breakpoint"]);
      if (m && u && !r.theme.hasDefault(`--breakpoint-${a}`)) continue;
      let h = true;
      typeof d == "string" && (h = false);
      let p = Dn(d);
      h ? l.push(f) : f(t);
    }
    if (l.length !== 0) {
      for (let [, a] of r.variants.variants) a.order > t && (a.order += l.length);
      r.variants.compareFns = new Map(Array.from(r.variants.compareFns).map(([a, d]) => (a > t && (a += l.length), [a, d])));
      for (let [a, d] of l.entries()) d(t + a + 1);
    }
  }
  function Dn(e) {
    return (Array.isArray(e) ? e : [e]).map((o) => typeof o == "string" ? { min: o } : o && typeof o == "object" ? o : null).map((o) => {
      if (o === null) return null;
      if ("raw" in o) return o.raw;
      let t = "";
      return o.max !== void 0 && (t += `${o.max} >= `), t += "width", o.min !== void 0 && (t += ` >= ${o.min}`), `(${t})`;
    }).filter(Boolean).join(", ");
  }
  function Po(e, r) {
    let o = e.theme.aria || {}, t = e.theme.supports || {}, l = e.theme.data || {};
    if (Object.keys(o).length > 0) {
      let s = r.variants.get("aria"), a = s?.applyFn, d = s?.compounds;
      r.variants.functional("aria", (m, u) => {
        let h = u.value;
        return h && h.kind === "named" && h.value in o ? a?.(m, { ...u, value: { kind: "arbitrary", value: o[h.value] } }) : a?.(m, u);
      }, { compounds: d });
    }
    if (Object.keys(t).length > 0) {
      let s = r.variants.get("supports"), a = s?.applyFn, d = s?.compounds;
      r.variants.functional("supports", (m, u) => {
        let h = u.value;
        return h && h.kind === "named" && h.value in t ? a?.(m, { ...u, value: { kind: "arbitrary", value: t[h.value] } }) : a?.(m, u);
      }, { compounds: d });
    }
    if (Object.keys(l).length > 0) {
      let s = r.variants.get("data"), a = s?.applyFn, d = s?.compounds;
      r.variants.functional("data", (m, u) => {
        let h = u.value;
        return h && h.kind === "named" && h.value in l ? a?.(m, { ...u, value: { kind: "arbitrary", value: l[h.value] } }) : a?.(m, u);
      }, { compounds: d });
    }
  }
  var Un = /^[a-z]+$/;
  async function _o({ designSystem: e, base: r, ast: o, loadModule: t, sources: l }) {
    let s = 0, a = [], d = [];
    _(o, (p, f) => {
      if (p.kind !== "at-rule") return;
      let v = Ie(f);
      if (p.name === "@plugin") {
        if (v.parent !== null) throw new Error("`@plugin` cannot be nested.");
        let k = p.params.slice(1, -1);
        if (k.length === 0) throw new Error("`@plugin` must have a path.");
        let b = {};
        for (let x of p.nodes ?? []) {
          if (x.kind !== "declaration") throw new Error(`Unexpected \`@plugin\` option:

${ae([x])}

\`@plugin\` options must be a flat list of declarations.`);
          if (x.value === void 0) continue;
          let O = x.value, C = L(O, ",").map((y) => {
            if (y = y.trim(), y === "null") return null;
            if (y === "true") return true;
            if (y === "false") return false;
            if (Number.isNaN(Number(y))) {
              if (y[0] === '"' && y[y.length - 1] === '"' || y[0] === "'" && y[y.length - 1] === "'") return y.slice(1, -1);
              if (y[0] === "{" && y[y.length - 1] === "}") throw new Error(`Unexpected \`@plugin\` option: Value of declaration \`${ae([x]).trim()}\` is not supported.

Using an object as a plugin option is currently only supported in JavaScript configuration files.`);
            } else return Number(y);
            return y;
          });
          b[x.property] = C.length === 1 ? C[0] : C;
        }
        return a.push([{ id: k, base: v.context.base, reference: !!v.context.reference, src: p.src }, Object.keys(b).length > 0 ? b : null]), s |= 4, R.Replace([]);
      }
      if (p.name === "@config") {
        if (p.nodes.length > 0) throw new Error("`@config` cannot have a body.");
        if (v.parent !== null) throw new Error("`@config` cannot be nested.");
        return d.push({ id: p.params.slice(1, -1), base: v.context.base, reference: !!v.context.reference, src: p.src }), s |= 4, R.Replace([]);
      }
    }), Ro(e);
    let m = e.resolveThemeValue;
    if (e.resolveThemeValue = function(f, v) {
      return f.startsWith("--") ? m(f, v) : (s |= zo({ designSystem: e, base: r, ast: o, sources: l, configs: [], pluginDetails: [] }), e.resolveThemeValue(f, v));
    }, !a.length && !d.length) return 0;
    let [u, h] = await Promise.all([Promise.all(d.map(async ({ id: p, base: f, reference: v, src: k }) => {
      let b = await t(p, f, "config");
      return { path: p, base: b.base, config: b.module, reference: v, src: k };
    })), Promise.all(a.map(async ([{ id: p, base: f, reference: v, src: k }, b]) => {
      let x = await t(p, f, "plugin");
      return { path: p, base: x.base, plugin: x.module, options: b, reference: v, src: k };
    }))]);
    return s |= zo({ designSystem: e, base: r, ast: o, sources: l, configs: u, pluginDetails: h }), s;
  }
  function zo({ designSystem: e, base: r, ast: o, sources: t, configs: l, pluginDetails: s }) {
    let a = 0, m = [...s.map((b) => {
      if (!b.options) return { config: { plugins: [b.plugin] }, base: b.base, reference: b.reference, src: b.src };
      if ("__isOptionsFunction" in b.plugin) return { config: { plugins: [b.plugin(b.options)] }, base: b.base, reference: b.reference, src: b.src };
      throw new Error(`The plugin "${b.path}" does not accept options`);
    }), ...l], { resolvedConfig: u } = tr(e, [{ config: So(e.theme), base: r, reference: true, src: void 0 }, ...m, { config: { plugins: [Eo] }, base: r, reference: true, src: void 0 }]), { resolvedConfig: h, replacedThemeKeys: p } = tr(e, m), f = { designSystem: e, ast: o, resolvedConfig: u, featuresRef: { set current(b) {
      a |= b;
    } } }, v = Xt({ ...f, referenceMode: false, src: void 0 }), k = e.resolveThemeValue;
    e.resolveThemeValue = function(x, O) {
      if (x[0] === "-" && x[1] === "-") return k(x, O);
      let C = v.theme(x, void 0);
      if (Array.isArray(C) && C.length === 2) return C[0];
      if (Array.isArray(C)) return C.join(", ");
      if (typeof C == "object" && C !== null && "DEFAULT" in C) return C.DEFAULT;
      if (typeof C == "string") return C;
    };
    for (let { handler: b, reference: x, src: O } of u.plugins) {
      let C = Xt({ ...f, referenceMode: x ?? false, src: O });
      b(C);
    }
    if (lo(e, h, p), Co(e, h), Po(h, e), Oo(h, e), Vo(h, e), !e.theme.prefix && u.prefix) {
      if (u.prefix.endsWith("-") && (u.prefix = u.prefix.slice(0, -1), console.warn(`The prefix "${u.prefix}" is invalid. Prefixes must be lowercase ASCII letters (a-z) only and is written as a variant before all utilities. We have fixed up the prefix for you. Remove the trailing \`-\` to silence this warning.`)), !Un.test(u.prefix)) throw new Error(`The prefix "${u.prefix}" is invalid. Prefixes must be lowercase ASCII letters (a-z) only.`);
      e.theme.prefix = u.prefix;
    }
    if (!e.important && u.important === true && (e.important = true), typeof u.important == "string") {
      let b = u.important;
      _(o, (x, O) => {
        if (x.kind !== "at-rule" || x.name !== "@tailwind" || x.params !== "utilities") return;
        let C = Ie(O);
        return C.parent?.kind === "rule" && C.parent.selector === b ? R.Stop : R.ReplaceStop(G(b, [x]));
      });
    }
    for (let b of u.blocklist) e.invalidCandidates.add(b);
    for (let b of u.content.files) {
      if ("raw" in b) throw new Error(`Error in the config file/plugin/preset. The \`content\` key contains a \`raw\` entry:

${JSON.stringify(b, null, 2)}

This feature is not currently supported.`);
      let x = false;
      b.pattern[0] == "!" && (x = true, b.pattern = b.pattern.slice(1)), t.push({ ...b, negated: x });
    }
    return a;
  }
  function Ko({ ast: e }) {
    let r = new H((l) => Ze(l.code)), o = new H((l) => ({ url: l.file, content: l.code, ignore: false })), t = { file: null, sources: [], mappings: [] };
    _(e, (l) => {
      if (!l.src || !l.dst) return;
      let s = o.get(l.src[0]);
      if (!s.content) return;
      let a = r.get(l.src[0]), d = r.get(l.dst[0]), m = s.content.slice(l.src[1], l.src[2]), u = 0;
      for (let f of m.split(`
`)) {
        if (f.trim() !== "") {
          let v = a.find(l.src[1] + u), k = d.find(l.dst[1]);
          t.mappings.push({ name: null, originalPosition: { source: s, ...v }, generatedPosition: k });
        }
        u += f.length, u += 1;
      }
      let h = a.find(l.src[2]), p = d.find(l.dst[2]);
      t.mappings.push({ name: null, originalPosition: { source: s, ...h }, generatedPosition: p });
    });
    for (let l of r.keys()) t.sources.push(o.get(l));
    return t.mappings.sort((l, s) => l.generatedPosition.line - s.generatedPosition.line || l.generatedPosition.column - s.generatedPosition.column || (l.originalPosition?.line ?? 0) - (s.originalPosition?.line ?? 0) || (l.originalPosition?.column ?? 0) - (s.originalPosition?.column ?? 0)), t;
  }
  var Lo = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
  function xt(e) {
    let r = e.indexOf("{");
    if (r === -1) return [e];
    let o = [], t = e.slice(0, r), l = e.slice(r), s = 0, a = l.lastIndexOf("}");
    for (let p = 0; p < l.length; p++) {
      let f = l[p];
      if (f === "{") s++;
      else if (f === "}" && (s--, s === 0)) {
        a = p;
        break;
      }
    }
    if (a === -1) throw new Error(`The pattern \`${e}\` is not balanced.`);
    let d = l.slice(1, a), m = l.slice(a + 1), u;
    jn(d) ? u = In(d) : u = L(d, ","), u = u.flatMap((p) => xt(p));
    let h = xt(m);
    for (let p of h) for (let f of u) o.push(t + f + p);
    return o;
  }
  function jn(e) {
    return Lo.test(e);
  }
  function In(e) {
    let r = e.match(Lo);
    if (!r) return [e];
    let [, o, t, l] = r, s = l ? parseInt(l, 10) : void 0, a = [];
    if (/^-?\d+$/.test(o) && /^-?\d+$/.test(t)) {
      let d = parseInt(o, 10), m = parseInt(t, 10);
      if (s === void 0 && (s = d <= m ? 1 : -1), s === 0) throw new Error("Step cannot be zero in sequence expansion.");
      let u = d < m;
      u && s < 0 && (s = -s), !u && s > 0 && (s = -s);
      for (let h = d; u ? h <= m : h >= m; h += s) a.push(h.toString());
    }
    return a;
  }
  function Do(e, r) {
    let o = /* @__PURE__ */ new Set(), t = /* @__PURE__ */ new Set(), l = [];
    function s(a, d = []) {
      if (e.has(a) && !o.has(a)) {
        t.has(a) && r.onCircularDependency?.(d, a), t.add(a);
        for (let m of e.get(a) ?? []) d.push(a), s(m, d), d.pop();
        o.add(a), t.delete(a), l.push(a);
      }
    }
    for (let a of e.keys()) s(a);
    return l;
  }
  var Fn = /^[a-z]+$/;
  function Mn() {
    throw new Error("No `loadModule` function provided to `compile`");
  }
  function Wn() {
    throw new Error("No `loadStylesheet` function provided to `compile`");
  }
  function Bn(e) {
    let r = 0, o = null;
    for (let t of L(e, " ")) t === "reference" ? r |= 2 : t === "inline" ? r |= 1 : t === "default" ? r |= 4 : t === "static" ? r |= 8 : t.startsWith("prefix(") && t.endsWith(")") && (o = t.slice(7, -1));
    return [r, o];
  }
  async function qn(e, { base: r = "", from: o, loadModule: t = Mn, loadStylesheet: l = Wn } = {}) {
    let s = 0;
    e = [pe({ base: r }, e)], s |= await Gt(e, r, l, 0, o !== void 0);
    let a = null, d = new rt(), m = /* @__PURE__ */ new Map(), u = /* @__PURE__ */ new Map(), h = [], p = null, f = null, v = [], k = [], b = [], x = [], O = null;
    _(e, (y, D) => {
      if (y.kind !== "at-rule") return;
      let z = Ie(D);
      if (y.name === "@tailwind" && (y.params === "utilities" || y.params.startsWith("utilities"))) {
        if (f !== null) return R.Replace([]);
        if (z.context.reference) return R.Replace([]);
        let K = L(y.params, " ");
        for (let j of K) if (j.startsWith("source(")) {
          let E = j.slice(7, -1);
          if (E === "none") {
            O = E;
            continue;
          }
          if (E[0] === '"' && E[E.length - 1] !== '"' || E[0] === "'" && E[E.length - 1] !== "'" || E[0] !== "'" && E[0] !== '"') throw new Error("`source(\u2026)` paths must be quoted.");
          O = { base: z.context.sourceBase ?? z.context.base, pattern: E.slice(1, -1) };
        }
        f = y, s |= 16;
      }
      if (y.name === "@utility") {
        if (z.parent !== null) throw new Error("`@utility` cannot be nested.");
        if (y.nodes.length === 0) throw new Error(`\`@utility ${y.params}\` is empty. Utilities should include at least one property.`);
        let K = Wr(y);
        if (K === null) {
          if (!y.params.endsWith("-*")) {
            if (y.params.endsWith("*")) throw new Error(`\`@utility ${y.params}\` defines an invalid utility name. A functional utility must end in \`-*\`.`);
            if (y.params.includes("*")) throw new Error(`\`@utility ${y.params}\` defines an invalid utility name. The dynamic portion marked by \`-*\` must appear once at the end.`);
          }
          throw new Error(`\`@utility ${y.params}\` defines an invalid utility name. Utilities should be alphanumeric and start with a lowercase letter.`);
        }
        h.push(K);
      }
      if (y.name === "@source") {
        if (y.nodes.length > 0) throw new Error("`@source` cannot have a body.");
        if (z.parent !== null) throw new Error("`@source` cannot be nested.");
        let K = false, j = false, E = y.params;
        if (E[0] === "n" && E.startsWith("not ") && (K = true, E = E.slice(4)), E[0] === "i" && E.startsWith("inline(") && (j = true, E = E.slice(7, -1).trim()), E[0] === '"' && E[E.length - 1] !== '"' || E[0] === "'" && E[E.length - 1] !== "'" || E[0] !== "'" && E[0] !== '"') throw new Error("`@source` paths must be quoted.");
        let U = E.slice(1, -1);
        if (j) {
          let B = K ? x : b, W = L(U, " ");
          for (let X of W) for (let te of xt(X)) B.push(te);
        } else k.push({ base: z.context.base, pattern: U, negated: K });
        return R.ReplaceSkip([]);
      }
      if (y.name === "@variant" && (z.parent === null ? y.nodes.length === 0 ? y.name = "@custom-variant" : (_(y.nodes, (K) => {
        if (K.kind === "at-rule" && K.name === "@slot") return y.name = "@custom-variant", R.Stop;
      }), y.name === "@variant" && v.push(y)) : v.push(y)), y.name === "@custom-variant") {
        if (z.parent !== null) throw new Error("`@custom-variant` cannot be nested.");
        let [K, j] = L(y.params, " ");
        if (!mt.test(K)) throw new Error(`\`@custom-variant ${K}\` defines an invalid variant name. Variants should only contain alphanumeric, dashes, or underscore characters and start with a lowercase letter or number.`);
        if (y.nodes.length > 0 && j) throw new Error(`\`@custom-variant ${K}\` cannot have both a selector and a body.`);
        if (y.nodes.length === 0) {
          if (!j) throw new Error(`\`@custom-variant ${K}\` has no selector or body.`);
          let E = L(j.slice(1, -1), ",");
          if (E.length === 0 || E.some((W) => W.trim() === "")) throw new Error(`\`@custom-variant ${K} (${E.join(",")})\` selector is invalid.`);
          let U = [], B = [];
          for (let W of E) W = W.trim(), W[0] === "@" ? U.push(W) : B.push(W);
          m.set(K, (W) => {
            W.variants.static(K, (X) => {
              let te = [];
              B.length > 0 && te.push(G(B.join(", "), X.nodes));
              for (let i of U) te.push(Z(i, X.nodes));
              X.nodes = te;
            }, { compounds: $e([...B, ...U]) });
          }), u.set(K, /* @__PURE__ */ new Set());
        } else {
          let E = /* @__PURE__ */ new Set();
          _(y.nodes, (U) => {
            U.kind === "at-rule" && U.name === "@variant" && E.add(U.params);
          }), m.set(K, (U) => {
            U.variants.fromAst(K, y.nodes, U);
          }), u.set(K, E);
        }
        return R.ReplaceSkip([]);
      }
      if (y.name === "@media") {
        let K = L(y.params, " "), j = [];
        for (let E of K) if (E.startsWith("source(")) {
          let U = E.slice(7, -1);
          _(y.nodes, (B) => {
            if (B.kind === "at-rule" && B.name === "@tailwind" && B.params === "utilities") return B.params += ` source(${U})`, R.ReplaceStop([pe({ sourceBase: z.context.base }, [B])]);
          });
        } else if (E.startsWith("theme(")) {
          let U = E.slice(6, -1), B = U.includes("reference");
          _(y.nodes, (W) => {
            if (W.kind !== "context") {
              if (W.kind !== "at-rule") {
                if (B) throw new Error('Files imported with `@import "\u2026" theme(reference)` must only contain `@theme` blocks.\nUse `@reference "\u2026";` instead.');
                return R.Continue;
              }
              if (W.name === "@theme") return W.params += " " + U, R.Skip;
            }
          });
        } else if (E.startsWith("prefix(")) {
          let U = E.slice(7, -1);
          _(y.nodes, (B) => {
            if (B.kind === "at-rule" && B.name === "@theme") return B.params += ` prefix(${U})`, R.Skip;
          });
        } else E === "important" ? a = true : E === "reference" ? y.nodes = [pe({ reference: true }, y.nodes)] : j.push(E);
        if (j.length > 0) y.params = j.join(" ");
        else if (K.length > 0) return R.Replace(y.nodes);
        return R.Continue;
      }
      if (y.name === "@theme") {
        let [K, j] = Bn(y.params);
        if (s |= 64, z.context.reference && (K |= 2), j) {
          if (!Fn.test(j)) throw new Error(`The prefix "${j}" is invalid. Prefixes must be lowercase ASCII letters (a-z) only.`);
          d.prefix = j;
        }
        return _(y.nodes, (E) => {
          if (E.kind === "at-rule" && E.name === "@keyframes") return d.addKeyframes(E), R.Skip;
          if (E.kind === "comment") return;
          if (E.kind === "declaration" && E.property.startsWith("--")) {
            d.add(me(E.property), E.value ?? "", K, E.src);
            return;
          }
          let U = ae([M(y.name, y.params, [E])]).split(`
`).map((B, W, X) => `${W === 0 || W >= X.length - 2 ? " " : ">"} ${B}`).join(`
`);
          throw new Error(`\`@theme\` blocks must only contain custom properties or \`@keyframes\`.

${U}`);
        }), p ? R.ReplaceSkip([]) : (p = G(":root, :host", []), p.src = y.src, R.ReplaceSkip(p));
      }
    });
    let C = eo(d, f?.src);
    if (a && (C.important = a), x.length > 0) for (let y of x) C.invalidCandidates.add(y);
    s |= await _o({ designSystem: C, base: r, ast: e, loadModule: t, sources: k });
    for (let y of m.keys()) C.variants.static(y, () => {
    });
    for (let y of Do(u, { onCircularDependency(D, z) {
      let K = ae(D.map((j, E) => M("@custom-variant", j, [M("@variant", D[E + 1] ?? z, [])]))).replaceAll(";", " { \u2026 }").replace(`@custom-variant ${z} {`, `@custom-variant ${z} { /* \u2190 */`);
      throw new Error(`Circular dependency detected in custom variants:

${K}`);
    } })) m.get(y)?.(C);
    for (let y of h) y(C);
    if (p) {
      let y = [];
      for (let [z, K] of C.theme.entries()) {
        if (K.options & 2) continue;
        let j = n(be(z), K.value);
        j.src = K.src, y.push(j);
      }
      let D = C.theme.getKeyframes();
      for (let z of D) e.push(pe({ theme: true }, [F([z])]));
      p.nodes = [pe({ theme: true }, y)];
    }
    if (s |= qe(e, C), s |= Pe(e, C), s |= He(e, C), f) {
      let y = f;
      y.kind = "context", y.context = {};
    }
    return _(e, (y) => {
      if (y.kind === "at-rule") return y.name === "@utility" ? R.Replace([]) : R.Skip;
    }), { designSystem: C, ast: e, sources: k, root: O, utilitiesNode: f, features: s, inlineCandidates: b };
  }
  async function Hn(e, r = {}) {
    let { designSystem: o, ast: t, sources: l, root: s, utilitiesNode: a, features: d, inlineCandidates: m } = await qn(e, r);
    t.unshift(tt(`! tailwindcss v${nr} | MIT License | https://tailwindcss.com `));
    function u(k) {
      o.invalidCandidates.add(k);
    }
    let h = /* @__PURE__ */ new Set(), p = null, f = 0, v = false;
    for (let k of m) o.invalidCandidates.has(k) || (h.add(k), v = true);
    return { sources: l, root: s, features: d, build(k) {
      if (d === 0) return e;
      if (!a) return p ??= Ce(t, o, r.polyfills), p;
      let b = v, x = false;
      v = false;
      let O = h.size;
      for (let y of k) if (!o.invalidCandidates.has(y)) if (y[0] === "-" && y[1] === "-") {
        let D = o.theme.markUsedVariable(y);
        b ||= D, x ||= D;
      } else h.add(y), b ||= h.size !== O;
      if (!b) return p ??= Ce(t, o, r.polyfills), p;
      let C = ye(h, o, { onInvalidCandidate: u }).astNodes;
      return r.from && _(C, (y) => {
        y.src ??= a.src;
      }), !x && f === C.length ? (p ??= Ce(t, o, r.polyfills), p) : (f = C.length, a.nodes = C, p = Ce(t, o, r.polyfills), p);
    } };
  }
  async function Uo(e, r = {}) {
    let o = Ee(e, { from: r.from }), t = await Hn(o, r), l = o, s = e;
    return { ...t, build(a) {
      let d = t.build(a);
      return d === l || (s = ae(d, !!r.from), l = d), s;
    }, buildSourceMap() {
      return Ko({ ast: l });
    } };
  }
  var jo = `@layer theme, base, components, utilities;

@import './theme.css' layer(theme);
@import './preflight.css' layer(base);
@import './utilities.css' layer(utilities);
`;
  var Io = `/*
  1. Prevent padding and border from affecting element width. (https://github.com/mozdevs/cssremedy/issues/4)
  2. Remove default margins and padding
  3. Reset all borders.
*/

*,
::after,
::before,
::backdrop,
::file-selector-button {
  box-sizing: border-box; /* 1 */
  margin: 0; /* 2 */
  padding: 0; /* 2 */
  border: 0 solid; /* 3 */
}

/*
  1. Use a consistent sensible line-height in all browsers.
  2. Prevent adjustments of font size after orientation changes in iOS.
  3. Use a more readable tab size.
  4. Use the user's configured \`sans\` font-family by default.
  5. Use the user's configured \`sans\` font-feature-settings by default.
  6. Use the user's configured \`sans\` font-variation-settings by default.
  7. Disable tap highlights on iOS.
*/

html,
:host {
  line-height: 1.5; /* 1 */
  -webkit-text-size-adjust: 100%; /* 2 */
  tab-size: 4; /* 3 */
  font-family: --theme(
    --default-font-family,
    ui-sans-serif,
    system-ui,
    sans-serif,
    'Apple Color Emoji',
    'Segoe UI Emoji',
    'Segoe UI Symbol',
    'Noto Color Emoji'
  ); /* 4 */
  font-feature-settings: --theme(--default-font-feature-settings, normal); /* 5 */
  font-variation-settings: --theme(--default-font-variation-settings, normal); /* 6 */
  -webkit-tap-highlight-color: transparent; /* 7 */
}

/*
  1. Add the correct height in Firefox.
  2. Correct the inheritance of border color in Firefox. (https://bugzilla.mozilla.org/show_bug.cgi?id=190655)
  3. Reset the default border style to a 1px solid border.
*/

hr {
  height: 0; /* 1 */
  color: inherit; /* 2 */
  border-top-width: 1px; /* 3 */
}

/*
  Add the correct text decoration in Chrome, Edge, and Safari.
*/

abbr:where([title]) {
  -webkit-text-decoration: underline dotted;
  text-decoration: underline dotted;
}

/*
  Remove the default font size and weight for headings.
*/

h1,
h2,
h3,
h4,
h5,
h6 {
  font-size: inherit;
  font-weight: inherit;
}

/*
  Reset links to optimize for opt-in styling instead of opt-out.
*/

a {
  color: inherit;
  -webkit-text-decoration: inherit;
  text-decoration: inherit;
}

/*
  Add the correct font weight in Edge and Safari.
*/

b,
strong {
  font-weight: bolder;
}

/*
  1. Use the user's configured \`mono\` font-family by default.
  2. Use the user's configured \`mono\` font-feature-settings by default.
  3. Use the user's configured \`mono\` font-variation-settings by default.
  4. Correct the odd \`em\` font sizing in all browsers.
*/

code,
kbd,
samp,
pre {
  font-family: --theme(
    --default-mono-font-family,
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    'Liberation Mono',
    'Courier New',
    monospace
  ); /* 1 */
  font-feature-settings: --theme(--default-mono-font-feature-settings, normal); /* 2 */
  font-variation-settings: --theme(--default-mono-font-variation-settings, normal); /* 3 */
  font-size: 1em; /* 4 */
}

/*
  Add the correct font size in all browsers.
*/

small {
  font-size: 80%;
}

/*
  Prevent \`sub\` and \`sup\` elements from affecting the line height in all browsers.
*/

sub,
sup {
  font-size: 75%;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
}

sub {
  bottom: -0.25em;
}

sup {
  top: -0.5em;
}

/*
  1. Remove text indentation from table contents in Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=999088, https://bugs.webkit.org/show_bug.cgi?id=201297)
  2. Correct table border color inheritance in all Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=935729, https://bugs.webkit.org/show_bug.cgi?id=195016)
  3. Remove gaps between table borders by default.
*/

table {
  text-indent: 0; /* 1 */
  border-color: inherit; /* 2 */
  border-collapse: collapse; /* 3 */
}

/*
  Use the modern Firefox focus style for all focusable elements.
*/

:-moz-focusring {
  outline: auto;
}

/*
  Add the correct vertical alignment in Chrome and Firefox.
*/

progress {
  vertical-align: baseline;
}

/*
  Add the correct display in Chrome and Safari.
*/

summary {
  display: list-item;
}

/*
  Make lists unstyled by default.
*/

ol,
ul,
menu {
  list-style: none;
}

/*
  1. Make replaced elements \`display: block\` by default. (https://github.com/mozdevs/cssremedy/issues/14)
  2. Add \`vertical-align: middle\` to align replaced elements more sensibly by default. (https://github.com/jensimmons/cssremedy/issues/14#issuecomment-634934210)
      This can trigger a poorly considered lint error in some tools but is included by design.
*/

img,
svg,
video,
canvas,
audio,
iframe,
embed,
object {
  display: block; /* 1 */
  vertical-align: middle; /* 2 */
}

/*
  Constrain images and videos to the parent width and preserve their intrinsic aspect ratio. (https://github.com/mozdevs/cssremedy/issues/14)
*/

img,
video {
  max-width: 100%;
  height: auto;
}

/*
  1. Inherit font styles in all browsers.
  2. Remove border radius in all browsers.
  3. Remove background color in all browsers.
  4. Ensure consistent opacity for disabled states in all browsers.
*/

button,
input,
select,
optgroup,
textarea,
::file-selector-button {
  font: inherit; /* 1 */
  font-feature-settings: inherit; /* 1 */
  font-variation-settings: inherit; /* 1 */
  letter-spacing: inherit; /* 1 */
  color: inherit; /* 1 */
  border-radius: 0; /* 2 */
  background-color: transparent; /* 3 */
  opacity: 1; /* 4 */
}

/*
  Restore default font weight.
*/

:where(select:is([multiple], [size])) optgroup {
  font-weight: bolder;
}

/*
  Restore indentation.
*/

:where(select:is([multiple], [size])) optgroup option {
  padding-inline-start: 20px;
}

/*
  Restore space after button.
*/

::file-selector-button {
  margin-inline-end: 4px;
}

/*
  Reset the default placeholder opacity in Firefox. (https://github.com/tailwindlabs/tailwindcss/issues/3300)
*/

::placeholder {
  opacity: 1;
}

/*
  Set the default placeholder color to a semi-transparent version of the current text color in browsers that do not
  crash when using \`color-mix(\u2026)\` with \`currentcolor\`. (https://github.com/tailwindlabs/tailwindcss/issues/17194)
*/

@supports (not (-webkit-appearance: -apple-pay-button)) /* Not Safari */ or
  (contain-intrinsic-size: 1px) /* Safari 17+ */ {
  ::placeholder {
    color: color-mix(in oklab, currentcolor 50%, transparent);
  }
}

/*
  Prevent resizing textareas horizontally by default.
*/

textarea {
  resize: vertical;
}

/*
  Remove the inner padding in Chrome and Safari on macOS.
*/

::-webkit-search-decoration {
  -webkit-appearance: none;
}

/*
  1. Ensure date/time inputs have the same height when empty in iOS Safari.
  2. Ensure text alignment can be changed on date/time inputs in iOS Safari.
*/

::-webkit-date-and-time-value {
  min-height: 1lh; /* 1 */
  text-align: inherit; /* 2 */
}

/*
  Prevent height from changing on date/time inputs in macOS Safari when the input is set to \`display: block\`.
*/

::-webkit-datetime-edit {
  display: inline-flex;
}

/*
  Remove excess padding from pseudo-elements in date/time inputs to ensure consistent height across browsers.
*/

::-webkit-datetime-edit-fields-wrapper {
  padding: 0;
}

::-webkit-datetime-edit,
::-webkit-datetime-edit-year-field,
::-webkit-datetime-edit-month-field,
::-webkit-datetime-edit-day-field,
::-webkit-datetime-edit-hour-field,
::-webkit-datetime-edit-minute-field,
::-webkit-datetime-edit-second-field,
::-webkit-datetime-edit-millisecond-field,
::-webkit-datetime-edit-meridiem-field {
  padding-block: 0;
}

/*
  Center dropdown marker shown on inputs with paired \`<datalist>\`s in Chrome. (https://github.com/tailwindlabs/tailwindcss/issues/18499)
*/

::-webkit-calendar-picker-indicator {
  line-height: 1;
}

/*
  Remove the additional \`:invalid\` styles in Firefox. (https://github.com/mozilla/gecko-dev/blob/2f9eacd9d3d995c937b4251a5557d95d494c9be1/layout/style/res/forms.css#L728-L737)
*/

:-moz-ui-invalid {
  box-shadow: none;
}

/*
  Correct the inability to style the border radius in iOS Safari.
*/

button,
input:where([type='button'], [type='reset'], [type='submit']),
::file-selector-button {
  appearance: button;
}

/*
  Correct the cursor style of increment and decrement buttons in Safari.
*/

::-webkit-inner-spin-button,
::-webkit-outer-spin-button {
  height: auto;
}

/*
  Make elements with the HTML hidden attribute stay hidden by default.
*/

[hidden]:where(:not([hidden='until-found'])) {
  display: none !important;
}
`;
  var Fo = `@theme default {
  --font-sans:
    ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol',
    'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif;
  --font-mono:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;

  --color-red-50: oklch(97.1% 0.013 17.38);
  --color-red-100: oklch(93.6% 0.032 17.717);
  --color-red-200: oklch(88.5% 0.062 18.334);
  --color-red-300: oklch(80.8% 0.114 19.571);
  --color-red-400: oklch(70.4% 0.191 22.216);
  --color-red-500: oklch(63.7% 0.237 25.331);
  --color-red-600: oklch(57.7% 0.245 27.325);
  --color-red-700: oklch(50.5% 0.213 27.518);
  --color-red-800: oklch(44.4% 0.177 26.899);
  --color-red-900: oklch(39.6% 0.141 25.723);
  --color-red-950: oklch(25.8% 0.092 26.042);

  --color-orange-50: oklch(98% 0.016 73.684);
  --color-orange-100: oklch(95.4% 0.038 75.164);
  --color-orange-200: oklch(90.1% 0.076 70.697);
  --color-orange-300: oklch(83.7% 0.128 66.29);
  --color-orange-400: oklch(75% 0.183 55.934);
  --color-orange-500: oklch(70.5% 0.213 47.604);
  --color-orange-600: oklch(64.6% 0.222 41.116);
  --color-orange-700: oklch(55.3% 0.195 38.402);
  --color-orange-800: oklch(47% 0.157 37.304);
  --color-orange-900: oklch(40.8% 0.123 38.172);
  --color-orange-950: oklch(26.6% 0.079 36.259);

  --color-amber-50: oklch(98.7% 0.022 95.277);
  --color-amber-100: oklch(96.2% 0.059 95.617);
  --color-amber-200: oklch(92.4% 0.12 95.746);
  --color-amber-300: oklch(87.9% 0.169 91.605);
  --color-amber-400: oklch(82.8% 0.189 84.429);
  --color-amber-500: oklch(76.9% 0.188 70.08);
  --color-amber-600: oklch(66.6% 0.179 58.318);
  --color-amber-700: oklch(55.5% 0.163 48.998);
  --color-amber-800: oklch(47.3% 0.137 46.201);
  --color-amber-900: oklch(41.4% 0.112 45.904);
  --color-amber-950: oklch(27.9% 0.077 45.635);

  --color-yellow-50: oklch(98.7% 0.026 102.212);
  --color-yellow-100: oklch(97.3% 0.071 103.193);
  --color-yellow-200: oklch(94.5% 0.129 101.54);
  --color-yellow-300: oklch(90.5% 0.182 98.111);
  --color-yellow-400: oklch(85.2% 0.199 91.936);
  --color-yellow-500: oklch(79.5% 0.184 86.047);
  --color-yellow-600: oklch(68.1% 0.162 75.834);
  --color-yellow-700: oklch(55.4% 0.135 66.442);
  --color-yellow-800: oklch(47.6% 0.114 61.907);
  --color-yellow-900: oklch(42.1% 0.095 57.708);
  --color-yellow-950: oklch(28.6% 0.066 53.813);

  --color-lime-50: oklch(98.6% 0.031 120.757);
  --color-lime-100: oklch(96.7% 0.067 122.328);
  --color-lime-200: oklch(93.8% 0.127 124.321);
  --color-lime-300: oklch(89.7% 0.196 126.665);
  --color-lime-400: oklch(84.1% 0.238 128.85);
  --color-lime-500: oklch(76.8% 0.233 130.85);
  --color-lime-600: oklch(64.8% 0.2 131.684);
  --color-lime-700: oklch(53.2% 0.157 131.589);
  --color-lime-800: oklch(45.3% 0.124 130.933);
  --color-lime-900: oklch(40.5% 0.101 131.063);
  --color-lime-950: oklch(27.4% 0.072 132.109);

  --color-green-50: oklch(98.2% 0.018 155.826);
  --color-green-100: oklch(96.2% 0.044 156.743);
  --color-green-200: oklch(92.5% 0.084 155.995);
  --color-green-300: oklch(87.1% 0.15 154.449);
  --color-green-400: oklch(79.2% 0.209 151.711);
  --color-green-500: oklch(72.3% 0.219 149.579);
  --color-green-600: oklch(62.7% 0.194 149.214);
  --color-green-700: oklch(52.7% 0.154 150.069);
  --color-green-800: oklch(44.8% 0.119 151.328);
  --color-green-900: oklch(39.3% 0.095 152.535);
  --color-green-950: oklch(26.6% 0.065 152.934);

  --color-emerald-50: oklch(97.9% 0.021 166.113);
  --color-emerald-100: oklch(95% 0.052 163.051);
  --color-emerald-200: oklch(90.5% 0.093 164.15);
  --color-emerald-300: oklch(84.5% 0.143 164.978);
  --color-emerald-400: oklch(76.5% 0.177 163.223);
  --color-emerald-500: oklch(69.6% 0.17 162.48);
  --color-emerald-600: oklch(59.6% 0.145 163.225);
  --color-emerald-700: oklch(50.8% 0.118 165.612);
  --color-emerald-800: oklch(43.2% 0.095 166.913);
  --color-emerald-900: oklch(37.8% 0.077 168.94);
  --color-emerald-950: oklch(26.2% 0.051 172.552);

  --color-teal-50: oklch(98.4% 0.014 180.72);
  --color-teal-100: oklch(95.3% 0.051 180.801);
  --color-teal-200: oklch(91% 0.096 180.426);
  --color-teal-300: oklch(85.5% 0.138 181.071);
  --color-teal-400: oklch(77.7% 0.152 181.912);
  --color-teal-500: oklch(70.4% 0.14 182.503);
  --color-teal-600: oklch(60% 0.118 184.704);
  --color-teal-700: oklch(51.1% 0.096 186.391);
  --color-teal-800: oklch(43.7% 0.078 188.216);
  --color-teal-900: oklch(38.6% 0.063 188.416);
  --color-teal-950: oklch(27.7% 0.046 192.524);

  --color-cyan-50: oklch(98.4% 0.019 200.873);
  --color-cyan-100: oklch(95.6% 0.045 203.388);
  --color-cyan-200: oklch(91.7% 0.08 205.041);
  --color-cyan-300: oklch(86.5% 0.127 207.078);
  --color-cyan-400: oklch(78.9% 0.154 211.53);
  --color-cyan-500: oklch(71.5% 0.143 215.221);
  --color-cyan-600: oklch(60.9% 0.126 221.723);
  --color-cyan-700: oklch(52% 0.105 223.128);
  --color-cyan-800: oklch(45% 0.085 224.283);
  --color-cyan-900: oklch(39.8% 0.07 227.392);
  --color-cyan-950: oklch(30.2% 0.056 229.695);

  --color-sky-50: oklch(97.7% 0.013 236.62);
  --color-sky-100: oklch(95.1% 0.026 236.824);
  --color-sky-200: oklch(90.1% 0.058 230.902);
  --color-sky-300: oklch(82.8% 0.111 230.318);
  --color-sky-400: oklch(74.6% 0.16 232.661);
  --color-sky-500: oklch(68.5% 0.169 237.323);
  --color-sky-600: oklch(58.8% 0.158 241.966);
  --color-sky-700: oklch(50% 0.134 242.749);
  --color-sky-800: oklch(44.3% 0.11 240.79);
  --color-sky-900: oklch(39.1% 0.09 240.876);
  --color-sky-950: oklch(29.3% 0.066 243.157);

  --color-blue-50: oklch(97% 0.014 254.604);
  --color-blue-100: oklch(93.2% 0.032 255.585);
  --color-blue-200: oklch(88.2% 0.059 254.128);
  --color-blue-300: oklch(80.9% 0.105 251.813);
  --color-blue-400: oklch(70.7% 0.165 254.624);
  --color-blue-500: oklch(62.3% 0.214 259.815);
  --color-blue-600: oklch(54.6% 0.245 262.881);
  --color-blue-700: oklch(48.8% 0.243 264.376);
  --color-blue-800: oklch(42.4% 0.199 265.638);
  --color-blue-900: oklch(37.9% 0.146 265.522);
  --color-blue-950: oklch(28.2% 0.091 267.935);

  --color-indigo-50: oklch(96.2% 0.018 272.314);
  --color-indigo-100: oklch(93% 0.034 272.788);
  --color-indigo-200: oklch(87% 0.065 274.039);
  --color-indigo-300: oklch(78.5% 0.115 274.713);
  --color-indigo-400: oklch(67.3% 0.182 276.935);
  --color-indigo-500: oklch(58.5% 0.233 277.117);
  --color-indigo-600: oklch(51.1% 0.262 276.966);
  --color-indigo-700: oklch(45.7% 0.24 277.023);
  --color-indigo-800: oklch(39.8% 0.195 277.366);
  --color-indigo-900: oklch(35.9% 0.144 278.697);
  --color-indigo-950: oklch(25.7% 0.09 281.288);

  --color-violet-50: oklch(96.9% 0.016 293.756);
  --color-violet-100: oklch(94.3% 0.029 294.588);
  --color-violet-200: oklch(89.4% 0.057 293.283);
  --color-violet-300: oklch(81.1% 0.111 293.571);
  --color-violet-400: oklch(70.2% 0.183 293.541);
  --color-violet-500: oklch(60.6% 0.25 292.717);
  --color-violet-600: oklch(54.1% 0.281 293.009);
  --color-violet-700: oklch(49.1% 0.27 292.581);
  --color-violet-800: oklch(43.2% 0.232 292.759);
  --color-violet-900: oklch(38% 0.189 293.745);
  --color-violet-950: oklch(28.3% 0.141 291.089);

  --color-purple-50: oklch(97.7% 0.014 308.299);
  --color-purple-100: oklch(94.6% 0.033 307.174);
  --color-purple-200: oklch(90.2% 0.063 306.703);
  --color-purple-300: oklch(82.7% 0.119 306.383);
  --color-purple-400: oklch(71.4% 0.203 305.504);
  --color-purple-500: oklch(62.7% 0.265 303.9);
  --color-purple-600: oklch(55.8% 0.288 302.321);
  --color-purple-700: oklch(49.6% 0.265 301.924);
  --color-purple-800: oklch(43.8% 0.218 303.724);
  --color-purple-900: oklch(38.1% 0.176 304.987);
  --color-purple-950: oklch(29.1% 0.149 302.717);

  --color-fuchsia-50: oklch(97.7% 0.017 320.058);
  --color-fuchsia-100: oklch(95.2% 0.037 318.852);
  --color-fuchsia-200: oklch(90.3% 0.076 319.62);
  --color-fuchsia-300: oklch(83.3% 0.145 321.434);
  --color-fuchsia-400: oklch(74% 0.238 322.16);
  --color-fuchsia-500: oklch(66.7% 0.295 322.15);
  --color-fuchsia-600: oklch(59.1% 0.293 322.896);
  --color-fuchsia-700: oklch(51.8% 0.253 323.949);
  --color-fuchsia-800: oklch(45.2% 0.211 324.591);
  --color-fuchsia-900: oklch(40.1% 0.17 325.612);
  --color-fuchsia-950: oklch(29.3% 0.136 325.661);

  --color-pink-50: oklch(97.1% 0.014 343.198);
  --color-pink-100: oklch(94.8% 0.028 342.258);
  --color-pink-200: oklch(89.9% 0.061 343.231);
  --color-pink-300: oklch(82.3% 0.12 346.018);
  --color-pink-400: oklch(71.8% 0.202 349.761);
  --color-pink-500: oklch(65.6% 0.241 354.308);
  --color-pink-600: oklch(59.2% 0.249 0.584);
  --color-pink-700: oklch(52.5% 0.223 3.958);
  --color-pink-800: oklch(45.9% 0.187 3.815);
  --color-pink-900: oklch(40.8% 0.153 2.432);
  --color-pink-950: oklch(28.4% 0.109 3.907);

  --color-rose-50: oklch(96.9% 0.015 12.422);
  --color-rose-100: oklch(94.1% 0.03 12.58);
  --color-rose-200: oklch(89.2% 0.058 10.001);
  --color-rose-300: oklch(81% 0.117 11.638);
  --color-rose-400: oklch(71.2% 0.194 13.428);
  --color-rose-500: oklch(64.5% 0.246 16.439);
  --color-rose-600: oklch(58.6% 0.253 17.585);
  --color-rose-700: oklch(51.4% 0.222 16.935);
  --color-rose-800: oklch(45.5% 0.188 13.697);
  --color-rose-900: oklch(41% 0.159 10.272);
  --color-rose-950: oklch(27.1% 0.105 12.094);

  --color-slate-50: oklch(98.4% 0.003 247.858);
  --color-slate-100: oklch(96.8% 0.007 247.896);
  --color-slate-200: oklch(92.9% 0.013 255.508);
  --color-slate-300: oklch(86.9% 0.022 252.894);
  --color-slate-400: oklch(70.4% 0.04 256.788);
  --color-slate-500: oklch(55.4% 0.046 257.417);
  --color-slate-600: oklch(44.6% 0.043 257.281);
  --color-slate-700: oklch(37.2% 0.044 257.287);
  --color-slate-800: oklch(27.9% 0.041 260.031);
  --color-slate-900: oklch(20.8% 0.042 265.755);
  --color-slate-950: oklch(12.9% 0.042 264.695);

  --color-gray-50: oklch(98.5% 0.002 247.839);
  --color-gray-100: oklch(96.7% 0.003 264.542);
  --color-gray-200: oklch(92.8% 0.006 264.531);
  --color-gray-300: oklch(87.2% 0.01 258.338);
  --color-gray-400: oklch(70.7% 0.022 261.325);
  --color-gray-500: oklch(55.1% 0.027 264.364);
  --color-gray-600: oklch(44.6% 0.03 256.802);
  --color-gray-700: oklch(37.3% 0.034 259.733);
  --color-gray-800: oklch(27.8% 0.033 256.848);
  --color-gray-900: oklch(21% 0.034 264.665);
  --color-gray-950: oklch(13% 0.028 261.692);

  --color-zinc-50: oklch(98.5% 0 0);
  --color-zinc-100: oklch(96.7% 0.001 286.375);
  --color-zinc-200: oklch(92% 0.004 286.32);
  --color-zinc-300: oklch(87.1% 0.006 286.286);
  --color-zinc-400: oklch(70.5% 0.015 286.067);
  --color-zinc-500: oklch(55.2% 0.016 285.938);
  --color-zinc-600: oklch(44.2% 0.017 285.786);
  --color-zinc-700: oklch(37% 0.013 285.805);
  --color-zinc-800: oklch(27.4% 0.006 286.033);
  --color-zinc-900: oklch(21% 0.006 285.885);
  --color-zinc-950: oklch(14.1% 0.005 285.823);

  --color-neutral-50: oklch(98.5% 0 0);
  --color-neutral-100: oklch(97% 0 0);
  --color-neutral-200: oklch(92.2% 0 0);
  --color-neutral-300: oklch(87% 0 0);
  --color-neutral-400: oklch(70.8% 0 0);
  --color-neutral-500: oklch(55.6% 0 0);
  --color-neutral-600: oklch(43.9% 0 0);
  --color-neutral-700: oklch(37.1% 0 0);
  --color-neutral-800: oklch(26.9% 0 0);
  --color-neutral-900: oklch(20.5% 0 0);
  --color-neutral-950: oklch(14.5% 0 0);

  --color-stone-50: oklch(98.5% 0.001 106.423);
  --color-stone-100: oklch(97% 0.001 106.424);
  --color-stone-200: oklch(92.3% 0.003 48.717);
  --color-stone-300: oklch(86.9% 0.005 56.366);
  --color-stone-400: oklch(70.9% 0.01 56.259);
  --color-stone-500: oklch(55.3% 0.013 58.071);
  --color-stone-600: oklch(44.4% 0.011 73.639);
  --color-stone-700: oklch(37.4% 0.01 67.558);
  --color-stone-800: oklch(26.8% 0.007 34.298);
  --color-stone-900: oklch(21.6% 0.006 56.043);
  --color-stone-950: oklch(14.7% 0.004 49.25);

  --color-mauve-50: oklch(98.5% 0 0);
  --color-mauve-100: oklch(96% 0.003 325.6);
  --color-mauve-200: oklch(92.2% 0.005 325.62);
  --color-mauve-300: oklch(86.5% 0.012 325.68);
  --color-mauve-400: oklch(71.1% 0.019 323.02);
  --color-mauve-500: oklch(54.2% 0.034 322.5);
  --color-mauve-600: oklch(43.5% 0.029 321.78);
  --color-mauve-700: oklch(36.4% 0.029 323.89);
  --color-mauve-800: oklch(26.3% 0.024 320.12);
  --color-mauve-900: oklch(21.2% 0.019 322.12);
  --color-mauve-950: oklch(14.5% 0.008 326);

  --color-olive-50: oklch(98.8% 0.003 106.5);
  --color-olive-100: oklch(96.6% 0.005 106.5);
  --color-olive-200: oklch(93% 0.007 106.5);
  --color-olive-300: oklch(88% 0.011 106.6);
  --color-olive-400: oklch(73.7% 0.021 106.9);
  --color-olive-500: oklch(58% 0.031 107.3);
  --color-olive-600: oklch(46.6% 0.025 107.3);
  --color-olive-700: oklch(39.4% 0.023 107.4);
  --color-olive-800: oklch(28.6% 0.016 107.4);
  --color-olive-900: oklch(22.8% 0.013 107.4);
  --color-olive-950: oklch(15.3% 0.006 107.1);

  --color-mist-50: oklch(98.7% 0.002 197.1);
  --color-mist-100: oklch(96.3% 0.002 197.1);
  --color-mist-200: oklch(92.5% 0.005 214.3);
  --color-mist-300: oklch(87.2% 0.007 219.6);
  --color-mist-400: oklch(72.3% 0.014 214.4);
  --color-mist-500: oklch(56% 0.021 213.5);
  --color-mist-600: oklch(45% 0.017 213.2);
  --color-mist-700: oklch(37.8% 0.015 216);
  --color-mist-800: oklch(27.5% 0.011 216.9);
  --color-mist-900: oklch(21.8% 0.008 223.9);
  --color-mist-950: oklch(14.8% 0.004 228.8);

  --color-taupe-50: oklch(98.6% 0.002 67.8);
  --color-taupe-100: oklch(96% 0.002 17.2);
  --color-taupe-200: oklch(92.2% 0.005 34.3);
  --color-taupe-300: oklch(86.8% 0.007 39.5);
  --color-taupe-400: oklch(71.4% 0.014 41.2);
  --color-taupe-500: oklch(54.7% 0.021 43.1);
  --color-taupe-600: oklch(43.8% 0.017 39.3);
  --color-taupe-700: oklch(36.7% 0.016 35.7);
  --color-taupe-800: oklch(26.8% 0.011 36.5);
  --color-taupe-900: oklch(21.4% 0.009 43.1);
  --color-taupe-950: oklch(14.7% 0.004 49.3);

  --color-black: #000;
  --color-white: #fff;

  --spacing: 0.25rem;

  --breakpoint-sm: 40rem;
  --breakpoint-md: 48rem;
  --breakpoint-lg: 64rem;
  --breakpoint-xl: 80rem;
  --breakpoint-2xl: 96rem;

  --container-3xs: 16rem;
  --container-2xs: 18rem;
  --container-xs: 20rem;
  --container-sm: 24rem;
  --container-md: 28rem;
  --container-lg: 32rem;
  --container-xl: 36rem;
  --container-2xl: 42rem;
  --container-3xl: 48rem;
  --container-4xl: 56rem;
  --container-5xl: 64rem;
  --container-6xl: 72rem;
  --container-7xl: 80rem;

  --text-xs: 0.75rem;
  --text-xs--line-height: calc(1 / 0.75);
  --text-sm: 0.875rem;
  --text-sm--line-height: calc(1.25 / 0.875);
  --text-base: 1rem;
  --text-base--line-height: calc(1.5 / 1);
  --text-lg: 1.125rem;
  --text-lg--line-height: calc(1.75 / 1.125);
  --text-xl: 1.25rem;
  --text-xl--line-height: calc(1.75 / 1.25);
  --text-2xl: 1.5rem;
  --text-2xl--line-height: calc(2 / 1.5);
  --text-3xl: 1.875rem;
  --text-3xl--line-height: calc(2.25 / 1.875);
  --text-4xl: 2.25rem;
  --text-4xl--line-height: calc(2.5 / 2.25);
  --text-5xl: 3rem;
  --text-5xl--line-height: 1;
  --text-6xl: 3.75rem;
  --text-6xl--line-height: 1;
  --text-7xl: 4.5rem;
  --text-7xl--line-height: 1;
  --text-8xl: 6rem;
  --text-8xl--line-height: 1;
  --text-9xl: 8rem;
  --text-9xl--line-height: 1;

  --font-weight-thin: 100;
  --font-weight-extralight: 200;
  --font-weight-light: 300;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  --font-weight-extrabold: 800;
  --font-weight-black: 900;

  --tracking-tighter: -0.05em;
  --tracking-tight: -0.025em;
  --tracking-normal: 0em;
  --tracking-wide: 0.025em;
  --tracking-wider: 0.05em;
  --tracking-widest: 0.1em;

  --leading-tight: 1.25;
  --leading-snug: 1.375;
  --leading-normal: 1.5;
  --leading-relaxed: 1.625;
  --leading-loose: 2;

  --radius-xs: 0.125rem;
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-2xl: 1rem;
  --radius-3xl: 1.5rem;
  --radius-4xl: 2rem;

  --shadow-2xs: 0 1px rgb(0 0 0 / 0.05);
  --shadow-xs: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
  --shadow-2xl: 0 25px 50px -12px rgb(0 0 0 / 0.25);

  --inset-shadow-2xs: inset 0 1px rgb(0 0 0 / 0.05);
  --inset-shadow-xs: inset 0 1px 1px rgb(0 0 0 / 0.05);
  --inset-shadow-sm: inset 0 2px 4px rgb(0 0 0 / 0.05);

  --drop-shadow-xs: 0 1px 1px rgb(0 0 0 / 0.05);
  --drop-shadow-sm: 0 1px 2px rgb(0 0 0 / 0.15);
  --drop-shadow-md: 0 3px 3px rgb(0 0 0 / 0.12);
  --drop-shadow-lg: 0 4px 4px rgb(0 0 0 / 0.15);
  --drop-shadow-xl: 0 9px 7px rgb(0 0 0 / 0.1);
  --drop-shadow-2xl: 0 25px 25px rgb(0 0 0 / 0.15);

  --text-shadow-2xs: 0px 1px 0px rgb(0 0 0 / 0.15);
  --text-shadow-xs: 0px 1px 1px rgb(0 0 0 / 0.2);
  --text-shadow-sm:
    0px 1px 0px rgb(0 0 0 / 0.075), 0px 1px 1px rgb(0 0 0 / 0.075), 0px 2px 2px rgb(0 0 0 / 0.075);
  --text-shadow-md:
    0px 1px 1px rgb(0 0 0 / 0.1), 0px 1px 2px rgb(0 0 0 / 0.1), 0px 2px 4px rgb(0 0 0 / 0.1);
  --text-shadow-lg:
    0px 1px 2px rgb(0 0 0 / 0.1), 0px 3px 2px rgb(0 0 0 / 0.1), 0px 4px 8px rgb(0 0 0 / 0.1);

  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

  --animate-spin: spin 1s linear infinite;
  --animate-ping: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
  --animate-pulse: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  --animate-bounce: bounce 1s infinite;

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes ping {
    75%,
    100% {
      transform: scale(2);
      opacity: 0;
    }
  }

  @keyframes pulse {
    50% {
      opacity: 0.5;
    }
  }

  @keyframes bounce {
    0%,
    100% {
      transform: translateY(-25%);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }

    50% {
      transform: none;
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
  }

  --blur-xs: 4px;
  --blur-sm: 8px;
  --blur-md: 12px;
  --blur-lg: 16px;
  --blur-xl: 24px;
  --blur-2xl: 40px;
  --blur-3xl: 64px;

  --perspective-dramatic: 100px;
  --perspective-near: 300px;
  --perspective-normal: 500px;
  --perspective-midrange: 800px;
  --perspective-distant: 1200px;

  --aspect-video: 16 / 9;

  --default-transition-duration: 150ms;
  --default-transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  --default-font-family: --theme(--font-sans, initial);
  --default-font-feature-settings: --theme(--font-sans--font-feature-settings, initial);
  --default-font-variation-settings: --theme(--font-sans--font-variation-settings, initial);
  --default-mono-font-family: --theme(--font-mono, initial);
  --default-mono-font-feature-settings: --theme(--font-mono--font-feature-settings, initial);
  --default-mono-font-variation-settings: --theme(--font-mono--font-variation-settings, initial);
}

/* Deprecated */
@theme default inline reference {
  --blur: 8px;
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --shadow-inner: inset 0 2px 4px 0 rgb(0 0 0 / 0.05);
  --drop-shadow: 0 1px 2px rgb(0 0 0 / 0.1), 0 1px 1px rgb(0 0 0 / 0.06);
  --radius: 0.25rem;
  --max-width-prose: 65ch;
}
`;
  var Mo = `@tailwind utilities;
`;
  var Ye = { index: jo, preflight: Io, theme: Fo, utilities: Mo };
  var At = class {
    start(r) {
      performance.mark(`${r} (start)`);
    }
    end(r, o) {
      performance.mark(`${r} (end)`), performance.measure(r, { start: `${r} (start)`, end: `${r} (end)`, detail: o });
    }
    hit(r, o) {
      performance.mark(r, { detail: o });
    }
    error(r) {
      throw performance.mark("(error)", { detail: { error: `${r}` } }), r;
    }
  };
  var Bo = "text/tailwindcss", Ct, or = /* @__PURE__ */ new Set(), rr = "", ir = document.createElement("style"), Wo = Promise.resolve(), el = 1, ie = new At();
  async function tl() {
    ie.start("Create compiler"), ie.start("Reading Stylesheets");
    let e = document.querySelectorAll(`style[type="${Bo}"]`), r = "";
    for (let o of e) qo(o), r += o.textContent + `
`;
    if (r.includes("@import") || (r = `@import "tailwindcss";${r}`), ie.end("Reading Stylesheets", { size: r.length, changed: rr !== r }), rr !== r) {
      rr = r, ie.start("Compile CSS");
      try {
        Ct = await Uo(r, { base: "/", loadStylesheet: rl, loadModule: ol });
      } finally {
        ie.end("Compile CSS"), ie.end("Create compiler");
      }
      or.clear();
    }
  }
  async function rl(e, r) {
    function o() {
      if (e === "tailwindcss") return { path: "virtual:tailwindcss/index.css", base: r, content: Ye.index };
      if (e === "tailwindcss/preflight" || e === "tailwindcss/preflight.css" || e === "./preflight.css") return { path: "virtual:tailwindcss/preflight.css", base: r, content: Ye.preflight };
      if (e === "tailwindcss/theme" || e === "tailwindcss/theme.css" || e === "./theme.css") return { path: "virtual:tailwindcss/theme.css", base: r, content: Ye.theme };
      if (e === "tailwindcss/utilities" || e === "tailwindcss/utilities.css" || e === "./utilities.css") return { path: "virtual:tailwindcss/utilities.css", base: r, content: Ye.utilities };
      throw new Error(`The browser build does not support @import for "${e}"`);
    }
    try {
      let t = o();
      return ie.hit("Loaded stylesheet", { id: e, base: r, size: t.content.length }), t;
    } catch (t) {
      throw ie.hit("Failed to load stylesheet", { id: e, base: r, error: t.message ?? t }), t;
    }
  }
  async function ol() {
    throw new Error("The browser build does not support plugins or config files.");
  }
  async function il(e) {
    if (!Ct) return;
    let r = /* @__PURE__ */ new Set();
    ie.start("Collect classes");
    for (let o of document.querySelectorAll("[class]")) for (let t of o.classList) or.has(t) || (or.add(t), r.add(t));
    ie.end("Collect classes", { count: r.size }), !(r.size === 0 && e === "incremental") && (ie.start("Build utilities"), ir.textContent = Ct.build(Array.from(r)), ie.end("Build utilities"));
  }
  function Nt(e) {
    async function r() {
      if (!Ct && e !== "full") return;
      let o = el++;
      ie.start(`Build #${o} (${e})`), e === "full" && await tl(), ie.start("Build"), await il(e), ie.end("Build"), ie.end(`Build #${o} (${e})`);
    }
    Wo = Wo.then(r).catch((o) => ie.error(o));
  }
  var nl = new MutationObserver(() => Nt("full"));
  function qo(e) {
    nl.observe(e, { attributes: true, attributeFilter: ["type"], characterData: true, subtree: true, childList: true });
  }
  new MutationObserver((e) => {
    let r = 0, o = 0;
    for (let t of e) {
      for (let l of t.addedNodes) l.nodeType === Node.ELEMENT_NODE && l.tagName === "STYLE" && l.getAttribute("type") === Bo && (qo(l), r++);
      for (let l of t.addedNodes) l.nodeType === 1 && l !== ir && o++;
      t.type === "attributes" && o++;
    }
    if (r > 0) return Nt("full");
    if (o > 0) return Nt("incremental");
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
  Nt("full");
  document.head.append(ir);
})();
