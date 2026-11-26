import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  createNarrativeIdeaContinuityIndex,
  createNarrativeIdeaContinuityOutboxCallback,
  createNarrativeIdeaContinuityIndexUpsertHandler,
  deliverNarrativeSyncOutboxBatch,
  IndexedDbNarrativeSyncOutbox,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function idea(projectId, id, documentId, text) {
  const excerpt = "La idea expresada es " + text + ".";
  const start = 10 + excerpt.indexOf(text);
  return {
    id,
    projectId,
    documentId,
    revision: 1,
    kind: "theme",
    text,
    confidence: "high",
    polarity: "affirmed",
    reviewStatus: "candidate",
    evidence: { start, end: start + text.length, excerpt }
  };
}

function makeIndex(projectId, generation, updatedAt, phrase = "memoria antigua de la ciudad") {
  const candidates = [
    idea(projectId, "idea-a", "chapter-1", phrase),
    idea(projectId, "idea-b", "chapter-2", phrase)
  ];
  const crossDocumentAnalysis = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId,
    ideaCandidates: candidates,
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });
  const evolution = buildNarrativeIdeaEvolution({
    projectId,
    crossDocumentAnalysis
  });
  const result = buildNarrativeIdeaContinuityLines({ projectId, evolution });
  return createNarrativeIdeaContinuityIndex({
    projectId,
    generation,
    updatedAt,
    sourceRevisions: [
      { documentId: "chapter-1", revision: 1, status: "active" },
      { documentId: "chapter-2", revision: 1, status: "active" }
    ],
    result
  });
}

function databaseName() {
  return "narrative-sync-outbox-" + randomUUID();
}

test("encola generaciones con secuencia de escritor y deduplica reintentos idénticos", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-sequence-" + randomUUID();
  const firstIndex = makeIndex(projectId, 1, 100);
  const secondIndex = makeIndex(projectId, 2, 200);

  try {
    const first = await outbox.enqueueContinuityIndex({
      index: firstIndex,
      writerId: "device-a"
    });
    assert.equal(first.status, "queued");
    assert.equal(first.entry.sequence, 1);
    assert.equal(first.entry.status, "pending");

    const duplicate = await outbox.enqueueContinuityIndex({
      index: firstIndex,
      writerId: "device-a"
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.entry.operationId, first.entry.operationId);
    assert.equal(duplicate.entry.sequence, 1);

    const second = await outbox.enqueueContinuityIndex({
      index: secondIndex,
      writerId: "device-a",
      expectedGeneration: 1
    });
    assert.equal(second.status, "queued");
    assert.equal(second.entry.sequence, 2);
    assert.equal(second.entry.envelope.payload.expectedGeneration, 1);

    const entries = await outbox.loadEntries(projectId);
    assert.deepEqual(entries.map(entry => entry.generation), [1, 2]);
    assert.deepEqual(entries.map(entry => entry.sequence), [1, 2]);
    const audit = await outbox.auditProject(projectId);
    assert.equal(audit.intact, true);
    assert.equal(audit.operationCount, 2);
    assert.equal(audit.pendingCount, 2);
    assert.equal(audit.writerCount, 1);
    assert.equal(audit.firstGeneration, 1);
    assert.equal(audit.lastGeneration, 2);
    assert.deepEqual(audit.issues, []);
  } finally {
    outbox.close();
  }
});

test("rechaza dos contenidos distintos para la misma generación del proyecto", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-conflict-" + randomUUID();

  try {
    const first = await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100),
      writerId: "device-a"
    });
    assert.equal(first.status, "queued");

    await assert.rejects(outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100, "destino oscuro del reino"),
      writerId: "device-a"
    }), /conflicto|otro contenido/u);
    assert.equal((await outbox.loadEntries(projectId)).length, 1);
  } finally {
    outbox.close();
  }
});

test("el outbox exige generaciones consecutivas después de su snapshot inicial", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-gap-" + randomUUID();

  try {
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 4, 400),
      writerId: "device-a",
      expectedGeneration: 3
    });
    await assert.rejects(outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 6, 600),
      writerId: "device-a",
      expectedGeneration: 5
    }), /generaciones consecutivas/u);
    const fifth = await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 5, 500),
      writerId: "device-a",
      expectedGeneration: 4
    });
    assert.equal(fifth.status, "queued");
    assert.deepEqual((await outbox.loadEntries(projectId)).map(entry => entry.generation), [4, 5]);
  } finally {
    outbox.close();
  }
});

