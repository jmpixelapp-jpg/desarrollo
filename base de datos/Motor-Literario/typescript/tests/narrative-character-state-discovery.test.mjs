import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeCharacterStateCandidates } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = {
  ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
};
const context = {
  projectId: "book-1", documentId: "chapter-1", revision: 5,
  entities: [ana, bruno]
};

function discover(text, baseOffset = 0) {
  return discoverNarrativeCharacterStateCandidates({
    ...context, text, baseOffset
  });
}

test("extrae estados explícitos de personajes y conserva evidencias exactas", () => {
  const text = "Ana está herida. Bruno permanece inconsciente. Ana está muy enferma.";
  const candidates = discover(text, 120);
  assert.deepEqual(candidates.map(item => [item.entityId, item.state]), [
    [ana.id, "injured"],
    [bruno.id, "unconscious"],
    [ana.id, "sick"]
  ]);
  for (const candidate of candidates) {
    for (const evidence of [
      candidate.entityEvidence, candidate.stateEvidence,
      candidate.predicateEvidence, candidate.evidence
    ]) {
      assert.equal(evidence.revision, 5);
      assert.equal(
        text.slice(evidence.start - 120, evidence.end - 120),
        evidence.excerpt
      );
    }
    assert.equal(candidate.reviewStatus, "candidate");
  }
  assert.equal(candidates[0].evidence.excerpt, "Ana está herida.");
  assert.equal(candidates[0].stateEvidence.excerpt, "herida");
  assert.equal(candidates[0].predicateEvidence.excerpt, "está herida");
});

test("distingue estados negados, cesación y recurrencia sin borrar la evidencia anterior", () => {
  const text = "Ana ya no está herida. Bruno dejó de estar enfermo. Ana volvió a estar herida.";
  const candidates = discover(text);
  assert.deepEqual(candidates.map(item => ({
    entityId: item.entityId, state: item.state, polarity: item.polarity,
    aspect: item.aspect, tense: item.grammaticalTense
  })), [
    { entityId: ana.id, state: "injured", polarity: "negated", aspect: "ordinary", tense: "present" },
    { entityId: bruno.id, state: "sick", polarity: "negated", aspect: "ceased", tense: "past" },
    { entityId: ana.id, state: "injured", polarity: "affirmed", aspect: "recurrent", tense: "past" }
  ]);
});

test("distingue estados pasados, futuros y perceptuales", () => {
  const candidates = discover("Ana estaba viva. Bruno estará libre. Ana parece consciente.");
  assert.deepEqual(candidates.map(item => [
    item.state, item.grammaticalTense, item.assertionMode
  ]), [
    ["alive", "past", "copular"],
    ["free", "future", "copular"],
    ["conscious", "present", "perceptual"]
  ]);
});

