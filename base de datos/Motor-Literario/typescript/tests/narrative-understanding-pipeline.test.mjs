import test from "node:test";
import assert from "node:assert/strict";
import { understandNarrativeFragment } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"novel", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

test("coordina ideas, acciones, eventos, consecuencias y escenas con una procedencia común", () => {
  const text = "ESCENA 1\nMara protegió a Elian. Como consecuencia, Mara traicionó a Elian. El conflicto central es la pérdida de confianza.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-1", revision:3, text, entities
  });
  assert.equal(result.projectId, "novel");
  assert.equal(result.documentId, "chapter-1");
  assert.equal(result.revision, 3);
  assert.equal(result.actions.length, 2);
  assert.equal(result.events.length, 2);
  assert.equal(result.consequences.length, 1);
  assert.equal(result.ideas.length, 1);
  assert.equal(result.interactions.length, 2);
  assert.equal(result.interactionShifts.length, 1);
  assert.ok(result.sceneAssignments.actionCandidates.every(item => item.sceneAssignment === "explicit"));
  assert.ok(result.sceneAssignments.eventCandidates.every(item => item.sceneAssignment === "explicit"));
  assert.equal(result.sceneAssignments.ideaCandidates[0].sceneAssignment, "explicit");
  for (const candidate of [...result.ideas, ...result.actions, ...result.events]) {
    assert.equal(candidate.evidence.documentId, "chapter-1");
    assert.equal(candidate.evidence.revision, 3);
  }
});

test("propaga baseOffset sin alterar offsets absolutos de evidencia", () => {
  const text = "Mara ayudó a Elian. Como consecuencia, Mara protegió a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-2", revision:4,
    text, entities, baseOffset:1200
  });
  assert.equal(result.analyzedRange.start, 1200);
  assert.equal(result.analyzedRange.end, 1200 + text.length);
  assert.equal(result.actions[0].evidence.start, 1200);
  assert.equal(result.consequences.length, 1);
  assert.equal(result.consequences[0].evidence.start, 1200 + text.indexOf("Como consecuencia"));
  assert.equal(result.sceneAssignments.actionCandidates[0].sceneAssignment, "unassigned");
});

test("rechaza entidades de otro proyecto antes de ejecutar extractores", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-1", revision:1,
    text:"Mara ayudó a Elian.",
    entities:[{ ...entities[0], projectId:"other" }]
  }));
});


test("integra resolución pronominal y atribuye acciones sin perder offsets absolutos", () => {
  const text = "Mara llegó. Ella protegió a Elian.";
  const nameStart = 0;
  const pronounStart = text.indexOf("Ella");
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronouns", revision:2,
    text, entities, baseOffset:800,
    characterMentions:[{
      characterId:"mara", documentId:"chapter-pronouns", revision:2,
      start:800 + nameStart, end:800 + 4,
      grammaticalNumber:"singular", grammaticalGender:"feminine"
    }],
    pronounReferences:[{
      id:"pronoun-ella", documentId:"chapter-pronouns", revision:2,
      start:800 + pronounStart, end:800 + pronounStart + 4,
      surface:"Ella", grammaticalNumber:"singular", grammaticalGender:"feminine"
    }]
  });
  assert.equal(result.pronounResolutions.length, 1);
  assert.equal(result.pronounResolutions[0].status, "resolved");
  assert.equal(result.pronounResolutions[0].characterId, "mara");
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounActions[0].actorEntityId, "mara");
  assert.equal(result.pronounActions[0].action, "protegió");
  assert.equal(result.pronounActions[0].evidence.start, 800 + pronounStart);
  assert.equal(result.pronounActions[0].evidence.documentId, "chapter-pronouns");
});

test("rechaza referencias pronominales cuya superficie no coincide con el texto", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronouns", revision:2,
    text:"Mara llegó. Ella protegió a Elian.",
    entities,
    pronounReferences:[{
      id:"wrong-surface", documentId:"chapter-pronouns", revision:2,
      start:13, end:17, surface:"Él",
      grammaticalNumber:"singular", grammaticalGender:"masculine"
    }]
  }));
});