test("solo reclama la siguiente generación y recupera un lease vencido", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-lease-" + randomUUID();
  const firstIndex = makeIndex(projectId, 1, 100);
  const secondIndex = makeIndex(projectId, 2, 200);

  try {
    await outbox.enqueueContinuityIndex({ index: firstIndex, writerId: "device-a" });
    await outbox.enqueueContinuityIndex({
      index: secondIndex, writerId: "device-a", expectedGeneration: 1
    });

    const firstClaim = await outbox.claimPending({
      projectId, workerId: "worker-a", now: 1_000, leaseMs: 1_000
    });
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].generation, 1);
    assert.equal(firstClaim[0].attempts, 1);

    const blockedByLease = await outbox.claimPending({
      projectId, workerId: "worker-b", now: 1_500
    });
    assert.deepEqual(blockedByLease, []);

    const expiredClaim = await outbox.claimPending({
      projectId, workerId: "worker-b", now: 2_000, leaseMs: 1_000
    });
    assert.equal(expiredClaim.length, 1);
    assert.equal(expiredClaim[0].generation, 1);
    assert.equal(expiredClaim[0].operationId, firstClaim[0].operationId);
    assert.equal(expiredClaim[0].attempts, 2);

    await assert.rejects(outbox.markDelivered(
      projectId, 1, "worker-a", expiredClaim[0].envelope.digest, 2_100
    ), /lease/u);
    await outbox.markDelivered(
      projectId, 1, "worker-b", expiredClaim[0].envelope.digest, 2_100
    );
    const nextClaim = await outbox.claimPending({
      projectId, workerId: "worker-b", now: 2_200
    });
    assert.equal(nextClaim.length, 1);
    assert.equal(nextClaim[0].generation, 2);
  } finally {
    outbox.close();
  }
});

test("marca la entrega de forma idempotente y valida el propietario del lease", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-ack-" + randomUUID();

  try {
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100),
      writerId: "device-a"
    });
    const [claim] = await outbox.claimPending({
      projectId, workerId: "worker-a", now: 200
    });
    await assert.rejects(outbox.markDelivered(
      projectId, 1, "worker-b", claim.envelope.digest, 300
    ), /lease/u);

    await outbox.markDelivered(projectId, 1, "worker-a", claim.envelope.digest, 300);
    await outbox.markDelivered(projectId, 1, "worker-a", claim.envelope.digest, 400);
    const [delivered] = await outbox.loadEntries(projectId, "delivered");
    assert.equal(delivered.deliveredAt, 300);
    assert.equal(delivered.attempts, 1);
  } finally {
    outbox.close();
  }
});

test("releaseForRetry aplica nextAttemptAt y no permite saltar una generación demorada", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-backoff-" + randomUUID();

  try {
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100),
      writerId: "device-a"
    });
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 2, 200),
      writerId: "device-a",
      expectedGeneration: 1
    });
    const [claim] = await outbox.claimPending({
      projectId, workerId: "worker-a", now: 1_000
    });
    await outbox.releaseForRetry(
      projectId, 1, "worker-a", claim.envelope.digest,
      { now: 1_000, retryAfterMs: 5_000, error: "sin conexión" }
    );

    assert.deepEqual(await outbox.claimPending({
      projectId, workerId: "worker-b", now: 5_999
    }), []);
    const retry = await outbox.claimPending({
      projectId, workerId: "worker-b", now: 6_000
    });
    assert.equal(retry.length, 1);
    assert.equal(retry[0].generation, 1);
    assert.equal(retry[0].attempts, 2);
  } finally {
    outbox.close();
  }
});

