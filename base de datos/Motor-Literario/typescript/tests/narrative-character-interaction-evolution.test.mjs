import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeCharacterInteractions, detectNarrativeInteractionShifts } from "../dist/motor-literario.js";

const entities = [
  { projectId:"book", id:"mara", kind:"character" },
  { projectId:"book", id:"elian", kind:"character" },
  { projectId:"book", id:"sword", kind:"object" }
];
function action(id, verb, actor="mara", target="elian", start=0, polarity="affirmed", revision=1) {
  return {
    id, projectId:"book", actorEntityId:actor, action:verb, targetEntityId:target,
    polarity, reviewStatus:"candidate",
    evidence:{documentId:"chapter", revision, start, end:start+12, excerpt:verb}
  };
}

test("extrae señales solo entre personajes y conserva la dirección", () => {
  const result = extractNarrativeCharacterInteractions([
    action("a1","protegió"), action("a2","atacó","elian","mara",20),
    action("a3","encontró","mara","sword",40)
  ], entities, "book");
  assert.equal(result.length, 2);
  assert.equal(result[0].actorEntityId, "mara");
  assert.equal(result[0].targetEntityId, "elian");
  assert.equal(result[0].effectiveSignal, "supportive");
  assert.equal(result[1].effectiveSignal, "hostile");
});

test("no interpreta una acción de apoyo negada como hostilidad", () => {
  const [interaction] = extractNarrativeCharacterInteractions([
    action("a1","protegió","mara","elian",0,"negated")
  ], entities, "book");
  assert.equal(interaction.valence, "supportive");
  assert.equal(interaction.effectiveSignal, "neutral-or-unknown");
});

test("detecta un cambio de señal explícita en la misma dirección", () => {
  const interactions = extractNarrativeCharacterInteractions([
    action("a1","protegió","mara","elian",0),
    action("a2","traicionó","mara","elian",50)
  ], entities, "book");
  const [shift] = detectNarrativeInteractionShifts(interactions);
  assert.equal(shift.fromValence, "supportive");
  assert.equal(shift.toValence, "hostile");
  assert.equal(shift.reviewStatus, "candidate");
  assert.equal(shift.evidence.length, 2);
});

test("no crea cambio por acciones neutrales ni combina revisiones", () => {
  const interactions = extractNarrativeCharacterInteractions([
    action("a1","ayudó","mara","elian",0),
    action("a2","encontró","mara","elian",30),
    action("a3","atacó","mara","elian",60,"affirmed",2)
  ], entities, "book");
  assert.deepEqual(detectNarrativeInteractionShifts(interactions), []);
});

test("rechaza proyectos ajenos y acciones duplicadas en el análisis de cambios", () => {
  assert.throws(() => extractNarrativeCharacterInteractions([
    { ...action("a1","protegió"), projectId:"other" }
  ], entities, "book"));
  const [interaction] = extractNarrativeCharacterInteractions([
    action("a1","protegió")
  ], entities, "book");
  assert.throws(() => detectNarrativeInteractionShifts([interaction, interaction]));
});
