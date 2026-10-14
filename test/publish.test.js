// ============================================================================
//  Тест раскладки релиза для HACS.
//
//  HACS ставит Dashboard-плагин из архива репозитория на теге и знает два
//  варианта: файл из hacs.json (filename) лежит в корне — тогда скачиваются
//  только корневые .js; либо файла в корне нет, и он найден в dist/ — тогда
//  скачивается содержимое dist/ целиком, с сохранением структуры
//  (custom_components/hacs/repositories/base.py, plugin.py).
//
//  Наш плагин многофайловый (ядро + модели + three.js), поэтому нужен ровно
//  второй вариант. Ошибка здесь не проявляется в тестах ядра: карточка просто
//  не найдёт ни src/, ни models/, ни vendor/ на сервере пользователя.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const ENTRY = "threejs-3d-card.js";

/** Ключи hacs.json, которые HACS действительно читает (HacsManifest). */
const MANIFEST_KEYS = new Set([
  "content_in_root", "country", "filename", "hacs", "hide_default_branch",
  "homeassistant", "manifest", "name", "persistent_directory", "render_readme",
  "zip_release",
]);

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Плоский список файлов (относительные пути с «/»). */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

const sha = async (file) =>
  crypto.createHash("sha1").update(await fs.readFile(file)).digest("hex");

// ---- 1. манифест ------------------------------------------------------------

test("hacs.json: имя файла и допустимые ключи", async () => {
  const manifest = await readJson(path.join(ROOT, "hacs.json"));
  assert.equal(manifest.filename, ENTRY, "filename должен указывать на точку входа");
  assert.ok(manifest.name, "в hacs.json нет name — HACS покажет пустую карточку");
  assert.notEqual(manifest.content_in_root, true,
    "content_in_root: true заставит HACS скачать только один файл — ядро и vendor не попадут на сервер");
  for (const key of Object.keys(manifest)) {
    assert.ok(MANIFEST_KEYS.has(key), `ключ «${key}» HACS не читает (см. HacsManifest)`);
  }
});

test("hacs.json: homeassistant задан как версия вида YYYY.M.P", async () => {
  const manifest = await readJson(path.join(ROOT, "hacs.json"));
  if (manifest.homeassistant) {
    assert.match(String(manifest.homeassistant), /^\d{4}\.\d{1,2}(\.\d+)?$/);
  }
});

// ---- 2. выбор режима установки ---------------------------------------------

test("точки входа нет в корне (иначе HACS выберет режим «только корневые .js»)", async () => {
  assert.equal(await exists(path.join(ROOT, ENTRY)), false,
    `в корне репозитория не должно быть ${ENTRY}: HACS скачал бы только корневые .js, ` +
    "и карточка осталась бы без src/, models/ и vendor/");
  assert.ok(await exists(path.join(DIST, ENTRY)),
    `нет dist/${ENTRY} — выполните npm run build и закоммитьте dist/`);
});

test("dist закоммичен: он не должен попадать в .gitignore", async () => {
  const ignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");
  const lines = ignore.split(/\r?\n/).map((l) => l.trim());
  assert.equal(lines.includes("dist/") || lines.includes("dist"), false,
    "dist/ в .gitignore: HACS собирает релиз из архива репозитория, без dist/ установка не работает");
});

// ---- 3. состав релиза -------------------------------------------------------

test("в dist есть точка входа, ядро, модели, three.js и загрузчики форматов", async () => {
  const required = [
    ENTRY,
    "src/card.js",
    "src/editor.js",
    "src/core/scene.js",
    "src/core/registry.js",
    "src/core/object-model.js",
    "src/core/object-rules.js",
    "src/core/geometry.js",
    "models/water-tank/manifest.js",
    "models/production-room/manifest.js",
    "vendor/three.module.js",
    "vendor/three-addons/loaders/OBJLoader.js",
    "vendor/three-addons/loaders/MTLLoader.js",
    "vendor/three-addons/loaders/GLTFLoader.js",
    "vendor/three-addons/utils/BufferGeometryUtils.js",
  ];
  for (const rel of required) {
    assert.ok(await exists(path.join(DIST, rel)), `в релизе нет dist/${rel}`);
  }
});

test("точка входа реэкспортирует ядро относительным путём", async () => {
  const code = await fs.readFile(path.join(DIST, ENTRY), "utf8");
  assert.match(code, /from\s+["']\.\/src\/card\.js["']/, "точка входа не импортирует ./src/card.js");
});

test("dist/src и dist/models побайтово совпадают с исходниками", async () => {
  for (const dir of ["src", "models"]) {
    const from = await listFiles(path.join(ROOT, dir));
    const to = await listFiles(path.join(DIST, dir));
    assert.deepEqual(to.sort(), from.sort(),
      `состав dist/${dir} разошёлся с ${dir}/ — пересоберите релиз (npm run build)`);
    for (const rel of from) {
      assert.equal(
        await sha(path.join(DIST, dir, rel)),
        await sha(path.join(ROOT, dir, rel)),
        `dist/${dir}/${rel} устарел: пересоберите релиз (npm run build)`,
      );
    }
  }
});

// ---- 4. пути внутри релиза не зависят от каталога установки -----------------

test("аддоны three.js импортируют локальную копию относительным путём", async () => {
  const addons = [
    "vendor/three-addons/loaders/OBJLoader.js",
    "vendor/three-addons/loaders/MTLLoader.js",
    "vendor/three-addons/loaders/GLTFLoader.js",
    "vendor/three-addons/utils/BufferGeometryUtils.js",
  ];
  for (const rel of addons) {
    const code = await fs.readFile(path.join(DIST, rel), "utf8");
    assert.match(code, /["']\.\.\/\.\.\/three\.module\.js["']/, `${rel}: нет относительного импорта three`);
    assert.doesNotMatch(code, /(from|import)\s*\(?\s*["']three["']/, `${rel}: остался импорт по имени пакета «three»`);
    assert.doesNotMatch(code, /["']\/hacsfiles\//, `${rel}: остался абсолютный путь /hacsfiles/`);
  }
});

test("в исходниках карточки нет жёстких путей /hacsfiles/threejs-3d-card", async () => {
  for (const rel of await listFiles(path.join(ROOT, "src"))) {
    const code = await fs.readFile(path.join(ROOT, "src", rel), "utf8");
    assert.doesNotMatch(code, /["']\/hacsfiles\/threejs-3d-card/, `src/${rel}: путь зависит от имени каталога установки`);
  }
});

test("путь к three.js считается от модуля, а не задан строкой", async () => {
  const code = await fs.readFile(path.join(ROOT, "src/core/constants.js"), "utf8");
  assert.match(code, /THREE_BUNDLED_URL\s*=\s*new URL\(/,
    "THREE_BUNDLED_URL должен вычисляться от import.meta.url");
});
