import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitor, subscribeLiveAuthorMonitorWithRefresh } = monitorModule;

function fixture(options = {}) {
  let time = 0;
  const monitor = new LiveAuthorMonitor({ now: () => time, ...options });
  const setTime = value => { time = value; };
  const open = (documentId = "chapter-1", text = "hello") => monitor.openDocument({
    documentId, text, revision: 0, sequence: 0
  }, "book-1");
  const change = (sequence, baseRevision, start, end, replacement, documentId = "chapter-1") => ({
    documentId, sequence, baseRevision, start, end, replacement
  });
  const queued = ticketId => ({ status: "queued", ticketId });
  return { monitor, setTime, open, change, queued };
}

test("inicia en reposo y cuenta inserciones, eliminaciones y longitud proyectada", () => {
  const { monitor, open, change, queued } = fixture();
  const initial = open("chapter-1", "hello");
  assert.equal(initial.state, "idle");
  assert.equal(initial.currentDocumentLength, 5);
  const first = monitor.recordAdmission(change(1, 0, 5, 5, " world"), queued("t-1"));
  assert.equal(first.state, "active");
  assert.equal(first.acceptedChanges, 1);
  assert.equal(first.insertedCharacters, 6);
  assert.equal(first.currentDocumentLength, 11);
  assert.equal(first.pendingChanges, 1);
  const second = monitor.recordAdmission(change(2, 1, 0, 5, "Hi"), queued("t-2"));
  assert.equal(second.insertedCharacters, 8);
  assert.equal(second.deletedCharacters, 5);
  assert.equal(second.netCharacterDelta, 3);
  assert.equal(second.currentDocumentLength, 8);
});

test("clasifica tiempo activo, pausas e inactividad con reloj monotónico", () => {
  const { monitor, setTime, open, change, queued } = fixture({ idleAfterMs: 10_000 });
  open();
  setTime(1_000);
  monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));
  setTime(2_500);
  monitor.recordAdmission(change(2, 1, 6, 6, "b"), queued("t-2"));
  setTime(20_000);
  const afterPause = monitor.recordAdmission(change(3, 2, 7, 7, "c"), queued("t-3"));
  assert.equal(afterPause.pauseCount, 1);
  assert.equal(afterPause.activeDurationMs, 11_500);
  assert.equal(afterPause.idleDurationMs, 8_500);
  setTime(32_000);
  const idle = monitor.getSnapshot("chapter-1");
  assert.equal(idle.state, "idle");
  assert.equal(idle.currentIdleMs, 2_000);
  assert.equal(idle.activeDurationMs, 21_500);
  assert.equal(idle.idleDurationMs, 10_500);
  assert.ok(idle.estimatedWordsPerMinute > 0);
});

test("registra rechazos sin sumarlos a los caracteres aceptados", () => {
  const { monitor, open, change } = fixture();
  open();
  const result = monitor.recordAdmission(change(1, 0, 5, 5, "x"), {
    status: "rejected", reason: "queue_full"
  });
  assert.equal(result.rejectedChanges, 1);
  assert.equal(result.acceptedChanges, 0);
  assert.equal(result.insertedCharacters, 0);
  assert.equal(result.state, "active");
});

test("correlaciona commits con tickets y calcula latencias recientes", () => {
  const { monitor, setTime, open, change, queued } = fixture({ commitSampleWindow: 2 });
  open();
  monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));
  setTime(15);
  const first = monitor.recordCommit({ ticketId: "t-1", status: "applied", revision: 1 });
  assert.equal(first.pendingChanges, 0);
  assert.equal(first.committedChanges, 1);
  assert.equal(first.durableRevision, 1);
  assert.equal(first.lastCommitLatencyMs, 15);
  assert.equal(first.averageCommitLatencyMs, 15);
  assert.equal(first.commitLatencyP50Ms, 15);
  assert.equal(monitor.recordCommit({ ticketId: "unknown", status: "applied" }), undefined);
  monitor.recordAdmission(change(2, 1, 6, 6, "b"), queued("t-2"));
  setTime(25);
  monitor.recordCommit({ ticketId: "t-2", status: "applied", revision: 2 });
  monitor.recordAdmission(change(3, 2, 7, 7, "c"), queued("t-3"));
  setTime(45);
  const third = monitor.recordCommit({ ticketId: "t-3", status: "applied", revision: 3 });
  assert.equal(third.commitLatencySamples, 2);
  assert.equal(third.commitLatencyP50Ms, 10);
  assert.equal(third.commitLatencyP95Ms, 20);
  assert.equal(third.averageCommitLatencyMs, 45 / 3);
});