test("no infiere estados desde adjetivos aislados, acciones ni objetos", () => {
  const sword = {
    projectId: "book-1", id: "object:sword", kind: "object",
    canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const result = discoverNarrativeCharacterStateCandidates({
    ...context, entities: [ana, sword],
    text: "Ana, herida, cruzó el puente. Bruno encontró a Ana herida. La Espada Solar está rota."
  });
  assert.deepEqual(result, []);
});

test("no resuelve pronombres ni nombres ambiguos entre dos fichas", () => {
  const duplicate = {
    ...ana, id: "character:ana-duplicate"
  };
  const result = discoverNarrativeCharacterStateCandidates({
    ...context, entities: [ana, duplicate],
    text: "Ella está herida. Ana está herida."
  });
  assert.deepEqual(result, []);
});

test("reconoce negaciones temporales nunca y jamás sin convertirlas en estados afirmados", () => {
  const candidates = discover("Ana nunca estuvo viva. Bruno jamás estuvo libre.");
  assert.deepEqual(candidates.map(item => [item.state, item.polarity, item.grammaticalTense]), [
    ["alive", "negated", "past"],
    ["free", "negated", "past"]
  ]);
});

test("clasifica estados cognitivos, emocionales, sociales y físicos sin mezclarlos", () => {
  const text = "Ana está dormida. Bruno está furioso. Ana está encarcelada. Bruno está ciego.";
  const candidates = discover(text);
  assert.deepEqual(candidates.map(item => [item.state, item.category]), [
    ["asleep", "cognitive"],
    ["angry", "emotional"],
    ["imprisoned", "social"],
    ["blind", "physical"]
  ]);
});

test("reconoce nombres con marcas Unicode descompuestas y conserva offsets UTF-16 originales", () => {
  const jose = {
    ...ana, id: "character:jose", canonicalName: "José",
    normalizedName: "josé"
  };
  const text = "Jose\u0301 está vivo.";
  const result = discoverNarrativeCharacterStateCandidates({
    ...context, entities: [jose], text, baseOffset: 41
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].entityId, jose.id);
  assert.equal(result[0].state, "alive");
  assert.equal(result[0].entityEvidence.excerpt, "Jose\u0301");
  assert.equal(
    text.slice(result[0].entityEvidence.start - 41, result[0].entityEvidence.end - 41),
    "Jose\u0301"
  );
});

test("rechaza entidades ajenas, offsets inválidos y texto fuera de presupuesto", () => {
  assert.throws(() => discoverNarrativeCharacterStateCandidates({
    ...context, entities: [{ ...ana, projectId: "other" }], text: "Ana está herida."
  }));
  assert.throws(() => discoverNarrativeCharacterStateCandidates({
    ...context, text: "Ana está herida.", baseOffset: -1
  }));
  assert.throws(() => discoverNarrativeCharacterStateCandidates({
    ...context, text: "x".repeat(2_000_001)
  }));
});

test("amplía estados emocionales y cognitivos mediante construcciones perceptuales", () => {
  const text = "Ana se siente preocupada. Bruno se veía desorientado. Ana está feliz. Bruno estaba confundido.";
  const candidates = discover(text);
  assert.deepEqual(candidates.map(item => [
    item.entityId, item.state, item.category, item.grammaticalTense, item.assertionMode
  ]), [
    [ana.id, "worried", "emotional", "present", "perceptual"],
    [bruno.id, "disoriented", "cognitive", "past", "perceptual"],
    [ana.id, "happy", "emotional", "present", "copular"],
    [bruno.id, "confused", "cognitive", "past", "copular"]
  ]);
  assert.equal(candidates[0].stateEvidence.excerpt, "preocupada");
  assert.equal(candidates[1].predicateEvidence.excerpt, "se veía desorientado");
});

test("no confunde estados nuevos con acciones ni acepta adjetivos sin cópula", () => {
  assert.deepEqual(discover("Ana, preocupada, abrió la puerta. Bruno sonrió feliz."), []);
});


test("separa los estados afirmados por el narrador de los estados que un personaje cree",()=>{
 const result=discover("Ana está herida. Ana creyó que Ana no estaba herida.");
 assert.equal(result.length,2);
 assert.equal(result[0].epistemicFrame,"narrator-asserted");
 assert.equal(result[1].epistemicFrame,"character-belief");
 assert.equal(result[1].epistemicFrameEvidence.excerpt,"creyó que ");
});
test("conserva la fuente explícita del discurso referido sobre un estado",()=>{
 const result=discover("Ana dijo que Ana estaba herida.");
 assert.equal(result.length,1);
 assert.equal(result[0].epistemicFrame,"reported-speech");
 assert.equal(result[0].epistemicSourceCandidate.entityId,ana.id);
 assert.equal(result[0].epistemicSourceCandidate.evidence.excerpt,"Ana");
});
test("no inventa fuente en discurso referido impersonal",()=>{
 const result=discover("Se dijo que Ana estaba herida.");
 assert.equal(result.length,1);
 assert.equal(result[0].epistemicFrame,"reported-speech");
 assert.equal(result[0].epistemicSourceCandidate,undefined);
});

test("rechaza alias vacíos, excesivos y entidades fuera del presupuesto",()=>{
 assert.throws(()=>discover({entities:[{...ana,aliases:["   "]}],text:"Ana está herida."}));
 assert.throws(()=>discover({entities:[{...ana,aliases:["x".repeat(257)]}],text:"Ana está herida."}));
 assert.throws(()=>discover({entities:Array.from({length:5001},(_,i)=>({...ana,id:"c:"+i})),text:"Ana está herida."}));
});
test("rechaza búsquedas combinadas que superan el presupuesto sin devolver resultados parciales",()=>{
 const entities=Array.from({length:5000},(_,i)=>({
  ...ana,id:"character:"+i,canonicalName:"Personaje"+i,normalizedName:"personaje"+i
 }));
 const text="x".repeat(10000);
 assert.throws(()=>discover({entities,text}),/presupuesto de análisis/);
});
