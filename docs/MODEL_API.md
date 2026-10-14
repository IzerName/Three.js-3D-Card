# API модели threejs-3d-card

**Версия API: 1** · относится к карточке `custom:threejs-3d-card` v0.1.0 и выше.

Модель — это обычный JavaScript-файл (ES-модуль), который описывает 3D-сцену
и **сам объявляет свои переменные**: какие сущности Home Assistant к ним
подключаются и какие настройки есть у сцены. Из этого описания карточка
автоматически строит форму в визуальном редакторе — с выбором устройств через
штатный `ha-entity-picker`, без правки кода карточки.

```
                 manifest.js / model.js
        ┌──────────────────────────────────────┐
        │  manifest  — кто я, как меня звать    │
        │  bindings  — какие устройства нужны   │──► форма в редакторе карточки
        │  params    — какие есть настройки     │
        │  create()  — как меня нарисовать      │──► three.js сцена
        └──────────────────────────────────────┘
```

---

## 1. Быстрый старт: минимальная модель

Положите файл, например, в `config/www/3d-models/my-box.js`:

```js
// window.ThreeJS3DCard доступен всегда — импорты не нужны.
window.ThreeJS3DCard.defineModel({
  manifest: {
    id: "my-box",
    name: "Моя коробка",
    description: "Демонстрационная модель",
    apiVersion: 1,
  },

  bindings: [
    {
      key: "power",
      name: "Питание",
      domain: ["switch", "binary_sensor"],
      value: { kind: "boolean" },
    },
    {
      key: "level",
      name: "Уровень, %",
      domain: ["sensor"],
      unit: ["%"],
      value: { kind: "number" },
    },
  ],

  params: [
    { key: "color", name: "Цвет коробки", type: "theme-color", default: "var(--primary-color)" },
  ],

  create(ctx) {
    // three.js всегда доступен через контекст — брать его на верхнем уровне файла нельзя
    const THREE = ctx.THREE;
    const color = new THREE.Color(ctx.resolveColor(ctx.params.color, "#1f6feb"));
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.5 })
    );
    mesh.position.y = 0.5;

    return {
      root: mesh,                       // что добавить в сцену
      applyStates(view) {               // view — значения всех привязок
        const on = view.power && view.power.value;
        mesh.material.emissive.setHex(on ? 0x1f6feb : 0x000000);
        mesh.material.emissiveIntensity = on ? 0.6 : 0;
      },
      frame(dt, time) {                 // анимация (необязательно)
        mesh.rotation.y += dt * 0.5;
      },
    };
  },
});
```

Подключение в карточке:

```yaml
type: custom:threejs-3d-card
model: /local/3d-models/my-box.js
title: Моя коробка
entities:
  power: switch.my_device
  level: sensor.my_level
```

Либо через редактор: **Модель → «Импортировать модель по URL…»** и указать
`/local/3d-models/my-box.js`.

> ⚠️ Код модели исполняется в контексте страницы Home Assistant с правами
> вашей сессии. Загружайте только свои модели или модели из источников,
> которым доверяете.

---

## 2. Структура описания модели

```js
{
  manifest: { ... },   // обязателен: идентификация, камера, окружение
  bindings: [ ... ],   // привязки к сущностям HA (попадают в редактор)
  params:   [ ... ],   // настройки внешнего вида (тоже в редактор)
  defaults: { config: { title, height, show_hud, params } },
  create(ctx) {
    // three.js всегда доступен через контекст — брать его на верхнем уровне файла нельзя
    const THREE = ctx.THREE; ... }, // обязателен для обычной модели
  attach(ctx) { ... }, // альтернатива create() для готовых движков
}
```

Внешняя модель обязана один раз вызвать `window.ThreeJS3DCard.defineModel({...})`.

---

## 3. `manifest` — паспорт модели

