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
      throw new Error(Vite terminó antes de estar listo (código ${child.exitCode}).);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(Vite respondió HTTP ${response.status}.);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error("Vite no respondió dentro del límite de arranque.", { cause: lastError });
}

async function typeAtEnd(page, value) {
  await page.locator("#manuscript").evaluate(element => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.locator("#manuscript").pressSequentially(value);
}

async function closeAndAssert(page) {
  await page.getByRole("button", { name: "Guardar todas las sesiones y cerrar monitoreo" }).click();
  await page.waitForFunction(() => {
    const demo = window.__liveAuthorMonitorDemo;
    const closeState = demo?.getCloseState?.();
    return demo?.closed === true || closeState?.stage === "error";
  });
  const result = await page.evaluate(() => ({
    closed: window.__liveAuthorMonitorDemo.closed,
    state: window.__liveAuthorMonitorDemo.getCloseState(),
    pending: window.__liveAuthorMonitorDemo.getPendingChanges()
  }));
  assert.equal(result.closed, true, "el cierre durable debe finalizar: " + JSON.stringify(result));
}

test("dos capítulos conservan métricas independientes al cambiar, guardar y recuperar en Chromium", {
  timeout: 120_000
}, async () => {
  const port = await reservePort();
  const projectId = "live-author-multidoc-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const secondDocumentId = documentId + "-chapter-2";
  const url = http://127.0.0.1:${port}/examples/live-author-monitor/index.html?project=${encodeURIComponent(projectId)}&document=${encodeURIComponent(documentId)};
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
      assert.equal(await page.evaluate(() => window.__liveAuthorMonitorDemo.documentIds.length), 2);
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo.getWorkspaceDocumentCount() === 2);

      const chapterOneInitial = await page.locator("#manuscript").inputValue();
      const chapterOneEdit = " Edición exclusiva del primer capítulo.";
      await typeAtEnd(page, chapterOneEdit);
      await page.evaluate(() => window.__liveAuthorMonitorDemo.flush());

      let chapterOne = await page.evaluate(() => {
        const demo = window.__liveAuthorMonitorDemo;
        return { snapshot: demo.getSnapshot(), metrics: demo.getMetrics() };
      });
      assert.equal(chapterOne.snapshot.text, chapterOneInitial + chapterOneEdit);
      assert.equal(chapterOne.metrics.acceptedChanges, chapterOneEdit.length);
      assert.equal(chapterOne.metrics.committedChanges, chapterOneEdit.length);
      assert.equal(chapterOne.metrics.durableSequence, chapterOneEdit.length);

      await page.evaluate(id => window.__liveAuthorMonitorDemo.switchDocument(id), secondDocumentId);
      assert.equal(await page.evaluate(() => window.__liveAuthorMonitorDemo.getActiveDocumentId()), secondDocumentId);
      const chapterTwoInitial = await page.locator("#manuscript").inputValue();
      const chapterTwoEdit = " Texto independiente del segundo capítulo.";
      await typeAtEnd(page, chapterTwoEdit);
      await page.evaluate(() => window.__liveAuthorMonitorDemo.flush());

      const chapterTwo = await page.evaluate(() => {
        const demo = window.__liveAuthorMonitorDemo;
        return { snapshot: demo.getSnapshot(), metrics: demo.getMetrics() };
      });
      assert.equal(chapterTwo.snapshot.text, chapterTwoInitial + chapterTwoEdit);
      assert.equal(chapterTwo.metrics.acceptedChanges, chapterTwoEdit.length);
      assert.equal(chapterTwo.metrics.committedChanges, chapterTwoEdit.length);
      assert.equal(chapterTwo.metrics.durableSequence, chapterTwoEdit.length);

      await page.evaluate(id => window.__liveAuthorMonitorDemo.switchDocument(id), documentId);
      const chapterOneAfterSwitch = await page.evaluate(() => {
        const demo = window.__liveAuthorMonitorDemo;
        return { text: demo.getSnapshot().text, metrics: demo.getMetrics() };
      });
      assert.equal(chapterOneAfterSwitch.text, chapterOneInitial + chapterOneEdit);
      assert.equal(chapterOneAfterSwitch.metrics.insertedCharacters, chapterOneEdit.length);
      assert.equal(await page.evaluate(() => window.__liveAuthorMonitorDemo.getWorkspaceDocumentCount()), 2);

      await closeAndAssert(page);
      await page.reload();
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo?.ready === true);
      await page.waitForFunction(() => window.__liveAuthorMonitorDemo.getWorkspaceDocumentCount() === 2);

      const restoredChapterOne = await page.evaluate(id => {
        const demo = window.__liveAuthorMonitorDemo;
        return { snapshot: demo.getSnapshot(id), metrics: demo.getMetrics(id) };
      }, documentId);
      const restoredChapterTwo = await page.evaluate(id => {
        const demo = window.__liveAuthorMonitorDemo;
        return { snapshot: demo.getSnapshot(id), metrics: demo.getMetrics(id) };
      }, secondDocumentId);
      assert.equal(restoredChapterOne.snapshot.text, chapterOneInitial + chapterOneEdit);
      assert.equal(restoredChapterOne.metrics.acceptedChanges, chapterOneEdit.length);
      assert.equal(restoredChapterOne.metrics.committedChanges, chapterOneEdit.length);
      assert.equal(restoredChapterOne.metrics.durableSequence, chapterOneEdit.length);
      assert.equal(restoredChapterTwo.snapshot.text, chapterTwoInitial + chapterTwoEdit);
      assert.equal(restoredChapterTwo.metrics.acceptedChanges, chapterTwoEdit.length);
      assert.equal(restoredChapterTwo.metrics.committedChanges, chapterTwoEdit.length);
      assert.equal(restoredChapterTwo.metrics.durableSequence, chapterTwoEdit.length);

      await page.evaluate(id => window.__liveAuthorMonitorDemo.switchDocument(id), secondDocumentId);
      const postRecoveryEdit = " Continuación tras recuperar el segundo capítulo.";
      await typeAtEnd(page, postRecoveryEdit);
      await page.evaluate(() => window.__liveAuthorMonitorDemo.flush());
      const continued = await page.evaluate(() => ({
        snapshot: window.__liveAuthorMonitorDemo.getSnapshot(),
        metrics: window.__liveAuthorMonitorDemo.getMetrics()
      }));
      assert.equal(continued.snapshot.text, chapterTwoInitial + chapterTwoEdit + postRecoveryEdit);
      assert.equal(continued.metrics.durableSequence, chapterTwoEdit.length + postRecoveryEdit.length);

      await closeAndAssert(page);
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
