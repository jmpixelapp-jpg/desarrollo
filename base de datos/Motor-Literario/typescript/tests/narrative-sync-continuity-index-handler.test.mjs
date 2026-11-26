import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  createNarrativeIdeaContinuityIndex,
  createNarrativeIdeaContinuityIndexSyncEnvelope,
  createNarrativeIdeaContinuityIndexUpsertHandler,
  NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS
} from "../dist/motor-literario.js";

function makeIndex(projectId, generation, suffix = "same") {
  const candidates = [
    idea(projectId, "first", "chapter-1", "memoria antigua de la ciudad"),
    idea(projectId, "second", "chapter-2", suffix === "same"
      ? "memoria antigua de la ciudad"
      : "destino oscuro del reino")
  ];
  const analysis = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId,
    ideaCandidates: candidates,
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });
  const evolution = buildNarrativeIdeaEvolution({
    projectId,
    crossDocumentAnalysis: analysis
  });
  const result = buildNarrativeIdeaContinuityLines({ projectId, evolution });
  return createNarrativeIdeaContinuityIndex({
    projectId,
    generation,
    updatedAt: generation * 100,
    sourceRevisions: [
      { documentId: "chapter-1", revision: 1, status: "active" },
      { documentId: "chapter-2", revision: 1, status: "active" }
    ],
    result
  });
}

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

function createStore(initial) {
  let value = initial;
  let writes = 0;
  return {
    get value() { return value; },
    get writes() { return writes; },
    async loadNarrativeIdeaContinuityIndex(projectId) {
      return value?.projectId === projectId ? structuredClone(value) : undefined;
    },
    async saveNarrativeIdeaContinuityIndexIfUnchanged(next, expectedGeneration) {
      assert.equal(value?.generation, expectedGeneration, "la escritura debe respetar CAS");
      value = structuredClone(next);
      writes++;
    }
  };
}

test("idea-continuity-index-upsert replica un índice compacto con CAS", async () => {
  const projectId = "sync-continuity";
  const index = makeIndex(projectId, 1);
  const store = createStore(undefined);
  const handler = createNarrativeIdeaContinuityIndexUpsertHandler(store);
  const payload = { index, expectedGeneration: undefined };

  assert.equal(handler.kind, "idea-continuity-index-upsert");
  assert.equal(handler.validate(payload), true);
  await handler.apply({
    projectId, operationId: "continuity-1", writerId: "writer-a", sequence: 1,
    schemaVersion: 1, algorithm: "SHA-256", createdAt: 100,
    kind: handler.kind, payload, digest: "sha256:" + "0".repeat(64)
  });
  assert.equal(store.value.generation, 1);
  assert.equal(store.writes, 1);

  await handler.apply({
    projectId, operationId: "continuity-1-replay", writerId: "writer-a", sequence: 2,
    schemaVersion: 1, algorithm: "SHA-256", createdAt: 200,
    kind: handler.kind, payload, digest: "sha256:" + "0".repeat(64)
  });
  assert.equal(store.writes, 1, "el replay equivalente no debe volver a escribir");
});

test("un índice divergente exige la generación base exacta y no pisa el estado local", async () => {
  const projectId = "sync-continuity-conflict";
  const current = makeIndex(projectId, 2, "same");
  const incoming = makeIndex(projectId, 2, "different");
  const store = createStore(current);
  const handler = createNarrativeIdeaContinuityIndexUpsertHandler(store);
  const payload = { index: incoming, expectedGeneration: 1 };

  assert.equal(handler.validate(payload), true);
  await assert.rejects(handler.apply({
    projectId, operationId: "continuity-conflict", writerId: "writer-b", sequence: 1,
    schemaVersion: 1, algorithm: "SHA-256", createdAt: 300,
    kind: handler.kind, payload, digest: "sha256:" + "0".repeat(64)
  }), /CAS|reconciliación/u);
  assert.deepEqual(store.value, current);
  assert.equal(store.writes, 0);
});

test("validador rechaza generación no consecutiva, índices corruptos y cruce de proyecto", async () => {
  const projectId = "sync-continuity-invalid";
  const index = makeIndex(projectId, 1);
  const handler = createNarrativeIdeaContinuityIndexUpsertHandler(createStore(undefined));

  assert.equal(handler.validate({ index, expectedGeneration: 1 }), false);
  assert.equal(handler.validate({
    index: { ...index, fingerprint: "fnv1a64:" + "0".repeat(16) }
  }), false);
  await assert.rejects(handler.apply({
    projectId: "wrong-project", operationId: "continuity-wrong-project",
    writerId: "writer-c", sequence: 1, schemaVersion: 1, algorithm: "SHA-256",
    createdAt: 400, kind: handler.kind,
    payload: { index, expectedGeneration: undefined },
    digest: "sha256:" + "0".repeat(64)
  }), /otro proyecto/u);
});


test("el helper crea una envoltura SHA-256 con el kind y límites de la proyección", async () => {
  const projectId = "sync-continuity-envelope";
  const index = makeIndex(projectId, 1);
  const envelope = await createNarrativeIdeaContinuityIndexSyncEnvelope({
    operationId: "continuity-envelope-1",
    projectId,
    writerId: "writer-envelope",
    sequence: 1,
    payload: { index }
  });

  assert.equal(envelope.kind, "idea-continuity-index-upsert");
  assert.equal(envelope.digest.startsWith("sha256:"), true);
  assert.ok(NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS.maxBytes > 1_048_576);
  assert.equal(envelope.payload.index.projectId, projectId);
});


test("avanza el CAS cuando una generación nueva conserva contenido idéntico y deduplica solo su replay", async () => {
  const projectId = "sync-continuity-same-content";
  const current = makeIndex(projectId, 1, "same");
  const next = makeIndex(projectId, 2, "same");
  assert.equal(current.fingerprint, next.fingerprint);

  const store = createStore(current);
  const handler = createNarrativeIdeaContinuityIndexUpsertHandler(store);
  const payload = { index: next, expectedGeneration: 1 };
  assert.equal(handler.validate(payload), true);

  const envelope = await createNarrativeIdeaContinuityIndexSyncEnvelope({
    operationId: "continuity-same-content-2",
    projectId,
    writerId: "replica-a",
    sequence: 2,
    payload
  });
  await handler.apply(envelope);
  assert.equal(store.value.generation, 2);
  assert.equal(store.writes, 1);

  await handler.apply(envelope);
  assert.equal(store.value.generation, 2);
  assert.equal(store.writes, 1, "solo el replay de la misma generación es idempotente");
});