test("detecta automáticamente menciones y pronombres con perfil gramatical explícito", () => {
  const text = "Mara llegó. Ella protegió a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-auto-pronouns", revision:5,
    text, entities,
    characterProfiles:[{ characterId:"mara", grammaticalGender:"feminine" }]
  });
  assert.equal(result.pronounResolutions.length, 1);
  assert.equal(result.pronounResolutions[0].status, "resolved");
  assert.equal(result.pronounResolutions[0].characterId, "mara");
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounActions[0].actorEntityId, "mara");
  assert.equal(result.pronounActions[0].action, "protegió");
});

test("no inventa género gramatical si el perfil del personaje no existe", () => {
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-unknown-gender", revision:1,
    text:"Mara llegó. Ella protegió a Elian.", entities
  });
  assert.equal(result.pronounResolutions[0].status, "unresolved");
  assert.equal(result.pronounActions.length, 0);
});


test("resuelve y atribuye acciones con pronombre enfático: Ella misma protegió", () => {
  const text = "Mara llegó. Ella misma protegió a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-emphatic", revision:1,
    text, entities,
    characterProfiles:[{ characterId:"mara", grammaticalGender:"feminine" }]
  });
  assert.equal(result.pronounResolutions.length, 1);
  assert.equal(result.pronounResolutions[0].status, "resolved");
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounActions[0].actorEntityId, "mara");
  assert.equal(result.pronounActions[0].action, "protegió");
  assert.equal(result.pronounActions[0].evidence.start, text.indexOf("Ella"));
});

test("rechaza colecciones de entidades nulas sin provocar errores de acceso", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-invalid", revision:1,
    text:"Mara llegó. Ella esperó.",
    entities:[null],
    characterMentions:[{
      characterId:"mara", documentId:"chapter-invalid", revision:1,
      start:0, end:4, grammaticalNumber:"singular", grammaticalGender:"feminine"
    }]
  }), /entidades/i);
});


test("integra actor pronominal y objetivo explícito en la evolución de interacciones", () => {
  const text = "Mara llegó. Ella protegió a Elian. Después, Ella traicionó a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronoun-interaction", revision:1,
    text, entities,
    characterProfiles:[{ characterId:"mara", grammaticalGender:"feminine" }]
  });
  assert.equal(result.pronounActions.length, 2);
  assert.equal(result.pronounTargetActions.length, 2);
  assert.equal(result.pronounTargetActions[0].actorEntityId, "mara");
  assert.equal(result.pronounTargetActions[0].targetEntityId, "elian");
  assert.equal(result.interactions.length, 2);
  assert.deepEqual(result.interactions.map(item => item.effectiveSignal), ["supportive", "hostile"]);
  assert.equal(result.interactionShifts.length, 1);
  assert.equal(result.interactionShifts[0].fromValence, "supportive");
  assert.equal(result.interactionShifts[0].toValence, "hostile");
});

test("no inventa objetivo cuando la acción pronominal no lo expresa", () => {
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-no-target", revision:1,
    text:"Mara llegó. Ella protegió.",
    entities,
    characterProfiles:[{ characterId:"mara", grammaticalGender:"feminine" }]
  });
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounTargetActions.length, 0);
  assert.equal(result.interactions.length, 0);
});


test("compara afirmaciones actuales con memoria previa y distingue evolución temporal", () => {
  const priorAssertions = [{
    projectId:"novel", id:"prior-age-mara", entityId:"mara", entityName:"Mara",
    attribute:"age", value:19,
    evidence:{ documentId:"chapter-previous", revision:2, start:0, end:20, excerpt:"Mara tiene 19 años el 2025-01-01." },
    timeReference:{ basis:"calendar", precision:"date", raw:"2025-01-01", orderValue:20089 },
    capturedAt:10
  }];
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-current", revision:3,
    text:"Mara tiene 20 años el 2026-01-01.", entities, priorAssertions
  });
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].entityId, "mara");
  assert.equal(result.assertions[0].value, 20);
  assert.equal(result.consistencyFindings.length, 1);
  assert.equal(result.consistencyFindings[0].classification, "temporal-change");
  assert.deepEqual(
    result.consistencyFindings[0].evidence.map(item => item.documentId).sort(),
    ["chapter-current", "chapter-previous"]
  );
});

