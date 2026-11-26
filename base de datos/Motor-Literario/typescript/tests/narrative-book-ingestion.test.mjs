import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestNarrativeBookText,
  MAX_NARRATIVE_BOOK_TEXT_UNITS,
  readNarrativeBookFile
} from "../dist/motor-literario.js";

test("ingesta capítulos, párrafos y señales con offsets UTF-16 absolutos", () => {
  const text = "Prólogo\n\nAna llegó al castillo en 1842.\n\n—No entraré —dijo Ana.\n\nCapítulo I\n\nDespués, huyó porque oyó un ruido.";
  const result = ingestNarrativeBookText({
    projectId: "book-1", documentId: "doc-1", revision: 7, baseOffset: 120,
    title: "La prueba", language: "es", text
  });
  assert.equal(result.coverage.chapterCount, 2);
  assert.equal(result.chapters[0].heading, "Prólogo");
  assert.equal(result.chapters[1].heading, "Capítulo I");
  assert.ok(result.paragraphs.length >= 3);
  const arrival = result.signals.find(signal => signal.label === "arrival");
  assert.ok(arrival);
  assert.ok(arrival.evidence.start <= 120 + text.indexOf("llegó"));
  assert.ok(arrival.evidence.end > 120 + text.indexOf("llegó"));
  assert.equal(arrival.evidence.excerpt.includes("llegó"), true);
  assert.equal(result.signals.some(signal => signal.kind === "causal-marker" && signal.surface === "porque"), true);
  assert.equal(result.signals.some(signal => signal.kind === "temporal-reference" && signal.surface.toLowerCase() === "después"), true);
});

test("mantiene las señales como candidatas y no inventa agentes ni causalidad", () => {
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "d", revision: 1,
    text: "María atacó. Pedro cayó porque la puerta se cerró."
  });
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.every(signal => signal.requiresReview === true));
  assert.ok(result.signals.every(signal => !("agentEntityId" in signal)));
  assert.ok(result.signals.every(signal => !("causeEventId" in signal)));
});

test("rechaza entradas inválidas y textos que exceden el presupuesto", () => {
  assert.throws(() => ingestNarrativeBookText({
    projectId: "p", documentId: "d", revision: -1, text: "texto"
  }));
  assert.throws(() => ingestNarrativeBookText({
    projectId: "p", documentId: "d", revision: 1,
    text: "x".repeat(MAX_NARRATIVE_BOOK_TEXT_UNITS + 1)
  }));
});

test("los IDs y resultados son deterministas para una misma revisión y fuente", () => {
  const input = { projectId: "p", documentId: "d", revision: 3, text: "Alicia llegó. Después salió." };
  const first = ingestNarrativeBookText(input);
  const second = ingestNarrativeBookText(input);
  assert.deepEqual(first, second);
});

test("lee archivos TXT y Markdown UTF-8 mediante APIs estándar", async () => {
  const text = "# Capítulo I\n\nLa niña llegó al puerto. 🌊";
  const bytes = new TextEncoder().encode(text);
  const source = await readNarrativeBookFile({
    name: "novela.md", type: "text/markdown", size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer
  });
  assert.equal(source.mediaType, "text/markdown");
  assert.equal(source.text, text);
  assert.equal(source.byteLength, bytes.byteLength);
  const parsed = ingestNarrativeBookText({
    projectId: "p", documentId: "file-1", revision: 1, text: source.text
  });
  assert.equal(parsed.coverage.wordCount, 7);
  assert.equal(parsed.chapters[0].heading, "Capítulo I");
  assert.ok(parsed.signals.some(signal => signal.label === "arrival"));
});

test("rechaza extensiones no admitidas, MIME incompatibles y UTF-8 inválido", async () => {
  const validBytes = new TextEncoder().encode("texto");
  await assert.rejects(() => readNarrativeBookFile({
    name: "novela.pdf", arrayBuffer: async () => validBytes.buffer
  }));
  await assert.rejects(() => readNarrativeBookFile({
    name: "novela.txt", type: "application/pdf",
    arrayBuffer: async () => validBytes.buffer
  }));
  const invalid = new Uint8Array([0xff, 0xfe]);
  await assert.rejects(() => readNarrativeBookFile({
    name: "novela.txt", arrayBuffer: async () => invalid.buffer
  }));
});


