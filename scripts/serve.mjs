// ============================================================================
//  Локальный HTTP-сервер для разработки: отдаёт dist/ и dev/.
//  Запуск:  npm run serve        (http://localhost:8099)
//           npm run serve -- --open
// ============================================================================

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DEV = path.join(ROOT, "dev");
// Примеры моделей из скилла: на стенде отдаются как /local/3d/…,
// чтобы проверка шла по тем же путям, что указаны в документации.
const MODELS_EXAMPLE = path.join(ROOT, "skills", "threejs-3d-model", "examples");

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT || 8099);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";

    // Приём отчётов страницы самопроверки (dev/probe.html).
    // Нужен, чтобы headless-браузер мог отдать результат наружу: писать файлы
    // со страницы нельзя, а stdout браузера ограничен.
    if (req.method === "POST" && rel === "/__report") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      const out = path.join(DEV, "report.json");
      await fs.writeFile(out, body, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: body.length, file: out }));
      console.log(`  отчёт самопроверки сохранён: ${out}`);
      return;
    }

    // Правило отдачи файлов:
    //   /dev/*                            — стенд разработки (dev/)
    //   /hacsfiles/threejs-3d-card/*      — релиз (dist/), как в Home Assistant
    //   /local/3d/*                       — примеры моделей из skills/examples,
    //                                       ровно по тем путям, что в документации
    //   остальное                         — релиз (dist/)
    let base = DIST;
    let relPath = rel;
    if (rel.startsWith("/dev/")) {
      base = DEV;
      relPath = rel.slice(5);
    } else if (rel.startsWith("/hacsfiles/threejs-3d-card/")) {
      base = DIST;
      relPath = rel.slice("/hacsfiles/threejs-3d-card/".length);
    } else if (rel.startsWith("/local/threejs-3d-card/")) {
      // Вариант ручной установки: релиз лежит в config/www/threejs-3d-card/.
      base = DIST;
      relPath = rel.slice("/local/threejs-3d-card/".length);
    } else if (rel.startsWith("/local/3d/")) {
      base = MODELS_EXAMPLE;
      relPath = rel.slice("/local/3d/".length);
    }
    const file = path.join(base, relPath);

    // защита от выхода за пределы каталога
    if (!path.resolve(file).startsWith(path.resolve(base))) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 — не найдено: ${req.url}\n\nСначала выполните сборку: npm run build`);
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`500 — ${e.message}`);
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/dev/harness.html`;
  console.log("");
  console.log("  threejs-3d-card — сервер разработки");
  console.log(`  стенд:   ${url}`);
  console.log(`  релиз:   http://localhost:${PORT}/threejs-3d-card.js`);
  console.log("  остановка: Ctrl+C");
  console.log("");
  if (args.includes("--open")) {
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Порт ${PORT} занят. Укажите другой: npm run serve -- --port=8100\n`);
  } else {
    console.error("\n  Сервер не запустился:", e.message, "\n");
  }
  process.exit(1);
});