test("un commit fallido exige resincronización y conserva las métricas acumuladas", () => {
  const { monitor, setTime, open, change, queued } = fixture();
  open();
  monitor.recordAdmission(change(1, 0, 5, 5, "x"), queued("t-1"));
  setTime(20);
  const failed = monitor.recordCommit({ ticketId: "t-1", status: "rejected" });
  assert.equal(failed.failedChanges, 1);
  assert.equal(failed.state, "needs-resync");
  assert.equal(failed.needsResync, true);
  const recovered = monitor.resynchronizeDocument({
    documentId: "chapter-1", text: "hello", revision: 0, sequence: 0
  });
  assert.equal(recovered.state, "active");
  assert.equal(recovered.needsResync, false);
  assert.equal(recovered.resynchronizations, 1);
  assert.equal(recovered.acceptedChanges, 1);
  assert.equal(recovered.currentDocumentLength, 5);
});

test("no permite cerrar o resincronizar con tickets pendientes", () => {
  const { monitor, open, change, queued } = fixture();
  open();
  monitor.recordAdmission(change(1, 0, 5, 5, "x"), queued("t-1"));
  assert.throws(() => monitor.closeDocument("chapter-1"), /pendientes de confirmación/);
  assert.throws(() => monitor.resynchronizeDocument({
    documentId: "chapter-1", text: "hello", revision: 0, sequence: 0
  }), /commits pendientes/);
  monitor.recordCommit({ ticketId: "t-1", status: "applied", revision: 1 });
  assert.equal(monitor.closeDocument("chapter-1").pendingChanges, 0);
  assert.equal(monitor.getSnapshot("chapter-1"), undefined);
});

test("aísla documentos y notifica sin permitir que un suscriptor interrumpa la escritura", () => {
  const { monitor, open, change, queued } = fixture();
  open("chapter-1", "hello");
  open("chapter-2", "world");
  let notifications = 0;
  monitor.subscribe(() => { throw new Error("panel desconectado"); });
  monitor.subscribe(snapshot => {
    if (snapshot.documentId === "chapter-1") notifications++;
  }, "chapter-1");
  monitor.recordAdmission(change(1, 0, 5, 5, "!"), queued("t-1"));
  assert.equal(notifications, 1);
  assert.equal(monitor.getSnapshot("chapter-1").insertedCharacters, 1);
  assert.equal(monitor.getSnapshot("chapter-2").insertedCharacters, 0);
  assert.equal(monitor.getSnapshots().length, 2);
});

test("serializa snapshots FIFO cuando un suscriptor provoca otra edición reentrante", () => {
  const { monitor, open, change, queued } = fixture();
  open();

  let nested = false;
  const observed = [];
  monitor.subscribe(snapshot => {
    if (snapshot.acceptedChanges !== 1 || nested) return;
    nested = true;
    monitor.recordAdmission(change(2, 1, 6, 6, "b"), queued("t-2"));
  });
  monitor.subscribe(snapshot => {
    observed.push([
      snapshot.latestSequence,
      snapshot.acceptedChanges,
      snapshot.insertedCharacters
    ]);
  });

  const first = monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));
  assert.equal(first.latestSequence, 1);
  assert.deepEqual(observed, [[1, 1, 1], [2, 2, 2]]);
});

test("fija destinatarios por snapshot y respeta altas y bajas durante reentrancia", () => {
  const { monitor, open, change, queued } = fixture();
  open();

  const removedDeliveries = [];
  const stableDeliveries = [];
  const addedDeliveries = [];
  let unsubscribeRemoved = () => {};

  monitor.subscribe(snapshot => {
    if (snapshot.acceptedChanges !== 1) return;
    unsubscribeRemoved();
    monitor.subscribe(next => addedDeliveries.push(next.latestSequence), "chapter-1");
    monitor.recordAdmission(change(2, 1, 6, 6, "b"), queued("t-2"));
  });
  unsubscribeRemoved = monitor.subscribe(
    snapshot => removedDeliveries.push(snapshot.latestSequence),
    "chapter-1"
  );
  monitor.subscribe(
    snapshot => stableDeliveries.push(snapshot.latestSequence),
    "chapter-1"
  );

  monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));

  assert.deepEqual(removedDeliveries, []);
  assert.deepEqual(stableDeliveries, [1, 2]);
  assert.deepEqual(addedDeliveries, [2]);
});

