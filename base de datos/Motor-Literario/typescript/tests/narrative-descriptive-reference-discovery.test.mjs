import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeDescriptiveReferences } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = {
  ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
};
const sword = {
  ...ana, id: "object:sword", kind: "object",
  canonicalName: "Espada", normalizedName: "espada"
};
function label(text, excerpt = text, status) {
  return {
    text,
    evidence: {
      documentId: "chapter-profile", revision: 1, start: 10,
      end: 10 + excerpt.length, excerpt, ...(status ? { status } : {})
    }
  };
}
function discover(text, profiles, entities = [ana, bruno], overrides = {}) {
  return discoverNarrativeDescriptiveReferences({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text, entities, profiles, ...overrides
  });
}

test("vincula una descripción literal registrada a un solo personaje", () => {
  const [match] = discover("El anciano abrió la puerta.", [
    { entityId: ana.id, labels: [label("el anciano")] }
  ]);
  assert.equal(match.status, "single-candidate");
  assert.equal(match.candidates[0].entityId, ana.id);
  assert.equal(match.mentionEvidence.excerpt, "El anciano");
  assert.equal(match.reviewStatus, "candidate");
});

test("conserva ambigüedad cuando dos personajes comparten una descripción", () => {
  const [match] = discover("La viajera llegó.", [
    { entityId: ana.id, labels: [label("la viajera")] },
    { entityId: bruno.id, labels: [label("la viajera")] }
  ]);
  assert.equal(match.status, "ambiguous");
  assert.deepEqual(match.candidates.map(x => x.entityId), [ana.id, bruno.id]);
});

test("no infiere descripciones que no estén registradas", () => {
  assert.deepEqual(discover("El anciano abrió la puerta.", []), []);
});

test("no confunde subcadenas dentro de palabras", () => {
  assert.deepEqual(discover("El ancianismo no llegó.", [
    { entityId: ana.id, labels: [label("anciano")] }
  ]), []);
});

test("acepta acentos y límites Unicode con offsets absolutos UTF-16", () => {
  const prefix = "😀 ";
  const text = "La mujer salió.";
  const [match] = discover(text, [
    { entityId: ana.id, labels: [label("la mujer")] }
  ], [ana], { baseOffset: prefix.length });
  assert.equal(match.mentionEvidence.start, prefix.length);
  assert.equal(match.mentionEvidence.end, prefix.length + "La mujer".length);
});

test("ignora perfiles sustentados únicamente por evidencia obsoleta", () => {
  assert.deepEqual(discover("El guardián volvió.", [
    { entityId: ana.id, labels: [label("el guardián", "guardián", "stale")] }
  ], [ana]), []);
});

test("no permite que una entidad no-personaje reciba una descripción personal", () => {
  assert.throws(() => discover("La viajera llegó.", [
    { entityId: sword.id, labels: [label("la viajera")] }
  ], [sword]), /personaje único/);
});

test("rechaza perfiles de otro proyecto, duplicados y evidencia inválida", () => {
  assert.throws(() => discover("El anciano.", [
    { entityId: "missing", labels: [label("el anciano")] }
  ]), /personaje único/);
  assert.throws(() => discover("El anciano.", [
    { entityId: ana.id, labels: [label("el anciano"), label(" EL   ANCIANO ")] }
  ]), /repetir descripciones/);
  assert.throws(() => discover("El anciano.", [
    { entityId: ana.id, labels: [{ text: "el anciano", evidence: {} }] }
  ]), /evidencia de procedencia/);
});

test("respeta el límite de resultados y la procedencia de cada etiqueta", () => {
  const matches = discover("El anciano vio al anciano.", [
    { entityId: ana.id, labels: [label("el anciano")] }
  ], [ana], { maxMatches: 1 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].candidates[0].labelEvidence.documentId, "chapter-profile");
});

test("detiene el análisis cuando las etiquetas exceden el presupuesto agregado de exploración", () => {
  const longText = "x".repeat(2_000_000);
  const profiles = Array.from({ length: 13 }, (_, index) => ({
    entityId: ana.id + ":" + index,
    labels: [label("descriptor-" + index)]
  }));
  const entities = profiles.map((profile, index) => ({
    ...ana, id: profile.entityId, canonicalName: "Personaje " + index,
    normalizedName: "personaje " + index
  }));
  assert.throws(() => discover(longText, profiles, entities),
    /presupuesto operativo de exploración/);
});

test("extrae una aposición descriptiva sin confirmar ni guardar automáticamente la etiqueta", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  const text = "Ana, la heredera del reino, abrió la puerta.";
  const [candidate] = discoverNarrativeDescriptiveLabelCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4, text, entities: [ana]
  });
  assert.equal(candidate.proposedLabel, "la heredera del reino");
  assert.equal(candidate.anchorEntityId, ana.id);
  assert.equal(candidate.relation, "appositive-description");
  assert.equal(candidate.reviewStatus, "candidate");
  assert.equal(candidate.labelEvidence.excerpt, "la heredera del reino");
  assert.equal(candidate.anchorEvidence.excerpt, "Ana");
});