test("descubre personajes etiquetados en el texto y extrae sus acciones sin fichas previas", () => {
  const text = "Personaje Ana cruzó el puente.";
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "self-discovery", revision: 3,
    text, baseOffset: 50
  });
  assert.equal(result.observationStatus, "extracted");
  assert.equal(result.entityCandidates.length, 1);
  assert.equal(result.entityCandidates[0].kind, "character");
  assert.equal(result.entityCandidates[0].canonicalName, "Ana");
  assert.equal(result.entityCandidates[0].evidence[0].start, 60);
  assert.equal(result.entityCandidates[0].evidence[0].end, 63);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].action, "cruzar");
  assert.equal(result.observations[0].singleMentionedCharacterId, result.entityCandidates[0].id);
  assert.equal(result.observations[0].actionEvidence.start, 64);
  assert.equal(result.observations[0].reviewStatus, "candidate");
});

test("no infiere entidades de nombres propios sin etiqueta explícita", () => {
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "no-name-guess", revision: 1,
    text: "Ana cruzó el puente."
  });
  assert.deepEqual(result.entityCandidates, []);
  assert.equal(result.observationStatus, "no-entities");
  assert.deepEqual(result.observations, []);
});

test("enriquece la ingesta con acciones vinculadas a personajes ya identificados", () => {
  const character = {
    projectId: "p", id: "character:ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const text = "Ana cruzó el puente.";
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "chapter-1", revision: 4,
    text, baseOffset: 80, entities: [character]
  });
  assert.equal(result.observationStatus, "extracted");
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].action, "cruzar");
  assert.equal(result.observations[0].singleMentionedCharacterId, character.id);
  assert.equal(result.observations[0].actionEvidence.start, 84);
  assert.equal(result.observations[0].actionEvidence.excerpt, "cruzó");
});

test("la ingesta no mezcla entidades de otro libro ni oculta el límite del análisis de observaciones", () => {
  const foreign = {
    projectId: "other", id: "character:ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  assert.throws(() => ingestNarrativeBookText({
    projectId: "p", documentId: "d", revision: 1, text: "Ana corrió.",
    entities: [foreign]
  }));
});

test("limita la negación al contexto de la acción y no a la oración anterior", () => {
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "negation-scope", revision: 1,
    text: "Ana no cruzó el puente. Pedro llegó al pueblo. María nunca salió."
  });
  const actionSignals = result.signals.filter(signal => signal.kind === "action");
  const crossed = actionSignals.find(signal => signal.surface === "cruzó");
  const arrived = actionSignals.find(signal => signal.surface === "llegó");
  const departed = actionSignals.find(signal => signal.surface === "salió");
  assert.equal(crossed?.polarity, "negated");
  assert.equal(arrived?.polarity, "affirmed");
  assert.equal(departed?.polarity, "negated");
});

test("la ingesta enlaza acciones solo mediante marcadores textuales explícitos", () => {
  const character = {
    projectId: "p", id: "character:ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const text = "Ana entró en la casa. Después Ana corrió hacia la puerta.";
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "chapter-links", revision: 2,
    text, entities: [character]
  });
  assert.equal(result.observations.length, 2);
  assert.equal(result.actionLinks.length, 1);
  assert.equal(result.actionLinks[0].markerKind, "temporal");
  assert.equal(result.actionLinks[0].marker, "Después");
  assert.equal(text.slice(
    result.actionLinks[0].evidence.start,
    result.actionLinks[0].evidence.end
  ), "Después");
});

test("reconoce acciones de movimiento y llegada en varios tiempos sin aceptar prefijos", () => {
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "verb-tenses", revision: 1,
    text: "Ana camina hacia el puerto. Mañana llegará. El caminante observó la llegada."
  });
  const actions = result.signals.filter(signal => signal.kind === "action");
  assert.deepEqual(actions.map(signal => signal.surface), ["camina", "llegará"]);
  assert.ok(actions.every(signal => signal.label === "movement" || signal.label === "arrival"));
});
