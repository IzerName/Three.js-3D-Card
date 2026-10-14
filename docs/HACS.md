# Публикация репозитория в HACS

Короткая инструкция для того, кто форкает или форкает и развивает этот проект.
Полная документация HACS — <https://hacs.xyz/docs/publish/start>.
Репозиторий проекта — <https://github.com/IzerName/Three.js-3D-Card>
(ветка по умолчанию — `main`).

---

## 1. Что обязательно должно быть в репозитории

```
<repo-root>/
├─ hacs.json                    ← манифест, ОБЯЗАТЕЛЕН
├─ README.md                    ← описание (HACS показывает его в карточке)
├─ LICENSE
├─ dist/                        ← релизный слой: то, что получает пользователь
│  ├─ threejs-3d-card.js        ← файл из hacs.json (filename), точка входа
│  ├─ src/                      ← ядро карточки, редактор, объектные модели
│  ├─ models/                   ← встроенные модели (water-tank, production-room)
│  └─ vendor/                   ← three.js r160 + загрузчики OBJ/MTL/glTF
├─ src/  models/                ← исходники (в поставку пользователю не попадают)
├─ scripts/build.mjs            ← сборка dist/
└─ test/  dev/  docs/  skills/  ← тесты, стенд, документация, скилл агента
```

`dist/` **закоммичен**: HACS ставит файлы прямо из архива тега и ничего не
собирает. Если `dist/` в теге нет или он устарел — ставить будет нечего.

`hacs.json` этого проекта:

```json
{
  "name": "Three.js 3D Card",
  "filename": "threejs-3d-card.js",
  "render_readme": true,
  "homeassistant": "2023.9.0"
}
```

| Поле | Смысл |
|---|---|
| `name` | Имя, которое увидит пользователь в HACS. |
| `filename` | **Ключевое поле для Dashboard-плагина:** файл, который HACS подключит ресурсом. Сначала ищется в корне архива тега, а если его там нет — в `dist/` (см. ниже). |
| `render_readme` | Рендерить README в карточке HACS (`true`). |
| `homeassistant` | Минимальная версия HA (HACS покажет предупреждение на более старых). |

> Ключа `contentdir` в HACS **не существует** — его нет в исходниках
> `hacs/integration`. Полный список известных HACS ключей: `content_in_root`,
> `country`, `filename`, `hacs`, `hide_default_branch`, `homeassistant`,
> `manifest`, `name`, `persistent_directory`, `render_readme`, `zip_release`.
> Незнакомые ключи игнорируются, поэтому каталог релиза задаёт не манифест, а
> раскладка репозитория.

### Почему релизный слой — `dist/`, а не корень

HACS выбирает файл так (`custom_components/hacs/repositories/plugin.py`,
метод `update_filenames`):

| № | Что проверяет HACS | Что скачивает |
|---|---|---|
| 1 | файл `filename` в **корне** архива тега | только корневые файлы |
| 2 | `content_in_root` не задан → `dist/<filename>` | **всё содержимое `dist/`** (структура сохраняется, префикс `dist/` срезается) |

Наш плагин многофайловый: точка входа импортирует ядро и модели, а те —
three.js и загрузчики форматов. Положи мы `threejs-3d-card.js` в корень, HACS
скачал бы из корня только `.js` — без `src/`, `models/` и `vendor/` карточка не
загрузится. Поэтому точка входа лежит в `dist/threejs-3d-card.js`, и HACS
забирает каталог `dist/` целиком.

### Что окажется на сервере

| Что | Значение |
|---|---|
| Каталог установки | `config/www/community/Three.js-3D-Card/` — имя репозитория **как есть, с регистром** |
| Содержимое | ровно `dist/` без префикса: `threejs-3d-card.js`, `src/…`, `models/…`, `vendor/…` |
| Ресурс Lovelace | `/hacsfiles/Three.js-3D-Card/threejs-3d-card.js?hacstag=…`, тип **JavaScript module** |

Каталог называется так из-за регистра имени репозитория, поэтому карточка не
использует абсолютных путей: three.js и загрузчики подключаются относительно
самого модуля (`new URL("../../vendor/three.module.js", import.meta.url)`).
Одна и та же сборка работает и из `config/www/community/Three.js-3D-Card/`,
и из `/local/<любая-папка>/`.

## 2. Релизы

HACS предлагает пользователю **последний релиз** репозитория.

1. Обновите версию:
   * `package.json` → `"version": "X.Y.Z"`;
   * `src/core/constants.js` → `CARD_VERSION = "X.Y.Z"`;
   * допишите `CHANGELOG.md`.
