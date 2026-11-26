import test from "node:test";
import assert from "node:assert/strict";
import { LiveAuthorMonitorImePairing } from "./browser/live-author-monitor-ime-pairing.js";

function beforeInput(inputType = "insertText", data = null, defaultPrevented = false) {
  return {
    entry: {
      type: "beforeinput",
      inputType,
      defaultPrevented
    },
    event: { data }
  };
}

function input(inputType = "insertText", data = null) {
  return {
    entry: {
      type: "input",
      inputType
    },
    event: { data }
  };
}

test("correlaciona pares completos y compara datos exactos sin retener contenido", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertText", "PRIVATE_INPUT_VALUE");
  const after = input("insertText", "PRIVATE_INPUT_VALUE");

  tracker.recordBeforeInput(before.entry, before.event);
  tracker.recordInput(after.entry, after.event);

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairId, after.entry.pairId);
  assert.equal(before.entry.pairStatus, "paired");
  assert.equal(after.entry.pairStatus, "paired");
  assert.equal(before.entry.dataComparison, "match");
  assert.equal(after.entry.dataComparison, "match");
  assert.equal(summary.pairedInputCount, 1);
  assert.equal(summary.pendingBeforeInputCount, 0);
  assert.equal(summary.inputDataMatchCount, 1);
  assert.equal(JSON.stringify([before.entry, after.entry, summary]).includes("PRIVATE_INPUT_VALUE"), false);
});

test("detecta datos contradictorios sin incluir sus valores en el resultado", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertCompositionText", "CANDIDATE_ALPHA");
  const after = input("insertCompositionText", "CANDIDATE_BRAVO");

  tracker.recordBeforeInput(before.entry, before.event);
  tracker.recordInput(after.entry, after.event);

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairId, after.entry.pairId);
  assert.equal(before.entry.dataComparison, "mismatch");
  assert.equal(after.entry.dataComparison, "mismatch");
  assert.equal(summary.inputDataMismatchCount, 1);
  assert.equal(summary.pairedInputCount, 1);
  assert.equal(JSON.stringify([before.entry, after.entry, summary]).includes("CANDIDATE_ALPHA"), false);
  assert.equal(JSON.stringify([before.entry, after.entry, summary]).includes("CANDIDATE_BRAVO"), false);
});

test("clasifica datos de un solo lado y datos no disponibles", () => {
  const cases = [
    { before: null, after: "INPUT_ONLY", expected: "one-sided", counter: "inputDataOneSidedCount" },
    { before: "BEFORE_ONLY", after: null, expected: "one-sided", counter: "inputDataOneSidedCount" },
    { before: null, after: null, expected: "unavailable", counter: "inputDataUnavailableCount" }
  ];

  for (const item of cases) {
    const tracker = new LiveAuthorMonitorImePairing();
    const before = beforeInput("insertText", item.before);
    const after = input("insertText", item.after);
    tracker.recordBeforeInput(before.entry, before.event);
    tracker.recordInput(after.entry, after.event);
    assert.equal(before.entry.dataComparison, item.expected);
    assert.equal(after.entry.dataComparison, item.expected);
    assert.equal(tracker.snapshot()[item.counter], 1);
    assert.equal(JSON.stringify([before.entry, after.entry, tracker.snapshot()]).includes("ONLY"), false);
  }
});

test("detecta inputType discordante aunque pueda comparar los datos", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertCompositionText", "SAME_VALUE");
  const after = input("insertText", "SAME_VALUE");

  tracker.recordBeforeInput(before.entry, before.event);
  tracker.recordInput(after.entry, after.event);

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairId, after.entry.pairId);
  assert.equal(before.entry.pairStatus, "inputtype-mismatch");
  assert.equal(after.entry.pairStatus, "inputtype-mismatch");
  assert.equal(after.entry.dataComparison, "match");
  assert.equal(summary.inputTypeMismatchCount, 1);
  assert.equal(summary.pairedInputCount, 0);
  assert.equal(summary.pendingBeforeInputCount, 0);
});