test("dispose descarta notificaciones reentrantes y no invoca listeners retirados", () => {
  const { monitor, open, change, queued } = fixture();
  open();

  let disposed = false;
  const laterNotifications = [];
  monitor.subscribe(snapshot => {
    if (snapshot.acceptedChanges !== 1 || disposed) return;
    disposed = true;
    monitor.recordAdmission(change(2, 1, 6, 6, "b"), queued("t-2"));
    monitor.dispose();
  });
  monitor.subscribe(snapshot => laterNotifications.push(snapshot.latestSequence));

  monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));

  assert.deepEqual(laterNotifications, []);
  assert.equal(monitor.getSnapshot("chapter-1"), undefined);
});

test("valida secuencias, límite de documentos y retroceso del reloj", () => {
  const { monitor, open, change, queued, setTime } = fixture({ maxOpenDocuments: 1 });
  open();
  assert.throws(() => open("chapter-2"), /límite de documentos/);
  assert.throws(() => monitor.recordAdmission(change(2, 0, 5, 5, "x"), queued("bad")), /no continúa la secuencia/);
  setTime(-1);
  assert.throws(() => monitor.getSnapshot("chapter-1"), /monotónico/);
});

test("refresca el estado de pausa sin nuevas pulsaciones y cancela el planificador", () => {
  const { monitor, setTime, open, change, queued } = fixture({ idleAfterMs: 10 });
  open();
  const hostApi = {
    getLiveAuthorMonitorSnapshot: documentId => monitor.getSnapshot(documentId),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, documentId) => monitor.subscribe(listener, documentId)
  };
  const received = [];
  let refresh;
  let cancelCalled = false;
  const stop = subscribeLiveAuthorMonitorWithRefresh(hostApi, snapshot => received.push(snapshot), {
    documentId: "chapter-1",
    intervalMs: 250,
    schedule(callback, intervalMs) {
      assert.equal(intervalMs, 250);
      refresh = callback;
      return () => { cancelCalled = true; };
    }
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].state, "idle");

  setTime(5);
  monitor.recordAdmission(change(1, 0, 5, 5, "a"), queued("t-1"));
  assert.equal(received.at(-1).state, "active");

  // No llega ninguna nueva edición: el pulso del panel debe detectar la pausa.
  setTime(16);
  refresh();
  assert.equal(received.at(-1).state, "idle");
  assert.equal(received.at(-1).currentIdleMs, 1);
  assert.equal(received.at(-1).activeDurationMs, 10);
  assert.equal(received.at(-1).idleDurationMs, 6);

  const deliveredBeforeStop = received.length;
  stop();
  refresh();
  assert.equal(received.length, deliveredBeforeStop);
  assert.equal(cancelCalled, true);
});

test("el refresco global publica cada documento y aísla errores del panel", () => {
  const { monitor, setTime, open } = fixture({ idleAfterMs: 10 });
  open("chapter-1", "one");
  open("chapter-2", "two");
  const hostApi = {
    getLiveAuthorMonitorSnapshot: documentId => monitor.getSnapshot(documentId),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, documentId) => monitor.subscribe(listener, documentId)
  };
  let refresh;
  const received = [];
  const stop = subscribeLiveAuthorMonitorWithRefresh(hostApi, snapshot => {
    received.push(snapshot.documentId + ":" + snapshot.state);
    if (snapshot.documentId === "chapter-1") throw new Error("panel no disponible");
  }, {
    intervalMs: 500,
    schedule(callback) {
      refresh = callback;
      return () => {};
    }
  });

  assert.deepEqual(received, ["chapter-1:idle", "chapter-2:idle"]);
  setTime(20);
  refresh();
  assert.deepEqual(received.slice(2), ["chapter-1:idle", "chapter-2:idle"]);
  stop();
});

