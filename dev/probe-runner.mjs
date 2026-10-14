// ============================================================================
//  Прогон dev-страниц в headless Chrome «по-настоящему» (реальное время).
//
//  Зачем: у Chrome с --virtual-time-budget requestAnimationFrame не крутит
//  время, поэтому проверки, которые зависят от кадров (плавная смена цвета,
//  разгорание лампы), дают ложный провал. Здесь страница живёт в обычном
//  времени: запускаем Chrome с remote debugging, ждём, читаем DOM и отчёт.
//
//  Запуск:
//    node dev/probe-runner.mjs http://127.0.0.1:8099/dev/probe-obj.html [мс]
//
//  Печатает строки протокола страницы (✔/✖ и ИТОГ) и возвращает код 1,
//  если на странице есть «ЕСТЬ ПРОБЛЕМЫ» или ошибки JS.
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const url = process.argv[2];
const waitMs = Number(process.argv[3] || 6000);
if (!url) {
  console.error("использование: node dev/probe-runner.mjs <url> [мс ожидания]");
  process.exit(2);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("не найден Chrome/Edge: задайте CHROME_PATH");
  process.exit(2);
}

const port = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(path.join(tmpdir(), "t3d-probe-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--window-size=1280,900",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* Chrome ещё поднимается */ }
    await sleep(250);
  }
  throw new Error("Chrome не открыл порт отладки");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}

let exitCode = 0;
try {
  const wsUrl = await debuggerUrl();
  // Новую вкладку создаём через HTTP-эндпоинт: он же отдаёт её сессию.
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  ).then((r) => r.json());

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("не удалось подключиться к вкладке")));
  });
  const send = cdp(ws);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await sleep(waitMs);   // реальное время: rAF и таймеры страницы идут как обычно

  const text = await send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  const body = String(text.result.value || "");
  const lines = body.split("\n").filter((l) => /✔|✖|ИТОГ/.test(l));
  for (const l of lines) console.log(l.trim());

  const ok = !/ЕСТЬ ПРОБЛЕМЫ/.test(body);
  console.log(ok ? "\n  страница: ОК" : "\n  страница: ЕСТЬ ПРОБЛЕМЫ");
  exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("ошибка прогона:", e.message);
  exitCode = 2;
} finally {
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль во временном каталоге */ }
}

process.exit(exitCode);
