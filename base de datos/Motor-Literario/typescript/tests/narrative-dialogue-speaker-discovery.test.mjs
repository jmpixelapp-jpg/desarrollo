import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeDialogueSpeakers } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = { ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno" };

function discover(text, entities = [ana, bruno], overrides = {}) {
  return discoverNarrativeDialogueSpeakers({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, entities, ...overrides
  });
}

test("atribuye una cita a un personaje cuando nombre y verbo de habla son explícitos", () => {
  const text = "Ana dijo: «Volveré mañana»";
  const [segment] = discover(text, [ana]);
  assert.equal(segment.format, "guillemets");
  assert.equal(segment.utteranceEvidence.excerpt, "Volveré mañana");
  assert.equal(segment.speakerStatus, "explicit-single");
  assert.equal(segment.speakerCandidates[0].entityId, ana.id);
  assert.equal(segment.speakerCandidates[0].speechVerbEvidence.excerpt, "dijo");
  assert.equal(text.slice(segment.speakerCandidates[0].nameEvidence.start,
    segment.speakerCandidates[0].nameEvidence.end), "Ana");
});

test("reconoce etiqueta posterior al diálogo sin confundir al destinatario con hablante", () => {
  const text = "«No entraré», respondió Bruno.";
  const [segment] = discover(text, [bruno]);
  assert.equal(segment.speakerStatus, "explicit-single");
  assert.equal(segment.speakerCandidates[0].entityId, bruno.id);
  assert.equal(segment.speakerCandidates[0].speechVerbEvidence.excerpt, "respondió");
});

test("conserva ambigüedad cuando la etiqueta nombra a más de un personaje", () => {
  const text = "«Nos iremos», dijeron Ana y Bruno.";
  const [segment] = discover(text);
  assert.equal(segment.speakerStatus, "ambiguous");
  assert.deepEqual(segment.speakerCandidates.map(item => item.entityId).sort(), [ana.id, bruno.id].sort());
});

test("no atribuye hablante por turno anterior ni por mención dentro de la cita", () => {
  const text = "Ana entró. «Te estaba esperando»";
  const [segment] = discover(text, [ana]);
  assert.equal(segment.speakerStatus, "unattributed");
  assert.deepEqual(segment.speakerCandidates, []);
});

test("reconoce intervención con raya y etiqueta explícita al cierre de línea", () => {
  const text = "—¿Vienes conmigo? —preguntó Ana.";
  const [segment] = discover(text, [ana]);
  assert.equal(segment.format, "em-dash");
  assert.equal(segment.utteranceEvidence.excerpt, "¿Vienes conmigo?");
  assert.equal(segment.speakerStatus, "explicit-single");
  assert.equal(segment.speakerCandidates[0].entityId, ana.id);
});

test("conserva offsets UTF-16 absolutos con prefijo emoji", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "Ana dijo: “Hola”";
  const [segment] = discover(text, [ana], { baseOffset: prefix.length });
  assert.equal(segment.utteranceEvidence.start, prefix.length + text.indexOf("Hola"));
  assert.equal(segment.utteranceEvidence.excerpt, "Hola");
});

test("rechaza entidades duplicadas o de otro proyecto y límites inválidos", () => {
  assert.throws(() => discover("«Hola»", [ana, ana]), /únicas, válidas/);
  assert.throws(() => discover("«Hola»", [{ ...ana, projectId: "other" }]), /mismo proyecto/);
  assert.throws(() => discover("«Hola»", [ana], { maxAttributionDistance: 1001 }), /Contexto inválido/);
});

test("no asigna hablante si la atribución no contiene verbo de habla", () => {
  const [segment] = discover("«Te esperaba», Ana.", [ana]);
  assert.equal(segment.speakerStatus, "unattributed");
});
