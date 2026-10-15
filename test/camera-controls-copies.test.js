// ============================================================================
//  T-006 — синхронность копий createCameraControls в автономных проектах.
//
//  Канон: src/core/camera-controls.js. Автономные страницы
//  (production-room-viewer, water-tank-3d) подключают модуль напрямую из
//  своей папки — импорт из карточки невозможен, поэтому у них лежат
//  копии: шапка с пометкой о каноне + тело, byte-в-byte равное канону.
//  Тест сравнивает SHA-256 тела с хэшем канона и проверяет, что пометка
//  не удалена — иначе правку внесут в копию, и она потеряется.
//
//  Репозиторий карточки собирается и тестируется отдельно (CI), без
//  соседних папок: список копий явный (файловая система не сканируется),
//  а проверка пропускается через t.skip(), если файла нет, — сборка
//  остаётся зелёной.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// Канон всегда лежит в репозитории карточки (создан в T-001).
const CANON = path.join(TEST_DIR, "..", "src", "core", "camera-controls.js");
const CANON_LABEL = "threejs-3d-card/src/core/camera-controls.js";

// Явный список копий (T-004, T-005), пути — от корня карточки,
// threejs-3d-card/. Новую копию добавляйте сюда, а не в обход списка.
const COPIES = [
  "../production-room-viewer/camera-controls.js",
  "../water-tank-3d/camera-controls.js",
];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const canon = existsSync(CANON) ? readFileSync(CANON, "utf8") : null;
const canonHash = canon ? sha256(canon) : null;

for (const rel of COPIES) {
  // Имя для сообщений — от корня рабочей папки.
  const name = rel.replace(/^\.\.\//, "");
  test(`копия ${name} синхронна с каноном`, (t) => {
    if (!canon) {
      assert.fail(`канон ${CANON_LABEL} не найден — тест синхронности не запустить`);
      return;
    }
    const copyPath = path.join(TEST_DIR, "..", rel);
    if (!existsSync(copyPath)) {
      t.skip("копия недоступна: проект вне репозитория карточки");
      return;
    }

    const copy = readFileSync(copyPath, "utf8");
    // Тело — всё после шапки, шапка — префикс, за которым следует канон.
    if (copy.length < canon.length || !copy.endsWith(canon)) {
      assert.fail(`копия ${name} разошлась с каноном: скопируйте ${CANON_LABEL}`);
    }
    const body = copy.slice(copy.length - canon.length);
    assert.equal(
      sha256(body), canonHash,
      `тело копии ${name} не совпадает с каноном (SHA-256): скопируйте ${CANON_LABEL}`,
    );

    // Пометка о каноне в шапке: без неё правку внесут в копию и потеряют.
    const header = copy.slice(0, copy.length - canon.length);
    assert.ok(header.trim(), `у копии ${name} нет шапки с пометкой о каноне`);
    assert.ok(
      header.includes(CANON_LABEL),
      `в шапке копии ${name} нет пути к канону: ${CANON_LABEL}`,
    );
    for (const line of header.split(/\r?\n/).filter((l) => l.trim())) {
      assert.ok(
        line.trim().startsWith("//"),
        `шапка копии ${name} должна состоять только из комментариев`,
      );
    }
  });
}
