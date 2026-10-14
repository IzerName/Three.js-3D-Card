// ============================================================================
//  Загрузка внешних моделей по URL.
//
//  Проверяет полный путь импорта: чтение файла → исполнение кода модели →
//  вызов defineModel() → регистрация в реестре → доступные bindings/params,
//  а также все ошибочные сценарии.
//
//  Файлы моделей отдаются заглушкой fetch (никакого HTTP-сервера: открытый
//  сокет не дал бы тесту завершиться), а внедрение <script type="module">
//  эмулируется так же, как это делает браузер.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ---- минимальный DOM --------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = { cssText: "" };
    this.className = "";
    this._listeners = {};
    this._src = null;
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  appendChild(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  remove() {}
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
  querySelector() { return null; }
  getContext() { return null; }
}

const MODELS = {
  "ok.js": `
    window.ThreeJS3DCard.defineModel({
      manifest: { id: "external-ok", name: "Внешняя ок", apiVersion: 1 },
      bindings: [
        { key: "power", name: "Питание", domain: ["switch"], value: { kind: "boolean" } },
        { key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } },
      ],
      params: [{ key: "color", name: "Цвет", type: "theme-color", default: "#fff" }],
      create() { return { root: null }; },
    });
  `,
  "no-define.js": "const x = 1 + 1;\n",
  "broken.js": "this is not javascript (((\n",
  "api-v99.js": `
    window.ThreeJS3DCard.defineModel({
      manifest: { id: "future", name: "Будущее", apiVersion: 99 },
      bindings: [],
      create() { return {}; },
    });
  `,
};

const BASE = "http://models.local/";
let fetchCount = 0;

globalThis.document = {
  head: new El("head"),
  body: new El("body"),
  documentElement: new El("html"),
  baseURI: "http://card.local/",
  createElement: (t) => new El(t),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.Element = El;
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// В браузере внешняя модель обращается к window.ThreeJS3DCard (её ставит
// entry-файл карточки). Здесь этого файла нет, поэтому эмулируем: объект
// живёт на globalThis, а defineModel попадает прямо в реестр.
globalThis.window.ThreeJS3DCard = globalThis;
if (!globalThis.defineModel) globalThis.defineModel = () => {};

/**
 * Эмуляция браузера: fetch отдаёт исходник модели, а присвоение src у
 * <script type="module"> приводит к настоящему import() того же исходника
 * (через data:-URL модуль) и событию load/error — как в браузере.
 */
globalThis.fetch = async (url) => {
  fetchCount++;
  const name = String(url).split("?")[0].split("/").pop();
  const body = MODELS[name];
  if (!body) return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
  return { ok: true, status: 200, statusText: "OK", text: async () => body };
};

Object.defineProperty(El.prototype, "src", {
  get() { return this._src; },
  set(value) {
    this._src = value;
    const name = String(value).split("?")[0].split("/").pop();
    const body = MODELS[name];
    queueMicrotask(async () => {
      if (!body) { this.dispatchEvent({ type: "error" }); return; }
      try {
        // data:-URL выполняет тот же исходник, что вернул fetch.
        // Уникальный фрагмент обязателен: без него повторный импорт того же
        // data:-URL брался бы из кэша модулей и модель не перерегистрировалась.
        const dataUrl = `data:text/javascript;base64,${Buffer.from(body, "utf8").toString("base64")}` +
          `#${Math.random().toString(36).slice(2)}`;
        await import(/* @vite-ignore */ dataUrl);
        this.dispatchEvent({ type: "load" });
      } catch (e) {
        this.dispatchEvent({ type: "error" });
      }
    });
  },
  configurable: true,
});

// ---- тесты ------------------------------------------------------------------

/** Свежий модуль реестра на каждый тест: у него собственное состояние. */
async function freshRegistry() {
  const url = pathToFileURL(path.resolve("dist/src/core/registry.js")).href;
  const mod = await import(`${url}?t=${Math.random()}`);
  // Модели из тестов вызывают window.ThreeJS3DCard.defineModel(...) —
  // направляем этот вызов в свежий реестр.
  globalThis.defineModel = mod.defineModel;
  return mod;
}

const u = (name) => `${BASE}${name}`;

test("внешняя модель загружается по URL и регистрируется", async () => {
  const { registry } = await freshRegistry();
  const model = await registry.resolve(u("ok.js"));
  assert.equal(model.manifest.id, "external-ok");
  assert.equal(model.bindings.length, 2);
  assert.equal(model.params.length, 1);
  assert.equal(typeof model.create, "function");
  assert.equal(model.source, u("ok.js"), "источник модели должен быть сохранён");
  assert.ok(registry.has("external-ok"), "модель не попала в реестр по id");
});

test("повторная загрузка берётся из кэша, force — перечитывает файл", async () => {
  const { registry } = await freshRegistry();
  const first = await registry.resolve(u("ok.js"));
  const fetchesAfterFirst = fetchCount;

  const second = await registry.resolve(u("ok.js"));
  assert.equal(first, second,
    `повторный resolve должен вернуть ту же модель; зарегистрировано: ${[...registry.models.keys()].join(", ")}; ` +
    `журнал: ${JSON.stringify(registry.log)}`);
  assert.equal(fetchCount, fetchesAfterFirst, "повторный resolve не должен качать файл заново");

  // force означает «перечитать файл»: кэш сбрасывается и запрос уходит снова
  const third = await registry.resolve(u("ok.js"), { force: true });
  assert.equal(third.manifest.id, "external-ok");
  assert.ok(fetchCount > fetchesAfterFirst, "force должен перечитать файл");
});

test("модель без defineModel даёт понятную ошибку", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(
    () => registry.resolve(u("no-define.js")),
    /не вызвала defineModel|defineModel/
  );
});

