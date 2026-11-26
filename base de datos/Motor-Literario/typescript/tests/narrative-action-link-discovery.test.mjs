import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeObservationCandidates, discoverNarrativeActionLinks } from "../dist/motor-literario.js";

const character = {
  projectId: "book-1", id: "entity:character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};

function observations(text, baseOffset = 0) {
  return discoverNarrativeObservationCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, baseOffset, entities: [character]
  });
}

test("vincula acciones solo cuando hay marcador temporal explícito entre ellas", () => {
  const text = "Ana entró en la casa. Después Ana corrió hacia la puerta.";
  const found = discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: observations(text)
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].markerKind, "temporal");
  assert.equal(found[0].marker.toLocaleLowerCase("es"), "después");
  assert.equal(text.slice(found[0].evidence.start, found[0].evidence.end), "Después");
  assert.equal(found[0].reviewStatus, "candidate");
});

test("registra un marcador causal sin decidir qué acción es causa o consecuencia", () => {
  const text = "Ana huyó porque Bruno atacó.";
  const found = discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: observations(text)
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].markerKind, "causal");
  assert.equal(found[0].marker, "porque");
  assert.equal("causeActionId" in found[0], false);
  assert.equal("effectActionId" in found[0], false);
});

test("no agrupa acciones cercanas si no existe un conector explícito", () => {
  const text = "Ana entró en la casa. Ana corrió hacia la puerta.";
  const found = discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: observations(text)
  });
  assert.deepEqual(found, []);
});

test("conserva offsets absolutos UTF-16 con prefijo y emoji", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "Ana entró. Luego Ana corrió.";
  const found = discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, baseOffset: prefix.length, observations: observations(text, prefix.length)
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.start, prefix.length + text.indexOf("Luego"));
  assert.equal(text.slice(
    found[0].evidence.start - prefix.length,
    found[0].evidence.end - prefix.length
  ), "Luego");
});

test("rechaza observaciones de otra revisión o evidencia que no coincide con el texto", () => {
  const text = "Ana entró. Luego Ana corrió.";
  const found = observations(text);
  assert.throws(() => discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 5,
    text, observations: found
  }));
  assert.throws(() => discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [{ ...found[0], actionEvidence: { ...found[0].actionEvidence, excerpt: "inventado" } }]
  }));
});

test("rechaza observaciones malformadas o IDs duplicados sin lanzar errores internos", () => {
  const text = "Ana entró. Luego Ana corrió.";
  const found = observations(text);
  assert.throws(() => discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [{ ...found[0], actionEvidence: undefined }]
  }), /offsets verificables/);
  assert.throws(() => discoverNarrativeActionLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, observations: [found[0], found[0]]
  }), /únicos/);
});


test("reconoce conectores temporales narrativos compuestos", () => {
  for (const [text, marker] of [
    ["Ana entró en la casa. Acto seguido, Ana corrió hacia la puerta.", "Acto seguido"],
    ["Ana entró. Al mismo tiempo, Ana buscó ayuda.", "Al mismo tiempo"],
    ["Ana entró. Poco después, Ana llegó a casa.", "Poco después"],
    ["Ana abrió la carta. De inmediato, Ana corrió.", "De inmediato"]
  ]) {
    const found = discoverNarrativeActionLinks({
      projectId: "book-1", documentId: "chapter-1", revision: 4,
      text, observations: observations(text)
    });
    assert.equal(found.length, 1, text);
    assert.equal(found[0].marker.toLocaleLowerCase("es"), marker.toLocaleLowerCase("es"));
    assert.equal(found[0].markerKind, "temporal");
    assert.equal(text.slice(found[0].evidence.start, found[0].evidence.end), found[0].marker);
  }
});

test("reconoce conectores causales sin asignar automáticamente causa y efecto", () => {
  for (const [text, marker] of [
    ["Ana entró. Por culpa de la tormenta, Ana perdió el tren.", "Por culpa de"],
    ["Ana llegó a tiempo. Gracias a Ana, Ana corrió.", "Gracias a"],
    ["Ana recibió la noticia. A raíz de ello, Ana corrió.", "A raíz de"],
    ["Ana entró. Como resultado, Ana corrió.", "Como resultado"]
  ]) {
    const found = discoverNarrativeActionLinks({
      projectId: "book-1", documentId: "chapter-1", revision: 4,
      text, observations: observations(text)
    });
    assert.equal(found.length, 1, text);
    assert.equal(found[0].marker.toLocaleLowerCase("es"), marker.toLocaleLowerCase("es"));
    assert.equal(found[0].markerKind, "causal");
    assert.equal("causeActionId" in found[0], false);
    assert.equal("effectActionId" in found[0], false);
  }
});

test("reconoce conectores adversativos y concesivos compuestos", () => {
  for (const [text, marker] of [
    ["Ana entró. A pesar de ello, Ana corrió.", "A pesar de ello"],
    ["Ana llegó. Aun así, Ana caminó.", "Aun así"],
    ["Ana entró. Pese a ello, Ana respondió.", "Pese a ello"]
  ]) {
    const found = discoverNarrativeActionLinks({
      projectId: "book-1", documentId: "chapter-1", revision: 4,
      text, observations: observations(text)
    });
    assert.equal(found.length, 1, text);
    assert.equal(found[0].marker.toLocaleLowerCase("es"), marker.toLocaleLowerCase("es"));
    assert.equal(found[0].markerKind, "contrast");
  }
});
