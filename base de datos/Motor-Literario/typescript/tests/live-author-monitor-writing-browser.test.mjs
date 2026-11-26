import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

async function reservePort() {
  const listener = createServer();
  await new Promise((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    await new Promise(resolveClose => listener.close(resolveClose));
    throw new Error("No se pudo reservar un puerto TCP para Vite.");
  }
  const port = address.port;
  await new Promise((resolveClose, reject) =>
    listener.close(error => error ? reject(error) : resolveClose())
  );
  return port;
}

async function waitForVite(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Vite terminó antes de estar listo (código ${child.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Vite respondió HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error("Vite no respondió dentro del límite de arranque.", { cause: lastError });
}

test("el autor escribe, ve métricas, guarda y recupera el manuscrito y el checkpoint en Chromium", {
  timeout: 120_000
}, async () => {
  const port = await reservePort();
  const projectId = "live-author-browser-" + randomUUID();
  const documentId = "manuscript-" + randomUUID();
  const url = `http://127.0.0.1:${port}/examples/live-author-monitor/index.html?project=${encodeURIComponent(projectId)}&document=${encodeURIComponent(documentId)}`;
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: process.cwd(), stdio: "ignore" }
  );
  let browser;

  try {
    await waitForVite(url, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(url);
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo?.ready === true);
      const textarea = page.locator("#manuscript");
      const initialText = await textarea.inputValue();
      const typed = " Texto escrito en vivo.";
      await textarea.evaluate(element => {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      });
      await textarea.pressSequentially(typed);
      await page.evaluate(() => window.__liveAuthorMonitorDemo.flush());

      const firstState = await page.evaluate(() => ({
        snapshot: window.__liveAuthorMonitorDemo.getSnapshot(),
        metrics: window.__liveAuthorMonitorDemo.getMetrics()
      }));
      assert.equal(firstState.snapshot.text, initialText + typed);
      assert.equal(firstState.metrics.acceptedChanges, typed.length);
      assert.equal(firstState.metrics.committedChanges, typed.length);
      assert.equal(firstState.metrics.durableSequence, typed.length);
      assert.equal(firstState.metrics.insertedCharacters, typed.length);
      await page.waitForFunction(
        expected => document.querySelector('[data-metric="inserted"]')?.textContent.replace(/\D/gu, "") === String(expected),
        typed.length
      );

      await page.getByRole("button", { name: "Guardar sesión y cerrar monitoreo" }).click();
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo?.closed === true);

      await page.reload();
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo?.ready === true);
      const restored = await page.evaluate(() => ({
        text: window.__liveAuthorMonitorDemo.getSnapshot()?.text,
        metrics: window.__liveAuthorMonitorDemo.getMetrics()
      }));
      assert.equal(restored.text, initialText + typed);
      assert.equal(restored.metrics.acceptedChanges, typed.length);
      assert.equal(restored.metrics.committedChanges, typed.length);
      assert.equal(restored.metrics.durableSequence, typed.length);
      assert.equal(restored.metrics.insertedCharacters, typed.length);

      const secondEdit = " Segunda edición.";
      await page.locator("#manuscript").evaluate(element => {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      });
      await page.locator("#manuscript").pressSequentially(secondEdit);
      await page.evaluate(() => window.__liveAuthorMonitorDemo.flush());
      const resumed = await page.evaluate(() => ({
        snapshot: window.__liveAuthorMonitorDemo.getSnapshot(),
        metrics: window.__liveAuthorMonitorDemo.getMetrics()
      }));
      assert.equal(resumed.snapshot.text, initialText + typed + secondEdit);
      assert.equal(resumed.metrics.durableSequence, typed.length + secondEdit.length);

      await page.getByRole("button", { name: "Guardar sesión y cerrar monitoreo" }).click();
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo?.closed === true);
    } finally {
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await Promise.race([
      new Promise(resolveExit => server.once("exit", resolveExit)),
      delay(3_000)
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});
