// ============================================================================
//  Модель для самопроверки dev/probe-glb.html: загрузка .glb из blob-URL.
//
//  Файла .glb на диске нет — страница собирает его программно (JSON-чанк +
//  BIN-чанк), отдаёт браузеру через URL.createObjectURL и публикует URL в
//  window.__GLB_URL__ ДО того, как карточка подключит этот модуль.
//
//  Так проверяется ровно то, что должен уметь загрузчик glTF: разбор
//  двоичного контейнера GLB без обращения к сети.
// ============================================================================

import { createObjectModel } from "/hacsfiles/threejs-3d-card/src/core/object-model.js";

// source.url собирается внутри модуля: к моменту его исполнения страница уже
// создала blob. Если URL нет — это ошибка страницы, и о ней надо сказать прямо,
// а не падать с невнятным «source.url не указан».
const glbUrl = window.__GLB_URL__;
if (!glbUrl) {
  console.error(
    "[probe-glb-model] window.__GLB_URL__ не задан: страница probe-glb.html " +
    "обязана собрать GLB и выставить blob-URL до подключения модели"
  );
}

export default createObjectModel({
  manifest: {
    id: "probe-glb",
    name: "Самопроверка GLB (blob-URL)",
    description: "Минимальный GLB, собранный на странице: лампа + дверь",
    apiVersion: 1,
  },

  source: {
    // У blob-URL нет расширения, поэтому формат задаём явно: определять его
    // по имени файла здесь невозможно.
    format: "gltf",
    url: glbUrl || "about:blank#glb-url-missing",
  },

  bindings: [
    {
      entity: "light.test_lamp",
      name: "Лампа (GLB)",
      target: "Lamp_Glb",
      colors: { on: "#ffd9a0", off: "#3a3a3a" },
      light: { lumens: 800, color: "#ffd9a0" },
    },
    {
      entity: "binary_sensor.test_door",
      name: "Дверь (GLB)",
      target: "Door_Glb",
      door: { hinge: "left", degrees: 95, open: ["on"] },
    },
  ],
});