| Поле | Тип | Обяз. | Назначение |
|---|---|---|---|
| `id` | string | **да** | Уникальный идентификатор. Псевдонимы вида `custom:my-card` можно добавить в реестр карточки. |
| `name` | string | **да** | Название в списке моделей редактора. |
| `description` | string | нет | Пояснение под названием. |
| `apiVersion` | number | нет (по умолчанию 1) | Версия контракта. Если больше поддерживаемой карточкой — модель не загрузится с понятной ошибкой. |
| `icon` | string | нет | Иконка `mdi:…`. |
| `author` | string | нет | Автор модели. |
| `camera` | object | нет | Начальное положение камеры (см. ниже). |
| `environment` | object | нет | Пол, свет, тени. |
| `size` | object | нет | `{ defaultHeight, minHeight, maxHeight }` — рекомендуемая высота карточки в пикселях. |

### `manifest.camera`

| Поле | По умолчанию | Смысл |
|---|---|---|
| `target` | `[0,0,0]` | Точка, на которую смотрит камера. |
| `radius` | `5` | Расстояние до цели. |
| `phi` | `1.1` | Наклон от вертикали, радианы (0 — сверху, π/2 — сбоку). |
| `theta` | `0.7` | Поворот вокруг вертикальной оси. |
| `minRadius`, `maxRadius` | `1.2`, `40` | Пределы зума колесом. |
| `minPhi`, `maxPhi` | `0.12`, `π/2−0.02` | Пределы наклона. |
| `panoramic` | `true` | Разрешить вращение (ЛКМ). |
| `tilt` | `true` | Разрешить изменение наклона. |
| `mode` | `"orbit"` | Пока поддерживается орбитальный режим. |

### `manifest.environment`

| Поле | Значения | Смысл |
|---|---|---|
| `floor` | `"none"` \| `"radial"` \| `"plane"` \| `"grid"` | Подложка под сценой. |
| `floorColor`, `floorSize`, `floorY` | — | Для `"plane"`. |
| `gridSize`, `gridColor1`, `gridColor2` | — | Для `"grid"`. |
| `background` | CSS-цвет | Фон сцены. |
| `hemiIntensity`, `keyIntensity`, `rimIntensity` | числа | Яркость полусферического, основного и контрового света. |
| `skyColor`, `groundColor` | CSS-цвет | Цвета полусферического света. |
| `shadows` | boolean | Тени (влияет на производительность). |

Все поля камеры и окружения можно переопределить из конфигурации карточки
(ключ `camera:` / `environment:`), не меняя модель.

---

## 4. `bindings` — переменные, которые видны в редакторе

Каждый элемент массива — одна переменная модели. Именно из этих записей
редактор строит поля выбора устройств.

| Поле | Тип | Назначение |
|---|---|---|
| `key` | string | **Обязательно.** Ключ, под которым модель получает значение (`ctx.bindings[key]`, `config.entities[key]`). |
| `name` | string | **Обязательно.** Подпись поля в редакторе. |
| `domain` | string[] | Фильтр `ha-entity-picker`: `["sensor","input_number"]`. |
| `deviceClass` | string \| string[] | Фильтр по `device_class` (частичное совпадение, регистр не важен). |
| `unit` | string \| string[] | Фильтр по `unit_of_measurement`. |
| `required` | boolean | Поле обязательно; пустое значение попадёт в список проблем. |
| `group` | string | Заголовок группы в форме. |
| `order` | number | Порядок внутри группы. |
| `value` | object | Как читать значение (см. ниже). По умолчанию `{ kind: "raw" }`. |
| `options` | array | `[{value,label}]` — подсказка для конкретных состояний. |
| `picker` | object | Доп. настройки `ha-entity-picker`, например `{ allowCustomEntity: true }`. |
| `hint` | string | Пояснение под полем. |
| `description` | string | Длинное пояснение (используется как подсказка). |

### `binding.value.kind`

| kind | Что возвращает |
|---|---|
| `raw` | Состояние строкой (`"on"`, `"42.5"`). |
| `number` | Число; `NaN` для `unknown`/`unavailable`/нечисловых значений. Поддерживает запятую как разделитель. |
| `boolean` | `true` для `on/open/opening/home/detected/playing/cleaning`, `false` для остальных; числа — `> 0`. |
| `brightness` | Яркость 0…1 (учитывает `brightness_pct` и `brightness`). |
| `attribute` | Значение атрибута: `{ kind: "attribute", param: "battery_level" }`. |

Дополнительно:

```js
value: {
  kind: "number",
  scale: { from: { min: 0, max: 1000 }, to: { min: 0, max: 1 }, round: false },
}
```

