// ============================================================================
//  Тест загрузки релиза в эмуляции браузера.
//
//  Проверяет то, что нельзя проверить юнит-тестами: регистрацию кастомных
//  элементов, ленивую загрузку моделей, построение формы редактора и
//  нормализацию конфигурации. three.js и WebGL не нужны.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ---- минимальная эмуляция DOM ----------------------------------------------
// Общая с bundle.test.js: обе точки входа (dist/ и однофайловая сборка) должны
// вести себя одинаково. Заглушки живут в test/dom-stub.mjs.
import { installDom } from "./dom-stub.mjs";

installDom();

// ---- загрузка релиза --------------------------------------------------------

const DIST = path.resolve("dist");
const entryUrl = pathToFileURL(path.join(DIST, "threejs-3d-card.js")).href;

test("релиз: регистрирует элементы и публикует API", async () => {
  await import(entryUrl);
  assert.ok(customElements.get("threejs-3d-card"), "карточка не зарегистрирована");
  assert.ok(customElements.get("threejs-3d-card-editor"), "редактор не зарегистрирован");
  const api = window.ThreeJS3DCard;
  assert.ok(api, "window.ThreeJS3DCard не создан");
  assert.equal(typeof api.defineModel, "function");
  assert.equal(typeof api.loadModel, "function");
  assert.ok(api.registry, "реестр моделей недоступен");
  assert.equal(typeof api.CardClass.getStubConfig, "function");
  assert.equal(typeof api.CardClass.getConfigElement, "function");
});

test("релиз: встроенная модель water-tank загружается и валидна", async () => {
  const api = window.ThreeJS3DCard;
  const model = await api.loadModel("water-tank");
  assert.equal(model.manifest.id, "water-tank");
  assert.equal(model.manifest.apiVersion, 1);
  assert.ok(model.bindings.length >= 6, "у модели бака должно быть не меньше 6 привязок");
  assert.ok(model.params.length >= 8, "у модели бака должны быть параметры внешнего вида");
  const level = model.bindings.find((b) => b.key === "level");
  assert.ok(level, "нет привязки level");
  assert.equal(level.required, true);
  assert.deepEqual(level.domain, ["sensor", "input_number", "number"]);
  assert.equal(typeof model.create, "function");
});

test("реестр: псевдонимы старых карточек работают", async () => {
  const api = window.ThreeJS3DCard;
  const model = await api.loadModel("custom:water-tank-card");
  assert.equal(model.manifest.id, "water-tank");
});

test("реестр: понятная ошибка для неизвестной модели", async () => {
  const api = window.ThreeJS3DCard;
  await assert.rejects(() => api.loadModel("no-such-model"), /не найдена/);
});

test("getStubConfig: подставляет сущности из hass", () => {
  const api = window.ThreeJS3DCard;
  const hass = {
    states: {
      "sensor.tank_level": { state: "55", attributes: { unit_of_measurement: "%", friendly_name: "Уровень" } },
      "sensor.tank_liters": { state: "120", attributes: { unit_of_measurement: "L" } },
      "binary_sensor.tank_high": { state: "off", attributes: { device_class: "moisture" } },
    },
  };
  const stub = api.CardClass.getStubConfig(hass, []);
  assert.equal(stub.type, "custom:threejs-3d-card");
  assert.equal(stub.model, "water-tank");
  assert.ok(stub.entities, "getStubConfig не заполнил entities");
  assert.equal(stub.entities.level, "sensor.tank_level");
});

test("редактор: setConfig строит форму по схеме модели", async () => {
  const EditorClass = customElements.get("threejs-3d-card-editor");
  const editor = new EditorClass();
  editor.setConfig({ type: "custom:threejs-3d-card", model: "water-tank" });
  // ждём ленивую загрузку модели и повторный рендер
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(editor.config, "редактор не сохранил конфигурацию");
  assert.equal(editor.config.model, "water-tank");
  const host = editor.shadowRoot || editor;
  const html = JSON.stringify(host.children.map((c) => c.innerHTML)) + JSON.stringify(host.children.map((c) => c._html));
  assert.ok(html.includes("Устройства и параметры") || host.children.length > 0, "форма редактора пуста");
});

test("карточка: setConfig принимает legacy-формат (entities без model)", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({
    type: "custom:water-tank-card",
    entities: { level: "sensor.x" },
    full_value: 100,
  });
  const cfg = card.getConfig();
  assert.equal(cfg.model, "water-tank", "legacy-конфигурация не преобразована в модель");
  assert.equal(cfg.entities.level, "sensor.x");
});

test("карточка: getCardSize зависит от высоты", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank", height: 500 });
  assert.equal(card.getCardSize(), 10);
});