test("el trabajador entrega, reintenta y confirma sin perder la operación durable", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-delivery-" + randomUUID();
  let sendAttempts = 0;

  try {
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100),
      writerId: "device-a"
    });

    const failed = await deliverNarrativeSyncOutboxBatch(outbox, {
      projectId,
      workerId: "worker-a",
      now: 2_000,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
      send: async () => {
        sendAttempts++;
        throw new Error("remoto no disponible");
      }
    });
    assert.deepEqual(failed, {
      claimed: 1,
      delivered: 0,
      deferred: 1,
      failedGenerations: [1]
    });
    assert.equal(sendAttempts, 1);

    const tooEarly = await deliverNarrativeSyncOutboxBatch(outbox, {
      projectId, workerId: "worker-a", now: 2_099,
      send: async () => { sendAttempts++; }
    });
    assert.equal(tooEarly.claimed, 0);

    const delivered = await deliverNarrativeSyncOutboxBatch(outbox, {
      projectId, workerId: "worker-a", now: 2_100,
      send: async envelope => {
        sendAttempts++;
        assert.equal(envelope.kind, "idea-continuity-index-upsert");
      }
    });
    assert.equal(delivered.delivered, 1);
    assert.equal(sendAttempts, 2);
    assert.equal((await outbox.loadEntries(projectId, "delivered")).length, 1);
  } finally {
    outbox.close();
  }
});

test("el callback de HostEngineApi se puede conectar al outbox durable y reanunciar generaciones", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-callback-" + randomUUID();
  const callback = createNarrativeIdeaContinuityOutboxCallback(outbox, "device-a");
  const index = makeIndex(projectId, 1, 100);

  try {
    const notice = {
      projectId,
      index,
      sourceDocumentCount: 2,
      analyzedCandidateCount: 2,
      truncated: false,
      reused: false
    };
    await callback(notice);
    await callback({ ...notice, reused: true });
    const entries = await outbox.loadEntries(projectId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "pending");
    assert.equal(entries[0].generation, 1);
  } finally {
    outbox.close();
  }
});

test("la reapertura del outbox recupera operaciones pendientes para otro trabajador", async () => {
  const name = databaseName();
  const projectId = "outbox-reopen-" + randomUUID();
  const first = new IndexedDbNarrativeSyncOutbox({ databaseName: name });
  const index = makeIndex(projectId, 1, 100);

  await first.enqueueContinuityIndex({ index, writerId: "device-a" });
  const [abandonedLease] = await first.claimPending({
    projectId, workerId: "worker-before-crash", now: 200, leaseMs: 1_000
  });
  first.close();

  const reopened = new IndexedDbNarrativeSyncOutbox({ databaseName: name });
  try {
    const entries = await reopened.loadEntries(projectId, "leased");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].envelope.payload.index.fingerprint, index.fingerprint);
    assert.equal(entries[0].operationId, abandonedLease.operationId);
    assert.deepEqual(await reopened.claimPending({
      projectId, workerId: "worker-after-restart", now: 1_199
    }), []);
    const [claim] = await reopened.claimPending({
      projectId, workerId: "worker-after-restart", now: 1_200
    });
    assert.equal(claim.generation, 1);
    assert.equal(claim.operationId, abandonedLease.operationId);
    assert.equal(claim.attempts, 2);
  } finally {
    reopened.close();
  }
});


test("dos generaciones encoladas concurrentemente nunca producen una secuencia de salida invertida", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-race-" + randomUUID();
  const generationOne = makeIndex(projectId, 1, 100);
  const generationTwo = makeIndex(projectId, 2, 200);

  try {
    const outcomes = await Promise.allSettled([
      outbox.enqueueContinuityIndex({
        index: generationOne,
        writerId: "device-race"
      }),
      outbox.enqueueContinuityIndex({
        index: generationTwo,
        writerId: "device-race",
        expectedGeneration: 1
      })
    ]);
    assert.ok(outcomes.some(item => item.status === "fulfilled"));
    const entries = await outbox.loadEntries(projectId);
    assert.ok(entries.length === 1 || entries.length === 2);
    assert.deepEqual(
      entries.map(item => item.generation),
      entries.length === 1 ? [2] : [1, 2]
    );
    assert.deepEqual(
      entries.map(item => item.sequence),
      entries.map((_, index) => index + 1)
    );
  } finally {
    outbox.close();
  }
});