`scale` линейно пересчитывает значение — удобно, когда датчик отдаёт не проценты.

### Что получает модель

```js
ctx.bindings;
// {
//   level: {
//     key: "level",
//     name: "Уровень воды, %",
//     entity: "sensor.tank_level",
//     state:  { state: "62", attributes: {…}, last_changed: "…" },
//     value:  62,                 // с учётом value.kind и scale
//     available: true             // false для unavailable/unknown/нет данных
//   },
//   ...
// }
```

Удобные сокращения: `ctx.entityId("level")`, `ctx.state("level")`,
`ctx.value("level")`, `ctx.available("level")`.

---

## 5. `params` — настройки сцены

Параметры попадают в редактор как поля и приходят модели в `ctx.params`.
В YAML они хранятся **плоско**, ключом как объявлено (в том числе с точкой).

| `type` | Виджет в редакторе | Доп. поля |
|---|---|---|
| `number` | числовое поле | `min`, `max`, `step`, `default` |
| `range` | ползунок | `min`, `max`, `step`, `default` |
| `boolean` | флажок | `default` |
| `text` | строка | `default` |
| `theme-color` | строка + подсказка про `var(--…)` | `default` |
| `color` | строка + палитра | `default` |
| `select` | выпадающий список | `options: [{value,label}]` |

Общие поля: `key`, `name`, `description`, `group`, `order`.

```js
params: [
  { key: "full_value", name: "Значение, равное 100 %", type: "number", default: 100, min: 1 },
  { key: "level_color", name: "Цвет воды", type: "theme-color", default: "var(--color-2)" },
  { key: "probe_levels.high", name: "Датчик «высокий», %", type: "range", default: 85, min: 0, max: 100 },
]
```

В YAML:

```yaml
params:
  full_value: 1000
  level_color: var(--color-2)
  probe_levels.high: 90
```

---

## 6. `create(ctx)` — построение сцены

Вызывается один раз, когда карточка появилась на экране. Может быть `async`.

### Что содержит `ctx`

| Поле | Назначение |
|---|---|
| `THREE` | Библиотека three.js (та же копия, что у карточки). |
| `scene` | `THREE.Scene` карточки — можно добавлять объекты напрямую, но лучше вернуть `root`. |
| `camera`, `renderer`, `canvas` | Камера, рендерер и canvas карточки. |
| `container` | DOM-элемент карточки (для собственного оверлея). |
| `config` | Итоговая конфигурация: `{ model, title, height, entities, params, camera, environment }`. |
| `params` | Только параметры модели (`config.params`). |
| `bindings` | Значения всех привязок (см. §4). |
| `entityId(key)`, `state(key)`, `value(key)`, `available(key)` | Быстрый доступ к привязкам. |
| `makeLabel(text, opts)` | Спрайт-подпись, читаемая при любом масштабе. |
| `resolveColor(spec, fallback)` | Разрешает `var(--…)` из темы HA в конкретный цвет. |
| `tag(object3d, key)` | Пометить объект как кликабельный: клик откроет модалку сущности привязки `key`. |
| `onPick(object3d, handler)` | Свой обработчик клика (получает `hit` от Raycaster). |
| `openEntity(entityId)` | Открыть модалку сущности программно. |
| `onService(domain, service, data)` | Вызвать сервис Home Assistant. |
| `requestRender()` | Попросить перерисовать кадр. |
| `report(level, message)` | Записать сообщение в диагностику карточки (`level`: `info`/`warn`/`error`). |
| `setStatus(text)` | Текст в статусной строке карточки. |
| `setParam(key, value)` | Изменить параметр модели на лету. |
| `asset(relative)` | Абсолютный URL файла рядом с моделью (если модель загружена по URL). |
| `setRenderer(renderer)` | Отдать карточке собственный рендерер (см. §8). |
| `clamp`, `ease` | Математические помощники. |

### Что должна вернуть `create()`

