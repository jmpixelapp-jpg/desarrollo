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

test("Chromium conserva la continuidad ante candidatos IME provisionales y cancelación", {
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
  let cdp;

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
      element.id = "ime-composition-editor";
      element.value = "abc";
      document.body.append(element);

      const errors = [];
      const deltas = [];
      const events = [];
      const source = new LiveAuthorMonitorTextAreaSource({
        element,
        initialSnapshot: {
          documentId: "chromium-ime-composition",
          text: "abc",
          revision: 0,
          sequence: 0
        },
        onError: error => errors.push(error.code)
      });
      source.subscribeChanges(change => deltas.push({
        sequence: change.sequence,
        baseRevision: change.baseRevision,
        start: change.start,
        end: change.end,
        replacement: change.replacement,
        activityKind: change.activityKind
      }));

      for (const type of [
        "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"
      ]) {
        element.addEventListener(type, event => events.push({
          type: event.type,
          inputType: typeof event.inputType === "string" ? event.inputType : null,
          isTrusted: event.isTrusted === true,
          isComposing: typeof event.isComposing === "boolean" ? event.isComposing : null,
          cancelable: typeof event.cancelable === "boolean" ? event.cancelable : null,
          defaultPrevented: typeof event.defaultPrevented === "boolean" ? event.defaultPrevented : null,
          dataLengthUtf16: typeof event.data === "string" ? event.data.length : null,
          valueLengthUtf16: element.value.length,
          selectionStart: element.selectionStart,
          selectionEnd: element.selectionEnd
        }));
      }

      element.focus();
      element.setSelectionRange(3, 3);
      window.__imeCompositionTest = { element, source, errors, deltas, events };
      return { initialValue: element.value, initialState: source.getState() };
    });

    assert.equal(setup.initialValue, "abc");
    assert.equal(setup.initialState.needsResync, false);
    cdp = await page.context().newCDPSession(page);

    await cdp.send("Input.imeSetComposition", {
      text: "に",
      selectionStart: 1,
      selectionEnd: 1
    });
    await page.waitForFunction(() =>
      window.__imeCompositionTest?.events.some(event => event.type === "compositionstart") === true
    , null, { timeout: 5_000 });

    await cdp.send("Input.imeSetComposition", {
      text: "日本語",
      selectionStart: 3,
      selectionEnd: 3
    });
    await page.waitForFunction(() =>
      window.__imeCompositionTest?.events.filter(
        event => event.type === "beforeinput" && event.inputType === "insertCompositionText"
      ).length >= 2
    , null, { timeout: 5_000 });

    const afterCandidateUpdates = await page.evaluate(() => {
      const test = window.__imeCompositionTest;
      return {
        valueLengthUtf16: test.element.value.length,
        state: test.source.getState(),
        errors: [...test.errors],
        events: test.events.map(event => ({ ...event })),
        deltaCount: test.deltas.length
      };
    });

    assert.equal(afterCandidateUpdates.state.compositionActive, true,
      "cambiar de candidato no debe cerrar la composición");
    assert.equal(afterCandidateUpdates.state.needsResync, false);
    assert.deepEqual(afterCandidateUpdates.errors, []);
    assert.ok(afterCandidateUpdates.events.some(event =>
      event.type === "compositionupdate" && event.isTrusted
    ), "Chromium debe exponer updates de composición confiables");
    assert.ok(afterCandidateUpdates.events.some(event =>
      event.type === "beforeinput" &&
      event.inputType === "insertCompositionText" &&
      event.isTrusted &&
      event.isComposing === true
    ), "el candidato debe anunciarse como insertCompositionText confiable");
    assert.ok(afterCandidateUpdates.events.some(event =>
      event.type === "input" &&
      event.inputType === "insertCompositionText" &&
      event.isTrusted &&
      event.isComposing === true
    ), "el candidato aplicado debe confirmarse mediante input confiable");

    // La documentación de CDP define texto vacío en imeSetComposition como cancelación.
    await cdp.send("Input.imeSetComposition", {
      text: "",
      selectionStart: 0,
      selectionEnd: 0
    });
    await page.waitForFunction(() =>
      window.__imeCompositionTest?.events.some(event => event.type === "compositionend") === true
    , null, { timeout: 5_000 });

    const afterCancel = await page.evaluate(() => {
      const test = window.__imeCompositionTest;
      let replay = "abc";
      for (const change of test.deltas) {
        replay = replay.slice(0, change.start) +
          change.replacement +
          replay.slice(change.end);
      }
      return {
        value: test.element.value,
        replay,
        deltas: test.deltas.map(({ replacement, ...metadata }) => ({
          ...metadata,
          replacementLengthUtf16: replacement.length
        })),
        state: test.source.getState(),
        errors: [...test.errors],
        events: test.events.map(event => ({ ...event }))
      };
    });

    assert.equal(afterCancel.value, "abc",
      "cancelar la composición debe restaurar exactamente el texto anterior");
    assert.equal(afterCancel.replay, afterCancel.value,
      "la secuencia de deltas debe reconstruir el estado final del textarea");
    assert.equal(afterCancel.state.compositionActive, false);
    assert.equal(afterCancel.state.pendingInput, false);
    assert.equal(afterCancel.state.needsResync, false);
    assert.deepEqual(afterCancel.errors, [],
      "una cancelación IME válida no debe requerir resincronización");
    assert.ok(afterCancel.deltas.length >= 2,
      "se deben observar las mutaciones aplicadas de los candidatos y su cancelación");
    assert.ok(afterCancel.deltas.every(change => change.activityKind === "composition" ||
      change.activityKind === "deletion"),
      "las actualizaciones/cancelación IME no deben etiquetarse como escritura ordinaria");
    assert.ok(afterCancel.events.filter(event =>
      event.type.startsWith("composition") || event.inputType === "insertCompositionText"
    ).every(event => event.isTrusted),
    "los eventos de composición usados como evidencia deben ser confiables");

    // La cancelación no puede dejar bloqueada la siguiente edición normal.
    await page.locator("#ime-composition-editor").focus();
    await page.keyboard.type("x");
    await page.waitForFunction(() =>
      window.__imeCompositionTest?.deltas.some(change => change.activityKind === "typing") === true
    , null, { timeout: 5_000 });

    const afterNextEdit = await page.evaluate(() => {
      const test = window.__imeCompositionTest;
      const result = {
        value: test.element.value,
        state: test.source.getState(),
        errors: [...test.errors],
        lastDelta: test.deltas.at(-1) && {
          sequence: test.deltas.at(-1).sequence,
          baseRevision: test.deltas.at(-1).baseRevision,
          start: test.deltas.at(-1).start,
          end: test.deltas.at(-1).end,
          replacementLengthUtf16: test.deltas.at(-1).replacement.length,
          activityKind: test.deltas.at(-1).activityKind
        }
      };
      test.source.dispose();
      return result;
    });
    assert.equal(afterNextEdit.value, "abcx");
    assert.equal(afterNextEdit.state.needsResync, false);
    assert.equal(afterNextEdit.state.pendingInput, false);
    assert.deepEqual(afterNextEdit.errors, []);
    assert.equal(afterNextEdit.lastDelta.activityKind, "typing");
    assert.equal(afterNextEdit.lastDelta.start, 3);
    assert.equal(afterNextEdit.lastDelta.end, 3);
    assert.equal(afterNextEdit.lastDelta.replacementLengthUtf16, 1);
    assert.equal(afterNextEdit.lastDelta.sequence, afterCancel.state.sequence + 1);
  } finally {
    await cdp?.detach().catch(() => {});
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
