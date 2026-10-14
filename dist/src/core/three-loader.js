// ============================================================================
//  Загрузка three.js: локальная копия из релиза либо CDN.
//  Локальный вариант — основной: карточка работает в закрытом контуре
//  без доступа в интернет.
// ============================================================================

import { THREE_MODE, THREE_CDN_URL, THREE_BUNDLED_URL } from "./constants.js";

let promise = null;
let loaded = null;

/** Загрузить three.js (одна попытка на страницу, результат кешируется). */
export function loadThree() {
  if (loaded) return Promise.resolve(loaded);
  if (promise) return promise;

  promise = (async () => {
    const attempts = [];
    if (THREE_MODE === "bundled") {
      attempts.push({ name: "локальный three.js", url: THREE_BUNDLED_URL });
      attempts.push({ name: "CDN three.js", url: THREE_CDN_URL });
    } else {
      attempts.push({ name: "CDN three.js", url: THREE_CDN_URL });
      attempts.push({ name: "локальный three.js", url: THREE_BUNDLED_URL });
    }

    const errors = [];
    for (const a of attempts) {
      try {
        const mod = await import(/* @vite-ignore */ a.url);
        const THREE = mod.default && mod.default.Scene ? mod.default : mod;
        if (!THREE || !THREE.Scene) throw new Error("модуль не содержит three.js");
        loaded = THREE;
        // Публикуем в глобальном API сразу: внешние модели берут three.js
        // из window.ThreeJS3DCard.THREE (см. docs/MODEL_API.md).
        if (typeof window !== "undefined") {
          window.ThreeJS3DCard = window.ThreeJS3DCard || {};
          window.ThreeJS3DCard.THREE = THREE;
          window.ThreeJS3DCard.threeRevision = THREE.REVISION;
        }
        return THREE;
      } catch (e) {
        errors.push(`${a.name}: ${e && e.message ? e.message : e}`);
      }
    }
    throw new Error(
      "Не удалось загрузить three.js. " +
      errors.join(" | ") +
      ". Проверьте, что файл vendor/three.module.js установлен вместе с карточкой, " +
      "либо что браузер имеет доступ к cdn.jsdelivr.net."
    );
  })();

  return promise;
}

/** Уже загруженный three.js (или null). */
export function threeSync() {
  return loaded;
}
