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
  deliverNarrativeSyncOutboxBatch,
  IndexedDbNarrativeSyncOutbox
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
  first.close();

  const reopened = new IndexedDbNarrativeSyncOutbox({ databaseName: name });
  try {
    const entries = await reopened.loadEntries(projectId, "pending");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].envelope.payload.index.fingerprint, index.fingerprint);
    const [claim] = await reopened.claimPending({
      projectId, workerId: "worker-after-restart", now: 200
    });
    assert.equal(claim.generation, 1);
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
