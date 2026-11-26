import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") { await new Promise(resolveClose => server.close(resolveClose)); throw new Error("No se pudo reservar el puerto para el harness del ciclo de vida."); }
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}
async function waitForVite(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Vite terminó antes de servir el harness.");
    try { const response = await fetch(url); if (response.ok) return; lastError = new Error("Vite respondió HTTP " + response.status + "."); }
    catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error("Vite no respondió a tiempo.", { cause: lastError });
}
test("Chromium recupera el polling tras pagehide/pageshow y freeze/resume", { timeout: 90_000 }, async () => {
  const port = await reservePort();
  const url = "http://127.0.0.1:" + port + "/tests/browser/live-author-monitor-lifecycle.html";
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: process.cwd(), stdio: "ignore" });
  let browser;
  try {
    await waitForVite(url, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__liveAuthorMonitorVisibilityReady === true);
    const result = await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, writable: true, value: false });
      const timers = []; let cancellations = 0; let refreshes = 0;
      const dispose = window.__liveAuthorMonitorVisibility(document, () => { refreshes += 1; }, 400, (callback, intervalMs) => {
        timers.push({ callback, intervalMs }); return () => { cancellations += 1; };
      });
      const initialTimerCount = timers.length;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); timers[0].callback();
      const afterPageHide = { timerCount: timers.length, cancellations, refreshes };
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      const afterPageShow = { timerCount: timers.length, cancellations, refreshes };
      document.dispatchEvent(new Event("freeze")); timers[1].callback();
      const afterFreeze = { timerCount: timers.length, cancellations, refreshes };
      document.dispatchEvent(new Event("resume"));
      const afterResume = { timerCount: timers.length, cancellations, refreshes };
      document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); document.dispatchEvent(new Event("resume"));
      const whileHidden = { timerCount: timers.length, cancellations, refreshes };
      document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
      const afterVisible = { timerCount: timers.length, cancellations, refreshes };
      dispose(); timers[timers.length - 1].callback();
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      document.dispatchEvent(new Event("freeze")); document.dispatchEvent(new Event("resume")); document.dispatchEvent(new Event("visibilitychange"));
      return { initialTimerCount, afterPageHide, afterPageShow, afterFreeze, afterResume, whileHidden, afterVisible, afterDispose: { timerCount: timers.length, cancellations, refreshes } };
    });
    assert.deepEqual(result, {
      initialTimerCount: 1,
      afterPageHide: { timerCount: 1, cancellations: 1, refreshes: 0 },
      afterPageShow: { timerCount: 2, cancellations: 1, refreshes: 1 },
      afterFreeze: { timerCount: 2, cancellations: 2, refreshes: 1 },
      afterResume: { timerCount: 3, cancellations: 2, refreshes: 2 },
      whileHidden: { timerCount: 3, cancellations: 3, refreshes: 2 },
      afterVisible: { timerCount: 4, cancellations: 3, refreshes: 3 },
      afterDispose: { timerCount: 4, cancellations: 4, refreshes: 3 }
    });
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await Promise.race([new Promise(resolveExit => server.once("exit", resolveExit)), delay(3_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});