test("valida el intervalo y el filtro documental antes de suscribirse", () => {
  const { monitor } = fixture();
  const hostApi = {
    getLiveAuthorMonitorSnapshot: documentId => monitor.getSnapshot(documentId),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, documentId) => monitor.subscribe(listener, documentId)
  };
  assert.throws(() => subscribeLiveAuthorMonitorWithRefresh(hostApi, () => {}, {
    intervalMs: 0,
    schedule: () => () => {}
  }), /intervalMs/);
  assert.throws(() => subscribeLiveAuthorMonitorWithRefresh(hostApi, () => {}, {
    documentId: "  ",
    schedule: () => () => {}
  }), /documentId/);
});


test("crea y restaura checkpoint durable conservando métricas y contando la interrupción como inactividad", () => {
  const first = fixture({ idleAfterMs: 10, commitSampleWindow: 4 });
  first.open("chapter-1", "hello");
  first.setTime(5);
  first.monitor.recordAdmission(
    first.change(1, 0, 5, 5, "!"),
    first.queued("checkpoint-ticket")
  );
  assert.equal(first.monitor.createCheckpoint("chapter-1", 1000), undefined);

  first.setTime(12);
  first.monitor.recordCommit({
    ticketId: "checkpoint-ticket",
    status: "applied",
    revision: 1
  });
  first.setTime(20);
  const checkpoint = first.monitor.createCheckpoint("chapter-1", 2000);
  assert.ok(checkpoint);
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.sessionDurationMs, 20);
  assert.equal(checkpoint.activeDurationMs, 10);
  assert.equal(checkpoint.idleDurationMs, 10);
  assert.equal(checkpoint.lastActivityAgeMs, 15);
  assert.equal(checkpoint.committedChanges, 1);
  assert.equal(checkpoint.sequence, 1);
  assert.equal(Object.hasOwn(checkpoint, "text"), false);

  const second = fixture({ idleAfterMs: 10, commitSampleWindow: 4 });
  const restored = second.monitor.restoreCheckpoint(
    checkpoint,
    { documentId: "chapter-1", text: "hello!", revision: 1, sequence: 1 },
    "book-1",
    3000
  );
  assert.equal(restored.sessionId, checkpoint.sessionId);
  assert.equal(restored.sessionDurationMs, 1020);
  assert.equal(restored.activeDurationMs, 10);
  assert.equal(restored.idleDurationMs, 1010);
  assert.equal(restored.state, "idle");
  assert.equal(restored.currentIdleMs, 1005);
  assert.equal(restored.committedChanges, 1);
  assert.equal(restored.pendingChanges, 0);

  second.setTime(5);
  const next = second.monitor.recordAdmission(
    second.change(2, 1, 6, 6, "?"),
    second.queued("after-restore")
  );
  assert.equal(next.pauseCount, checkpoint.pauseCount + 1);
  assert.equal(next.latestSequence, 2);
});

test("una recuperación inmediata no sitúa la última actividad antes del inicio de la sesión", () => {
  const first = fixture({ idleAfterMs: 10 });
  first.open("chapter-1", "a");
  first.setTime(1);
  first.monitor.recordAdmission(
    first.change(1, 0, 1, 1, "b"),
    first.queued("short-session-ticket")
  );
  first.setTime(2);
  first.monitor.recordCommit({
    ticketId: "short-session-ticket",
    status: "applied",
    revision: 1
  });
  first.setTime(3);
  const checkpoint = first.monitor.createCheckpoint("chapter-1", 100);
  assert.ok(checkpoint);
  assert.equal(checkpoint.sessionDurationMs, 3);
  assert.equal(checkpoint.lastActivityAgeMs, 2);

  const second = fixture({ idleAfterMs: 10 });
  const restored = second.monitor.restoreCheckpoint(
    checkpoint,
    { documentId: "chapter-1", text: "ab", revision: 1, sequence: 1 },
    "book-1",
    101
  );
  assert.equal(restored.sessionDurationMs, 4);
  assert.equal(restored.idleDurationMs, checkpoint.idleDurationMs + 1);
  const nextCheckpoint = second.monitor.createCheckpoint("chapter-1", 102);
  assert.ok(nextCheckpoint);
  assert.equal(nextCheckpoint.lastActivityAgeMs, 3);
  assert.ok(nextCheckpoint.lastActivityAgeMs <= nextCheckpoint.sessionDurationMs + 1);
});