| Поле | Обяз. | Назначение |
|---|---|---|
| `root` | нет | `THREE.Object3D`, который карточка добавит в сцену. |
| `applyStates(view, config)` | нет | Вызывается при каждом изменении привязанных сущностей. |
| `applyState(key, info, config)` | нет | Альтернатива: по одному ключу за раз. |
| `frame(dt, time, config)` | нет | Анимация; `dt` в секундах (0 при `prefers-reduced-motion`). |
| `applyConfig(config)` | нет | Пользователь изменил настройки в редакторе — обновить сцену без пересоздания. |
| `resize(w, h, config)` | нет | Изменился размер карточки. |
| `setHudSub(text)` | нет | Подпись под заголовком в HUD. |
| `pickTargets()` | нет | Массив объектов для Raycaster (по умолчанию — `root`). |
| `onPickKey(key)` | нет | Клик по объекту с `ctx.tag(obj, key)` без сущности. |
| `actions()` | нет | `[{label, title, onClick}]` — кнопки под сценой. |
| `dispose()` | нет | Освободить геометрии, материалы, текстуры, слушатели. |
| `external` | нет | `true`, если модель сама владеет рендерером и циклом кадров (см. §8). |

### Обязанности по ресурсам

Карточка вызывает `dispose()` при удалении с карточки/пересоздании.
Освобождайте всё, что создали:

```js
dispose() {
  geometry.dispose();
  material.dispose();
  material.map?.dispose();
  ctx.renderer.domElement.removeEventListener("pointerdown", onDown);
}
```

---

## 7. `attach(ctx)` — подключение готового движка

Если у вас уже есть собственный класс сцены (как `WaterTankEngine` в этом
репозитории), используйте `attach` вместо `create` и верните тот же набор
методов, что в §6. Пример — `models/water-tank/scene.js`: он передаёт движку
уже созданный canvas/рендерер карточки и транслирует состояния.

---

## 8. Модель со своим рендерером (`host: "external"`)

Некоторым сценам нужен собственный `WebGLRenderer`, цикл кадров и модальные
окна (как у готовых движков бака и цеха). В этом случае:

1. объявите в манифесте `host: "external"` — карточка создаст канвас, но
   **не** будет создавать свой рендерер, свет и сцену;
2. в `create()` создайте рендерер на канвасе карточки:
   `new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })`.
   **Два WebGL-контекста на одном канвасе создать нельзя** — если карточка уже
   сделала свой, ваш окажется нерабочим и сцена останется пустой;
3. верните `external: true` — карточка не будет вызывать `renderer.render()`,
   трогать камеру и освобождать ваш рендерер (это делает модель);
4. `frame()` при этом не вызывается — цикл кадров у модели свой;
5. верните `resize(w, h)`, если сцена зависит от размера канваса.

Готовый пример — `models/water-tank/scene.js`. Благодаря этому на карточку
приходится **один** WebGL-контекст вместо двух (браузеры ограничивают их число).

> Если модель рисует сама, но хочет пользоваться состояниями, HUD и модалкой
> карточки — достаточно `host: "external"` без `external: true`: тогда
> `applyState(key, info)` продолжит вызываться.

---

## 9. Глобальный API `window.ThreeJS3DCard`

| Поле | Назначение |
|---|---|
| `version`, `apiVersion` | Версии карточки и контракта модели. |
| `THREE` | three.js. Карточка начинает загрузку сразу при подключении ресурса; пока библиотеки нет, поле читается как `undefined`. |
| `threeReady` | `Promise`, разрешающийся после загрузки three.js. |
| `loadThree()` | `Promise<THREE>` (то же, что `threeReady`). |
| `defineModel(def)` | Регистрация модели (обязательный вызов во внешнем файле). |
| `registry` | Реестр моделей (`resolve`, `list`, `reload`, `log`). |
| `loadModel(idOrUrl, opts)` | Загрузить модель программно. |
| `models()` | Список загруженных моделей (метаданные). |
| `builtinIds()` | Идентификаторы встроенных моделей. |
| `SceneEngine`, `CardClass` | Классы ядра — для отладки и расширений. |
| `absoluteUrl(rel)` | Абсолютный URL относительно модуля карточки. |

**Про three.js:** берите библиотеку из `ctx.THREE` внутри `create()`.
Обращение к `window.ThreeJS3DCard.THREE` на верхнем уровне файла ненадёжно:
библиотека может ещё грузиться.

