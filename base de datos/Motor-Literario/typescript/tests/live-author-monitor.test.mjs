import test from "node:test";
import assert from "node:assert/strict";
import { LiveAuthorMonitor } from "../dist/motor-literario.js";

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

test("valida secuencias, límite de documentos y retroceso del reloj", () => {
  const { monitor, open, change, queued, setTime } = fixture({ maxOpenDocuments: 1 });
  open();
  assert.throws(() => open("chapter-2"), /límite de documentos/);
  assert.throws(() => monitor.recordAdmission(change(2, 0, 5, 5, "x"), queued("bad")), /no continúa la secuencia/);
  setTime(-1);
  assert.throws(() => monitor.getSnapshot("chapter-1"), /monotónico/);
});