test("no compara memoria narrativa de otro proyecto", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-current", revision:1,
    text:"Mara tiene 20 años.", entities,
    priorAssertions:[{
      projectId:"other", id:"foreign", entityId:"mara", entityName:"Mara",
      attribute:"age", value:19,
      evidence:{ documentId:"other-chapter", revision:1, start:0, end:10, excerpt:"Mara tiene 19." },
      capturedAt:1
    }]
  }), /proyecto/i);
});


test("rechaza afirmaciones previas de personajes que no pertenecen al contexto del proyecto", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-current", revision:1,
    text:"Mara tiene 20 años.", entities,
    priorAssertions:[{
      projectId:"novel", id:"unknown-character", entityId:"unknown",
      entityName:"Desconocido", attribute:"age", value:19,
      evidence:{ documentId:"chapter-old", revision:1, start:0, end:10, excerpt:"Desconocido tenía 19." },
      capturedAt:1
    }]
  }), /personajes conocidos/i);
});


test("integra afirmaciones atribuidas y separa negación del hablante y del contenido", () => {
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-claims", revision:1,
    text:"Mara no cree que Elian sea culpable. Elian afirma que Mara nunca regresará.",
    entities
  });
  assert.equal(result.attributedClaims.length, 2);
  assert.equal(result.attributedClaims[0].speakerEntityId, "mara");
  assert.equal(result.attributedClaims[0].attributionPolarity, "negated");
  assert.equal(result.attributedClaims[0].contentPolarity, "affirmed");
  assert.equal(result.attributedClaims[1].speakerEntityId, "elian");
  assert.equal(result.attributedClaims[1].attributionPolarity, "affirmed");
  assert.equal(result.attributedClaims[1].contentPolarity, "negated");
  assert.equal(result.attributedClaims[1].evidence.documentId, "chapter-claims");
});


test("integra atribución de hablantes de diálogo en el pipeline coordinado", () => {
  const text = "—No volveré —dijo Mara. Elian respondió: «Te esperaré».";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-dialogue-pipeline", revision:2,
    text, entities
  });
  assert.equal(result.dialogueAttributions.length, 2);
  assert.deepEqual(
    result.dialogueAttributions.map(item => item.speakerEntityId),
    ["mara", "elian"]
  );
  assert.deepEqual(
    result.dialogueAttributions.map(item => item.speech),
    ["No volveré", "Te esperaré"]
  );
});


test("integra procedencia epistemológica sin convertir reportes en hechos", () => {
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-provenance-pipeline", revision:1,
    text:"Elian le contó a Mara que el puente había caído. Mara vio que la torre ardía.",
    entities
  });
  assert.equal(result.informationProvenance.length, 2);
  assert.equal(result.informationProvenance[0].sourceEntityId, "elian");
  assert.equal(result.informationProvenance[0].informationHolderEntityId, "mara");
  assert.equal(result.informationProvenance[0].status, "reported");
  assert.equal(result.informationProvenance[1].informationHolderEntityId, "mara");
  assert.equal(result.informationProvenance[1].channel, "visual-observation");
  assert.equal(result.informationProvenance[1].sourceEntityId, undefined);
});


test("integra la evolución del conocimiento y enlaza evidencia entre capítulos", () => {
  const priorClaims = [{
    id:"claim:old:0:mara", projectId:"novel", speakerEntityId:"mara",
    attribution:"afirma", kind:"assertion", content:"el puente había caído",
    attributionPolarity:"affirmed", contentPolarity:"affirmed", polarity:"affirmed",
    reviewStatus:"candidate",
    evidence:{documentId:"chapter-old",revision:1,start:0,end:30,excerpt:"Mara afirma que el puente había caído"}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-new", revision:2,
    text:"Mara confirmó que el puente había caído.",
    entities, priorClaims
  });
  assert.equal(result.knowledgeEvolution.length, 1);
  assert.equal(result.knowledgeEvolution[0].evaluation, "confirmed");
  assert.equal(result.knowledgeEvolution[0].matchedClaimId, "claim:old:0:mara");
  assert.equal(result.knowledgeEvolution[0].claimEvidence.documentId, "chapter-old");
});


