// ============================================================================
//  Минимальная эмуляция браузера для тестов, которые загружают релиз.
//
//  Нужна, чтобы проверить то, что нельзя проверить юнит-тестами: регистрацию
//  кастомных элементов, ленивую загрузку моделей, построение формы редактора и
//  нормализацию конфигурации. three.js и WebGL при этом не нужны.
//
//  Используется тестами release.test.js (раскладка dist/) и bundle.test.js
//  (однофайловая сборка) — обе точки входа должны вести себя одинаково.
// ============================================================================

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on) { if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); } else if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class FakeNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "", display: "" };
    this.dataset = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this._text = "";
    this._html = "";
    this._listeners = {};
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { if (n && n.parentNode) n.parentNode.removeChild(n); this.children.push(n); if (n) n.parentNode = this; return n; }
  insertBefore(n, ref) {
    if (n && n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, n); else this.children.push(n);
    if (n) n.parentNode = this;
    return n;
  }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); if (n) n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const l = this._listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
  attachShadow() { const s = new FakeNode("shadow-root"); s.host = this; this.shadowRoot = s; return s; }
  replaceWith() {}
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get clientWidth() { return 800; }
  get clientHeight() { return 400; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; }
}

class FakeHTMLElement extends FakeNode {
  constructor() { super("div"); this._props = {}; }
  connectedCallback() {}
  disconnectedCallback() {}
}

class FakeCustomElementRegistry {
  constructor() { this.map = new Map(); }
  define(name, cls) {
    // Как в браузере: повторная регистрация того же имени — ошибка. Именно так
    // ловится случай, когда на странице оказались две копии карточки.
    if (this.map.has(name)) throw new Error(`custom element «${name}» уже определён`);
    this.map.set(name, cls);
  }
  get(name) { return this.map.get(name); }
  whenDefined(name) { return Promise.resolve(this.map.get(name)); }
}

/** Установить заглушки в глобальную область и вернуть их. */
export function installDom() {
  const documentStub = {
    head: new FakeNode("head"),
    body: new FakeNode("body"),
    documentElement: new FakeNode("html"),
    baseURI: "http://localhost/threejs-3d-card.js",
    createElement: (tag) => (tag === "canvas"
      ? Object.assign(new FakeNode("canvas"), { getContext: () => null, width: 0, height: 0 })
      : new FakeNode(tag)),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = new FakeCustomElementRegistry();
  globalThis.document = documentStub;
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    ThreeJS3DCard: undefined,
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };

  return { documentStub, FakeNode, FakeHTMLElement };
}
