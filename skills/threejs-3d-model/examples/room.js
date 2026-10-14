// ============================================================================
//  Демо-комната: обёртка над спецификацией room.json.
//
//  Куда положить (на сервере Home Assistant):
//     config/www/3d/room.js     ← этот файл
//     config/www/3d/room.json   ← спецификация
//     config/www/3d/room.obj    ← геометрия
//
//  Конфигурация карточки:
//     type: custom:threejs-3d-card
//     model: /local/3d/room.js
//
//  Фабрику createObjectModel берём из глобального API карточки, а не импортом
//  по абсолютному пути: каталог установки зависит от имени репозитория
//  (/hacsfiles/Three.js-3D-Card/… при HACS, /local/<любая-папка>/… вручную),
//  и импорт с жёстким путём ломался бы при любой другой установке.
//
//  Вариант с импортом тоже возможен, если файл лежит на том же origin, что и
//  карточка, — но тогда путь нужно подставить под свою установку:
//     import { createObjectModel } from "/hacsfiles/<имя-репозитория>/src/core/object-model.js";
// ============================================================================

const { createObjectModel } = window.ThreeJS3DCard;
if (typeof createObjectModel !== "function") {
  throw new Error(
    "threejs-3d-card не загружена: ресурс Lovelace должен быть подключён " +
    "до обращения к модели (см. README, раздел «Установка»)."
  );
}

// Спецификация читается с сервера рядом с этим файлом: так её можно править
// без пересборки карточки и без правки этого модуля.
const url = new URL("./room.json", import.meta.url).href;
const spec = await fetch(url, { cache: "no-cache" }).then((r) => {
  if (!r.ok) throw new Error(`не удалось прочитать ${url}: ${r.status}`);
  return r.json();
});

export default createObjectModel(spec);
