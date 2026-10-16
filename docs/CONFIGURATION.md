# Конфигурация карточки `custom:threejs-3d-card`

Полная справка по параметрам. Краткая версия — в [README.md](../README.md).

---

## Верхний уровень

```yaml
type: custom:threejs-3d-card
model: water-tank
model_url: /local/3d-models/my-model.js
reload_model: false
allow_external_models: true
title: Бак чистой воды
show_hud: true
height: 400                  # необязательно: без него карточка занимает всю доступную высоту
show_diagnostics: false
entities: { … }
params: { … }
camera: { … }
environment: { … }
```

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `type` | string | — | Всегда `custom:threejs-3d-card`. |
| `model` | string | `water-tank` | `id` встроенной модели (`water-tank`, `production-room`) либо URL файла модели (`/local/…` → `config/www`, `/hacsfiles/…`, абсолютный). Файл с расширением `.json` читается как спецификация (не исполняется), остальные — как код модели; геометрию (`.glb`, `.obj`) в этом поле указывать нельзя. |
| `model_url` | string | — | URL внешней модели. Заполняется редактором; при наличии `model` имеет приоритет только как источник для перезагрузки. |
| `reload_model` | boolean | `false` | Добавляет к URL модели параметр с отметкой времени — обход кэша браузера. |
| `allow_external_models` | boolean | `true` | `false` — запретить загрузку моделей не из встроенного реестра (безопасность). |
| `title` | string | из модели | Заголовок в HUD. Пустая строка `""` скрывает его. |
| `show_hud` | boolean | `true` | Показывать HUD-заголовок. |
| `height` | number | не задано (авто) | Высота сцены в пикселях (минимум 120). **Не задавайте её без необходимости:** без `height` карточка занимает всю доступную область — в разделе (Sections) клетку сетки, в «кирпичной» раскладке рекомендованную моделью высоту (`manifest.size.defaultHeight`). Это поле влияет только на размер карточки, а не на саму модель. |
| `show_diagnostics` | boolean | `false` | Панель диагностики привязок поверх сцены. Показывается ниже надписей верхней полосы (HUD карточки и заголовок модели), поэтому их не перекрывает; по умолчанию выключена — пустой панели на сцене нет. |

### Почему файлы кладут вручную

Home Assistant не даёт записать файл в `/local/` (`config/www`) из браузера: ни
WebSocket-команды ядра, ни REST-endpoint'ы этого не делают, а штатная
медиа-загрузка (`POST /api/media_source/local_source/upload`) принимает только
`image/*`, `video/*` и `audio/*` и требует прав администратора — `.glb`,
`.gltf`, `.obj` и `.mtl` через неё не проходят. Поэтому файлы модели кладут на
сервер в `config/www/3d-models/` (Samba share, File editor, Advanced SSH & Web
Terminal, Studio Code Server — любым привычным способом), а в конфигурации
указывают путь `/local/3d-models/…`.

## `entities` — привязки к сущностям

Ключи задаёт модель (`bindings` в её описании). Значение — `entity_id`.

```yaml
entities:
  level: sensor.water_level
  high: binary_sensor.water_high
```

Правила:

* незаполненные ключи просто не используются — ошибкой это не считается,
  кроме привязок с `required: true`;
* ключи, которых нет в описании модели, сохраняются и передаются модели
  (совместимость со старыми конфигурациями);
* значения `unavailable`/`unknown` не превращаются в числа: сцена получает
  признак недоступности и должна показать это визуально.

## `params` — настройки модели

Ключи и типы объявляет модель. **Ключи хранятся плоско**, как объявлены, в том
числе с точкой:

```yaml
params:
  full_value: 1000
  max_liters: 500
  level_color: var(--color-2)
  tank_radius: 0.8
  probe_levels.high: 90
  probe_levels.medium: 50
  probe_levels.low: 10
```

Допускается и вложенная запись (`probe_levels: { high: 90 }`) — она читается
как эквивалент.

Типы полей в редакторе: `number`, `range`, `boolean`, `text`, `theme-color`,
`color`, `select`. Цвета поддерживают переменные темы Home Assistant
(`var(--primary-color)`, `var(--color-2)` и т. д.).

## `camera` — переопределение камеры

Значения по умолчанию задаёт модель; здесь можно поправить вид под свой
дашборд.

