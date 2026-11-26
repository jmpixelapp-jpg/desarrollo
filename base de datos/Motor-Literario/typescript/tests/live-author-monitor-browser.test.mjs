import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
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
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
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

async function invoke(page, operation, ...args) {
  return page.evaluate(
    ({ operation, args }) => {
      const harness = window.__monitorLeaseHarness;
      if (!harness || typeof harness[operation] !== "function") {
        throw new Error("El harness IndexedDB no está listo.");
      }
      return harness[operation](...args);
    },
    { operation, args }
  );
}

test("dos páginas Chromium comparten IndexedDB real y aplican fencing del lease", {
  timeout: 120_000
}, async () => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const harnessUrl = origin + "/tests/browser/live-author-monitor-lease.html";
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: process.cwd(), stdio: "ignore" }
  );
  let browser;

  try {
    await waitForVite(harnessUrl, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const firstPage = await context.newPage();
    const secondPage = await context.newPage();

    try {
      await Promise.all([firstPage.goto(harnessUrl), secondPage.goto(harnessUrl)]);
      await Promise.all([
        firstPage.waitForFunction(() => window.__monitorLeaseHarness !== undefined),
        secondPage.waitForFunction(() => window.__monitorLeaseHarness !== undefined)
      ]);

      const projectId = "browser-monitor-" + randomUUID();
      const documentId = "chapter-" + randomUUID();
      const firstOwner = "tab-a-" + randomUUID();
      const secondOwner = "tab-b-" + randomUUID();
      const now = Date.now();
      const attempts = await Promise.all([
        invoke(firstPage, "acquire", projectId, documentId, firstOwner, now, 30_000),
        invoke(secondPage, "acquire", projectId, documentId, secondOwner, now, 30_000)
      ]);

      assert.equal(attempts.filter(Boolean).length, 1, "solo una página debe adquirir el lease inicial");
      const firstWon = Boolean(attempts[0]);
      const ownerPage = firstWon ? firstPage : secondPage;
      const observerPage = firstWon ? secondPage : firstPage;
      const ownerLease = attempts[firstWon ? 0 : 1];
      const ownerId = firstWon ? firstOwner : secondOwner;
      const observerId = firstWon ? secondOwner : firstOwner;

      assert.equal(ownerLease.ownerId, ownerId);
      assert.equal(ownerLease.fencingToken, 1);

      // La pestaña propietaria también mantiene un segundo documento. Su lease
      // y checkpoint deben sobrevivir al takeover del primero.
      const secondDocumentId = "chapter-" + randomUUID();
      const secondOwnerLease = await invoke(
        ownerPage,
        "acquire",
        projectId,
        secondDocumentId,
        ownerId,
        now + 1,
        30_000
      );
      assert.ok(secondOwnerLease);
      assert.equal(secondOwnerLease.fencingToken, 1);
      const secondCheckpoint = {
        version: 1,
        projectId,
        documentId: secondDocumentId,
        sessionId: "browser-session-" + randomUUID(),
        savedAt: Date.now(),
        sessionDurationMs: 0,
        activeDurationMs: 0,
        idleDurationMs: 0,
        lastActivityAgeMs: null,
        pauseCount: 0,
        acceptedChanges: 0,
        rejectedChanges: 0,
        committedChanges: 0,
        failedChanges: 0,
        insertedCharacters: 0,
        deletedCharacters: 0,
        currentDocumentLength: 0,
        revision: 0,
        sequence: 0,
        resynchronizations: 0,
        lastCommitLatencyMs: 0,
        totalCommitLatencyMs: 0,
        commitLatencies: []
      };
      await invoke(ownerPage, "saveCheckpoint", secondCheckpoint, secondOwnerLease);

      assert.equal(
        await invoke(observerPage, "acquire", projectId, documentId, observerId, now + 2, 30_000),
        undefined,
        "la segunda página no debe robar el lease activo del documento A"
      );
      assert.equal(
        await invoke(observerPage, "acquire", projectId, secondDocumentId, observerId, now + 2, 30_000),
        undefined,
        "la segunda página tampoco debe apropiarse del documento B"
      );

      // Cierre abrupto: la pestaña propietaria desaparece sin ejecutar release().
      await ownerPage.close();
      await invoke(observerPage, "expire", projectId, documentId);
      const takeoverTime = Date.now() + 5;
      const observerLease = await invoke(
        observerPage,
        "acquire",
        projectId,
        documentId,
        observerId,
        takeoverTime,
        30_000
      );
      assert.ok(observerLease);
      assert.equal(observerLease.ownerId, observerId);
      assert.equal(observerLease.fencingToken, ownerLease.fencingToken + 1);

      assert.equal(
        await invoke(observerPage, "acquire", projectId, secondDocumentId, observerId, takeoverTime + 1, 30_000),
        undefined,
        "el takeover del documento A no debe liberar ni robar el lease B"
      );
      assert.deepEqual(
        await invoke(observerPage, "loadCheckpoint", projectId, secondDocumentId),
        secondCheckpoint,
        "el checkpoint B debe permanecer disponible después del takeover de A"
      );

      const checkpoint = {
        version: 1,
        projectId,
        documentId,
        sessionId: "browser-session-" + randomUUID(),
        savedAt: Date.now(),
        sessionDurationMs: 0,
        activeDurationMs: 0,
        idleDurationMs: 0,
        lastActivityAgeMs: null,
        pauseCount: 0,
        acceptedChanges: 0,
        rejectedChanges: 0,
        committedChanges: 0,
        failedChanges: 0,
        insertedCharacters: 0,
        deletedCharacters: 0,
        currentDocumentLength: 0,
        revision: 0,
        sequence: 0,
        resynchronizations: 0,
        lastCommitLatencyMs: 0,
        totalCommitLatencyMs: 0,
        commitLatencies: []
      };

      await assert.rejects(
        invoke(observerPage, "saveCheckpoint", checkpoint, ownerLease),
        /fencing token/,
        "la página anterior debe quedar cercada aunque conserve el objeto de lease"
      );

      await invoke(observerPage, "saveCheckpoint", checkpoint, observerLease);
      const observedAfterTakeover = await invoke(
        observerPage,
        "loadCheckpoint",
        projectId,
        documentId
      );
      assert.deepEqual(observedAfterTakeover, checkpoint,
        "la nueva pestaña propietaria debe leer el checkpoint persistido en IndexedDB");

      // La segunda pestaña recarga el documento y crea una instancia nueva del
      // adaptador; IndexedDB debe conservar el checkpoint y el lease vigente.
      await observerPage.reload();
      await observerPage.waitForFunction(() => window.__monitorLeaseHarness !== undefined);
      await observerPage.evaluate(async () => {
        const { LiveAuthorMonitorTextAreaSource } = await import("/src/live-author-monitor-textarea-source.ts");
        const element = document.createElement("textarea");
        element.id = "native-capture-textarea";
        element.value = "abc";
        document.body.append(element);
        const errors = [];
        const changes = [];
        const source = new LiveAuthorMonitorTextAreaSource({
          element,
          initialSnapshot: { documentId: "browser-native-capture", text: "abc", revision: 0, sequence: 0 },
          onError: error => errors.push(error.code)
        });
        source.subscribeChanges(change => changes.push(change));
        window.__nativeCaptureHarness = { element, source, errors, changes };
      });

      const nativeTextarea = observerPage.locator("#native-capture-textarea");
      await nativeTextarea.focus();
      await nativeTextarea.evaluate(element => element.setSelectionRange(3, 3));
      await observerPage.keyboard.type("!");

      // dispatchEvent() no puede fabricar un evento confiable aunque copie InputEvent.
      await observerPage.evaluate(() => {
        const harness = window.__nativeCaptureHarness;
        harness.element.setSelectionRange(4, 4);
        harness.element.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, inputType: "insertText", data: "x"
        }));
      });

      const nativeCapture = await observerPage.evaluate(() => {
        const harness = window.__nativeCaptureHarness;
        const result = {
          changes: harness.changes,
          errors: harness.errors,
          state: harness.source.getState()
        };
        harness.source.dispose();
        harness.element.remove();
        delete window.__nativeCaptureHarness;
        return result;
      });
      assert.equal(nativeCapture.changes.length, 1,
        "el navegador debe producir un delta exacto para el par beforeinput/input válido");
      assert.deepEqual(nativeCapture.changes[0], {
        documentId: "browser-native-capture",
        sequence: 1,
        baseRevision: 0,
        start: 3,
        end: 3,
        replacement: "!",
        activityKind: "typing"
      });
      assert.deepEqual(nativeCapture.errors, ["untrusted-event"]);
      assert.equal(nativeCapture.state.needsResync, true,
        "un evento dispatchEvent sintético debe suspender la captura aunque copie inputType");

      assert.deepEqual(
        await invoke(observerPage, "loadCheckpoint", projectId, documentId),
        checkpoint,
        "el checkpoint debe sobrevivir a una recarga real de la página"
      );
      assert.deepEqual(
        await invoke(observerPage, "loadCheckpoint", projectId, secondDocumentId),
        secondCheckpoint,
        "el checkpoint del segundo documento también debe sobrevivir a la recarga"
      );
      assert.equal(
        await invoke(observerPage, "acquire", projectId, secondDocumentId, observerId, Date.now(), 30_000),
        undefined,
        "el cierre abrupto de A no debe invalidar la titularidad durable de B"
      );

      assert.equal(await invoke(observerPage, "release", observerLease, Date.now()), true);
      await observerPage.close();
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