2. Пересоберите и закоммитьте релизный слой:
   ```bash
   npm run build
   git add dist
   git commit -m "build: dist для vX.Y.Z"
   ```
   Без этого шага в теге окажется старый (или отсутствующий) `dist/` — HACS
   скачает именно то, что лежит в теге, а не то, что собирается в CI.
3. Поставьте тег и запушьте:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
4. Workflow `.github/workflows/release.yml` по тегу `v*` выполняет `npm test` —
   в нём `test/publish.test.js` падает, если закоммиченный `dist/` разошёлся с
   `src/` и `models/`, — затем `npm run build` и проверку состава `dist/`
   (точка входа, `src/`, `models/`, `vendor/three.module.js`). Архив
   `threejs-3d-card.zip` (содержимое `dist/`) прикладывается к релизу.
5. Архив нужен для ручной установки: распакуйте его в
   `config/www/threejs-3d-card/` и добавьте ресурс
   `/local/threejs-3d-card/threejs-3d-card.js` типа **JavaScript module**.
   Имя папки может быть любым — карточка к нему не привязана.

## 3. Установка «как у пользователя» (обязательная проверка перед релизом)

1. HACS → **Frontend** → ⋮ → **Custom repositories** → URL
   `https://github.com/IzerName/Three.js-3D-Card` → категория **Dashboard**.
2. Найти карточку → **Download**.
3. Проверьте результат — должно появиться **и то, и другое**:
   * на сервере: `config/www/community/Three.js-3D-Card/` с файлами
     `threejs-3d-card.js`, `src/…`, `models/…`, `vendor/…`;
   * в *Настройки → Панели → ⋮ → Ресурсы*: ресурс
     `/hacsfiles/Three.js-3D-Card/threejs-3d-card.js?hacstag=…` типа
     **JavaScript module** (`?hacstag=…` — служебная отметка версии).
   Если HACS ресурс не добавил — добавьте вручную тот же URL без `?hacstag=…`
   и перезагрузите страницу.
4. Добавьте карточку через UI: «Добавить карточку» → **Three.js 3D Card**.
   Должны выполниться все три условия:
   * карточка появилась в списке (значит `getConfigElement` отработал);
   * в редакторе есть поля выбора устройств (значит модель загрузилась,
     `bindings` прочитаны);
   * 3D-сцена рисуется, привязки показывают живые значения.
5. Обновите версию в HACS — убедитесь, что обновление проходит без
   переустановки ресурса: HACS сам меняет отметку `?hacstag=…` у уже
   добавленного ресурса.

## 4. Частые причины отказа HACS

| Симптом | Причина |
|---|---|
| «Repository structure for … is not compliant» | Нет `hacs.json` или нет `dist/threejs-3d-card.js` в теге: `dist/` не собран или не закоммичен. |
| Ресурс есть, но файл не отдаётся (404) | URL ресурса указывает на другой каталог: HACS отдаёт плагин по имени репозитория как есть — `/hacsfiles/Three.js-3D-Card/…`, регистр важен. |
| Карточка есть, но не грузится | Файл добавлен ресурсом с типом «JavaScript» вместо «JavaScript module». |
| «Custom element doesn't exist» | Браузер держит старую версию — очистите кэш (Ctrl+F5) или обновите ресурс с `?v=`. |
| 3D-сцена не появляется, ошибка про three.js | В релиз не попал `dist/vendor/three.module.js` (и аддоны `dist/vendor/three-addons/` — загрузчики OBJ/MTL/glTF). Проверьте содержимое архива. |
| Модели не находятся | В релиз не попали `dist/src/` или `dist/models/`: карточка тянет их относительными импортами. |
| Обновление не подхватилось | HACS обновляет `?hacstag=…` у существующего ресурса, но браузер держит старый файл — нужен Ctrl+F5. |

## 5. Локальная проверка перед публикацией

```bash
npm install
npm run check      # сборка + 96 тестов
npm run serve      # стенд: http://localhost:8099/dev/harness.html
```

Отдельно раскладку релиза проверяет `test/publish.test.js`: ключи `hacs.json`,
отсутствие точки входа в корне, состав `dist/` и совпадение `dist/src`,
`dist/models` с исходниками.

Стенд отдаёт релиз по `/hacsfiles/threejs-3d-card/*` — это префикс **стенда**
(страницы `dev/probe-*.html` написаны под него), а не тот путь, по которому
карточка окажется на сервере Home Assistant. Стенд же отдаёт и вариант ручной
установки — `/local/threejs-3d-card/*`.

Проверьте на стенде: сцену, редактор (кнопка «Показать конфигурацию»),
`getStubConfig()` и переключение моделей. Затем — установка на тестовом
Home Assistant по шагам из раздела 3.