test("rechaza checkpoints que no coinciden con el snapshot durable o contienen métricas inválidas", () => {
  const first = fixture();
  first.open("chapter-1", "hello");
  const checkpoint = first.monitor.createCheckpoint("chapter-1", 100);
  assert.ok(checkpoint);

  const second = fixture();
  assert.throws(() => second.monitor.restoreCheckpoint(
    checkpoint,
    { documentId: "chapter-1", text: "changed", revision: 0, sequence: 0 },
    "book-1",
    101
  ), /no coincide exactamente/);

  const malformed = { ...checkpoint, activeDurationMs: -1 };
  assert.throws(() => second.monitor.restoreCheckpoint(
    malformed,
    { documentId: "chapter-1", text: "hello", revision: 0, sequence: 0 },
    "book-1",
    101
  ), /métricas o tiempos inválidos/);

  assert.throws(() => second.monitor.restoreCheckpoint(
    checkpoint,
    { documentId: "chapter-1", text: "hello", revision: 0, sequence: 0 },
    "another-project",
    101
  ), /no corresponde/);
});

test("rechaza timestamps de restauración anteriores al checkpoint", () => {
  const first = fixture();
  first.open();
  const checkpoint = first.monitor.createCheckpoint("chapter-1", 500);
  const second = fixture();
  assert.throws(() => second.monitor.restoreCheckpoint(
    checkpoint,
    { documentId: "chapter-1", text: "hello", revision: 0, sequence: 0 },
    "book-1",
    499
  ), /métricas o tiempos inválidos/);
});

test("mantiene métricas acotadas tras más de ocho horas y 40.000 cambios en ocho documentos grandes", () => {
  let time = 0;
  const sampleWindow = 32;
  const documentCount = 8;
  const changesPerDocument = 5_000;
  const monitor = new LiveAuthorMonitor({
    now: () => time,
    idleAfterMs: 10_000,
    maxOpenDocuments: documentCount,
    commitSampleWindow: sampleWindow
  });
  const privateSentinel = "PRIVATE_MANUSCRIPT_SENTINEL";
  const initialText = privateSentinel + "x".repeat(256 * 1024);
  const revisions = new Array(documentCount).fill(0);
  const sequences = new Array(documentCount).fill(0);
  const lengths = new Array(documentCount).fill(initialText.length);

  for (let index = 0; index < documentCount; index += 1) {
    monitor.openDocument({
      documentId: "long-session-" + index,
      text: initialText,
      revision: 0,
      sequence: 0
    }, "book-long-session");
  }

  for (let changeIndex = 0; changeIndex < changesPerDocument; changeIndex += 1) {
    for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
      const documentId = "long-session-" + documentIndex;
      const sequence = ++sequences[documentIndex];
      const revision = revisions[documentIndex];
      const ticketId = documentId + "-ticket-" + sequence;
      time += 1_000;
      const admission = monitor.recordAdmission({
        documentId,
        sequence,
        baseRevision: revision,
        start: lengths[documentIndex],
        end: lengths[documentIndex],
        replacement: "x"
      }, { status: "queued", ticketId });
      assert.equal(admission.pendingChanges, 1);
      time += 1;
      const committed = monitor.recordCommit({
        ticketId,
        status: "applied",
        revision: revision + 1
      });
      assert.equal(committed.pendingChanges, 0);
      revisions[documentIndex] = revision + 1;
      lengths[documentIndex] += 1;
    }
  }

  const snapshots = monitor.getSnapshots();
  assert.equal(snapshots.length, documentCount);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.acceptedChanges, changesPerDocument);
    assert.equal(snapshot.committedChanges, changesPerDocument);
    assert.equal(snapshot.failedChanges, 0);
    assert.equal(snapshot.pendingChanges, 0);
    assert.equal(snapshot.commitLatencySamples, sampleWindow);
    assert.equal(snapshot.currentDocumentLength, initialText.length + changesPerDocument);
    assert.ok(snapshot.sessionDurationMs >= 8 * 60 * 60 * 1_000,
      "la simulación debe cubrir al menos ocho horas");
  }
  assert.equal(JSON.stringify(snapshots).includes(privateSentinel), false,
    "los snapshots del monitor no deben retener ni exponer el texto del manuscrito");
});