test("integra cadenas de transmisión con procedencia previa de otros capítulos", () => {
  const priorInformationProvenance = [{
    id:"information:chapter-1:0:visual-observation:elian",
    projectId:"novel", informationHolderEntityId:"elian",
    channel:"visual-observation", status:"observed",
    content:"el puente había caído", reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start:0,end:36,excerpt:"Elian vio que el puente había caído."},
    contentEvidence:{documentId:"chapter-1",revision:1,start:14,end:36,excerpt:"el puente había caído"}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-2", revision:2,
    text:"Elian le contó a Mara que el puente había caído.",
    entities, priorInformationProvenance
  });
  assert.equal(result.informationChain.length, 1);
  assert.equal(result.informationChain[0].linkStatus, "linked");
  assert.equal(result.informationChain[0].predecessorRecordId,
    "information:chapter-1:0:visual-observation:elian");
  assert.equal(result.informationChain[0].recipientEntityId, "mara");
});


test("integra interpretaciones explícitas y las compara con información previa del personaje", () => {
  const priorInformationProvenance = [{
    id:"prior:mara:bridge",projectId:"novel",
    informationHolderEntityId:"mara",sourceEntityId:"elian",
    channel:"reported-speech",status:"reported",
    content:"el puente había caído",reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start:0,end:49,excerpt:"Elian le contó a Mara que el puente había caído."},
    contentEvidence:{documentId:"chapter-1",revision:1,start:28,end:49,excerpt:"el puente había caído"}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel",documentId:"chapter-2",revision:2,
    text:"Mara entendió mal que el puente seguía en pie.",
    entities,priorInformationProvenance
  });
  assert.equal(result.informationInterpretations.length,1);
  assert.equal(result.informationInterpretations[0].signal,"explicit-misinterpretation");
  assert.equal(result.informationInterpretations[0].comparison,"different-content");
  assert.equal(result.informationInterpretations[0].priorInformationId,"prior:mara:bridge");
});


test("el pipeline produce un estado de conocimiento por personaje con su interpretación vinculada", () => {
  const priorInformationProvenance = [{
    id:"prior:mara:bridge",projectId:"novel",
    informationHolderEntityId:"mara",sourceEntityId:"elian",
    channel:"reported-speech",status:"reported",
    content:"el puente había caído",reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start:0,end:49,excerpt:"Elian le contó a Mara que el puente había caído."},
    contentEvidence:{documentId:"chapter-1",revision:1,start:28,end:49,excerpt:"el puente había caído"}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel",documentId:"chapter-2",revision:2,
    text:"Mara entendió mal que el puente seguía en pie.",
    entities,priorInformationProvenance
  });
  const maraState = result.characterKnowledgeStates.find(state =>
    state.characterEntityId === "mara");
  assert.equal(maraState.summary.recordedInformationCount,1);
  assert.equal(maraState.summary.explicitMisinterpretationCount,1);
  assert.equal(maraState.items[0].interpretations[0].priorInformationId,
    "prior:mara:bridge");
});


test("el pipeline conserva evaluaciones previas y actualiza la valoración del personaje", () => {
  const priorInformationProvenance = [{
    id:"prior:mara:bridge",projectId:"novel",
    informationHolderEntityId:"mara",sourceEntityId:"elian",
    channel:"reported-speech",status:"reported",
    content:"el puente había caído",reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start:0,end:49,excerpt:"Elian le contó a Mara que el puente había caído."},
    contentEvidence:{documentId:"chapter-1",revision:1,start:28,end:49,excerpt:"el puente había caído"}
  }];
  const priorKnowledgeEvolution = [{
    id:"assessment:uncertain",projectId:"novel",evaluatorEntityId:"mara",
    evaluation:"uncertain",content:"el puente había caído",
    matchStatus:"no-prior-match",reviewStatus:"candidate",
    evidence:{documentId:"chapter-2",revision:1,start:0,end:37,excerpt:"Mara dudó que el puente había caído."}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel",documentId:"chapter-3",revision:1,
    text:"Mara refutó que el puente había caído.",
    entities,priorInformationProvenance,priorKnowledgeEvolution,
    orderedDocumentIds:["chapter-1","chapter-2","chapter-3"]
  });
  const mara = result.characterKnowledgeStates.find(state =>
    state.characterEntityId === "mara");
  assert.equal(mara.items[0].evaluations.length,2);
  assert.equal(mara.items[0].currentAssessment,"refuted-by-character");
});