test("conserva offsets UTF-16 absolutos al proponer una descripción", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  const prefix = "😀 ";
  const text = "Ana, la mujer con cicatriz llegó.";
  const [candidate] = discoverNarrativeDescriptiveLabelCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4, text, entities: [ana], baseOffset: prefix.length
  });
  assert.equal(candidate.labelEvidence.start, prefix.length + text.indexOf("la mujer"));
  assert.equal(candidate.anchorEvidence.start, prefix.length);
});

test("no propone aposiciones sin una entidad explícita inmediatamente anterior", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  const candidates = discoverNarrativeDescriptiveLabelCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "La heredera del reino abrió la puerta.", entities: [ana]
  });
  assert.deepEqual(candidates, []);
});

 
test("rechaza IDs de entidad duplicados y alias malformados en la extracción", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  const input = {
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "Ana, la heredera llegó.", entities: [ana, { ...ana, canonicalName: "Anita" }]
  };
  assert.throws(() => discoverNarrativeDescriptiveLabelCandidates(input), /únicas, válidas/);
  assert.throws(() => discoverNarrativeDescriptiveLabelCandidates({
    ...input, entities: [{ ...ana, aliases: ["", "Anita"] }]
  }), /alias deben ser textos válidos/);
  assert.throws(() => discoverNarrativeDescriptiveLabelCandidates({
    ...input, entities: [{ ...ana, aliases: ["Anita", " anita "] }]
  }), /alias deben ser textos válidos/);
});

test("no devuelve silenciosamente una lista parcial al superar el máximo de propuestas", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  assert.throws(() => discoverNarrativeDescriptiveLabelCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "Ana, la heredera llegó. Ana, la viajera volvió.",
    entities: [ana], maxCandidates: 1
  }), /no se devuelve un resultado parcial/);
});

test("ordena propuestas por posición textual aunque las entidades estén desordenadas", async () => {
  const { discoverNarrativeDescriptiveLabelCandidates } = await import("../dist/motor-literario.js");
  const text = "Bruno, el guardián llegó. Ana, la heredera volvió.";
  const results = discoverNarrativeDescriptiveLabelCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text, entities: [ana, bruno]
  });
  assert.deepEqual(results.map(x => x.proposedLabel), ["el guardián", "la heredera"]);
});


test("extrae una cláusula relativa explícita como candidata sin convertirla en hecho", async () => {
  const { discoverNarrativeRelativeClauseCandidates } = await import("../dist/motor-literario.js");
  const text = "Ana, que conocía la ciudad, abrió la puerta.";
  const [candidate] = discoverNarrativeRelativeClauseCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4, text, entities: [ana]
  });
  assert.equal(candidate.clauseText, "que conocía la ciudad");
  assert.equal(candidate.anchorEntityId, ana.id);
  assert.equal(candidate.relation, "relative-clause");
  assert.equal(candidate.reviewStatus, "candidate");
  assert.equal(candidate.clauseEvidence.excerpt, "que conocía la ciudad");
  assert.equal(candidate.anchorEvidence.excerpt, "Ana");
});

test("conserva offsets UTF-16 y no confunde un que sin verbo finito", async () => {
  const { discoverNarrativeRelativeClauseCandidates } = await import("../dist/motor-literario.js");
  const prefix = "😀 ";
  const text = "Ana, que llegó desde el norte, sonrió.";
  const [candidate] = discoverNarrativeRelativeClauseCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text, entities: [ana], baseOffset: prefix.length
  });
  assert.equal(candidate.clauseEvidence.start, prefix.length + text.indexOf("que llegó"));
  assert.deepEqual(discoverNarrativeRelativeClauseCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "Ana, que llevaba una espada, volvió.", entities: [ana], maxClauseLength: 20
  }), []);
});

test("no cruza límites de oración ni acepta cláusulas relativas sin coma de cierre", async () => {
  const { discoverNarrativeRelativeClauseCandidates } = await import("../dist/motor-literario.js");
  assert.deepEqual(discoverNarrativeRelativeClauseCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "Ana, que conocía la ciudad. Después salió.", entities: [ana]
  }), []);
});

test("rechaza un conjunto de cláusulas que excede el máximo en vez de truncarlo", async () => {
  const { discoverNarrativeRelativeClauseCandidates } = await import("../dist/motor-literario.js");
  assert.throws(() => discoverNarrativeRelativeClauseCandidates({
    projectId: "book-1", documentId: "chapter-2", revision: 4,
    text: "Ana, que conocía la ciudad, salió. Ana, que vivía allí, volvió.",
    entities: [ana], maxCandidates: 1
  }), /no se devuelve un resultado parcial/);
});
