// ============================================================================
//  threejs-3d-card — публичные константы, версия API и разрешение ресурсов.
//
//  Этот файл НЕ должен импортировать ничего, кроме себя: он попадает
//  и в карточку, и в редактор, и во внешние модели.
// ============================================================================

/** Версия контракта модели. Модели объявляют её в manifest.apiVersion. */
export const API_VERSION = 1;

/** Версия продукта (карточки). Отображается в редакторе. */
export const CARD_VERSION = "0.1.1";

/** Имя кастомного элемента карточки. */
export const CARD_TAG = "threejs-3d-card";

/** Тег визуального редактора карточки. */
export const EDITOR_TAG = "threejs-3d-card-editor";

/**
 * Как загружать three.js.
 *  - "bundled" (по умолчанию) — из vendor/three.module.js, установленного
 *    вместе с карточкой. Работает в закрытом контуре без интернета.
 *  - "cdn" — динамический import с CDN, без локального файла.
 */
export const THREE_MODE = "bundled";

/** Версия three.js, на которой собрана карточка. */
export const THREE_REVISION = "160";

/** Адрес three.js на CDN (используется при THREE_MODE === "cdn" или как fallback). */
export const THREE_CDN_URL = "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js";

/**
 * Структура каталогов в релизе:
 *   threejs-3d-card.js      <- entry, ресурс Lovelace (однофайловая сборка)
 *   src/core/constants.js   <- этот файл
 *   models/…                <- встроенные модели
 *   vendor/three.module.js  <- three.js (в раскладке dist/ и при ручной установке)
 *
 * Путь к three.js строкой здесь не хранится: src/core/three-loader.js
 * импортирует его литеральным спецификатором "../../vendor/three.module.js",
 * чтобы однофайловая сборка (scripts/build.mjs) подставила библиотеку внутрь
 * файла, а раскладка dist/ работала по сети без изменений.
 */

/** Префикс, под которым HA отдаёт файлы HACS-плагинов. */
export const HACSFILES_PREFIX = "/hacsfiles";

/** Домены, для которых мы умеем показывать управление в модальном окне. */
export const DOMAIN_LABELS = {
  sensor: "Датчик",
  binary_sensor: "Бинарный датчик",
  switch: "Выключатель",
  light: "Свет",
  fan: "Вентилятор",
  cover: "Штора / привод",
  climate: "Климат",
  lock: "Замок",
  input_boolean: "Переключатель",
  input_number: "Число",
  input_select: "Выбор",
  number: "Число",
  select: "Выбор",
  media_player: "Медиаплеер",
  vacuum: "Пылесос",
  humidifier: "Увлажнитель",
  water_heater: "Водонагреватель",
  valve: "Клапан",
  button: "Кнопка",
  scene: "Сцена",
  script: "Скрипт",
  automation: "Автоматизация",
  person: "Человек",
  device_tracker: "Трекер",
  update: "Обновление",
  camera: "Камера",
  group: "Группа",
};

/** Человекочитаемые состояния HA (RU). */
export const STATE_LABELS = {
  on: "Включено",
  off: "Выключено",
  open: "Открыто",
  closed: "Закрыто",
  opening: "Открывается",
  closing: "Закрывается",
  unavailable: "Недоступно",
  unknown: "Неизвестно",
  idle: "Ожидание",
  heating: "Нагрев",
  cooling: "Охлаждение",
  drying: "Сушка",
  fan: "Обдув",
  auto: "Авто",
  heat: "Нагрев",
  cool: "Охлаждение",
  heat_cool: "Нагрев/охлаждение",
  dry: "Осушение",
  off_line: "Не в сети",
  home: "Дома",
  not_home: "Не дома",
  playing: "Воспроизведение",
  paused: "Пауза",
  locked: "Заблокировано",
  unlocked: "Разблокировано",
  cleaning: "Уборка",
  docked: "На базе",
  returning: "Возвращается",
  detected: "Обнаружено",
  clear: "Чисто",
  online: "В сети",
  ok: "Норма",
  problem: "Проблема",
};

/**
 * Абсолютный URL файла из этого же каталога/репозитория.
 * Нужен, когда модель пришла с другого origin (например /local/3d-models/)
 * и не может импортировать ядро относительным путём.
 */
export function absoluteModuleUrl(relative) {
  return new URL(relative, import.meta.url).href;
}

/**
 * Глобальный объект для внешних скриптов и отладки из консоли браузера.
 * Заполняется в entry-файле (src/card.js).
 */
export function globalApi() {
  if (typeof window === "undefined") return {};
  if (!window.ThreeJS3DCard) {
    window.ThreeJS3DCard = { version: CARD_VERSION, apiVersion: API_VERSION };
  }
  return window.ThreeJS3DCard;
}