```yaml
camera:
  target: [0, 0.5, 0]   # точка взгляда
  radius: 5             # дистанция
  phi: 1.15             # наклон от вертикали, радианы
  theta: 0.7            # поворот вокруг оси Y
  minRadius: 2          # пределы зума
  maxRadius: 12
  minPhi: 0.15
  maxPhi: 1.45
  panoramic: true       # разрешить вращение
  tilt: true            # разрешить наклон
  drift: 0              # медленное авто-вращение (0 — выключено)
```

Единый набор жестов для мыши и касаний (одна реализация —
`src/core/camera-controls.js`):

* **Мышь:** **ЛКМ** — вращение (орбита вокруг точки взгляда),
  **ПКМ** или **Shift + ЛКМ** — сдвиг, **колесо** — зум,
  **двойной клик** — вернуть исходный вид, **одиночный клик** по объекту —
  выбор объекта. ПКМ не раскрывает контекстное меню браузера.
* **Касания:** один палец — вращение, два пальца — зум (щипок) и сдвиг
  (смещение середины между пальцами) одновременно, **двойной тап** —
  вернуть исходный вид, **тап** по объекту — выбор объекта.

Пределы камеры (`minRadius`/`maxRadius`, `minPhi`/`maxPhi`) и флаги
`panoramic` (вращение) и `tilt` (наклон) действуют одинаково для мыши
и для касаний.

## `environment` — окружение

```yaml
environment:
  floor: radial         # none | radial | plane | grid
  background: "#0a0d12" # фон сцены (поддерживает var(--…))
  shadows: false        # тени (дороже по производительности)
  hemiIntensity: 0.55
  keyIntensity: 1.05
  rimIntensity: 0.7
```

| `floor` | Что рисуется |
|---|---|
| `none` | Ничего (модель сама создаёт пол). |
| `radial` | Мягкое радиальное пятно с сеткой — «студийная» подложка. |
| `plane` | Плоскость одного цвета (`floorColor`, `floorSize`, `floorY`). |
| `grid` | Штатная сетка three.js (`gridSize`, `gridColor1`, `gridColor2`). |

---

## Полный пример: бак

```yaml
type: custom:threejs-3d-card
model: water-tank
title: Бак чистой воды
# height не задаём: карточка занимает всю доступную высоту.
entities:
  level: sensor.water_preparation_level_clean_percentage
  liters: sensor.water_preparation_level_clean_liters
  counter: sensor.water_preparation_counter_clean_water
  high: binary_sensor.water_preparation_clean_high_sensor
  medium: binary_sensor.water_preparation_clean_medium_sensor
  low: binary_sensor.water_preparation_clean_low_sensor
params:
  full_value: 100
  max_liters: 200
  level_color: var(--color-2)
  tank_radius: 0.55
  tank_length: 1.7
  probe_levels.high: 85
  probe_levels.medium: 50
  probe_levels.low: 25
camera:
  radius: 4.6
  phi: 1.19
  theta: 0.62
```

## Полный пример: цех

```yaml
type: custom:threejs-3d-card
model: production-room
title: Производственный цех
# height не задаём: карточка занимает всю доступную высоту.
entities:
  vru: switch.vru
  water: sensor.water_total
  water_flow: sensor.water_flow
  machine: switch.machine
  light1: light.light_1
  light2: light.light_2
  fire: binary_sensor.fire_alarm
  heater: switch.heater
  ac: climate.ac
  door: binary_sensor.door_opening
  lux: sensor.illuminance
params:
  width: 12
  depth: 8
  height: 3.2
```

---

## Совместимость со старыми конфигурациями

Карточка принимает конфигурации прежних проектов без изменений:

```yaml
type: custom:water-tank-card          # → модель water-tank
entities:
  level: sensor.water_level
full_value: 100
max_liters: 200
level_color: var(--color-2)
probe_levels:
  high: 85
```

```yaml
type: custom:production-room-card     # → модель production-room
width: 12
depth: 8
height: 3.2
entities:
  machine: switch.machine
```

Плоские параметры (`full_value`, `max_liters`, `level_color`, `width`, `depth`,
`height`, `probe_levels`) читаются наравне с `params`. Если в конфигурации
указаны обе формы — приоритет у `params`.

> Осторожно с `height`: в старой карточке цеха это была высота помещения в
> метрах, а в нынешней это высота карточки в пикселях (поле «Высота, px» в
> редакторе). Поэтому плоское значение `height` модель понимает как метры
> только тогда, когда оно на метры похоже (≤ 40); высота помещения надёжнее
> задавать через `params.height`.