test("clasifica escritura, pegado, borrado, corrección, deshacer y rehacer; los conserva al restaurar", () => {
  let time = 0;
  const monitor = new LiveAuthorMonitor({ now: () => time });
  monitor.openDocument({ documentId: "chapter-activity", text: "abcd", revision: 0, sequence: 0 }, "book-activity");
  const operations = [
    { activityKind: "typing", start: 4, end: 4, replacement: "x" },
    { activityKind: "paste", start: 5, end: 5, replacement: "yy" },
    { activityKind: "deletion", start: 5, end: 6, replacement: "" },
    { activityKind: "correction", start: 0, end: 1, replacement: "Z" },
    { activityKind: "undo", start: 0, end: 1, replacement: "" },
    { activityKind: "redo", start: 0, end: 0, replacement: "Z" }
  ];
  operations.forEach((operation, index) => {
    time += 1;
    const admission = monitor.recordAdmission({
      documentId: "chapter-activity",
      sequence: index + 1,
      baseRevision: index,
      ...operation
    }, { status: "queued", ticketId: "activity-" + index });
    assert.equal(admission.pendingChanges, 1);
    monitor.recordCommit({ ticketId: "activity-" + index, status: "applied", revision: index + 1 });
  });

  const snapshot = monitor.getSnapshot("chapter-activity");
  assert.equal(snapshot.typingChanges, 1);
  assert.equal(snapshot.pasteChanges, 1);
  assert.equal(snapshot.deletionChanges, 1);
  assert.equal(snapshot.correctionChanges, 1);
  assert.equal(snapshot.undoChanges, 1);
  assert.equal(snapshot.redoChanges, 1);
  assert.equal(snapshot.acceptedChanges,
    snapshot.typingChanges + snapshot.pasteChanges + snapshot.deletionChanges +
    snapshot.correctionChanges + snapshot.undoChanges + snapshot.redoChanges);

  const checkpoint = monitor.createCheckpoint("chapter-activity", 100);
  assert.ok(checkpoint);
  const restored = new LiveAuthorMonitor({ now: () => 0 });
  const recovered = restored.restoreCheckpoint(checkpoint, {
    documentId: "chapter-activity", text: "Zbcdxy", revision: 6, sequence: 6
  }, "book-activity", 200);
  assert.equal(recovered.typingChanges, 1);
  assert.equal(recovered.pasteChanges, 1);
  assert.equal(recovered.deletionChanges, 1);
  assert.equal(recovered.correctionChanges, 1);
  assert.equal(recovered.undoChanges, 1);
  assert.equal(recovered.redoChanges, 1);
  assert.equal(recovered.otherChanges, 0);

  const legacy = { ...checkpoint };
  for (const key of ["typingChanges", "pasteChanges", "deletionChanges", "correctionChanges",
    "undoChanges", "redoChanges", "otherChanges"]) delete legacy[key];
  const legacyMonitor = new LiveAuthorMonitor({ now: () => 0 });
  const legacySnapshot = legacyMonitor.restoreCheckpoint(legacy, {
    documentId: "chapter-activity", text: "Zbcdxy", revision: 6, sequence: 6
  }, "book-activity", 200);
  assert.equal(legacySnapshot.otherChanges, 6,
    "las ediciones históricas sin clasificación deben conservarse como otras operaciones");
  const nextCheckpoint = legacyMonitor.createCheckpoint("chapter-activity", 300);
  assert.ok(nextCheckpoint);
  assert.equal(nextCheckpoint.otherChanges, 6);

  const interim = { ...checkpoint };
  delete interim.otherChanges;
  const interimMonitor = new LiveAuthorMonitor({ now: () => 0 });
  const interimSnapshot = interimMonitor.restoreCheckpoint(interim, {
    documentId: "chapter-activity", text: "Zbcdxy", revision: 6, sequence: 6
  }, "book-activity", 200);
  assert.equal(interimSnapshot.otherChanges, 0,
    "una entrega intermedia con las seis categorías debe restaurar el residual calculado");
});