test("el pipeline expone eventos explícitos de memoria con evidencia", () => {
  const result = understandNarrativeFragment({
    projectId:"novel",documentId:"chapter-memory",revision:1,
    text:"Mara olvidó que Elian había salido. Después, Mara recordó que la puerta estaba abierta.",
    entities
  });
  assert.deepEqual(result.memoryEvents.map(item => item.kind),["forgetting","remembering"]);
  assert.ok(result.memoryEvents.every(item => item.evidence.documentId === "chapter-memory"));
});


test("el pipeline conserva el historial y proyecta la memoria explícita del personaje", () => {
  const priorMemoryEvents = [{
    id:"memory-prior",projectId:"novel",characterEntityId:"mara",
    kind:"remembering",content:"Elian había salido",reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start:10,end:30,excerpt:"Mara recordó que Elian había salido"}
  }];
  const result = understandNarrativeFragment({
    projectId:"novel",documentId:"chapter-2",revision:1,
    text:"Mara olvidó que Elian había salido.",entities,
    priorMemoryEvents,orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.memoryEvents.length,1);
  assert.equal(result.characterMemoryTimelines[0].memories[0].currentStatus,"forgotten");
  assert.equal(result.characterMemoryTimelines[0].memories[0].events.length,2);
});

test("integra objetivos explícitos de personajes en el pipeline", () => {
  const text = "ESCENA 4\nMara quiere rescatar a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-intent", revision:1, text, entities
  });
  assert.equal(result.characterIntents.length, 1);
  assert.equal(result.characterIntents[0].characterEntityId, "mara");
  assert.equal(result.characterIntents[0].kind, "goal");
  assert.equal(result.characterIntents[0].text, "rescatar a Elian");
  assert.equal(result.characterIntents[0].polarity, "affirmed");
  assert.equal(result.sceneAssignments.characterIntentCandidates[0].sceneAssignment, "explicit");
});

test("conserva offsets absolutos y polaridad de objetivos negados", () => {
  const text = "Mara no quiere abandonar a Elian.";
  const baseOffset = 1500;
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-intent-negated", revision:2,
    text, entities, baseOffset
  });
  assert.equal(result.characterIntents.length, 1);
  assert.equal(result.characterIntents[0].kind, "goal");
  assert.equal(result.characterIntents[0].polarity, "negated");
  assert.equal(result.characterIntents[0].evidence.start, baseOffset + text.indexOf("abandonar"));
  assert.equal(result.characterIntents[0].evidence.end, baseOffset + text.indexOf("abandonar a Elian") + "abandonar a Elian".length);
});

test("integra evolución de objetivos previos con cronología documental explícita", () => {
  const text = "Mara quiere rescatar a Elian.";
  const prior = {
    id:"prior-goal", projectId:"novel", characterEntityId:"mara",
    kind:"goal", text:"rescatar a Elian", polarity:"affirmed",
    reviewStatus:"candidate",
    evidence:{documentId:"chapter-1", revision:1, start:0, end:17, excerpt:"Mara quiere rescatar a Elian."}
  };
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-2", revision:1, text, entities,
    priorCharacterIntents:[prior],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.characterIntentEvolution.length, 1);
  assert.equal(result.characterIntentEvolution[0].transition, "maintained");
  assert.deepEqual(result.characterIntentEvolution[0].priorIntentIds, ["prior-goal"]);
});

test("detecta oposición entre un objetivo explícito y una acción posterior del mismo personaje", () => {
  const text = "Mara quiere proteger a Elian. Mara traicionó a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-intent-action", revision:1, text, entities
  });
  assert.equal(result.characterIntents.length, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.intentActionConsistency.length, 1);
  assert.equal(result.intentActionConsistency[0].relation, "opposes-intent");
  assert.equal(result.intentActionConsistency[0].characterEntityId, "mara");
  assert.equal(result.intentActionConsistency[0].matchedTargetEntityId, "elian");
});

test("integra acciones pronominales resueltas en el contraste con objetivos", () => {
  const text = "Mara quiere proteger a Elian. Ella traicionó a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronoun-intent", revision:1, text, entities
  });
  assert.equal(result.characterIntents.length, 1);
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounActions[0].actorEntityId, "mara");
  assert.equal(result.pronounTargetActions.length, 1);
  assert.equal(result.intentActionConsistency.length, 1);
  assert.equal(result.intentActionConsistency[0].relation, "opposes-intent");
  assert.equal(result.intentActionConsistency[0].actionId, result.pronounTargetActions[0].id);
});
