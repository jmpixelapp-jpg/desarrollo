import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverNarrativeObservationCandidates,
  discoverNarrativeEventChainLinks
} from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = {
  ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
};

function observations(text, baseOffset = 0, entities = [ana]) {
  return discoverNarrativeObservationCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, baseOffset, entities
  });
}

function discover(text, baseOffset = 0, entities = [ana]) {
  return discoverNarrativeEventChainLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, baseOffset, observations: observations(text, baseOffset, entities)
  });
}

test("conecta acciones sucesivas a través de un salto de párrafo con marcador temporal", () => {
  const text = "Ana corrió.\n\nDespués Ana entró.";
  const links = discover(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].markerKind, "temporal");
  assert.equal(links[0].marker, "Después");
  assert.equal(links[0].paragraphBreakCount, 1);
  assert.deepEqual(links[0].sharedCharacterIds, [ana.id]);
  assert.equal(links[0].reviewStatus, "candidate");
  assert.equal(text.slice(
    links[0].markerEvidence.start, links[0].markerEvidence.end
  ), "Después");
  assert.equal(text.slice(
    links[0].bridgeEvidence.start, links[0].bridgeEvidence.end
  ), links[0].bridgeEvidence.excerpt);
});

test("clasifica un conector causal sin afirmar causalidad confirmada", () => {
  const text = "Ana corrió porque Ana entró.";
  const links = discover(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].markerKind, "causal");
  assert.equal(links[0].marker, "porque");
  assert.equal(links[0].reviewStatus, "candidate");
});

test("conserva conectores de contraste como relaciones distintas", () => {
  const text = "Ana corrió; sin embargo, Ana entró.";
  const links = discover(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].markerKind, "contrast");
  assert.equal(links[0].marker, "sin embargo");
});

test("no conecta acciones separadas solo por proximidad", () => {
  assert.deepEqual(discover("Ana corrió. Ana entró."), []);
});

test("no salta una acción intermedia para fabricar una cadena", () => {
  const text = "Ana corrió. Ana entró. Después Ana salió.";
  const links = discover(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].marker, "Después");
});

test("expone que dos acciones no comparten personaje cuando el marcador las conecta", () => {
  const text = "Ana corrió. Después Bruno entró.";
  const links = discover(text, 0, [ana, bruno]);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].sharedCharacterIds, []);
  assert.equal(links[0].markerKind, "temporal");
});

test("conserva offsets UTF-16 absolutos con prefijo y emoji", () => {
  const prefix = "😀 Inicio.\n";
  const text = "Ana corrió.\n\nDespués Ana entró.";
  const links = discover(text, prefix.length);
  assert.equal(links.length, 1);
  assert.equal(
    links[0].markerEvidence.start,
    prefix.length + text.indexOf("Después")
  );
  assert.equal(
    text.slice(
      links[0].markerEvidence.start - prefix.length,
      links[0].markerEvidence.end - prefix.length
    ),
    "Después"
  );
});

test("rechaza observaciones de otra revisión o evidencia manipulada", () => {
  const text = "Ana corrió. Después Ana entró.";
  const found = observations(text);
  assert.throws(() => discoverNarrativeEventChainLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [{ ...found[0], revision: 3 }, found[1]]
  }), /mismo documento y revisión/);
  assert.throws(() => discoverNarrativeEventChainLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [{
      ...found[0],
      actionEvidence: { ...found[0].actionEvidence, excerpt: "texto falso" }
    }, found[1]]
  }), /evidencia literal verificable/);
});

test("rechaza IDs de acción duplicados", () => {
  const text = "Ana corrió. Después Ana entró.";
  const found = observations(text);
  assert.throws(() => discoverNarrativeEventChainLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [found[0], found[0]]
  }), /identidad única/);
});


test("rechaza colecciones de observaciones que exceden el presupuesto de reconstrucción", () => {
  assert.throws(() => discoverNarrativeEventChainLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text: "", observations: Array.from({ length: 10_001 }, () => null)
  }), /Contexto inválido/);
});