test("integra outbox, transporte y handler receptor con aplicación CAS e idempotencia", async () => {
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const projectId = "outbox-roundtrip-" + randomUUID();
  let remoteIndex;
  let remoteWrites = 0;
  const receiverStore = {
    async loadNarrativeIdeaContinuityIndex(requestedProjectId) {
      return requestedProjectId === projectId && remoteIndex
        ? structuredClone(remoteIndex)
        : undefined;
    },
    async saveNarrativeIdeaContinuityIndexIfUnchanged(index, expectedGeneration) {
      assert.equal(remoteIndex?.generation, expectedGeneration);
      remoteIndex = structuredClone(index);
      remoteWrites++;
    }
  };
  const handler = createNarrativeIdeaContinuityIndexUpsertHandler(receiverStore);

  try {
    const first = makeIndex(projectId, 1, 100);
    await outbox.enqueueContinuityIndex({
      index: first,
      writerId: "source-device"
    });
    const firstDelivery = await deliverNarrativeSyncOutboxBatch(outbox, {
      projectId,
      workerId: "outbox-worker",
      now: 1_000,
      send: async envelope => handler.apply(envelope)
    });
    assert.equal(firstDelivery.delivered, 1);
    assert.equal(remoteIndex.generation, 1);
    assert.equal(remoteWrites, 1);

    const deliveredFirst = await outbox.loadEntries(projectId, "delivered");
    assert.equal(deliveredFirst.length, 1);
    await handler.apply(deliveredFirst[0].envelope);
    assert.equal(remoteWrites, 1, "el receptor no vuelve a escribir un snapshot idéntico");

    const second = makeIndex(projectId, 2, 200, "destino oscuro del reino");
    await outbox.enqueueContinuityIndex({
      index: second,
      writerId: "source-device",
      expectedGeneration: 1
    });
    const secondDelivery = await deliverNarrativeSyncOutboxBatch(outbox, {
      projectId,
      workerId: "outbox-worker",
      now: 2_000,
      send: async envelope => handler.apply(envelope)
    });
    assert.equal(secondDelivery.delivered, 1);
    assert.equal(remoteIndex.generation, 2);
    assert.equal(remoteWrites, 2);
    assert.equal((await outbox.loadEntries(projectId, "delivered")).length, 2);
  } finally {
    outbox.close();
  }
});


test("dos instalaciones pueden enviar la misma generación al mismo diario sin colisionar operationId", async () => {
  const projectId = "outbox-multi-device-" + randomUUID();
  const sharedIndex = makeIndex(projectId, 1, 100);
  const outboxA = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const outboxB = new IndexedDbNarrativeSyncOutbox({ databaseName: databaseName() });
  const receiver = new IndexedDbNarrativeSyncJournal({
    databaseName: "receiver-multi-device-" + randomUUID()
  });

  try {
    const [queuedA, queuedB] = await Promise.all([
      outboxA.enqueueContinuityIndex({
        index: sharedIndex,
        writerId: "replica-device-a"
      }),
      outboxB.enqueueContinuityIndex({
        index: sharedIndex,
        writerId: "replica-device-b"
      })
    ]);
    assert.notEqual(queuedA.entry.operationId, queuedB.entry.operationId);
    assert.notEqual(queuedA.entry.envelope.digest, queuedB.entry.envelope.digest);
    assert.equal(queuedA.entry.sequence, 1);
    assert.equal(queuedB.entry.sequence, 1);

    const [acceptedA, acceptedB] = await Promise.all([
      receiver.accept(queuedA.entry.envelope),
      receiver.accept(queuedB.entry.envelope)
    ]);
    assert.equal(acceptedA.status, "accepted");
    assert.equal(acceptedB.status, "accepted");
    assert.equal((await receiver.loadOperations(projectId)).length, 2);
    assert.deepEqual(
      (await receiver.loadWriterCursors(projectId)).map(item => item.writerId),
      ["replica-device-a", "replica-device-b"]
    );
  } finally {
    outboxA.close();
    outboxB.close();
    receiver.close();
  }
});


test("auditProject detecta envolturas alteradas y reporta el digest inválido", async () => {
  const name = databaseName();
  const outbox = new IndexedDbNarrativeSyncOutbox({ databaseName: name });
  const projectId = "outbox-audit-corrupt-" + randomUUID();

  try {
    await outbox.enqueueContinuityIndex({
      index: makeIndex(projectId, 1, 100),
      writerId: "replica-audit"
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("outbox-operations", "readwrite");
      const store = transaction.objectStore("outbox-operations");
      const request = store.get([projectId, 1]);
      request.onsuccess = () => {
        const entry = request.result;
        entry.envelope = {
          ...entry.envelope,
          digest: "sha256:" + "0".repeat(64)
        };
        store.put(entry);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();

    const audit = await outbox.auditProject(projectId);
    assert.equal(audit.intact, false);
    assert.ok(audit.issues.includes("INVALID_ENVELOPE_DIGEST"));
  } finally {
    outbox.close();
  }
});
