// ============================================================================
//  Тест однофайловой сборки (threejs-3d-card.js в корне репозитория).
//
//  Именно этот файл ставит HACS: он лежит в корне и указан в hacs.json как
//  filename. Значит он обязан быть самодостаточным — на сервере не будет ни
//  vendor/, ни src/, ни models/. Тест проверяет и это (по тексту файла),
//  и то, что бандл действительно работает: регистрирует элементы, публикует
//  API, отдаёт встроенные модели и поднимает three.js из самого себя.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { installDom } from "./dom-stub.mjs";

installDom();

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, "threejs-3d-card.js");

test("бандл: файл на месте и не содержит относительных импортов", async () => {
  const code = await fs.readFile(BUNDLE, "utf8");
  assert.ok(code.length > 500 * 1024, `бандл подозрительно мал: ${Math.round(code.length / 1024)} КБ`);
  const relImport = /(?:^|[^\w$])(?:import|export)\s*(?:[^"'()]*?\sfrom\s*)?["'](\.[^"']*)["']/g;
  const found = [...code.matchAll(relImport)].map((m) => m[1]);
  assert.deepEqual(found, [], "в бандле остались относительные импорты — он не самодостаточен");
  assert.doesNotMatch(code, /["']\/hacsfiles\//, "в бандле остался жёсткий путь /hacsfiles/");
  assert.match(code, /bundled\s*:\s*(?:!0|true)/, "нет отметки bundled");
});

test("бандл: регистрирует элементы и публикует API", async () => {
  await import(pathToFileURL(BUNDLE).href);
  assert.ok(customElements.get("threejs-3d-card"), "карточка не зарегистрирована");
  assert.ok(customElements.get("threejs-3d-card-editor"), "редактор не зарегистрирован");
  const api = window.ThreeJS3DCard;
  assert.ok(api, "window.ThreeJS3DCard не создан");
  assert.equal(api.bundled, true, "бандл не отметился как bundled");
  assert.equal(typeof api.defineModel, "function");
  assert.equal(typeof api.loadModel, "function");
  assert.equal(typeof api.createObjectModel, "function");
  assert.equal(typeof api.CardClass.getStubConfig, "function");
  assert.equal(typeof api.CardClass.getConfigElement, "function");
});

test("бандл: three.js внутри файла (загружается без обращения к vendor/)", async () => {
  const api = window.ThreeJS3DCard;
  const THREE = await api.loadThree();
  assert.ok(THREE && THREE.Scene, "three.js не загрузился из бандла");
  assert.equal(THREE.REVISION, "160");
  assert.equal(api.THREE, THREE, "THREE не опубликован в глобальном API");
});

test("бандл: встроенные модели доступны", async () => {
  const api = window.ThreeJS3DCard;
  const ids = api.builtinIds();
  assert.ok(ids.includes("water-tank"), `в бандле нет модели water-tank: ${ids.join(", ")}`);
  const model = await api.loadModel("water-tank");
  assert.equal(model.manifest.id, "water-tank");
  assert.ok(model.bindings.length >= 6, "у модели бака должно быть не меньше 6 привязок");
});
