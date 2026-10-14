// ============================================================================
//  Запуск всех юнит-тестов (npm test).
//
//  Каждый файл запускается отдельным процессом: `node --test test/<файл>`.
//  Так сделано намеренно:
//    * тесты не делят между собой глобальные заглушки (window/document/THREE),
//      а они есть почти в каждом файле;
//    * один упавший файл не мешает остальным;
//    * node:test сам считает результаты, и его встроенному репортёру можно
//      доверять — свой парсер разбирает только итоговые строки.
//
//  Итог печатается сводкой и дублируется в dev/test-out.txt (запись
//  синхронна, поэтому отчёт не теряется при перенаправлении вывода).
// ============================================================================

import { promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(DIR, "..", "dev", "test-out.txt");
const started = Date.now();

const files = (await fs.readdir(DIR))
  .filter((f) => f.endsWith(".test.js"))
  .sort();

const results = [];
for (const file of files) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ["--test", path.join(DIR, file)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`;
  const num = (label) => {
    const m = output.match(new RegExp(`^\\u2139 ${label} (\\d+)$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const tests = num("tests");
  results.push({
    file,
    code: res.status,
    ms: Date.now() - t0,
    tests,
    pass: num("pass"),
    fail: num("fail"),
    skipped: num("skipped"),
    // строки с провалившимися тестами — для сводки
    failures: output.split(/\r?\n/).filter((l) => /^\s*✖/.test(l)).map((l) => l.trim()),
    output,
  });
}

// ---- отчёт ------------------------------------------------------------------

const total = results.reduce((s, r) => s + (r.tests || 0), 0);
const pass = results.reduce((s, r) => s + (r.pass || 0), 0);
const fail = results.reduce((s, r) => s + (r.fail || 0), 0);
const broken = results.filter((r) => r.tests === null);

const lines = [];
lines.push("");
lines.push("  threejs-3d-card — тесты");
lines.push("  " + "-".repeat(62));
for (const r of results) {
  const mark = r.tests === null ? "✖" : (r.fail ? "✖" : "✔");
  const counts = r.tests === null
    ? "не запустились (см. вывод ниже)"
    : `${String(r.pass).padStart(3)} ok` + (r.fail ? `, ${r.fail} fail` : "      ");
  lines.push(`  ${mark} ${r.file.padEnd(26)} ${counts}  ${Math.round(r.ms)} мс`);
}
lines.push("  " + "-".repeat(62));

for (const r of results) {
  if (r.tests === null) {
    lines.push("");
    lines.push(`  Файл ${r.file} не выполнился:`);
    for (const l of (r.output || "").split(/\r?\n/).slice(0, 12)) lines.push(`    ${l}`);
  } else if (r.fail) {
    lines.push("");
    lines.push(`  Провалы в ${r.file}:`);
    for (const l of r.failures.slice(0, 12)) lines.push(`    ${l}`);
    // детали ошибок из вывода node:test
    const details = (r.output.match(/✖[\s\S]{0,400}?(?=\n\s*(?:✔|✖|ℹ|$))/g) || []).slice(0, 6);
    for (const d of details) {
      for (const l of d.split(/\r?\n/).slice(0, 6)) lines.push(`      ${l.trim()}`);
    }
  }
}

lines.push("");
lines.push(`  всего: ${total}, успешно: ${pass}, провалено: ${fail}` +
  (broken.length ? `, файлов с ошибкой запуска: ${broken.length}` : "") +
  `, время: ${((Date.now() - started) / 1000).toFixed(2)} с`);
lines.push("");

const text = lines.join("\n");
process.stdout.write(text);
try { writeFileSync(REPORT, text, "utf8"); } catch (e) { /* не критично */ }

// Даём stdout сброситься и завершаемся с понятным кодом.
setTimeout(() => process.exit(fail || broken.length ? 1 : 0), 150);