test("conserva una pareja cuando input no informa inputType", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertText", "TEXT_VALUE");
  const after = input("", "TEXT_VALUE");

  tracker.recordBeforeInput(before.entry, before.event);
  tracker.recordInput(after.entry, after.event);

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairId, after.entry.pairId);
  assert.equal(before.entry.pairStatus, "paired-inputtype-unavailable");
  assert.equal(after.entry.pairStatus, "paired-inputtype-unavailable");
  assert.equal(summary.pairedInputCount, 1);
  assert.equal(summary.pairedWithoutInputTypeCount, 1);
  assert.equal(summary.inputTypeMismatchCount, 0);
});

test("marca beforeinput cancelado y input huérfano sin abrir una pareja pendiente", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const prevented = beforeInput("insertText", "CANCELLED_VALUE", true);
  tracker.recordBeforeInput(prevented.entry, prevented.event);

  const orphan = input("insertText", "ORPHAN_VALUE");
  tracker.recordInput(orphan.entry, orphan.event);

  const summary = tracker.snapshot();
  assert.equal(prevented.entry.pairStatus, "default-prevented");
  assert.equal(prevented.entry.dataComparison, "not-applicable");
  assert.equal(orphan.entry.pairStatus, "orphan-input");
  assert.equal(summary.defaultPreventedBeforeInputCount, 1);
  assert.equal(summary.orphanInputCount, 1);
  assert.equal(summary.pendingBeforeInputCount, 0);
});

test("marca y libera un beforeinput sustituido por una nueva operación", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const first = beforeInput("insertText", "FIRST_PRIVATE_VALUE");
  const second = beforeInput("insertText", "SECOND_PRIVATE_VALUE");
  const after = input("insertText", "SECOND_PRIVATE_VALUE");

  tracker.recordBeforeInput(first.entry, first.event);
  tracker.recordBeforeInput(second.entry, second.event);
  tracker.recordInput(after.entry, after.event);

  const summary = tracker.snapshot();
  assert.equal(first.entry.pairStatus, "superseded-by-next-beforeinput");
  assert.equal(second.entry.pairId, after.entry.pairId);
  assert.equal(summary.unmatchedBeforeInputCount, 1);
  assert.equal(summary.pairedInputCount, 1);
  assert.equal(summary.pendingBeforeInputCount, 0);
  assert.equal(JSON.stringify([first.entry, second.entry, after.entry, summary]).includes("PRIVATE_VALUE"), false);
});

test("un error interrumpe y libera el payload pendiente", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertText", "PENDING_PRIVATE_VALUE");
  tracker.recordBeforeInput(before.entry, before.event);
  tracker.interrupt("monitor-error-before-input");

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairStatus, "monitor-error-before-input");
  assert.equal(summary.pendingBeforeInputCount, 0);
  assert.equal(summary.interruptedBeforeInputCount, 1);
  assert.equal(JSON.stringify([before.entry, summary]).includes("PENDING_PRIVATE_VALUE"), false);
});

test("dispose abandona y libera cualquier beforeinput pendiente", () => {
  const tracker = new LiveAuthorMonitorImePairing();
  const before = beforeInput("insertCompositionText", "DISPOSE_PRIVATE_VALUE");
  tracker.recordBeforeInput(before.entry, before.event);
  tracker.dispose();
  tracker.dispose();

  const summary = tracker.snapshot();
  assert.equal(before.entry.pairStatus, "page-disposed-before-input");
  assert.equal(summary.pendingBeforeInputCount, 0);
  assert.equal(summary.interruptedBeforeInputCount, 1);
  assert.equal(JSON.stringify([before.entry, summary]).includes("DISPOSE_PRIVATE_VALUE"), false);

  const ignored = input("insertCompositionText", "LATE_VALUE");
  tracker.recordInput(ignored.entry, ignored.event);
  assert.equal(tracker.snapshot().orphanInputCount, 0,
    "la instancia dispuesta ignora eventos tardíos");
});
