// Точка входа однофайловой сборки. Файл создаётся сборкой (scripts/build.mjs).
// Отметка bundled говорит карточке, что three.js и загрузчики форматов уже
// внутри файла и проверять каталог vendor/ в рантайме не нужно.
window.ThreeJS3DCard = Object.assign(window.ThreeJS3DCard || {}, { bundled: true });
await import("./src/card.js");