```js
// правильно
create(ctx) {
  const THREE = ctx.THREE;
  …
}

// ненадёжно: THREE может оказаться undefined
const { THREE } = window.ThreeJS3DCard;
```

Отладка из консоли браузера:

```js
ThreeJS3DCard.models();                       // какие модели загружены
await ThreeJS3DCard.loadModel("/local/3d-models/my-box.js");
document.querySelector("threejs-3d-card")._engine.diagnostics();  // состояние привязок
```

---

## 10. Правила и ограничения

1. **Не импортируйте `three` по имени пакета** — во внешней модели берите его
   из `ctx.THREE` или `window.ThreeJS3DCard.THREE`. Своя копия three.js
   создаст вторую библиотеку на странице и конфликты классов.
2. **Один `defineModel()` на файл.** Если файл оборачивается в IIFE/CJS —
   вызовите его явно.
3. **CSP Home Assistant**: загрузка внешней модели выполняется вставкой
   `<script type="module">` с того же origin. Модель должна отдаваться
   сервером HA (`/local/…`, `/hacsfiles/…`) с типом `text/javascript`.
4. **`apiVersion`** увеличивается при несовместимых изменениях контракта.
   Карточка сообщит об ошибке, если модель требует более новый API.
5. **Производительность**: не пересоздавайте материалы в `frame()`, кэшируйте
   геометрии, а тяжёлые подписи рисуйте через `ctx.makeLabel`.
6. **Идентификаторы** модели должны быть уникальны: реестр хранит модели по
   `manifest.id`, повторная регистрация перезаписывает предыдущую.

---

## 11. Шаблон модели (копируйте и правьте)

```js
// config/www/3d-models/template.js
(() => {
  const api = window.ThreeJS3DCard;

  api.defineModel({
    manifest: {
      id: "template",
      name: "Шаблон модели",
      description: "Заготовка для новой 3D-сцены",
      apiVersion: 1,
      camera: { radius: 6, phi: 1.15, theta: 0.6, target: [0, 0.5, 0] },
      environment: { floor: "radial", shadows: false },
      size: { defaultHeight: 380 },
    },

    bindings: [
      { key: "power", name: "Питание", domain: ["switch"], value: { kind: "boolean" } },
      { key: "value", name: "Значение", domain: ["sensor"], value: { kind: "number" } },
    ],

    params: [
      { key: "color", name: "Цвет", type: "theme-color", default: "var(--primary-color)" },
    ],

    defaults: { config: { title: "Шаблон", show_hud: true, height: 380 } },

    create(ctx) {
      // three.js всегда доступен через контекст — брать его на верхнем уровне файла нельзя
      const THREE = ctx.THREE;
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: ctx.resolveColor(ctx.params.color, "#1f6feb") })
      );
      mesh.position.y = 0.5;
      mesh.userData; // объект, который можно пометить ctx.tag()
      group.add(mesh);

      const label = ctx.makeLabel("Шаблон", { scale: 0.004 });
      label.position.set(0, 1.4, 0);
      group.add(label);

      ctx.tag(mesh, "power");

      return {
        root: group,
        applyStates(view) {
          const on = view.power ? view.power.value : false;
          mesh.material.emissive.setHex(on ? 0x2ea043 : 0x000000);
          mesh.material.emissiveIntensity = on ? 0.5 : 0;
          label.userData.redraw(on ? "ВКЛ" : "ВЫКЛ");
          ctx.requestRender();
        },
        frame(dt) {
          mesh.rotation.y += dt * 0.4;
        },
        dispose() {
          mesh.geometry.dispose();
          mesh.material.dispose();
        },
      };
    },
  });
})();
```
---

## 12. Встроенные модели как примеры

| Модель | Файлы | Что показывает |
|---|---|---|
| `water-tank` | `models/water-tank/manifest.js`, `scene.js` | Минимум привязок, вложенные параметры (`probe_levels.high`), подключение готового движка через `attach`-подход, `external: true`. |
| `production-room` | `models/production-room/manifest.js`, `scene.js` | Много объектов и разных доменов, группы привязок, фильтры по `device_class` и единицам измерения. |

Обе модели лежат в релизе рядом с карточкой и могут служить основой для
своей: скопируйте каталог, поменяйте `manifest.id` и геометрию.