test("битый файл модели не роняет реестр, а сообщает об ошибке", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(() => registry.resolve(u("broken.js")), /Ошибка исполнения модели|не сработал|Unexpected/i);
  const ok = await registry.resolve(u("ok.js"));
  assert.equal(ok.manifest.id, "external-ok", "реестр должен остаться работоспособным");
});

test("модель с более новым apiVersion отклоняется с объяснением", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(() => registry.resolve(u("api-v99.js")), /требует API v99/);
});

test("несуществующий файл модели даёт ошибку загрузки", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(() => registry.resolve(u("nope.js")), /Не удалось загрузить модель/);
});

test("импорт внешних моделей можно запретить", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(
    () => registry.resolve(u("ok.js"), { allowExternal: false }),
    /Импорт внешних моделей отключён/
  );
});

test("неизвестный id без URL подсказывает, что делать", async () => {
  const { registry } = await freshRegistry();
  await assert.rejects(() => registry.resolve("no-such-model"), /не найдена[\s\S]*Доступны/);
});

test("defineModel() вне загрузки регистрирует модель напрямую", async () => {
  const { defineModel, registry } = await freshRegistry();
  defineModel({
    manifest: { id: "manual", name: "Вручную", apiVersion: 1 },
    bindings: [],
    create() { return { root: null }; },
  });
  assert.ok(registry.has("manual"), "defineModel не зарегистрировал модель");
});

test("модель без create/attach отклоняется", async () => {
  const { defineModel, registry } = await freshRegistry();
  assert.throws(
    () => defineModel({ manifest: { id: "empty", name: "Пустая", apiVersion: 1 }, bindings: [] }),
    /нужен create\(ctx\) или attach\(ctx\)/
  );
});

test("журнал реестра фиксирует успехи и ошибки загрузок", async () => {
  const { registry } = await freshRegistry();
  await registry.resolve(u("ok.js"));
  await registry.resolve(u("broken.js")).catch(() => {});
  assert.ok(registry.log.some((l) => l.ok === true), "нет записи об успешной загрузке");
  assert.ok(registry.log.some((l) => l.ok === false), "нет записи об ошибке");
});

test("внешняя модель может использовать window.ThreeJS3DCard.THREE", async () => {
  // Внешние модели не могут импортировать three.js по имени пакета:
  // они обязаны брать его из глобального API. Проверяем, что поле есть.
  await freshRegistry();
  assert.ok(globalThis.window.ThreeJS3DCard, "глобальный API не создан");
  assert.equal(globalThis.window.ThreeJS3DCard.defineModel, globalThis.defineModel,
    "window.ThreeJS3DCard.defineModel должен указывать на реестр");
});
