import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

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
  await new Promise((resolveClose, reject) => {
    listener.close(error => error ? reject(error) : resolveClose());
  });
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
    await delay(100);
  }
  throw new Error("Vite no respondió dentro del límite de arranque.", { cause: lastError });
}

test("Chromium recupera la captura cuando un listener posterior cancela beforeinput", {
  timeout: 90_000
}, async () => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const pageUrl = origin + "/tests/browser/live-author-monitor-ime-manual.html";
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: process.cwd(), stdio: "ignore" }
  );
  let browser;

  try {
    await waitForVite(pageUrl, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(pageUrl);

    const setup = await page.evaluate(async () => {
      const { LiveAuthorMonitorTextAreaSource } = await import(
        "/src/live-author-monitor-textarea-source.ts"
      );
      const element = document.createElement("textarea");
      element.id = "trusted-input-editor";
      element.value = "abc";
      document.body.append(element);

      const errors = [];
      const changes = [];
      const source = new LiveAuthorMonitorTextAreaSource({
        element,
        initialSnapshot: {
          documentId: "chromium-beforeinput-cancellation",
          text: "abc",
          revision: 0,
          sequence: 0
        },
        onError: error => errors.push(error.code)
      });
      source.subscribeChanges(change => changes.push({
        sequence: change.sequence,
        baseRevision: change.baseRevision,
        start: change.start,
        end: change.end,
        replacementLengthUtf16: change.replacement.length,
        activityKind: change.activityKind
      }));

      let cancellationCount = 0;
      let cancelledEventWasTrusted = false;
      const eventTrace = [];
      const cancelFirstInsertion = event => {
        if (cancellationCount === 0 && event.inputType === "insertText") {
          cancellationCount += 1;
          cancelledEventWasTrusted = event.isTrusted === true;
          event.preventDefault();
        }
        eventTrace.push({
          type: event.type,
          inputType: typeof event.inputType === "string" ? event.inputType : null,
          isTrusted: event.isTrusted === true,
          cancelable: event.cancelable === true,
          defaultPreventedAfterHostListener: event.defaultPrevented === true
        });
      };

      // Se registra después de la fuente: reproduce un listener anfitrión que
      // cancela el beforeinput después de que el monitor capturó el candidato.
      element.addEventListener("beforeinput", cancelFirstInsertion);
      element.addEventListener("beforeinput", event => {
        queueMicrotask(() => {
          eventTrace.push({
            type: "microtask-after-host-listener",
            defaultPrevented: event.defaultPrevented === true,
            pendingInput: source.getState().pendingInput
          });
        });
        window.setTimeout(() => {
          eventTrace.push({
            type: "timer-after-host-listener",
            defaultPrevented: event.defaultPrevented === true,
            pendingInput: source.getState().pendingInput
          });
        }, 0);
      });
      element.addEventListener("input", event => {
        eventTrace.push({
          type: event.type,
          inputType: typeof event.inputType === "string" ? event.inputType : null,
          isTrusted: event.isTrusted === true,
          cancelable: event.cancelable === true,
          defaultPreventedAfterHostListener: event.defaultPrevented === true
        });
      });
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      window.__beforeinputCancellationTest = {
        element,
        source,
        errors,
        changes,
        get cancellationCount() { return cancellationCount; },
        get cancelledEventWasTrusted() { return cancelledEventWasTrusted; },
        get eventTrace() { return eventTrace.map(event => ({ ...event })); }
      };

      return { initialValue: element.value, initialState: source.getState() };
    });

    assert.equal(setup.initialValue, "abc");
    assert.equal(setup.initialState.pendingInput, false);
    assert.equal(setup.initialState.needsResync, false);

    await page.locator("#trusted-input-editor").focus();
    await page.keyboard.type("x");

    // No basta con ceder una tarea del runner: esperamos el estado observable
    // de la fuente y la tarea del propio navegador que verifica el fallback.
    await page.waitForFunction(() => {
      const test = window.__beforeinputCancellationTest;
      return test?.source.getState().pendingInput === false;
    }, null, { timeout: 5_000 });
    await page.waitForFunction(() =>
      window.__beforeinputCancellationTest?.eventTrace.some(
        event => event.type === "timer-after-host-listener"
      ) === true
    , null, { timeout: 5_000 });

    const afterCancellation = await page.evaluate(() => {
      const test = window.__beforeinputCancellationTest;
      return {
        value: test.element.value,
        cancellationCount: test.cancellationCount,
        cancelledEventWasTrusted: test.cancelledEventWasTrusted,
        events: test.eventTrace,
        errors: [...test.errors],
        changes: [...test.changes],
        state: test.source.getState()
      };
    });

    assert.equal(afterCancellation.cancellationCount, 1,
      "Chromium debe haber emitido un beforeinput cancelable que el listener anfitrión canceló: " +
      JSON.stringify(afterCancellation.events));
    assert.equal(afterCancellation.cancelledEventWasTrusted, true,
      "la cancelación debe proceder de un evento confiable del navegador");
    assert.equal(afterCancellation.value, "abc",
      "el default action cancelado no debe modificar el textarea");
    assert.deepEqual(afterCancellation.errors, [],
      "la cancelación voluntaria no es una discontinuidad del stream");
    assert.deepEqual(afterCancellation.changes, [],
      "no se debe publicar un delta para una edición que el editor no aplicó");
    assert.equal(afterCancellation.state.pendingInput, false,
      "el estado pendiente debe resolverse tras la propagación: " + JSON.stringify(afterCancellation.events));
    assert.equal(afterCancellation.state.needsResync, false);

    // La siguiente edición real debe iniciar una pareja nueva y ser admitida.
    await page.keyboard.type("y");
    await page.waitForFunction(() =>
      window.__beforeinputCancellationTest?.changes.length === 1
    );

    const afterNextEdit = await page.evaluate(() => {
      const test = window.__beforeinputCancellationTest;
      const state = test.source.getState();
      const result = {
        value: test.element.value,
        errors: [...test.errors],
        changes: [...test.changes],
        state
      };
      test.source.dispose();
      return result;
    });

    assert.equal(afterNextEdit.value, "abcy");
    assert.deepEqual(afterNextEdit.errors, []);
    assert.deepEqual(afterNextEdit.changes, [{
      sequence: 1,
      baseRevision: 0,
      start: 3,
      end: 3,
      replacementLengthUtf16: 1,
      activityKind: "typing"
    }]);
    assert.equal(afterNextEdit.state.sequence, 1);
    assert.equal(afterNextEdit.state.revision, 1);
    assert.equal(afterNextEdit.state.pendingInput, false);
    assert.equal(afterNextEdit.state.needsResync, false);
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise(resolveExit => server.once("exit", resolveExit)),
        delay(2_000)
      ]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  }
});