test("карточка: без height — авто-высота на доступную область", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank" });
  assert.equal(card._heightPx(), null, "высота не задана — карточка занимает доступную область");
  // Пока модель не загружена, Lovelace резервирует место по общей рекомендации
  // (360 px), а после загрузки — по manifest.size.defaultHeight модели.
  assert.equal(card.getCardSize(), 7);
  card._model = { manifest: { size: { defaultHeight: 400 } } };
  assert.equal(card.getCardSize(), 8);
  delete card._model;
  const grid = card.getGridOptions();
  assert.equal(grid.columns, 12, "в разделе карточка занимает всю ширину");
  assert.ok(grid.rows >= 3, "в разделе клетка задаёт высоту — карточка её занимает");
});

test("карточка: авто-высота не пересобирает сцену при смене height", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank" });
  let applied = 0;
  let rebuilt = 0;
  card._engine = {
    applyConfig() { applied++; },
    setDiagnosticsVisible() {},
  };
  card._rebuild = () => { rebuilt++; };
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank", height: 480 });
  assert.equal(rebuilt, 0, "смена высоты не должна пересобирать сцену");
  assert.equal(applied, 1, "высота применяется через applyConfig");
  assert.equal(card._heightPx(), 480);
});

test("карточка: авто-высота растягивается, а без высоты родителя берёт рекомендованную", async () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank" });
  card._model = { manifest: { size: { defaultHeight: 400 } } };

  // Родитель задал высоту (клетка раздела, панельный вид): растягиваемся.
  const root = { clientHeight: 500, style: { height: "", minHeight: "" }, parentNode: null };
  card._root = root;
  card._engine = null;
  card._applyHeight();
  assert.equal(root.style.height, "100%");
  assert.equal(card._autoFilled, undefined);

  // Родитель высоты не задал («кирпичная» раскладка): после раскладки
  // подставляем рекомендованную моделью высоту, иначе карточка — полоска.
  root.clientHeight = 120;
  card._applyHeight();
  assert.equal(root.style.height, "100%", "до замера растягиваемся");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(card._autoFilled, true, "высота не задана родителем — берём рекомендацию модели");
  assert.equal(root.style.height, "400px");
  assert.equal(root.style.minHeight, "120px");
});

test("карточка: вид камеры переживает пересборку сцены", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const cfg = { type: "custom:threejs-3d-card", model: "water-tank" };

  // Первая сцена: пользователь повернул модель, карточку пересоздали
  // (Lovelace делает это в окне предпросмотра на каждое изменение конфигурации).
  const first = new CardClass();
  first.setConfig(cfg);
  const view = { target: [1, 2, 3], radius: 7, phi: 1.1, theta: 0.5 };
  first._engine = { getView: () => view, dispose() {}, disposeDom() {} };
  first._root = { parentNode: { removeChild() {} } };
  first.disconnectedCallback();

  // Новая сцена сразу после пересборки — вид возвращается.
  const second = new CardClass();
  second.setConfig(cfg);
  const applied = [];
  second._restoreView({ setView: (v) => { applied.push(v); return true; } });
  assert.equal(applied.length, 1, "вид камеры не восстановлен");
  assert.deepEqual(applied[0].target, [1, 2, 3]);
  assert.equal(applied[0].radius, 7);

  // Другая модель — чужой вид не подставляем.
  const third = new CardClass();
  third.setConfig({ type: "custom:threejs-3d-card", model: "production-room" });
  const other = [];
  third._restoreView({ setView: (v) => { other.push(v); return true; } });
  assert.equal(other.length, 0, "вид от другой модели применяться не должен");
});

test("редактор: эхо конфигурации не перерисовывает форму (фокус сохраняется)", async () => {
  const EditorClass = customElements.get("threejs-3d-card-editor");
  const editor = new EditorClass();
  // В браузере элемент подключён; заглушка DOM про isConnected не знает.
  Object.defineProperty(editor, "isConnected", { value: true, configurable: true });

  const cfg = { type: "custom:threejs-3d-card", model: "water-tank", title: "Бак", height: 420 };
  editor.setConfig(cfg);
  await new Promise((r) => setTimeout(r, 50));   // ленивая загрузка модели
  const block = editor._root.children[0];

  // 1. HA возвращает редактору его же конфиг (hui-element-editor так делает
  //    после каждого config-changed) — форма должна остаться той же: иначе
  //    innerHTML = "" уничтожает поле вместе с фокусом после первого символа.
  editor.setConfig(Object.assign({}, cfg));
  assert.equal(editor._root.children[0], block, "форма перерисована на эхо конфигурации");

  // 2. Пользователь печатает символ: _patch отправляет конфиг, HA отвечает тем
  //    же конфигом — форма по-прежнему не перерисовывается.
  editor._patch({ title: "Ба" });
  editor.setConfig(Object.assign({}, editor.config));
  assert.equal(editor._root.children[0], block, "форма перерисована после ввода символа");

  // 3. Настоящее изменение (например, правка YAML) форму обновляет.
  editor.setConfig(Object.assign({}, editor.config, { title: "Другой заголовок" }));
  assert.notEqual(editor._root.children[0], block, "изменённый конфиг должен обновить форму");
});
