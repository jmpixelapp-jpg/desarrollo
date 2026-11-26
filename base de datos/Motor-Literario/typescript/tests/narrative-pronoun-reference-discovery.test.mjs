import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativePronounReferences } from "../dist/motor-literario.js";

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
  canonicalName: "Espada Solar", normalizedName: "espada solar"
};

function discover(text, overrides = {}) {
  return discoverNarrativePronounReferences({
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    text, entities: [ana, bruno, sword], ...overrides
  });
}

test("recupera antecedente nombrado aunque esté varios párrafos antes", () => {
  const text = "Ana llegó al refugio.\n\nLa lluvia comenzó.\n\nElla cerró la puerta.";
  const [reference] = discover(text);
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.pronoun, "Ella");
  assert.deepEqual(reference.antecedentCandidates.map(x => x.entityId), [ana.id]);
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.excerpt, "Ana");
  assert.equal(text.slice(
    reference.pronounEvidence.start, reference.pronounEvidence.end
  ), "Ella");
});

test("conserva varios antecedentes posibles y los ordena por recencia", () => {
  const text = "Ana llegó. Bruno esperó. Ella abrió la puerta.";
  const [reference] = discover(text);
  assert.equal(reference.status, "ambiguous");
  assert.deepEqual(
    reference.antecedentCandidates.map(x => x.entityId),
    [bruno.id, ana.id]
  );
  assert.equal(reference.antecedentCandidates[0].distance <
    reference.antecedentCandidates[1].distance, true);
});

test("no elige automáticamente al candidato más cercano", () => {
  const text = "Ana habló con Bruno. Él respondió.";
  const [reference] = discover(text);
  assert.equal(reference.status, "ambiguous");
  assert.equal(reference.antecedentCandidates.length, 2);
  assert.equal(reference.reviewStatus, "candidate");
});

test("devuelve estado sin antecedente si no hay entidad nombrada en la ventana", () => {
  const [reference] = discover("El viento cambió. Ella corrió.", {
    entities: [ana], maxAntecedentDistance: 8
  });
  assert.equal(reference.status, "no-antecedent");
  assert.deepEqual(reference.antecedentCandidates, []);
});

test("no recupera nombres posteriores al pronombre", () => {
  const [reference] = discover("Ella corrió. Ana llegó después.");
  assert.equal(reference.status, "no-antecedent");
});

test("conserva offsets UTF-16 absolutos con prefijo emoji", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "Ana llegó. Ella corrió.";
  const [reference] = discover(text, { baseOffset: prefix.length, entities: [ana] });
  assert.equal(reference.pronounEvidence.start,
    prefix.length + text.indexOf("Ella"));
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.start,
    prefix.length + text.indexOf("Ana"));
});

test("acepta alias explícitos como menciones de antecedente", () => {
  const aliased = { ...ana, aliases: ["la viajera"] };
  const [reference] = discover("La viajera llegó. Ella salió.", {
    entities: [aliased]
  });
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.excerpt, "La viajera");
});

test("no exige concordancia gramatical para conservar un antecedente nominal explícito", () => {
  const text = "Espada Solar brilló. Ella cayó.";
  const [reference] = discover(text, { entities: [sword] });
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.antecedentCandidates[0].entityId, sword.id);
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.excerpt, "Espada Solar");
});

test("rechaza entidades duplicadas o de otro proyecto", () => {
  assert.throws(() => discover("Ella corrió.", {
    entities: [ana, ana]
  }), /únicas, válidas/);
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, projectId: "other" }]
  }), /mismo proyecto/);
});


test("rechaza textos y colecciones de entidades fuera de los límites operativos", () => {
  assert.throws(() => discover("Ella corrió.", {
    text: "x".repeat(2_000_001)
  }), /Contexto inválido/);
  assert.throws(() => discover("Ella corrió.", {
    entities: Array.from({ length: 10_001 }, (_, index) => ({
      ...ana, id: "character:" + index
    }))
  }), /Contexto inválido/);
});

test("rechaza alias no textuales, vacíos o excesivamente largos", () => {
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, aliases: [""] }]
  }), /únicas, válidas/);
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, aliases: [null] }]
  }), /únicas, válidas/);
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, aliases: ["A".repeat(257)] }]
  }), /únicas, válidas/);
});

test("rechaza nombres canónicos excesivamente largos y tipos vacíos", () => {
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, canonicalName: "A".repeat(257) }]
  }), /únicas, válidas/);
  assert.throws(() => discover("Ella corrió.", {
    entities: [{ ...ana, kind: " " }]
  }), /únicas, válidas/);
});


test("recorre segmentos de forma incremental y conserva evidencia en documentos densos", () => {
  const chunks = ["Ana llegó. Ella corrió."];
  for (let index = 0; index < 2_500; index++) {
    chunks.push("La tormenta avanzó. Ella esperó.");
  }
  const text = chunks.join("\n");
  const references = discover(text, { entities: [ana] });
  assert.equal(references.length, 2_000);
  for (const reference of references) {
    assert.equal(text.slice(
      reference.pronounEvidence.start, reference.pronounEvidence.end
    ), reference.pronoun);
    for (const candidate of reference.antecedentCandidates) {
      assert.equal(text.slice(
        candidate.antecedentEvidence.start, candidate.antecedentEvidence.end
      ), candidate.antecedentEvidence.excerpt);
    }
  }
});

test("separa oraciones por saltos de línea sin consumir letras del texto", () => {
  const [reference] = discover("Ana llegó\nElla salió.", { entities: [ana] });
  assert.equal(reference.pronoun, "Ella");
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.excerpt, "Ana");
});

test("escapa signos especiales en nombres y alias", () => {
  const named = { ...ana, canonicalName: "Ana (la viajera)" };
  const [reference] = discover("Ana (la viajera) llegó. Ella partió.", {
    entities: [named]
  });
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.antecedentCandidates[0].antecedentEvidence.excerpt,
    "Ana (la viajera)");
});

test("expone distancia oracional y de párrafo sin confundirlas con certeza de correferencia", () => {
  const text = "Ana llegó.\n\nLa lluvia comenzó.\n\nElla cerró la puerta.";
  const [reference] = discover(text, { entities: [ana] });
  const [candidate] = reference.antecedentCandidates;
  assert.equal(candidate.sentenceDistance, 4);
  assert.equal(candidate.paragraphDistance, 2);
  assert.equal(reference.status, "single-candidate");
  assert.equal(reference.reviewStatus, "candidate");
});

test("mantiene alternativas y mide sus contextos por separado", () => {
  const text = "Ana llegó.\n\nBruno esperó. Ella abrió la puerta.";
  const [reference] = discover(text, { entities: [ana, bruno] });
  assert.equal(reference.status, "ambiguous");
  assert.equal(reference.antecedentCandidates[0].entityId, bruno.id);
  assert.equal(reference.antecedentCandidates[0].paragraphDistance, 0);
  assert.equal(reference.antecedentCandidates[1].paragraphDistance, 1);
});
