// ============================================================================
//  Модель для самопроверки dev/probe-gltf.html: .gltf + внешний .bin.
//
//  Ни того, ни другого файла на диске нет: страница собирает байты, создаёт
//  ДВА blob-URL (бинарник и JSON, который ссылается на бинарник через
//  buffers[0].uri) и публикует URL спецификации в window.__GLTF_URL__ до
//  подключения этого модуля.
//
//  Смысл проверки: загрузчик должен сходить по внешней ссылке за буфером —
//  именно так работают модели, экспортированные «.gltf + .bin».
// ============================================================================

import { createObjectModel } from "/hacsfiles/threejs-3d-card/src/core/object-model.js";

const gltfUrl = window.__GLTF_URL__;
if (!gltfUrl) {
  console.error(
    "[probe-gltf-model] window.__GLTF_URL__ не задан: страница probe-gltf.html " +
    "обязана собрать .gltf и .bin и выставить blob-URL до подключения модели"
  );
}

export default createObjectModel({
  manifest: {
    id: "probe-gltf",
    name: "Самопроверка glTF (внешний буфер)",
    description: "Минимальный .gltf со ссылкой на отдельный .bin (blob-URL)",
    apiVersion: 1,
  },

  source: {
    // У blob-URL нет расширения — формат задаём явно.
    format: "gltf",
    url: gltfUrl || "about:blank#gltf-url-missing",
  },

  bindings: [
    {
      entity: "light.test_lamp",
      name: "Лампа (glTF)",
      target: "Lamp_Gltf",
      colors: { on: "#ffd9a0", off: "#3a3a3a" },
      light: { lumens: 800, color: "#ffd9a0" },
    },
    {
      entity: "binary_sensor.test_door",
      name: "Дверь (glTF)",
      target: "Door_Gltf",
      door: { hinge: "left", degrees: 95, open: ["on"] },
    },
  ],
});
