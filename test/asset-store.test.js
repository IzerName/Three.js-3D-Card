// ============================================================================
//  AssetStore — хранилище файлов моделей в браузере (T-010).
//
//  В Node нет IndexedDB, поэтому бэкенд подменяется Map-фейком, а API
//  (put/get/list/remove/objectUrl) проверяется в чистом виде. Отдельно
//  проверяется, что createIndexedDBBackend честно падает без indexedDB и
//  что общий экземпляр (getSharedAssetStore) возвращает null — редактор
//  и карточка должны работать и без хранилища.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  AssetStore, createIndexedDBBackend, getSharedAssetStore, setSharedAssetStore,
} from "../src/core/asset-store.js";

/** Фейк IndexedDB-бэкенда поверх Map. */
function fakeBackend() {
  const map = new Map();
  return {
    put: async (rec) => { map.set(rec.id, rec); },
    get: async (id) => map.get(id) || null,
    all: async () => [...map.values()],
    remove: async (id) => { map.delete(id); },
  };
}

function testFile(name = "model.glb", type = "model/gltf-binary", size = 1234) {
  const body = new Uint8Array(size || 8);
  if (typeof File !== "undefined") return new File([body], name, { type });
  return new Blob([body], { type });
}

test("put возвращает id с префиксом t3d-asset-, имя, тип и размер", async () => {
  const store = new AssetStore(fakeBackend());
  const rec = await store.put(testFile("house.glb"));
  assert.ok(rec.id.startsWith("t3d-asset-"), `id: ${rec.id}`);
  assert.equal(rec.name, "house.glb");
  assert.equal(rec.type, "model/gltf-binary");
  assert.ok(rec.size > 0);
});

test("get отдаёт запись без blob; неизвестный id — null", async () => {
  const store = new AssetStore(fakeBackend());
  const rec = await store.put(testFile("a.obj", "model/obj"));
  const got = await store.get(rec.id);
  assert.equal(got.name, "a.obj");
  assert.equal(got.size, rec.size);
  assert.ok(!("blob" in got), "blob наружу не выносим");
  assert.equal(await store.get("t3d-asset-nope"), null);
});

test("list показывает все сохранённые файлы", async () => {
  const store = new AssetStore(fakeBackend());
  await store.put(testFile("a.glb"));
  await store.put(testFile("b.mtl", "model/mtl"));
  const all = await store.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.name).sort(), ["a.glb", "b.mtl"]);
});

test("remove удаляет файл и возвращает true; повторный remove — false", async () => {
  const store = new AssetStore(fakeBackend());
  const rec = await store.put(testFile("x.glb"));
  assert.equal(await store.remove(rec.id), true);
  assert.equal(await store.get(rec.id), null);
  assert.equal(await store.list().then((l) => l.length), 0);
  assert.equal(await store.remove(rec.id), false);
});

test("objectUrl: повторный вызов — тот же URL, после revoke — свежий", async () => {
  const store = new AssetStore(fakeBackend());
  const rec = await store.put(testFile("y.glb"));
  const a = await store.objectUrl(rec.id);
  const b = await store.objectUrl(rec.id);
  assert.equal(a.url, b.url, "пока URL жив — отдаём кешированный");
  a.revoke();
  const c = await store.objectUrl(rec.id);
  assert.notEqual(c.url, a.url, "после revoke хранилище выдаёт новый URL");
  c.revoke();
  c.revoke(); // повторный отзыв не падает
});

test("objectUrl неизвестного id — reject", async () => {
  const store = new AssetStore(fakeBackend());
  await assert.rejects(() => store.objectUrl("t3d-asset-unknown"));
});

test("put без имени файла — ошибка", async () => {
  const store = new AssetStore(fakeBackend());
  await assert.rejects(() => store.put({ size: 10, type: "" }));
});

test("некорректный бэкенд — ошибка в конструкторе", () => {
  assert.throws(() => new AssetStore({}), /бэкенд/);
  assert.throws(() => new AssetStore(null), /бэкенд/);
});

test("createIndexedDBBackend без indexedDB честно падает", () => {
  assert.equal(typeof indexedDB, "undefined", "в Node нет indexedDB");
  assert.throws(() => createIndexedDBBackend(), /IndexedDB/);
});

test("getSharedAssetStore в Node возвращает null и не падает", () => {
  assert.equal(getSharedAssetStore(), null);
  const store = new AssetStore(fakeBackend());
  setSharedAssetStore(store);
  assert.equal(getSharedAssetStore(), store);
  setSharedAssetStore(null);
  assert.equal(getSharedAssetStore(), null);
});