test("Chromium captura candidatos IME y separa la confirmación de texto por CDP", {
  timeout: 120_000
}, async () => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const harnessUrl = origin + "/tests/browser/live-author-monitor-lease.html";
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: process.cwd(), stdio: "ignore" }
  );
  let browser;

  try {
    await waitForVite(harnessUrl, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(harnessUrl);
      await page.waitForFunction(() => window.__monitorLeaseHarness !== undefined);
      await page.evaluate(async () => {
        const { LiveAuthorMonitorTextAreaSource } =
          await import("/src/live-author-monitor-textarea-source.ts");
        const element = document.createElement("textarea");
        element.id = "ime-capture-textarea";
        element.value = "abc";
        document.body.append(element);
        const errors = [];
        const changes = [];
        const events = [];
        for (const type of [
          "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"
        ]) {
          element.addEventListener(type, event => events.push({
            type,
            inputType: event.inputType ?? null,
            data: event.data ?? null,
            isComposing: event.isComposing ?? null,
            isTrusted: event.isTrusted
          }));
        }
        const source = new LiveAuthorMonitorTextAreaSource({
          element,
          initialSnapshot: {
            documentId: "browser-ime-capture",
            text: "abc",
            revision: 0,
            sequence: 0
          },
          onError: error => errors.push({ code: error.code, message: error.message })
        });
        source.subscribeChanges(change => changes.push(change));
        window.__imeCaptureHarness = { element, source, errors, changes, events };
      });

      const textarea = page.locator("#ime-capture-textarea");
      await textarea.focus();
      await textarea.evaluate(element => element.setSelectionRange(3, 3));
      const cdp = await context.newCDPSession(page);
      try {
        // CDP sets successive IME candidate strings. This exercises the real
        // Chromium editing pipeline and trusted DOM events, not dispatchEvent().
        await cdp.send("Input.imeSetComposition", {
          text: "に",
          selectionStart: 1,
          selectionEnd: 1
        });
        await cdp.send("Input.imeSetComposition", {
          text: "日本",
          selectionStart: 2,
          selectionEnd: 2
        });

        const candidateResult = await page.evaluate(() => {
          const harness = window.__imeCaptureHarness;
          return {
            value: harness.element.value,
            errors: [...harness.errors],
            changes: [...harness.changes],
            events: [...harness.events],
            state: harness.source.getState()
          };
        });

        assert.equal(candidateResult.value, "abc日本",
          "la segunda actualización debe sustituir el candidato anterior");
        assert.deepEqual(candidateResult.errors, [],
          "las actualizaciones de candidatos IME deben completar pares válidos");
        assert.equal(candidateResult.state.needsResync, false);
        assert.equal(candidateResult.state.compositionActive, true);

        const compositionChanges = candidateResult.changes.filter(
          change => change.activityKind === "composition"
        );
        assert.ok(compositionChanges.length >= 2,
          "cada candidato IME observado debe publicarse como actividad composition");
        assert.ok(candidateResult.changes.every(change =>
          change.activityKind !== "typing" ||
          (change.replacement !== "に" && change.replacement !== "日本")
        ), "los candidatos provisionales no deben contarse como typing ordinario");

        const trustedCompositionUpdates = candidateResult.events.filter(event =>
          (event.type === "beforeinput" || event.type === "input") &&
          event.inputType === "insertCompositionText"
        );
        assert.ok(trustedCompositionUpdates.length >= 4,
          "Chromium debe producir pares beforeinput/input para las actualizaciones de composición");
        assert.ok(trustedCompositionUpdates.every(event => event.isTrusted === true),
          "los pares beforeinput/input generados por el pipeline IME deben ser confiables");
        assert.ok(candidateResult.events.some(event =>
          event.type === "compositionstart" && event.isTrusted === true
        ), "debe observarse el inicio confiable de la composición");
        assert.ok(candidateResult.events.some(event =>
          event.type === "compositionupdate" && event.isTrusted === true
        ), "debe observarse una actualización confiable de la composición");

        // La API CDP de confirmación usa ImeCommitText, pero en este runner
        // Chromium emite compositionend no confiable. No se permite que ese
        // artefacto de automatización atraviese la barrera isTrusted: disponemos
        // la fuente después de comprobar los candidatos y probamos el commit
        // de Chromium por separado, inspeccionando el evento sin atribuírselo
        // a una edición de autor capturada.
        await page.evaluate(() => {
          const harness = window.__imeCaptureHarness;
          harness.source.dispose();
        });
        await cdp.send("Input.insertText", { text: "日本" });
        const committedResult = await page.evaluate(() => {
          const harness = window.__imeCaptureHarness;
          const result = {
            value: harness.element.value,
            events: [...harness.events]
          };
          harness.element.remove();
          delete window.__imeCaptureHarness;
          return result;
        });
        assert.equal(committedResult.value, "abc日本",
          "el candidato confirmado debe permanecer en el documento");
        assert.ok(committedResult.events.some(event => event.type === "compositionend"),
          "la confirmación debe cerrar la composición en Chromium");
      } finally {
        await cdp.detach();
      }
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

test("la página manual de IME exporta metadatos sin incluir el manuscrito ni InputEvent.data", {
  timeout: 120_000
}, async () => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const harnessUrl = origin + "/tests/browser/live-author-monitor-ime-manual.html";
  const viteCli = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: process.cwd(), stdio: "ignore" }
  );
  let browser;

  try {
    await waitForVite(harnessUrl, server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    try {
      await page.goto(harnessUrl);
      const textarea = page.locator("#editor");
      const privateSentinel = "PRIVATE_MANUSCRIPT_EXPORT_SENTINEL";
      await textarea.fill(privateSentinel);
      await page.getByRole("button", { name: "Iniciar captura" }).click();
      await textarea.focus();
      await textarea.evaluate(element => element.setSelectionRange(
        element.value.length, element.value.length
      ));
      await page.keyboard.type("Z");
      try {
        await page.waitForFunction(() => {
          const metrics = document.querySelector("#metrics")?.textContent ?? "";
          try {
            const parsed = JSON.parse(metrics);
            return parsed.eventCounters.beforeInputCount >= 1 &&
              parsed.eventCounters.inputCount >= 1 &&
              parsed.deltaCounters.typing >= 1;
          } catch { return false; }
        }, undefined, { timeout: 15_000 });
      } catch (error) {
        const browserState = await page.evaluate(() => ({
          status: document.querySelector("#status")?.textContent ?? null,
          metrics: document.querySelector("#metrics")?.textContent ?? null,
          textareaLengthUtf16: document.querySelector("#editor")?.value.length ?? null,
          startButtonDisabled: document.querySelector("#start")?.disabled ?? null
        }));
        throw new Error(
          String(error) + "; browserState=" + JSON.stringify(browserState) +
          "; browserErrors=" + JSON.stringify(browserErrors)
        );
      }
      const captureMetrics = JSON.parse(await page.locator("#metrics").textContent());
      assert.equal(captureMetrics.deltaCounters.typing, 1, JSON.stringify(captureMetrics));
      assert.equal(captureMetrics.pairing.pairedInputCount, 1,
        "beforeinput e input deben quedar correlacionados");
      assert.equal(captureMetrics.pairing.pendingBeforeInputCount, 0);
      assert.equal(captureMetrics.pairing.orphanInputCount, 0);
      assert.equal(
        captureMetrics.pairing.inputDataMatchCount +
        captureMetrics.pairing.inputDataOneSidedCount +
        captureMetrics.pairing.inputDataUnavailableCount,
        1,
        "el par debe clasificar si los datos coinciden, están disponibles en un solo evento o faltan"
      );
      assert.equal(captureMetrics.pairing.inputDataMismatchCount, 0);

      // Inyecta un beforeinput sintético que el adaptador debe rechazar.
      // Su onError ocurre antes de que el listener manual vea ese mismo evento.
      const rejectedInputSentinel = "PRIVATE_REJECTED_INPUT_PAYLOAD";
      await page.evaluate(data => {
        document.querySelector("#editor").dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertText",
          data,
          bubbles: true,
          cancelable: true
        }));
      }, rejectedInputSentinel);
      const interruptedMetrics = JSON.parse(await page.locator("#metrics").textContent());
      assert.equal(interruptedMetrics.state.needsResync, true);
      assert.equal(interruptedMetrics.eventCounters.monitorErrorCount, 1);
      assert.equal(interruptedMetrics.pairing.interruptedBeforeInputCount, 1);
      assert.equal(interruptedMetrics.pairing.pendingBeforeInputCount, 0);
      assert.equal(interruptedMetrics.errorCodeCounts["untrusted-event"], 1);
      assert.equal(JSON.stringify(interruptedMetrics).includes(rejectedInputSentinel), false,
        "el payload del beforeinput rechazado no debe quedar en métricas ni diagnósticos");

      // Solo para probar retención acotada y contadores acumulativos:
      // estos eventos son sintéticos, no modifican el textarea ni representan
      // una sesión IME. El adaptador no consume compositionupdate.
      const privateCompositionSentinel = "PRIVATE_IME_CANDIDATE_SENTINEL";
      await page.evaluate(({ candidate, count }) => {
        const target = document.querySelector("#editor");
        for (let index = 0; index < count; index += 1) {
          target.dispatchEvent(new CompositionEvent("compositionupdate", {
            data: candidate,
            bubbles: true
          }));
        }
      }, { candidate: privateCompositionSentinel, count: 2_010 });

      const longSessionMetrics = JSON.parse(await page.locator("#metrics").textContent());
      assert.equal(longSessionMetrics.eventCounters.compositionUpdateCount, 2_010);
      assert.equal(longSessionMetrics.retainedEventCount, 2_000);
      assert.equal(longSessionMetrics.droppedOldestEvents, 14);
      assert.equal(longSessionMetrics.pairing.pairedInputCount, 1);
      assert.equal(longSessionMetrics.deltaCounters.typing, 1);

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Exportar traza sin contenido" }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "live-author-monitor-ime-trace.json");
      const stream = await download.createReadStream();
      assert.ok(stream, "el informe debe estar disponible para descarga");
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const serialized = Buffer.concat(chunks).toString("utf8");
      const report = JSON.parse(serialized);

      assert.equal(report.format, "live-author-monitor-ime-trace-v2");
      assert.equal(report.privacy.manuscriptContentIncluded, false);
      assert.equal(report.privacy.inputEventDataIncluded, false);
      assert.equal(report.privacy.keystrokesIncluded, false);
      assert.equal(report.privacy.localOnlyDownload, true);
      assert.equal(report.baselineLengthUtf16, privateSentinel.length);
      assert.equal(report.finalLengthUtf16, privateSentinel.length + 1);
      assert.equal(report.eventCounters.beforeInputCount, 2);
      assert.equal(report.eventCounters.inputCount, 1);
      assert.equal(report.eventCounters.compositionUpdateCount, 2_010,
        "los contadores de vida de sesión no deben perder eventos descartados del buffer");
      assert.equal(report.eventCounters.monitorErrorCount, 1);
      assert.equal(report.errorCodeCounts["untrusted-event"], 1);
      assert.equal(report.eventCounters.untrustedEventCount, 2_011,
        "las CompositionEvent sintéticas de esta regresión deben quedar identificadas como no confiables");
      assert.equal(report.pairing.pairedInputCount, 1);
      assert.equal(report.pairing.pendingBeforeInputCount, 0);
      assert.equal(report.pairing.unmatchedBeforeInputCount, 0);
      assert.equal(report.pairing.interruptedBeforeInputCount, 1);
      assert.equal(report.pairing.orphanInputCount, 0);
      assert.equal(
        report.pairing.inputDataMatchCount +
        report.pairing.inputDataOneSidedCount +
        report.pairing.inputDataUnavailableCount,
        1
      );
      assert.equal(report.pairing.inputDataMismatchCount, 0);
      assert.equal(report.retainedEventCount, 2_000);
      assert.equal(report.events.length, 2_000);
      assert.equal(report.droppedEventCount, 14);
      assert.equal(report.totalDeltaCount, 1);
      assert.equal(report.deltaCounters.typing, 1);
      assert.equal(report.deltas.length, 1);
      assert.ok(report.events.some(event =>
        event.type === "compositionupdate" &&
        event.dataLengthUtf16 === privateCompositionSentinel.length
      ));
      assert.ok(report.deltas.some(delta =>
        delta.activityKind === "typing" && delta.replacementLengthUtf16 === 1
      ));
      assert.equal(serialized.includes(privateSentinel), false,
        "el texto inicial privado nunca debe aparecer en el archivo exportado");
      assert.equal(serialized.includes(privateCompositionSentinel), false,
        "el candidato IME tampoco debe aparecer en el archivo exportado");
      assert.equal(serialized.includes(rejectedInputSentinel), false,
        "el payload del beforeinput rechazado tampoco debe aparecer en el archivo exportado");
      assert.equal(serialized.includes('"data":"Z"'), false,
        "InputEvent.data debe exportarse solo como longitud, nunca como contenido");
    } finally {
      await page.close();
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

