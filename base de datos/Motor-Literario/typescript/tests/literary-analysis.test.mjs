import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiteraryFragment } from "../dist/motor-literario.js";

function analyze(text, baseOffset = 0) {
  return analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    baseOffset
  });
}

test("detecta ecos léxicos entre escenas con conteos y offsets absolutos", () => {
  const text = [
    "Escena 1",
    "La sombra cubría la vieja torre. La sombra avanzó lentamente.",
    "Escena 2",
    "Una sombra cruzó la plaza. La torre permanecía vacía."
  ].join("\n");
  const baseOffset = 137;
  const result = analyze(text, baseOffset);
  const echo = result.sceneLexicalEchoes.echoes.find(item => item.normalizedWord === "sombra");

  assert.equal(result.explicitScenes.length, 2);
  assert.ok(echo);
  assert.equal(echo.word, "sombra");
  assert.equal(echo.sceneCount, 2);
  assert.equal(echo.totalOccurrenceCount, 3);
  assert.deepEqual(echo.scenes.map(scene => scene.sceneIndex), [1, 2]);
  assert.deepEqual(echo.scenes.map(scene => scene.occurrenceCount), [2, 1]);
  assert.equal(echo.scenes[0].occurrences[0].start, baseOffset + text.indexOf("sombra"));
  assert.equal(echo.scenes[0].occurrences[0].end, baseOffset + text.indexOf("sombra") + "sombra".length);
  assert.equal(echo.scenes[0].evidenceTruncated, false);
  assert.deepEqual(echo.scenes.map(scene => scene.contextClassification), ["narrative-only", "narrative-only"]);
  assert.deepEqual(echo.scenes.map(scene => scene.dialogueOccurrenceCount), [0, 0]);

  // "torre" aparece en dos escenas, pero solo dos veces: no alcanza el umbral de tres.
  assert.equal(result.sceneLexicalEchoes.echoes.some(item => item.normalizedWord === "torre"), false);
});

test("acota muestras por escena sin perder los conteos completos", () => {
  const firstScene = Array.from({ length: 18 }, () => "sombra").join(" ");
  const secondScene = Array.from({ length: 4 }, () => "sombra").join(" ");
  const result = analyze(["Escena 1", firstScene, "Escena 2", secondScene].join("\n"));
  const echo = result.sceneLexicalEchoes.echoes.find(item => item.normalizedWord === "sombra");

  assert.ok(echo);
  assert.equal(echo.totalOccurrenceCount, 22);
  assert.equal(echo.scenes[0].occurrenceCount, 18);
  assert.equal(echo.scenes[0].occurrences.length, 12);
  assert.equal(echo.scenes[0].evidenceTruncated, true);
  assert.equal(echo.scenes[1].occurrences.length, 4);
  assert.equal(echo.scenes[1].evidenceTruncated, false);
});

test("no presenta ecos cuando el fragmento carece de escenas explícitas", () => {
  const result = analyze("Sombra, sombra, sombra. La sombra regresó.");

  assert.equal(result.sceneLexicalEchoes.explicitSceneCount, 0);
  assert.equal(result.sceneLexicalEchoes.candidateCount, 0);
  assert.deepEqual(result.sceneLexicalEchoes.echoes, []);
});
test("distingue recurrencia léxica en narración y diálogo reconocido", () => {
  const text = [
    "Escena 1",
    "«La sombra regresó.»",
    "La sombra permaneció.",
    "Escena 2",
    "«La sombra habló.»",
    "La sombra avanzó."
  ].join("\n");
  const result = analyze(text);
  const echo = result.sceneLexicalEchoes.echoes.find(item => item.normalizedWord === "sombra");

  assert.ok(echo);
  assert.equal(echo.totalOccurrenceCount, 4);
  assert.deepEqual(echo.scenes.map(scene => scene.narrativeOccurrenceCount), [1, 1]);
  assert.deepEqual(echo.scenes.map(scene => scene.dialogueOccurrenceCount), [1, 1]);
  assert.deepEqual(echo.scenes.map(scene => scene.contextClassification), ["mixed", "mixed"]);
  assert.deepEqual(echo.scenes.map(scene => scene.occurrences.map(item => item.context)), [
    ["dialogue", "narrative"],
    ["dialogue", "narrative"]
  ]);
});
test("clasifica como dialogada la recurrencia que solo aparece en citas", () => {
  const text = [
    "Escena 1",
    "«La sombra cayó; la sombra se fue.»",
    "Escena 2",
    "«La sombra cruzó la plaza.»"
  ].join("\n");
  const result = analyze(text);
  const echo = result.sceneLexicalEchoes.echoes.find(item => item.normalizedWord === "sombra");

  assert.ok(echo);
  assert.equal(echo.totalOccurrenceCount, 3);
  assert.deepEqual(echo.scenes.map(scene => scene.narrativeOccurrenceCount), [0, 0]);
  assert.deepEqual(echo.scenes.map(scene => scene.dialogueOccurrenceCount), [2, 1]);
  assert.deepEqual(echo.scenes.map(scene => scene.contextClassification), ["dialogue-only", "dialogue-only"]);
});

test("separa mención nominal de participación respaldada por evidencia de acontecimiento", () => {
  const text = [
    "Escena 1",
    "Ana cruzó el puente. «Ana, ven», dijo Luis.",
    "Escena 2",
    "El puente se derrumbó.",
    "Escena 3",
    "La carta llegó."
  ].join("\n");
  const firstEvidenceStart = text.indexOf("Ana cruzó el puente.");
  const secondEvidenceStart = text.indexOf("El puente se derrumbó.");
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents: [
      {
        eventId: "event-crossing",
        label: "Cruce del puente",
        participants: ["ana-id"],
        evidence: [{
          documentId: "chapter-one",
          revision: 1,
          start: firstEvidenceStart,
          end: firstEvidenceStart + "Ana cruzó el puente.".length,
          excerpt: "Ana cruzó el puente."
        }]
      },
      {
        eventId: "event-collapse",
        label: "Derrumbe del puente",
        participants: ["ana-id"],
        evidence: [{
          documentId: "chapter-one",
          revision: 1,
          start: secondEvidenceStart,
          end: secondEvidenceStart + "El puente se derrumbó.".length,
          excerpt: "El puente se derrumbó."
        }]
      }
    ]
  });
  const profile = result.characterSceneEvidence.profiles.find(item => item.entityId === "ana-id");

  assert.ok(profile);
  assert.equal(profile.canonicalName, "Ana");
  assert.equal(profile.totalMentionCount, 2);
  assert.equal(profile.mentionSceneCount, 1);
  assert.deepEqual(profile.mentionSceneIndexes, [1]);
  assert.equal(profile.eventParticipationSceneCount, 2);
  assert.deepEqual(profile.eventParticipationSceneIndexes, [1, 2]);
  assert.equal(profile.scenes[0].mentionStatus, "mentioned-by-known-name");
  assert.equal(profile.scenes[0].participationStatus, "linked-to-explicit-event-evidence");
  assert.equal(profile.scenes[0].mentionCount, 2);
  assert.deepEqual(profile.scenes[0].eventIds, ["event-crossing"]);
  assert.equal(profile.scenes[1].mentionStatus, "not-mentioned-by-known-name");
  assert.equal(profile.scenes[1].participationStatus, "linked-to-explicit-event-evidence");
  assert.deepEqual(profile.scenes[1].eventIds, ["event-collapse"]);
  assert.equal(profile.scenes[2].mentionStatus, "not-mentioned-by-known-name");
  assert.equal(profile.scenes[2].participationStatus, "not-linked-in-current-evidence");
  assert.equal(profile.firstMentionSceneIndex, 1);
  assert.equal(profile.lastEventParticipationSceneIndex, 2);
});

test("marca como desconocida la participación en escenas con vínculos de eventos truncados", () => {
  const text = [
    "Escena 1",
    "Ana esperaba junto a la ventana.",
    "Escena 2",
    "La puerta se cerró."
  ].join("\n");
  const evidenceStart = text.indexOf("La puerta se cerró.");
  const knownEvents = Array.from({ length: 101 }, (_, index) => ({
    eventId: "event-" + String(index + 1).padStart(3, "0"),
    label: "Acontecimiento " + (index + 1),
    participants: ["other-character-id"],
    evidence: [{
      documentId: "chapter-one",
      revision: 1,
      start: evidenceStart,
      end: evidenceStart + "La puerta se cerró.".length,
      excerpt: "La puerta se cerró."
    }]
  }));
  const result = LiteraryAnalysisForEvidence(text, knownEvents);
  const profile = result.characterSceneEvidence.profiles.find(item => item.entityId === "ana-id");

  assert.ok(profile);
  assert.equal(result.explicitScenes[1].eventLinks.length, 100);
  assert.equal(result.explicitScenes[1].eventLinksTruncated, true);
  assert.equal(result.characterSceneEvidence.sourceTruncatedSceneCount, 1);
  assert.deepEqual(result.characterSceneEvidence.sourceTruncatedSceneIndexes, [2]);
  assert.equal(profile.scenes[1].participationStatus, "unknown-due-to-event-truncation");
  assert.equal(profile.incompleteSceneCount, 1);
});

function LiteraryAnalysisForEvidence(text, knownEvents) {
  return analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents
  });
}

function makeAssertion({
  id, attribute = "age", value, text, phrase,
  documentId = "chapter-one", revision = 2, status, timeReference
}) {
  const start = text.indexOf(phrase);
  if (start < 0) throw new Error("No se encontró el fragmento de evidencia de prueba.");
  return {
    projectId: "literary-analysis-test",
    id,
    entityId: "ana-id",
    entityName: "Ana",
    attribute,
    value,
    evidence: {
      documentId,
      revision,
      start,
      end: start + phrase.length,
      excerpt: phrase,
      ...(status ? { status } : {})
    },
    ...(timeReference ? { timeReference } : {}),
    capturedAt: 100
  };
}

test("compara cambios y permanencias de atributos únicos entre escenas", () => {
  const text = [
    "Escena 1",
    "Ana tenía 18 años.",
    "Escena 2",
    "Ana tenía 20 años.",
    "Escena 3",
    "Ana tenía 20 años."
  ].join("\n");
  const knownAssertions = [
    makeAssertion({ id: "age-18", value: 18, text, phrase: "Ana tenía 18 años." }),
    makeAssertion({ id: "age-20-a", value: 20, text, phrase: "Ana tenía 20 años.", revision: 2 }),
    makeAssertion({ id: "age-20-b", value: 20, text, phrase: "Ana tenía 20 años.", revision: 2 })
  ];
  // Las dos afirmaciones "20" se anclan primero en la segunda aparición y en la tercera escena.
  const secondStart = text.indexOf("Ana tenía 20 años.");
  const thirdStart = text.indexOf("Ana tenía 20 años.", secondStart + 1);
  knownAssertions[1] = {
    ...knownAssertions[1],
    id: "age-20-scene-2",
    evidence: { ...knownAssertions[1].evidence, start: secondStart, end: secondStart + "Ana tenía 20 años.".length }
  };
  knownAssertions[2] = {
    ...knownAssertions[2],
    id: "age-20-scene-3",
    evidence: { ...knownAssertions[2].evidence, start: thirdStart, end: thirdStart + "Ana tenía 20 años.".length }
  };
  knownAssertions.push(
    makeAssertion({
      id: "age-stale",
      value: 17,
      text,
      phrase: "Ana tenía 18 años.",
      revision: 1,
      status: "stale"
    }),
    makeAssertion({
      id: "role-other-chapter",
      attribute: "role",
      value: "capitana",
      text: "Ana era capitana.",
      phrase: "Ana era capitana.",
      documentId: "chapter-two",
      revision: 1
    })
  );

  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 2,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownAssertions
  });
  const profile = result.characterAttributeEvolution.profiles.find(item =>
    item.entityId === "ana-id" && item.attribute === "age"
  );

  assert.ok(profile);
  assert.equal(profile.assertionCount, 3);
  assert.equal(profile.sceneCount, 3);
  assert.deepEqual(profile.scenes.map(scene => scene.values), [[18], [20], [20]]);
  assert.deepEqual(profile.transitions.map(item => item.status), ["changed-value", "unchanged-value"]);
  assert.equal(profile.changedValueTransitionCount, 1);
  assert.equal(result.characterAttributeEvolution.sourceAssertionCount, 5);
  assert.equal(result.characterAttributeEvolution.currentRevisionAssertionCount, 3);
  assert.equal(result.characterAttributeEvolution.staleAssertionCount, 1);
  assert.equal(result.characterAttributeEvolution.outOfScopeAssertionCount, 1);
  assert.equal(result.characterAttributeEvolution.unmappedCurrentAssertionCount, 0);
});

test("no convierte varios valores explícitos en una escena en una contradicción resuelta", () => {
  const text = [
    "Escena 1",
    "Ana tenía 20 años.",
    "Ana tenía 21 años.",
    "Escena 2",
    "Ana tenía 22 años."
  ].join("\n");
  const knownAssertions = [
    makeAssertion({ id: "age-20", value: 20, text, phrase: "Ana tenía 20 años." }),
    makeAssertion({ id: "age-21", value: 21, text, phrase: "Ana tenía 21 años." }),
    makeAssertion({ id: "age-22", value: 22, text, phrase: "Ana tenía 22 años." })
  ];
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 2,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownAssertions
  });
  const profile = result.characterAttributeEvolution.profiles.find(item => item.attribute === "age");

  assert.ok(profile);
  assert.deepEqual(profile.multipleValueSceneIndexes, [1]);
  assert.equal(profile.transitions[0].status, "multiple-values-in-scene");
  assert.deepEqual(profile.scenes[0].values, [20, 21]);
  assert.equal(profile.scenes[0].assertionCount, 2);
});

test("rechaza afirmaciones históricas ajenas al proyecto o a personajes no conocidos", () => {
  const text = ["Escena 1", "Ana tenía 20 años."].join("\n");
  const assertion = makeAssertion({ id: "age-20", value: 20, text, phrase: "Ana tenía 20 años." });
  assert.throws(() => analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 2,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownAssertions: [{ ...assertion, projectId: "other-project" }]
  }), /afirmaciones históricas/);
  assert.throws(() => analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 2,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownAssertions: [{ ...assertion, entityId: "unknown-character" }]
  }), /afirmaciones históricas/);
});

test("compara atributos entre capítulos solo con referencias temporales explícitas comparables", () => {
  const text = ["Escena 1", "Ana cruzó el patio."].join("\n");
  const dated = (id, value, documentId, raw, orderValue, revision = 1) => ({
    ...makeAssertion({
      id,
      value,
      text: "Ana cruzó el patio.",
      phrase: "Ana cruzó el patio.",
      documentId,
      revision
    }),
    timeReference: {
      basis: "calendar",
      precision: "year",
      raw,
      orderValue
    }
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 2,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownAssertions: [
      dated("chapter-one-age", 18, "chapter-one", "año 2020", 100, 2),
      dated("chapter-two-age", 20, "chapter-two", "año 2021", 200),
      dated("chapter-three-age", 20, "chapter-three", "año 2022", 300),
      {
        ...dated("chapter-old-age", 17, "chapter-old", "año 2019", 0),
        evidence: {
          ...dated("chapter-old-age-copy", 17, "chapter-old", "año 2019", 0).evidence,
          status: "stale"
        }
      }
    ]
  });
  const profile = result.characterAttributeEvolution.profiles.find(item => item.attribute === "age");

  assert.ok(profile);
  assert.equal(profile.sceneCount, 1, "solo la revisión del capítulo abierto se asigna a escenas");
  assert.equal(profile.projectTimelineAssertionCount, 3);
  assert.equal(profile.projectTimelinePointCount, 3);
  assert.deepEqual(profile.projectTimeline.map(item => item.rawTimeReferences), [
    ["año 2020"], ["año 2021"], ["año 2022"]
  ]);
  assert.deepEqual(profile.projectTimelineTransitions.map(item => item.status), [
    "changed-value", "unchanged-value"
  ]);
  assert.deepEqual(profile.projectTimelineTransitions.map(item => item.previousValues), [[18], [20]]);
  assert.deepEqual(profile.projectTimelineTransitions.map(item => item.nextValues), [[20], [20]]);
  assert.equal(result.characterAttributeEvolution.staleAssertionCount, 1);
  assert.equal(result.characterAttributeEvolution.outOfScopeAssertionCount, 2);
});

test("detecta dependencias candidatas con conectores causales explícitos y evidencia de dos eventos", () => {
  const text = "La tormenta provocó el derrumbe. El derrumbe ocurrió porque la tormenta llegó.";
  const baseOffset = 120;
  const evidence = (phrase, occurrence = 0) => {
    let start = -1;
    let cursor = 0;
    for (let index = 0; index <= occurrence; index++) {
      start = text.indexOf(phrase, cursor);
      if (start < 0) throw new Error("No se encontró evidencia: " + phrase);
      cursor = start + phrase.length;
    }
    return {
      documentId: "chapter-one",
      revision: 1,
      start: baseOffset + start,
      end: baseOffset + start + phrase.length,
      excerpt: phrase
    };
  };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    baseOffset,
    knownEvents: [
      {
        eventId: "storm",
        label: "La tormenta",
        participants: ["ana", "milo"],
        evidence: [evidence("La tormenta"), evidence("la tormenta")]
      },
      {
        eventId: "collapse",
        label: "El derrumbe",
        participants: ["ana", "luisa"],
        evidence: [evidence("el derrumbe"), evidence("El derrumbe")]
      }
    ]
  });

  assert.equal(result.eventDependencyAnalysis.evidenceAnchorCount, 4);
  assert.equal(result.eventDependencyAnalysis.candidateCount, 2);
  assert.deepEqual(result.eventDependencyAnalysis.candidates.map(item => item.connector), [
    "provocó", "porque"
  ]);
  assert.deepEqual(result.eventDependencyAnalysis.candidates.map(item => item.direction), [
    "cause-before-consequence", "consequence-before-cause"
  ]);
  assert.deepEqual(result.eventDependencyAnalysis.candidates.map(item => [
    item.causeEventId, item.consequenceEventId
  ]), [
    ["storm", "collapse"], ["storm", "collapse"]
  ]);
  assert.deepEqual(result.eventDependencyAnalysis.candidates[0].sharedParticipantIds, ["ana"]);
  assert.deepEqual(result.eventDependencyAnalysis.candidates[0].firstEventParticipantIds, ["ana", "milo"]);
  assert.deepEqual(result.eventDependencyAnalysis.candidates[0].secondEventParticipantIds, ["ana", "luisa"]);
  assert.equal(result.eventDependencyAnalysis.candidates[0].firstEventOccurrence.start,
    baseOffset + text.indexOf("La tormenta"));
  assert.ok(result.eventDependencyAnalysis.candidates.every(item =>
    item.status === "candidate-needs-review" &&
    item.sentenceOccurrence.end > item.sentenceOccurrence.start &&
    item.connectorOccurrence.end > item.connectorOccurrence.start
  ));
});

test("no infiere dependencias sin conector y excluye evidencia obsoleta o de otra revisión", () => {
  const text = "La tormenta precedió el derrumbe.";
  const startStorm = text.indexOf("La tormenta");
  const startCollapse = text.indexOf("el derrumbe");
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownEvents: [
      {
        eventId: "storm",
        label: "La tormenta",
        participants: [],
        evidence: [{
          documentId: "chapter-one",
          revision: 1,
          start: startStorm,
          end: startStorm + "La tormenta".length,
          excerpt: "La tormenta"
        }]
      },
      {
        eventId: "collapse",
        label: "El derrumbe",
        participants: [],
        evidence: [{
          documentId: "chapter-one",
          revision: 1,
          start: startCollapse,
          end: startCollapse + "el derrumbe".length,
          excerpt: "el derrumbe"
        }]
      },
      {
        eventId: "stale-event",
        label: "Acontecimiento obsoleto",
        participants: [],
        evidence: [{
          documentId: "chapter-one",
          revision: 1,
          start: startStorm,
          end: startStorm + "La tormenta".length,
          excerpt: "La tormenta",
          status: "stale"
        }]
      },
      {
        eventId: "other-revision",
        label: "Acontecimiento de otra revisión",
        participants: [],
        evidence: [{
          documentId: "chapter-one",
          revision: 2,
          start: startCollapse,
          end: startCollapse + "el derrumbe".length,
          excerpt: "el derrumbe"
        }]
      }
    ]
  });

  assert.equal(result.eventDependencyAnalysis.evidenceAnchorCount, 2);
  assert.equal(result.eventDependencyAnalysis.candidateCount, 0);
  assert.deepEqual(result.eventDependencyAnalysis.candidates, []);
});

test("acota las anclas de evidencia causal y cuenta las omitidas por el límite", () => {
  const text = "La tormenta provocó el derrumbe.";
  const start = text.indexOf("La tormenta");
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + "La tormenta".length,
    excerpt: "La tormenta"
  };
  const knownEvents = Array.from({ length: 11 }, (_, index) => ({
    eventId: "event-" + index,
    label: "Evento " + index,
    participants: [],
    evidence: Array.from({ length: index === 10 ? 1 : 200 }, () => ({ ...evidence }))
  }));
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownEvents
  });

  assert.equal(result.eventDependencyAnalysis.evidenceAnchorCount, 2001);
  assert.equal(result.eventDependencyAnalysis.omittedEvidenceAnchorCount, 1);
  assert.equal(result.eventDependencyAnalysis.candidateCount, 0);
});

test("construye trayectorias de personaje integrando atributos, acontecimientos y causalidades candidatas", () => {
  const text = [
    "Escena 1",
    "Ana tenía 18 años. Ana contempló cómo la tormenta provocó el derrumbe.",
    "Escena 2",
    "Ana tenía 19 años. Bruno observó la torre."
  ].join("\n");
  const evidence = phrase => {
    const start = text.indexOf(phrase);
    assert.notEqual(start, -1, "evidencia encontrada: " + phrase);
    return {
      documentId: "chapter-one",
      revision: 1,
      start,
      end: start + phrase.length,
      excerpt: phrase
    };
  };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana" },
      { entityId: "bruno-id", canonicalName: "Bruno" },
      { entityId: "carla-id", canonicalName: "Carla" }
    ],
    knownEvents: [
      {
        eventId: "storm",
        label: "La tormenta",
        participants: ["ana-id"],
        evidence: [evidence("la tormenta")]
      },
      {
        eventId: "collapse",
        label: "El derrumbe",
        participants: ["ana-id", "bruno-id"],
        evidence: [evidence("el derrumbe")]
      }
    ],
    knownProjectEvents: [
      {
        projectId: "literary-analysis-test",
        eventId: "storm",
        label: "La tormenta",
        participants: ["ana-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "año 2020", orderValue: 100 },
        evidence: [evidence("la tormenta")]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "collapse",
        label: "El derrumbe",
        participants: ["ana-id", "bruno-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "año 2021", orderValue: 200 },
        evidence: [evidence("el derrumbe")]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "untracked",
        label: "La llegada",
        participants: ["ana-id"],
        timeReference: { basis: "calendar", precision: "year", raw: "año 2022", orderValue: 300 },
        evidence: [{
          documentId: "chapter-two", revision: 2, start: 10, end: 20, excerpt: "La llegada"
        }]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "untimed",
        label: "El recuerdo",
        participants: ["ana-id"],
        evidence: [{
          documentId: "chapter-three", revision: 1, start: 0, end: 11, excerpt: "El recuerdo"
        }]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "stale-event",
        label: "La caída antigua",
        participants: ["ana-id"],
        timeReference: { basis: "calendar", precision: "year", raw: "año 2019", orderValue: 0 },
        evidence: [{
          documentId: "chapter-old", revision: 1, start: 0, end: 12,
          excerpt: "La caída antigua", status: "stale"
        }]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "unverified-event",
        label: "El rumor",
        participants: ["ana-id"],
        evidence: []
      }
    ],
    knownProjectEventsOmittedCount: 3,
    knownAssertions: [
      {
        projectId: "literary-analysis-test",
        id: "ana-age-18",
        entityId: "ana-id",
        entityName: "Ana",
        attribute: "age",
        value: 18,
        evidence: evidence("Ana tenía 18 años."),
        capturedAt: 1
      },
      {
        projectId: "literary-analysis-test",
        id: "ana-age-19",
        entityId: "ana-id",
        entityName: "Ana",
        attribute: "age",
        value: 19,
        evidence: evidence("Ana tenía 19 años."),
        capturedAt: 2
      }
    ]
  });

  const trajectories = result.characterNarrativeTrajectories.trajectories;
  const ana = trajectories.find(item => item.entityId === "ana-id");
  const bruno = trajectories.find(item => item.entityId === "bruno-id");
  const carla = trajectories.find(item => item.entityId === "carla-id");
  assert.ok(ana && bruno && carla);
  assert.equal(result.characterNarrativeTrajectories.catalogCharacterCount, 3);
  assert.equal(result.characterNarrativeTrajectories.profileCount, 3);
  assert.deepEqual(ana.attributes.find(item => item.attribute === "age").scenes.map(item => item.values), [
    [18], [19]
  ]);
  assert.equal(ana.attributes.find(item => item.attribute === "age").transitions[0].status, "changed-value");
  assert.deepEqual(ana.scenes.map(item => item.evidenceStatus), ["documented", "documented"]);
  assert.deepEqual(ana.scenes.map(item => item.eventIds), [["collapse", "storm"], []]);
  assert.equal(ana.causalRelations.length, 1);
  assert.equal(ana.causalRelations[0].characterRole, "both-events-participant");
  assert.equal(ana.scenes[0].causalCandidateIds[0], ana.causalRelations[0].candidateId);
  assert.equal(ana.projectEventTimeline.sourceEventCount, 6);
  assert.equal(ana.projectEventTimeline.timedEventCount, 3);
  assert.equal(ana.projectEventTimeline.untimedEventCount, 1);
  assert.equal(ana.projectEventTimeline.unverifiedEventCount, 1);
  assert.equal(ana.projectEventTimeline.staleEventCount, 1);
  assert.equal(result.characterNarrativeTrajectories.omittedProjectEventCount, 3);
  assert.equal(ana.projectEventTimeline.pointCount, 3);
  assert.equal(ana.projectEventTimeline.transitionCount, 1,
    "solo una pista temporal declarada autoriza transiciones entre puntos");
  assert.deepEqual(ana.projectEventTimeline.transitions.map(item => [
    item.timelineTrackId, item.fromOrderValue, item.toOrderValue
  ]), [["main", 100, 200]]);
  assert.equal(bruno.causalRelations[0].characterRole, "consequence-event-participant");
  assert.deepEqual(bruno.eventParticipation.map(item => item.eventId), ["collapse"]);
  assert.deepEqual(carla.observedSceneIndexes, []);
  assert.deepEqual(carla.scenes.map(item => item.evidenceStatus), ["no-known-evidence", "no-known-evidence"]);
});

test("las trayectorias señalan escenas con fuente truncada sin convertirlas en ausencias", () => {
  const knownCharacters = Array.from({ length: 42 }, (_, index) => ({
    entityId: "character-" + index,
    canonicalName: "Personaje " + index
  }));
  const text = [
    "Escena 1",
    ...knownCharacters.map(character => character.canonicalName + " observó el río.")
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters
  });
  const first = result.characterNarrativeTrajectories.trajectories.find(item =>
    item.entityId === "character-41"
  );
  assert.ok(first);
  assert.equal(first.scenes[0].mentionStatus, "unknown-due-to-mention-truncation");
  assert.equal(first.scenes[0].evidenceStatus, "unknown-due-to-truncation");
  assert.deepEqual(first.incompleteSceneIndexes, [1]);
  assert.equal(result.characterNarrativeTrajectories.sourceTruncatedSceneCount, 1);
});

test("la cronología de acontecimientos conserva contadores cuando recorta evidencia global", () => {
  const evidence = Array.from({ length: 200 }, (_, index) => ({
    documentId: "chapter-" + index,
    revision: 0,
    start: 0,
    end: 1,
    excerpt: "x"
  }));
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna cruzó el umbral.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownProjectEvents: [{
      projectId: "literary-analysis-test",
      eventId: "arrival",
      label: "La llegada de Ana",
      participants: ["ana-id"],
      timeReference: {
        basis: "calendar",
        precision: "year",
        raw: "año 2030",
        orderValue: 300
      },
      evidenceCount: 250,
      staleEvidenceCount: 2,
      evidence
    }]
  });
  const timeline = result.characterNarrativeTrajectories.trajectories[0].projectEventTimeline;
  assert.equal(timeline.sourceEventCount, 1);
  assert.equal(timeline.timedEventCount, 1);
  assert.equal(timeline.staleEvidenceCount, 2);
  assert.equal(timeline.points[0].evidenceCount, 250);
  assert.equal(timeline.points[0].evidenceSamples.length, 20);
  assert.equal(timeline.points[0].omittedEvidenceCount, 230);
  assert.equal(timeline.points[0].evidenceTruncated, true);
});

test("integra relaciones actuales y decisiones de ideas vinculadas en la trayectoria", () => {
  const text = [
    "Escena 1",
    "Ana habló con Bruno. La tormenta provocó el derrumbe.",
    "Escena 2",
    "Bruno recordó la promesa."
  ].join("\n");
  const evidence = phrase => {
    const start = text.indexOf(phrase);
    assert.notEqual(start, -1);
    return {
      documentId: "chapter-one",
      revision: 1,
      start,
      end: start + phrase.length,
      excerpt: phrase
    };
  };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana" },
      { entityId: "bruno-id", canonicalName: "Bruno" }
    ],
    knownEvents: [{
      eventId: "ana-meets-bruno",
      label: "Ana habla con Bruno",
      participants: ["ana-id", "bruno-id"],
      evidence: [evidence("Ana habló con Bruno.")]
    }],
    knownProjectEvents: [{
      projectId: "literary-analysis-test",
      eventId: "ana-meets-bruno",
      label: "Ana habla con Bruno",
      participants: ["ana-id", "bruno-id"],
      evidence: [
        evidence("Ana habló con Bruno."),
        {
          documentId: "chapter-two",
          revision: 2,
          start: 10,
          end: 32,
          excerpt: "La conversación continúa."
        }
      ]
    }],
    knownRelations: [
      {
        projectId: "literary-analysis-test",
        relationId: "ana-bruno",
        fromEntityId: "ana-id",
        toEntityId: "bruno-id",
        relationType: "alliance",
        evidenceCount: 1,
        staleEvidenceCount: 0,
        evidence: [evidence("Ana habló con Bruno.")]
      },
      {
        projectId: "literary-analysis-test",
        relationId: "ana-city",
        fromEntityId: "ana-id",
        toEntityId: "city-id",
        relationType: "resides-in",
        evidenceCount: 0,
        staleEvidenceCount: 1,
        evidence: []
      }
    ],
    knownIdeas: [
      {
        projectId: "literary-analysis-test",
        ideaId: "ana-decision",
        text: "Ana decide ayudar a Bruno.",
        status: "incorporated",
        originDocumentId: "chapter-one",
        sourceProjectName: "Libro de prueba",
        relatedEntityIds: ["ana-id"],
        relatedIdeaIds: ["bruno-discarded", "context-not-loaded"],
        evidenceCount: 1,
        staleEvidenceCount: 0,
        evidence: [evidence("Ana habló con Bruno.")],
        statusHistory: [
          { status: "IDEA", reason: "initial", changedAt: 1 },
          { status: "incorporated", reason: "writer", changedAt: 2 }
        ],
        writerDecisionCount: 1,
        omittedStatusHistoryCount: 0
      },
      {
        projectId: "literary-analysis-test",
        ideaId: "bruno-discarded",
        text: "Bruno abandona la ciudad.",
        status: "discarded",
        originDocumentId: "chapter-two",
        sourceProjectName: "Libro de prueba",
        relatedEntityIds: ["bruno-id"],
        relatedIdeaIds: [],
        evidenceCount: 0,
        staleEvidenceCount: 1,
        evidence: [],
        statusHistory: [
          { status: "IDEA", reason: "initial" },
          { status: "discarded", reason: "writer", changedAt: 3 }
        ],
        writerDecisionCount: 1,
        omittedStatusHistoryCount: 0
      }
    ]
  });
  const ana = result.characterNarrativeTrajectories.trajectories.find(item => item.entityId === "ana-id");
  const bruno = result.characterNarrativeTrajectories.trajectories.find(item => item.entityId === "bruno-id");
  assert.ok(ana && bruno);
  assert.equal(ana.relationships.length, 2);
  assert.deepEqual(ana.relationships.map(item => [item.relationId, item.direction]), [
    ["ana-bruno", "outgoing"],
    ["ana-city", "outgoing"]
  ]);
  assert.equal(ana.relationships[0].otherCharacterName, "Bruno");
  assert.equal(ana.relationships[0].evidenceStatus, "active-evidence");
  assert.equal(ana.relationships[1].evidenceStatus, "stale-only");
  assert.equal(ana.relationships[0].historyStatus, "current-record-only");
  assert.equal(ana.documentedDecisions[0].status, "incorporated");
  assert.equal(ana.documentedDecisions[0].currentStatusHistoryConsistency, "consistent");
  assert.equal(ana.documentedDecisions[0].nonMonotonicStatusTimestampCount, 0);
  assert.equal(ana.documentedDecisions[0].comparableStatusTimestampPairCount, 1);
  assert.deepEqual(ana.documentedDecisions[0].evidencedSceneIndexes, [1]);
  assert.deepEqual(ana.documentedDecisions[0].materializedEventIds, ["ana-meets-bruno"]);
  assert.equal(ana.documentedDecisions[0].eventMaterializationStatus, "linked-to-event");
  assert.deepEqual(ana.documentedDecisions[0].crossDocumentEventIds, ["ana-meets-bruno"]);
  assert.equal(ana.documentedDecisions[0].crossDocumentEventEvidenceCount, 1);
  assert.equal(ana.documentedDecisions[0].crossDocumentContinuityStatus, "cross-document-evidence");
  assert.equal(ana.documentedDecisions[0].writerDecisionCount, 1);
  assert.equal(bruno.documentedDecisions[0].currentStatusHistoryConsistency, "consistent");
  assert.equal(bruno.documentedDecisions[0].comparableStatusTimestampPairCount, 0);
  assert.deepEqual(bruno.documentedDecisions[0].evidencedSceneIndexes, []);
  assert.deepEqual(bruno.documentedDecisions[0].materializedEventIds, []);
  assert.equal(bruno.documentedDecisions[0].eventMaterializationStatus, "no-current-scene-evidence");
  assert.deepEqual(bruno.documentedDecisions[0].crossDocumentEventIds, []);
  assert.equal(bruno.documentedDecisions[0].crossDocumentEventEvidenceCount, 0);
  assert.equal(bruno.documentedDecisions[0].crossDocumentContinuityStatus, "not-applicable");
  assert.deepEqual(ana.documentedDecisions[0].relatedIdeaReferences, [
    { ideaId: "bruno-discarded", resolution: "included-in-analysis-snapshot" },
    { ideaId: "context-not-loaded", resolution: "not-in-analysis-snapshot" }
  ]);
  assert.deepEqual(ana.scenes[0].relationshipIds, ["ana-bruno"]);
  assert.deepEqual(ana.scenes[0].documentedDecisionIdeaIds, ["ana-decision"]);
  assert.equal(ana.writerDecisionCount, 1);
  assert.equal(bruno.documentedDecisions[0].status, "discarded");
  assert.equal(bruno.documentedDecisions[0].writerDecisionCount, 1);
  assert.equal(result.characterNarrativeTrajectories.relationshipRecordCount, 2);
  assert.equal(result.characterNarrativeTrajectories.linkedIdeaCount, 2);
  assert.equal(result.characterNarrativeTrajectories.ideaReferenceCount, 2);
  assert.equal(result.characterNarrativeTrajectories.resolvedIdeaReferenceCount, 1);
  assert.equal(result.characterNarrativeTrajectories.notIncludedIdeaReferenceCount, 1);
});

test("construye el grafo explícito de ideas y distingue referencias externas del snapshot", () => {
  const makeIdea = (
    ideaId, relatedIdeaIds = [], status = "IDEA",
    evidenceCount = 0, staleEvidenceCount = 0
  ) => ({
    projectId: "literary-analysis-test",
    ideaId,
    text: "Idea " + ideaId,
    status,
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro",
    relatedEntityIds: [],
    relatedIdeaIds,
    evidenceCount,
    staleEvidenceCount,
    evidence: [],
    statusHistory: status === "IDEA"
      ? [{ status: "IDEA", reason: "initial", changedAt: 1 }]
      : [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status, reason: "writer", changedAt: 2 }
      ],
    writerDecisionCount: status === "IDEA" ? 0 : 1,
    omittedStatusHistoryCount: 0
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nAna espera.",
    knownIdeas: [
      makeIdea("idea-a", ["idea-b"]),
      makeIdea("idea-b", ["idea-a", "context-not-loaded"], "incorporated", 2, 1),
      makeIdea("idea-c", [], "IDEA", 0, 1),
      makeIdea("idea-d", ["idea-c"], "discarded", 1, 0)
    ],
    knownIdeasOmittedCount: 3
  });
  const graph = result.ideaGraph;
  assert.equal(graph.ideaCount, 4);
  const stableStatusProfile = profile => ({
    status: profile.status,
    ideaCount: profile.ideaCount,
    sourceIdeaCount: profile.sourceIdeaCount,
    terminalWithinSnapshotIdeaCount: profile.terminalWithinSnapshotIdeaCount,
    isolatedWithinSnapshotIdeaCount: profile.isolatedWithinSnapshotIdeaCount,
    incomingReferenceCount: profile.incomingReferenceCount,
    includedOutgoingReferenceCount: profile.includedOutgoingReferenceCount,
    notIncludedOutgoingReferenceCount: profile.notIncludedOutgoingReferenceCount,
    statusHistoryRecordCount: profile.statusHistoryRecordCount,
    omittedStatusHistoryCount: profile.omittedStatusHistoryCount,
    writerDecisionCount: profile.writerDecisionCount,
    activeEvidenceCount: profile.activeEvidenceCount,
    staleEvidenceCount: profile.staleEvidenceCount,
    ideasWithActiveEvidenceCount: profile.ideasWithActiveEvidenceCount,
    ideasWithStaleEvidenceCount: profile.ideasWithStaleEvidenceCount,
    ideasWithoutActiveEvidenceCount: profile.ideasWithoutActiveEvidenceCount
  });
  assert.deepEqual(graph.statusProfiles.map(stableStatusProfile), [
    {
      status: "IDEA",
      ideaCount: 2,
      sourceIdeaCount: 0,
      terminalWithinSnapshotIdeaCount: 1,
      isolatedWithinSnapshotIdeaCount: 0,
      incomingReferenceCount: 2,
      includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 0,
      statusHistoryRecordCount: 2,
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 0,
      activeEvidenceCount: 0,
      staleEvidenceCount: 1,
      ideasWithActiveEvidenceCount: 0,
      ideasWithStaleEvidenceCount: 1,
      ideasWithoutActiveEvidenceCount: 2
    },
    {
      status: "incorporated",
      ideaCount: 1,
      sourceIdeaCount: 0,
      terminalWithinSnapshotIdeaCount: 0,
      isolatedWithinSnapshotIdeaCount: 0,
      incomingReferenceCount: 1,
      includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 1,
      statusHistoryRecordCount: 2,
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 1,
      activeEvidenceCount: 2,
      staleEvidenceCount: 1,
      ideasWithActiveEvidenceCount: 1,
      ideasWithStaleEvidenceCount: 1,
      ideasWithoutActiveEvidenceCount: 0
    },
    {
      status: "discarded",
      ideaCount: 1,
      sourceIdeaCount: 1,
      terminalWithinSnapshotIdeaCount: 0,
      isolatedWithinSnapshotIdeaCount: 0,
      incomingReferenceCount: 0,
      includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 0,
      statusHistoryRecordCount: 2,
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 1,
      activeEvidenceCount: 1,
      staleEvidenceCount: 0,
      ideasWithActiveEvidenceCount: 1,
      ideasWithStaleEvidenceCount: 0,
      ideasWithoutActiveEvidenceCount: 0
    }
  ]);
  assert.equal(graph.omittedIdeaCount, 3);
  assert.equal(graph.referenceCount, 4);
  assert.equal(graph.includedReferenceCount, 3);
  assert.equal(graph.notIncludedReferenceCount, 1);
  assert.equal(graph.reciprocalReferencePairCount, 1);
  assert.equal(graph.sourceNodeCount, 1);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 1);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 0);
  assert.equal(graph.weakComponentCount, 2);
  assert.equal(graph.omittedWeakComponentCount, 0);
  assert.equal(graph.largestWeakComponentSize, 2);
  assert.deepEqual(graph.weakComponents, [
    { representativeIdeaId: "idea-a", ideaIds: ["idea-a", "idea-b"] },
    { representativeIdeaId: "idea-c", ideaIds: ["idea-c", "idea-d"] }
  ]);
  assert.equal(graph.cycleCount, 1);
  assert.deepEqual(graph.cycles, [{ ideaIds: ["idea-a", "idea-b"] }]);
  const stableGraphNode = node => ({
    ideaId: node.ideaId,
    status: node.status,
    incomingReferenceCount: node.incomingReferenceCount,
    includedOutgoingReferenceCount: node.includedOutgoingReferenceCount,
    notIncludedOutgoingReferenceCount: node.notIncludedOutgoingReferenceCount,
    statusHistory: node.statusHistory,
    omittedStatusHistoryCount: node.omittedStatusHistoryCount,
    writerDecisionCount: node.writerDecisionCount,
    activeEvidenceCount: node.activeEvidenceCount,
    staleEvidenceCount: node.staleEvidenceCount
  });
  assert.deepEqual(graph.nodes.map(stableGraphNode), [
    {
      ideaId: "idea-a", status: "IDEA",
      incomingReferenceCount: 1, includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 0,
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 0,
      activeEvidenceCount: 0,
      staleEvidenceCount: 0
    },
    {
      ideaId: "idea-b", status: "incorporated",
      incomingReferenceCount: 1, includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 1,
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 1,
      activeEvidenceCount: 2,
      staleEvidenceCount: 1
    },
    {
      ideaId: "idea-c", status: "IDEA",
      incomingReferenceCount: 1, includedOutgoingReferenceCount: 0,
      notIncludedOutgoingReferenceCount: 0,
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 0,
      activeEvidenceCount: 0,
      staleEvidenceCount: 1
    },
    {
      ideaId: "idea-d", status: "discarded",
      incomingReferenceCount: 0, includedOutgoingReferenceCount: 1,
      notIncludedOutgoingReferenceCount: 0,
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "discarded", reason: "writer", changedAt: 2 }
      ],
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 1,
      activeEvidenceCount: 1,
      staleEvidenceCount: 0
    }
  ]);
  assert.deepEqual(graph.references, [
    { fromIdeaId: "idea-a", toIdeaId: "idea-b", resolution: "included-in-snapshot" },
    { fromIdeaId: "idea-b", toIdeaId: "context-not-loaded", resolution: "not-in-snapshot" },
    { fromIdeaId: "idea-b", toIdeaId: "idea-a", resolution: "included-in-snapshot" },
    { fromIdeaId: "idea-d", toIdeaId: "idea-c", resolution: "included-in-snapshot" }
  ]);
  assert.equal(graph.referencesTruncated, false);
});

test("acota la muestra de componentes sin perder sus totales globales", () => {
  const knownIdeas = Array.from({ length: 105 }, (_, index) => ({
    projectId: "literary-analysis-test",
    ideaId: "idea-" + String(index).padStart(3, "0"),
    text: "Idea independiente " + index,
    status: "IDEA",
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro",
    relatedEntityIds: [],
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    evidence: [],
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  }));
  const graph = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna espera.",
    knownIdeas
  }).ideaGraph;

  assert.equal(graph.weakComponentCount, 105);
  assert.equal(graph.omittedWeakComponentCount, 5);
  assert.equal(graph.weakComponents.length, 100);
  assert.equal(graph.largestWeakComponentSize, 1);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 105);
  assert.equal(graph.weakComponents[0].representativeIdeaId, "idea-000");
  assert.equal(graph.weakComponents[99].representativeIdeaId, "idea-099");
});

test("rechaza relaciones o decisiones que no pertenecen al proyecto o al catálogo de personajes", () => {
  const text = "Escena 1\nAna observó la puerta.";
  const base = {
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }]
  };
  assert.throws(() => analyzeLiteraryFragment({
    ...base,
    knownRelations: [{
      projectId: "another-project",
      relationId: "wrong-project",
      fromEntityId: "ana-id",
      toEntityId: "other",
      relationType: "ally",
      evidenceCount: 0,
      staleEvidenceCount: 0,
      evidence: []
    }]
  }), /relaciones narrativas/);
  assert.throws(() => analyzeLiteraryFragment({
    ...base,
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "wrong-entity",
      text: "Ana toma una decisión.",
      status: "IDEA",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro",
      relatedEntityIds: ["unknown-id"],
      relatedIdeaIds: [],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      evidence: [],
      statusHistory: [{ status: "IDEA", reason: "initial" }],
      omittedStatusHistoryCount: 0
    }]
  }), /ideas y decisiones/);
});

test("rechaza referencias de ideas duplicadas o autorreferenciales", () => {
  const base = {
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna espera.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }]
  };
  const idea = {
    projectId: "literary-analysis-test",
    ideaId: "idea-a",
    text: "Ana espera una señal.",
    status: "IDEA",
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro",
    relatedEntityIds: ["ana-id"],
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    evidence: [],
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
  assert.throws(() => analyzeLiteraryFragment({
    ...base,
    knownIdeas: [{ ...idea, relatedIdeaIds: ["idea-a"] }]
  }), /ideas y decisiones/);
  assert.throws(() => analyzeLiteraryFragment({
    ...base,
    knownIdeas: [{ ...idea, relatedIdeaIds: ["idea-b", "idea-b"] }]
  }), /ideas y decisiones/);
});

test("mantiene el total de decisiones de escritor cuando el historial de una idea se recorta", () => {
  const statusHistory = [{ status: "IDEA", reason: "initial", changedAt: 1 }];
  for (let index = 1; index <= 104; index++) {
    statusHistory.push({
      status: index % 2 === 1 ? "incorporated" : "discarded",
      reason: "writer",
      changedAt: index + 1
    });
  }
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna recordó su promesa.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "long-history",
      text: "Ana decide mantener su promesa.",
      status: "discarded",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      evidence: [],
      statusHistory: statusHistory.slice(-100),
      writerDecisionCount: 104,
      omittedStatusHistoryCount: 5
    }]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(decision.statusHistory.length, 100);
  assert.equal(decision.writerDecisionCount, 104);
  assert.equal(decision.omittedStatusHistoryCount, 5);
  assert.equal(result.characterNarrativeTrajectories.trajectories[0].writerDecisionCount, 104);
});

test("el grafo no reutiliza omisiones de trayectorias cuando recibe el catálogo global", () => {
  const projectId = "literary-analysis-test";
  const statusHistory = [{ status: "IDEA", reason: "initial", changedAt: 1 }];
  const result = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea permanece.",
    knownProjectIdeas: [{
      projectId,
      ideaId: "source",
      status: "IDEA",
      relatedIdeaIds: ["missing-target"],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      statusHistory,
      writerDecisionCount: 0,
      omittedStatusHistoryCount: 0
    }],
    // Este contador pertenece solo al subconjunto de ideas ligadas a personajes.
    knownIdeasOmittedCount: 7
  });

  assert.equal(result.ideaGraph.projectCatalogComplete, true);
  assert.equal(result.ideaGraph.omittedIdeaCount, 0);
  assert.equal(result.ideaGraph.notIncludedReferenceCount, 1);
  assert.equal(result.ideaGraph.missingFromProjectReferenceCount, 1);
  assert.equal(result.ideaGraph.references[0].resolution, "missing-from-project");
  result.ideaGraph.nodes[0].statusHistory[0].reason = "writer";
  assert.equal(statusHistory[0].reason, "initial");
});

test("el catálogo de compatibilidad no presenta como ausentes ideas fuera del subconjunto de personajes", () => {
  const projectId = "literary-analysis-test";
  const result = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna recordó el origen.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [{
      projectId,
      ideaId: "character-idea",
      text: "Ana recuerda su promesa.",
      status: "IDEA",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: ["unlinked-idea"],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      evidence: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
      writerDecisionCount: 0,
      omittedStatusHistoryCount: 0
    }],
    knownIdeasOmittedCount: 0
  });

  assert.equal(result.ideaGraph.catalogScope, "character-linked-fallback");
  assert.equal(result.ideaGraph.projectCatalogComplete, false);
  assert.equal(result.ideaGraph.omittedIdeaCount, 0);
  assert.equal(result.ideaGraph.notIncludedReferenceCount, 1);
  assert.equal(result.ideaGraph.missingFromProjectReferenceCount, 0);
  assert.equal(result.ideaGraph.references[0].resolution, "not-in-snapshot");
});

test("el grafo conserva orden determinista ante permutaciones del catálogo", () => {
  const projectId = "literary-analysis-test";
  const catalog = [
    {
      projectId, ideaId: "delta", status: "IDEA", relatedIdeaIds: ["alpha"],
      evidenceCount: 0, staleEvidenceCount: 0,
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
      writerDecisionCount: 0, omittedStatusHistoryCount: 0
    },
    {
      projectId, ideaId: "alpha", status: "incorporated", relatedIdeaIds: ["gamma"],
      evidenceCount: 2, staleEvidenceCount: 1,
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1, omittedStatusHistoryCount: 0
    },
    {
      projectId, ideaId: "gamma", status: "discarded", relatedIdeaIds: [],
      evidenceCount: 0, staleEvidenceCount: 0,
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "discarded", reason: "writer", changedAt: 3 }
      ],
      writerDecisionCount: 1, omittedStatusHistoryCount: 0
    }
  ];
  const analyzeCatalog = knownProjectIdeas => analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nLa idea permanece.",
    knownProjectIdeas
  }).ideaGraph;

  const ordered = analyzeCatalog(catalog);
  const permuted = analyzeCatalog([catalog[2], catalog[0], catalog[1]]);
  assert.deepEqual(permuted, ordered);
  assert.deepEqual(ordered.nodes.map(node => node.ideaId), ["alpha", "delta", "gamma"]);
  assert.equal(ordered.catalogScope, "project");
  assert.equal(ordered.projectCatalogComplete, true);
});

test("valida identidad, enlaces, historial y contador de omisión del catálogo global", () => {
  const projectId = "literary-analysis-test";
  const idea = {
    projectId,
    ideaId: "global-idea",
    status: "IDEA",
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
  const input = {
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea.",
    knownProjectIdeas: [idea]
  };

  assert.equal(analyzeLiteraryFragment(input).ideaGraph.ideaCount, 1);
  assert.throws(
    () => analyzeLiteraryFragment({ ...input, knownProjectIdeas: [idea, { ...idea }] }),
    /catálogo global de ideas/
  );
  assert.throws(
    () => analyzeLiteraryFragment({
      ...input,
      knownProjectIdeas: [{ ...idea, relatedIdeaIds: ["global-idea"] }]
    }),
    /catálogo global de ideas/
  );
  assert.throws(
    () => analyzeLiteraryFragment({
      ...input,
      knownProjectIdeas: [{
        ...idea,
        relatedIdeaIds: Array.from({ length: 501 }, (_, index) => "linked-" + index)
      }]
    }),
    /catálogo global de ideas/
  );
  assert.throws(
    () => analyzeLiteraryFragment({ ...input, knownProjectIdeasOmittedCount: -1 }),
    /Contexto de análisis literario inválido/
  );
  assert.throws(
    () => analyzeLiteraryFragment({
      ...input,
      knownProjectIdeas: [{
        ...idea,
        statusHistory: [{ status: "unknown", reason: "initial" }]
      }]
    }),
    /historial de decisiones del catálogo global/
  );
  for (const invalidHistory of [
    [],
    [{ status: "incorporated", reason: "initial" }],
    [{ status: "IDEA", reason: "writer", changedAt: 1 }],
    [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "IDEA", reason: "writer", changedAt: 2 }
    ],
    [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "incorporated", reason: "writer", changedAt: 3 },
      { status: "discarded", reason: "writer", changedAt: 2 }
    ],
    [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "incorporated", reason: "writer", changedAt: 2 }
    ]
  ]) {
    assert.throws(
      () => analyzeLiteraryFragment({
        ...input,
        knownProjectIdeas: [{
          ...idea,
          statusHistory: invalidHistory,
          writerDecisionCount: 1
        }]
      }),
      /historial de decisiones del catálogo global/
    );
  }

  assert.throws(
    () => analyzeLiteraryFragment({
      ...input,
      knownProjectIdeas: [{
        ...idea,
        status: "discarded",
        statusHistory: [
          { status: "incorporated", reason: "initial", changedAt: 1 },
          { status: "discarded", reason: "text-revised", changedAt: 2 }
        ],
        writerDecisionCount: 0
      }]
    }),
    /historial de decisiones del catálogo global/
  );

  const truncated = analyzeLiteraryFragment({
    ...input,
    knownProjectIdeas: [{
      ...idea,
      ideaId: "truncated-history",
      status: "incorporated",
      statusHistory: [
        { status: "discarded", reason: "writer", changedAt: 10 },
        { status: "incorporated", reason: "writer", changedAt: 20 }
      ],
      writerDecisionCount: 2,
      omittedStatusHistoryCount: 3
    }]
  });
  assert.equal(truncated.ideaGraph.nodes[0].status, "incorporated");
  assert.equal(truncated.ideaGraph.nodes[0].statusHistory.length, 2);
  assert.equal(truncated.ideaGraph.nodes[0].omittedStatusHistoryCount, 3);

  assert.throws(
    () => analyzeLiteraryFragment({
      ...input,
      knownProjectIdeas: [{
        ...idea,
        ideaId: "impossible-decision-count",
        status: "incorporated",
        statusHistory: [
          { status: "discarded", reason: "writer", changedAt: 10 },
          { status: "incorporated", reason: "writer", changedAt: 20 }
        ],
        writerDecisionCount: 5,
        omittedStatusHistoryCount: 3
      }]
    }),
    /historial de decisiones del catálogo global/
  );
});

test("distingue IDs Unicode distintos aunque el orden lingüístico los equipare", () => {
  const projectId = "literary-analysis-test";
  const composedId = "é";
  const decomposedId = "e\u0301";
  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea.",
    knownProjectIdeas: [
      {
        projectId,
        ideaId: composedId,
        status: "IDEA",
        relatedIdeaIds: [decomposedId],
        evidenceCount: 0,
        staleEvidenceCount: 0,
        statusHistory: [{ status: "IDEA", reason: "initial" }],
        writerDecisionCount: 0,
        omittedStatusHistoryCount: 0
      },
      {
        projectId,
        ideaId: decomposedId,
        status: "IDEA",
        relatedIdeaIds: [],
        evidenceCount: 0,
        staleEvidenceCount: 0,
        statusHistory: [{ status: "IDEA", reason: "initial" }],
        writerDecisionCount: 0,
        omittedStatusHistoryCount: 0
      }
    ]
  }).ideaGraph;

  assert.deepEqual(graph.nodes.map(node => node.ideaId), [decomposedId, composedId]);
  assert.equal(graph.referenceCount, 1);
  assert.equal(graph.includedReferenceCount, 1);
  assert.equal(graph.reciprocalReferencePairCount, 0);
  assert.equal(graph.references[0].resolution, "included-in-snapshot");
});


test("el grafo de ideas es determinista ante permutaciones del catálogo y sus referencias", () => {
  const makeIdea = (ideaId, relatedIdeaIds = []) => ({
    projectId: "literary-analysis-test",
    ideaId,
    text: "Idea " + ideaId,
    status: "IDEA",
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro",
    relatedEntityIds: [],
    relatedIdeaIds,
    evidenceCount: 0,
    staleEvidenceCount: 0,
    evidence: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  });
  const catalog = [
    makeIdea("idea-c", ["idea-a", "external-z"]),
    makeIdea("idea-a", ["idea-b"]),
    makeIdea("idea-b", ["idea-c", "idea-a"]),
    makeIdea("idea-d")
  ];
  const analyzeCatalog = knownIdeas => analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nUna idea permanece.",
    knownIdeas
  }).ideaGraph;

  const baseline = analyzeCatalog(catalog);
  const permuted = analyzeCatalog([
    makeIdea("idea-d"),
    makeIdea("idea-b", ["idea-a", "idea-c"]),
    makeIdea("idea-a", ["idea-b"]),
    makeIdea("idea-c", ["external-z", "idea-a"])
  ]);

  assert.deepEqual(permuted, baseline);
  assert.deepEqual(baseline.nodes.map(node => node.ideaId), [
    "idea-a", "idea-b", "idea-c", "idea-d"
  ]);
  assert.deepEqual(baseline.references, [
    { fromIdeaId: "idea-a", toIdeaId: "idea-b", resolution: "included-in-snapshot" },
    { fromIdeaId: "idea-b", toIdeaId: "idea-a", resolution: "included-in-snapshot" },
    { fromIdeaId: "idea-b", toIdeaId: "idea-c", resolution: "included-in-snapshot" },
    { fromIdeaId: "idea-c", toIdeaId: "external-z", resolution: "not-in-snapshot" },
    { fromIdeaId: "idea-c", toIdeaId: "idea-a", resolution: "included-in-snapshot" }
  ]);
});


test("analiza iterativamente un ciclo largo sin depender de la pila recursiva", () => {
  const projectId = "literary-analysis-test";
  const nodeCount = 1500;
  const knownProjectIdeas = Array.from({ length: nodeCount }, (_, index) => ({
    projectId,
    ideaId: "node-" + String(index).padStart(4, "0"),
    status: "IDEA",
    relatedIdeaIds: [
      "node-" + String((index + 1) % nodeCount).padStart(4, "0")
    ],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  }));

  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nUna cadena de ideas permanece.",
    knownProjectIdeas
  }).ideaGraph;

  assert.equal(graph.ideaCount, nodeCount);
  assert.equal(graph.referenceCount, nodeCount);
  assert.equal(graph.includedReferenceCount, nodeCount);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.largestWeakComponentSize, nodeCount);
  assert.equal(graph.sourceNodeCount, 0);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 0);
  assert.equal(graph.cycleCount, 1);
  assert.equal(graph.cycles[0].ideaIds.length, nodeCount);
  assert.equal(graph.cycles[0].ideaIds[0], "node-0000");
  assert.equal(graph.cycles[0].ideaIds.at(-1), "node-1499");
});


test("aísla del caché las mutaciones de resultados del grafo de ideas", () => {
  const projectId = "literary-analysis-test";
  const input = {
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nLa promesa permanece.",
    knownProjectIdeas: [
      {
        projectId,
        ideaId: "idea-a",
        text: "La promesa permanece.",
        status: "IDEA",
        relatedIdeaIds: ["idea-b"],
        evidenceCount: 0,
        staleEvidenceCount: 0,
        statusHistory: [{ status: "IDEA", reason: "initial" }],
        writerDecisionCount: 0,
        omittedStatusHistoryCount: 0
      },
      {
        projectId,
        ideaId: "idea-b",
        text: "La promesa cambia.",
        status: "incorporated",
        relatedIdeaIds: [],
        evidenceCount: 0,
        staleEvidenceCount: 0,
        statusHistory: [
          { status: "IDEA", reason: "initial" },
          { status: "incorporated", reason: "writer" }
        ],
        writerDecisionCount: 1,
        omittedStatusHistoryCount: 0
      }
    ]
  };

  const first = analyzeLiteraryFragment(input).ideaGraph;
  first.nodes[0].statusHistory[0].reason = "tampered";
  first.nodes.push({ ...first.nodes[0], ideaId: "injected" });
  first.references[0].toIdeaId = "injected";
  first.cycles.push({ ideaIds: ["injected"] });
  first.lexicalResonances.resonances.push({
    leftIdeaId: "injected",
    rightIdeaId: "injected",
    leftTermCount: 0,
    rightTermCount: 0,
    sharedTermCount: 0,
    jaccardSimilarity: 0,
    frequencyWeightedJaccardSimilarity: 0,
    frequencyCosineSimilarity: 0,
    leftVocabularyCoverage: 0,
    rightVocabularyCoverage: 0,
    leftFrequencyCoverage: 0,
    rightFrequencyCoverage: 0,
    overlapCoefficient: 0,
    sharedTerms: [],
    sharedTermFrequencies: [],
    omittedSharedTermCount: 0
  });

  const second = analyzeLiteraryFragment(input).ideaGraph;
  assert.equal(second.nodes.length, 2);
  assert.equal(second.nodes[0].statusHistory[0].reason, "initial");
  assert.equal(second.references[0].toIdeaId, "idea-b");
  assert.equal(second.cycles.length, 0);
  assert.equal(second.lexicalResonances.resonances.some(
    resonance => resonance.leftIdeaId === "injected"
  ), false);
});


test("invalida el caché del grafo cuando cambia una relación o el texto de una idea", () => {
  const projectId = "literary-analysis-test";
  const ideaA = {
    projectId,
    ideaId: "idea-a",
    text: "La promesa permanece en silencio.",
    status: "IDEA",
    relatedIdeaIds: ["idea-b"],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
  const ideaB = {
    projectId,
    ideaId: "idea-b",
    text: "La promesa permanece en silencio.",
    status: "IDEA",
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
  const ideaC = {
    projectId,
    ideaId: "idea-c",
    text: "El invierno comienza lejos.",
    status: "IDEA",
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
  const input = {
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nLa promesa permanece.",
    knownProjectIdeas: [ideaA, ideaB, ideaC]
  };

  const initial = analyzeLiteraryFragment(input).ideaGraph;
  assert.equal(initial.references[0].toIdeaId, "idea-b");
  assert.ok(initial.lexicalResonances.resonances.some(
    resonance => resonance.leftIdeaId === "idea-a" &&
      resonance.rightIdeaId === "idea-b"
  ));

  ideaA.relatedIdeaIds[0] = "idea-c";
  ideaA.text = "El invierno comienza lejos.";
  const updated = analyzeLiteraryFragment(input).ideaGraph;

  assert.equal(updated.references[0].toIdeaId, "idea-c");
  assert.ok(updated.lexicalResonances.resonances.some(
    resonance => resonance.leftIdeaId === "idea-a" &&
      resonance.rightIdeaId === "idea-c"
  ));
  assert.ok(!updated.lexicalResonances.resonances.some(
    resonance => resonance.leftIdeaId === "idea-a" &&
      resonance.rightIdeaId === "idea-b"
  ));
});


test("el caché distingue catálogos incompletos de catálogos globales completos", () => {
  const projectId = "literary-analysis-test";
  const knownProjectIdeas = [{
    projectId,
    ideaId: "idea-a",
    text: "Una idea permanece.",
    status: "IDEA",
    relatedIdeaIds: ["idea-outside-snapshot"],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  }];
  const input = {
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\\nUna idea permanece.",
    knownProjectIdeas,
    knownProjectIdeasOmittedCount: 1
  };

  const partial = analyzeLiteraryFragment(input).ideaGraph;
  assert.equal(partial.catalogScope, "project");
  assert.equal(partial.references[0].resolution, "not-in-snapshot");
  assert.equal(partial.missingFromProjectReferenceCount, 0);

  const complete = analyzeLiteraryFragment({
    ...input,
    knownProjectIdeasOmittedCount: 0
  }).ideaGraph;
  assert.equal(complete.catalogScope, "project");
  assert.equal(complete.references[0].resolution, "missing-from-project");
  assert.equal(complete.missingFromProjectReferenceCount, 1);

  const partialAgain = analyzeLiteraryFragment(input).ideaGraph;
  assert.equal(partialAgain.references[0].resolution, "not-in-snapshot");
  assert.equal(partialAgain.missingFromProjectReferenceCount, 0);
});


test("cuenta co-menciones de personajes por escena sin confundirlas con relaciones", () => {
  const text = [
    "Escena 1",
    "Ana encontró a Luis. Anita llamó a Luis otra vez.",
    "Escena 2",
    "Ana y Luis hablaron con Marta.",
    "Escena 3",
    "Marta caminó sola."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana", aliases: ["Anita"] },
      { entityId: "luis-id", canonicalName: "Luis" },
      { entityId: "marta-id", canonicalName: "Marta" }
    ]
  });

  assert.deepEqual(result.characterCoMentions, [
    {
      characterIds: ["ana-id", "luis-id"],
      sharedSceneCount: 2,
      sceneIndexes: [1, 2]
    },
    {
      characterIds: ["ana-id", "marta-id"],
      sharedSceneCount: 1,
      sceneIndexes: [2]
    },
    {
      characterIds: ["luis-id", "marta-id"],
      sharedSceneCount: 1,
      sceneIndexes: [2]
    }
  ]);
  assert.equal(result.characterCoMentions[0].sharedSceneCount, 2);
  assert.equal(result.characterCoMentions[0].sceneIndexes.length, 2);
});


test("no asigna alias ambiguos a personajes ni genera co-menciones falsas", () => {
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: [
      "Escena 1",
      "Alex habló con Luis."
    ].join("\n"),
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana", aliases: ["Alex"] },
      { entityId: "alex-id", canonicalName: "Alex" },
      { entityId: "luis-id", canonicalName: "Luis" }
    ]
  });

  assert.deepEqual(result.characterCoMentions, []);
  assert.deepEqual(
    result.characterMentionDistributions.characters.map(character => character.entityId),
    ["luis-id"]
  );
  assert.equal(result.characterMentionDistributions.characters[0].totalMentionCount, 1);
});


test("las trayectorias resuelven escenas con evidencia posterior a las primeras veinte muestras", () => {
  const phrases = Array.from({ length: 21 }, (_, index) =>
    "Ana habló con Bruno durante el encuentro número " + (index + 1) + "."
  );
  const text = [
    "Escena 1",
    ...phrases.slice(0, 20),
    "Escena 2",
    phrases[20]
  ].join("\n");
  const evidence = phrase => {
    const start = text.indexOf(phrase);
    assert.notEqual(start, -1);
    return {
      documentId: "chapter-one",
      revision: 1,
      start,
      end: start + phrase.length,
      excerpt: phrase
    };
  };
  const evidenceSamples = [
    ...phrases.slice(0, 19).map(evidence),
    evidence(phrases[20])
  ];
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana" },
      { entityId: "bruno-id", canonicalName: "Bruno" }
    ],
    knownRelations: [{
      projectId: "literary-analysis-test",
      relationId: "ana-bruno",
      fromEntityId: "ana-id",
      toEntityId: "bruno-id",
      relationType: "alliance",
      evidenceCount: 21,
      staleEvidenceCount: 0,
      evidence: evidenceSamples
    }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana decide confiar en Bruno.",
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 21,
      staleEvidenceCount: 0,
      evidence: evidenceSamples,
      statusHistory: [{ status: "incorporated", reason: "writer", changedAt: 2 }],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  });

  const ana = result.characterNarrativeTrajectories.trajectories.find(
    item => item.entityId === "ana-id"
  );
  assert.ok(ana);
  assert.deepEqual(ana.scenes[1].relationshipIds, ["ana-bruno"]);
  assert.deepEqual(ana.scenes[1].documentedDecisionIdeaIds, ["ana-decision"]);
  assert.ok(ana.scenes[1].incompleteReasons.includes("relationship-evidence-truncation"));
  assert.ok(ana.scenes[1].incompleteReasons.includes("decision-evidence-truncation"));
  assert.equal(ana.relationships[0].evidenceSamples.length, 20);
  assert.equal(ana.relationships[0].evidenceTruncated, true);
  assert.equal(ana.documentedDecisions[0].evidenceSamples.length, 20);
  assert.equal(ana.documentedDecisions[0].evidenceTruncated, true);
});


test("las trayectorias ignoran evidencia obsoleta y evidencia de otros documentos o revisiones", () => {
  const text = "Escena 1\nAna habló con Bruno.";
  const phrase = "Ana habló con Bruno.";
  const start = text.indexOf(phrase);
  const makeEvidence = (documentId, revision, status) => ({
    documentId,
    revision,
    start,
    end: start + phrase.length,
    excerpt: phrase,
    ...(status ? { status } : {})
  });
  const foreignEvidence = [
    makeEvidence("chapter-two", 1),
    makeEvidence("chapter-one", 2)
  ];
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [
      { entityId: "ana-id", canonicalName: "Ana" },
      { entityId: "bruno-id", canonicalName: "Bruno" }
    ],
    knownRelations: [{
      projectId: "literary-analysis-test",
      relationId: "ana-bruno",
      fromEntityId: "ana-id",
      toEntityId: "bruno-id",
      relationType: "alliance",
      evidenceCount: 2,
      staleEvidenceCount: 1,
      evidence: foreignEvidence
    }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana decide confiar en Bruno.",
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 2,
      staleEvidenceCount: 1,
      evidence: foreignEvidence,
      statusHistory: [{ status: "incorporated", reason: "writer", changedAt: 2 }],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  });

  const ana = result.characterNarrativeTrajectories.trajectories.find(
    item => item.entityId === "ana-id"
  );
  assert.ok(ana);
  assert.deepEqual(ana.scenes[0].relationshipIds, []);
  assert.deepEqual(ana.scenes[0].documentedDecisionIdeaIds, []);
  assert.equal(ana.scenes[0].evidenceStatus, "no-known-evidence");
  assert.equal(ana.relationships[0].evidenceStatus, "active-evidence");
  assert.equal(ana.documentedDecisions[0].evidenceCount, 2);
});


test("la cronología de proyecto excluye posiciones temporales no finitas", () => {
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start: 0,
    end: 5,
    excerpt: "Ana."
  };
  const makeEvent = (eventId, orderValue) => ({
    projectId: "literary-analysis-test",
    eventId,
    label: eventId,
    participants: ["ana-id"],
    timelineTrackId: "main",
    timeReference: {
      basis: "calendar",
      precision: "year",
      raw: String(orderValue),
      orderValue
    },
    evidence: [evidence]
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownProjectEvents: [
      makeEvent("valid", 2020),
      makeEvent("not-a-number", Number.NaN),
      makeEvent("infinite", Number.POSITIVE_INFINITY)
    ]
  });
  const timeline = result.characterNarrativeTrajectories.trajectories[0].projectEventTimeline;

  assert.equal(timeline.sourceEventCount, 3);
  assert.equal(timeline.timedEventCount, 1);
  assert.equal(timeline.unverifiedEventCount, 2);
  assert.equal(timeline.pointCount, 1);
  assert.deepEqual(timeline.points[0].eventIds, ["valid"]);
  assert.equal(timeline.transitionCount, 0);
});


test("la cronología excluye IDs de acontecimiento con posiciones incompatibles", () => {
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start: 0,
    end: 5,
    excerpt: "Ana."
  };
  const makeEvent = (orderValue, label) => ({
    projectId: "literary-analysis-test",
    eventId: "same-event",
    label,
    participants: ["ana-id"],
    timelineTrackId: "main",
    timeReference: {
      basis: "calendar",
      precision: "year",
      raw: String(orderValue),
      orderValue
    },
    evidence: [evidence]
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownProjectEvents: [
      makeEvent(2020, "La tormenta"),
      makeEvent(2021, "La tormenta")
    ]
  });
  const timeline = result.characterNarrativeTrajectories.trajectories[0].projectEventTimeline;

  assert.equal(timeline.sourceEventCount, 2);
  assert.equal(timeline.timedEventCount, 0);
  assert.equal(timeline.unverifiedEventCount, 2);
  assert.equal(timeline.pointCount, 0);
  assert.equal(timeline.transitionCount, 0);
});


test("la cronología aísla IDs reutilizados con identidades narrativas distintas", () => {
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start: 0,
    end: 5,
    excerpt: "Ana."
  };
  const makeEvent = (label) => ({
    projectId: "literary-analysis-test",
    eventId: "reused-event",
    label,
    participants: ["ana-id"],
    timelineTrackId: "main",
    timeReference: {
      basis: "calendar",
      precision: "year",
      raw: "2020",
      orderValue: 2020
    },
    evidence: [evidence]
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownProjectEvents: [
      makeEvent("La tormenta"),
      makeEvent("La coronación")
    ]
  });
  const timeline = result.characterNarrativeTrajectories.trajectories[0].projectEventTimeline;

  assert.equal(timeline.sourceEventCount, 2);
  assert.equal(timeline.timedEventCount, 0);
  assert.equal(timeline.unverifiedEventCount, 2);
  assert.equal(timeline.pointCount, 0);
  assert.equal(timeline.transitionCount, 0);
});


test("contrasta las dependencias causales con el orden temporal del proyecto", () => {
  const text = "Escena 1\nLa tormenta provocó el derrumbe.";
  const stormStart = text.indexOf("La tormenta");
  const collapseStart = text.indexOf("el derrumbe");
  const evidence = (start, phrase) => ({
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  });
  const eventEvidence = [
    evidence(stormStart, "La tormenta"),
    evidence(collapseStart, "el derrumbe")
  ];
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents: [
      { eventId: "storm", label: "La tormenta", participants: ["ana-id"], evidence: [eventEvidence[0]] },
      { eventId: "collapse", label: "El derrumbe", participants: ["ana-id"], evidence: [eventEvidence[1]] }
    ],
    knownProjectEvents: [
      {
        projectId: "literary-analysis-test",
        eventId: "storm",
        label: "La tormenta",
        participants: ["ana-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "2021", orderValue: 2021 },
        evidence: [eventEvidence[0]]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "collapse",
        label: "El derrumbe",
        participants: ["ana-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "2020", orderValue: 2020 },
        evidence: [eventEvidence[1]]
      }
    ]
  });
  const trajectory = result.characterNarrativeTrajectories.trajectories[0];
  assert.equal(trajectory.causalRelations.length, 1);
  assert.equal(trajectory.causalRelations[0].temporalConsistency, "contradiction");
});


test("vincula decisiones con acontecimientos posteriores solo en escalas temporales comparables", () => {
  const text = "Escena 1\nAna decide cruzar el puente.";
  const phrase = "Ana decide cruzar el puente.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const makeEvent = (eventId, orderValue, options = {}) => ({
    projectId: "literary-analysis-test",
    eventId,
    label: eventId,
    participants: ["ana-id"],
    timelineTrackId: options.track ?? "main",
    timeReference: {
      basis: options.basis ?? "calendar",
      precision: options.precision ?? "year",
      raw: String(orderValue),
      orderValue
    },
    evidence: [evidence]
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents: [{
      eventId: "decision-event",
      label: "La decisión",
      participants: ["ana-id"],
      evidence: [evidence]
    }],
    knownProjectEvents: [
      makeEvent("decision-event", 2020),
      makeEvent("later-event", 2022),
      makeEvent("other-track", 2023, { track: "dreams" }),
      makeEvent("other-basis", 2024, { basis: "story-day", precision: "day-index" }),
      makeEvent("earlier-event", 2019)
    ],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana decide cruzar el puente.",
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 1,
      staleEvidenceCount: 0,
      evidence: [evidence],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.deepEqual(decision.materializedEventIds, ["decision-event"]);
  assert.deepEqual(decision.laterDocumentedEventIds, ["later-event"]);
  assert.equal(decision.laterDocumentedEventCount, 1);
  assert.equal(decision.laterEventChronologyStatus, "later-events-found");
});


test("la cronología de decisiones no convierte evidencia obsoleta en acontecimientos posteriores", () => {
  const text = "Escena 1\nAna decide esperar.";
  const phrase = "Ana decide esperar.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const staleEvidence = { ...evidence, status: "stale" };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents: [{
      eventId: "decision-event",
      label: "La decisión",
      participants: ["ana-id"],
      evidence: [evidence]
    }],
    knownProjectEvents: [
      {
        projectId: "literary-analysis-test",
        eventId: "decision-event",
        label: "La decisión",
        participants: ["ana-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "2020", orderValue: 2020 },
        evidence: [evidence]
      },
      {
        projectId: "literary-analysis-test",
        eventId: "stale-later-event",
        label: "Acontecimiento obsoleto",
        participants: ["ana-id"],
        timelineTrackId: "main",
        timeReference: { basis: "calendar", precision: "year", raw: "2025", orderValue: 2025 },
        evidenceCount: 0,
        staleEvidenceCount: 1,
        evidence: [staleEvidence]
      }
    ],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana decide esperar.",
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 1,
      staleEvidenceCount: 0,
      evidence: [evidence],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.deepEqual(decision.laterDocumentedEventIds, []);
  assert.equal(decision.laterEventChronologyStatus, "no-later-event-in-snapshot");
});


test("la cronología de decisiones conserva incertidumbre ante referencias ausentes y catálogos parciales", () => {
  const text = "Escena 1\nAna decide marcharse.";
  const phrase = "Ana decide marcharse.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const base = {
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownEvents: [{
      eventId: "decision-event",
      label: "La decisión",
      participants: ["ana-id"],
      evidence: [evidence]
    }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana decide marcharse.",
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 1,
      staleEvidenceCount: 0,
      evidence: [evidence],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  };
  const withoutTime = analyzeLiteraryFragment({
    ...base,
    knownProjectEvents: [{
      projectId: "literary-analysis-test",
      eventId: "decision-event",
      label: "La decisión",
      participants: ["ana-id"],
      evidence: [evidence]
    }]
  }).characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(withoutTime.laterEventChronologyStatus, "unknown-time-reference");

  const partialCatalog = analyzeLiteraryFragment({
    ...base,
    knownProjectEvents: [{
      projectId: "literary-analysis-test",
      eventId: "decision-event",
      label: "La decisión",
      participants: ["ana-id"],
      timelineTrackId: "main",
      timeReference: { basis: "calendar", precision: "year", raw: "2020", orderValue: 2020 },
      evidence: [evidence]
    }],
    knownProjectEventsOmittedCount: 2
  }).characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(partialCatalog.laterEventChronologyStatus, "unknown-due-to-incomplete-catalog");
});


test("las trayectorias detectan reaperturas explícitas en el historial de decisiones", () => {
  const text = "Escena 1\nAna decide volver a estudiar.";
  const phrase = "Ana decide volver a estudiar.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: phrase,
      status: "IDEA",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 1,
      staleEvidenceCount: 0,
      evidence: [evidence],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 10 },
        { status: "incorporated", reason: "writer", changedAt: 20 },
        { status: "IDEA", reason: "text-revised", changedAt: 30 }
      ],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 0
    }]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(decision.statusEvolutionStatus, "reopened");
  assert.equal(decision.reopeningCount, 1);
  assert.deepEqual(decision.statusTransitions, [
    { fromStatus: "IDEA", toStatus: "incorporated", changedAt: 20, reason: "writer" },
    { fromStatus: "incorporated", toStatus: "IDEA", changedAt: 30, reason: "text-revised" }
  ]);
  assert.equal(decision.currentStatusHistoryConsistency, "consistent");
});


test("las trayectorias no concluyen la evolución cuando el historial de decisiones está truncado", () => {
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nAna espera.",
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "ana-decision",
      text: "Ana espera.",
      status: "IDEA",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: [],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      evidence: [],
      statusHistory: [
        { status: "incorporated", reason: "writer", changedAt: 20 },
        { status: "IDEA", reason: "text-revised", changedAt: 30 }
      ],
      writerDecisionCount: 1,
      omittedStatusHistoryCount: 2
    }]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(decision.statusEvolutionStatus, "unknown-incomplete-history");
  assert.equal(decision.reopeningCount, 0);
  assert.equal(decision.currentStatusHistoryConsistency, "unknown");
});


test("las decisiones muestran divergencia de estados entre ideas relacionadas sin inferir contradicción", () => {
  const text = "Escena 1\nAna espera una respuesta.";
  const phrase = "Ana espera una respuesta.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const makeIdea = (ideaId, status, relatedIdeaIds = []) => ({
    projectId: "literary-analysis-test",
    ideaId,
    text: ideaId,
    status,
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro de prueba",
    relatedEntityIds: ["ana-id"],
    relatedIdeaIds,
    evidenceCount: 1,
    staleEvidenceCount: 0,
    evidence: [evidence],
    statusHistory: [{ status, reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  });
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [
      makeIdea("idea-a", "incorporated", ["idea-b", "idea-c"]),
      makeIdea("idea-b", "discarded"),
      makeIdea("idea-c", "incorporated")
    ]
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0]
    .documentedDecisions.find(item => item.ideaId === "idea-a");
  assert.equal(decision.relatedIdeaStateStatus, "mixed-status");
  assert.equal(decision.relatedIdeaStateDivergenceCount, 1);
  assert.deepEqual(decision.relatedIdeaStateProfiles, [
    { ideaId: "idea-b", status: "discarded", resolution: "included-in-analysis-snapshot" },
    { ideaId: "idea-c", status: "incorporated", resolution: "included-in-analysis-snapshot" }
  ]);
});


test("las decisiones mantienen desconocido el estado relacionado si el catálogo está incompleto", () => {
  const text = "Escena 1\nAna espera.";
  const phrase = "Ana espera.";
  const start = text.indexOf(phrase);
  const evidence = {
    documentId: "chapter-one",
    revision: 1,
    start,
    end: start + phrase.length,
    excerpt: phrase
  };
  const result = analyzeLiteraryFragment({
    projectId: "literary-analysis-test",
    documentId: "chapter-one",
    revision: 1,
    text,
    knownCharacters: [{ entityId: "ana-id", canonicalName: "Ana" }],
    knownIdeas: [{
      projectId: "literary-analysis-test",
      ideaId: "idea-a",
      text: phrase,
      status: "incorporated",
      originDocumentId: "chapter-one",
      sourceProjectName: "Libro de prueba",
      relatedEntityIds: ["ana-id"],
      relatedIdeaIds: ["idea-b"],
      evidenceCount: 1,
      staleEvidenceCount: 0,
      evidence: [evidence],
      statusHistory: [{ status: "incorporated", reason: "initial" }],
      writerDecisionCount: 0,
      omittedStatusHistoryCount: 0
    }],
    knownProjectIdeasOmittedCount: 3
  });
  const decision = result.characterNarrativeTrajectories.trajectories[0].documentedDecisions[0];
  assert.equal(decision.relatedIdeaStateStatus, "unknown-due-to-incomplete-snapshot");
  assert.equal(decision.relatedIdeaStateDivergenceCount, 0);
  assert.deepEqual(decision.relatedIdeaStateProfiles, []);
});


test("el grafo resume estados de referencias directas sin tratarlas como dependencias causales", () => {
  const projectId = "literary-analysis-test";
  const makeIdea = (ideaId, status, relatedIdeaIds = []) => ({
    projectId,
    ideaId,
    text: "Idea " + ideaId,
    status,
    relatedIdeaIds,
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status, reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  });
  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea permanece.",
    knownProjectIdeas: [
      makeIdea("source", "IDEA", ["accepted", "rejected", "outside"]),
      makeIdea("accepted", "incorporated"),
      makeIdea("rejected", "discarded")
    ],
    knownProjectIdeasOmittedCount: 2
  }).ideaGraph;
  const source = graph.nodes.find(node => node.ideaId === "source");
  assert.deepEqual(source.directReferenceStatusCounts, {
    IDEA: 0,
    incorporated: 1,
    discarded: 1,
    notInSnapshot: 1
  });
  assert.equal(source.directReferenceStatusAlignment, "mixed-status");
  const accepted = graph.nodes.find(node => node.ideaId === "accepted");
  assert.equal(accepted.directReferenceStatusAlignment, "no-references");
});
test("cada nodo identifica su componente cíclico incluso cuando hay auto-referencias", () => {
  const projectId = "literary-analysis-test";
  const makeIdea = (ideaId, relatedIdeaIds = []) => ({
    projectId,
    ideaId,
    text: "Idea " + ideaId,
    status: "IDEA",
    relatedIdeaIds,
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  });
  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea permanece.",
    knownProjectIdeas: [
      makeIdea("alpha", ["beta"]),
      makeIdea("beta", ["alpha"]),
      makeIdea("self", ["self"]),
      makeIdea("outside-cycle")
    ]
  }).ideaGraph;
  const node = id => graph.nodes.find(item => item.ideaId === id);
  assert.equal(node("alpha").cycleMembership, "cyclic-component");
  assert.equal(node("alpha").cycleComponentSize, 2);
  assert.equal(node("beta").cycleComponentSize, 2);
  assert.equal(node("self").cycleMembership, "cyclic-component");
  assert.equal(node("self").cycleComponentSize, 1);
  assert.equal(node("outside-cycle").cycleMembership, "acyclic-within-snapshot");
  assert.equal(node("outside-cycle").cycleComponentSize, 0);
});


test("el grafo detecta convergencia indirecta a través de ramas distintas", () => {
  const projectId = "literary-analysis-test";
  const makeIdea = (ideaId, relatedIdeaIds = []) => ({
    projectId, ideaId, text: "Idea " + ideaId, status: "IDEA", relatedIdeaIds,
    evidenceCount: 0, staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0, omittedStatusHistoryCount: 0
  });
  const graph = analyzeLiteraryFragment({
    projectId, documentId: "chapter-diamond", revision: 1,
    text: "Escena 1\nUna bifurcación vuelve a converger.",
    knownProjectIdeas: [
      makeIdea("root", ["left", "right"]),
      makeIdea("left", ["shared", "left-only"]),
      makeIdea("right", ["shared", "right-only"]),
      makeIdea("shared"),
      makeIdea("left-only"),
      makeIdea("right-only")
    ]
  }).ideaGraph;
  assert.equal(graph.twoHopConvergentSourceCount, 1);
  assert.equal(graph.twoHopSharedDestinationCount, 1);
  assert.equal(graph.twoHopExclusiveDestinationCount, 2);
  assert.equal(graph.twoHopIndependentBranchSourceCount, 1);
  assert.equal(graph.twoHopConvergenceAnalysisStatus, "complete");
});

test("el grafo identifica puntos de articulación en cadenas de referencias", () => {
  const projectId = "literary-analysis-test";
  const makeIdea = (ideaId, relatedIdeaIds = []) => ({
    projectId, ideaId, text: "Idea " + ideaId, status: "IDEA", relatedIdeaIds,
    evidenceCount: 0, staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0, omittedStatusHistoryCount: 0
  });
  const graph = analyzeLiteraryFragment({
    projectId, documentId: "chapter-one", revision: 1,
    text: "Escena 1\nUna idea permanece.",
    knownProjectIdeas: [
      makeIdea("a", ["b"]),
      { ...makeIdea("b", ["c"]), status: "incorporated",
        statusHistory: [{ status: "incorporated", reason: "initial" }] },
      makeIdea("c"),
      makeIdea("isolated")
    ]
  }).ideaGraph;
  const node = id => graph.nodes.find(item => item.ideaId === id);
  assert.equal(node("a").articulationPointStatus, "not-articulation-within-snapshot");
  assert.equal(node("b").articulationPointStatus, "connector");
  assert.equal(node("b").weakComponentPiecesAfterRemoval, 2);
  assert.equal(node("b").undirectedReferenceDegree, 2);
  assert.equal(node("a").weakComponentPiecesAfterRemoval, 1);
  assert.equal(node("c").articulationPointStatus, "not-articulation-within-snapshot");
  assert.equal(node("isolated").articulationPointStatus, "not-articulation-within-snapshot");
  assert.equal(node("isolated").weakComponentPiecesAfterRemoval, 0);
  assert.equal(node("a").minimumDirectedHopsToTerminal, 2);
  assert.equal(node("b").minimumDirectedHopsToTerminal, 1);
  assert.equal(node("c").minimumDirectedHopsToTerminal, 0);
  assert.equal(node("isolated").minimumDirectedHopsToTerminal, 0);
  assert.equal(graph.terminalReachableNodeCount, 4);
  assert.equal(graph.terminalReachabilityCoverage, 1);
  assert.deepEqual(graph.statusTransitionProfiles, [
    { fromStatus: "IDEA", toStatus: "incorporated", referenceCount: 1 },
    { fromStatus: "incorporated", toStatus: "IDEA", referenceCount: 1 }
  ]);
  assert.equal(node("a").distinctOutgoingIdeaCount, 1);
  assert.equal(node("b").distinctIncomingIdeaCount, 1);
  assert.equal(graph.directedBranchNodeCount, 0);
  assert.equal(graph.directedConvergenceNodeCount, 0);
  assert.equal(graph.articulationPointCount, 1);
  assert.deepEqual(graph.articulationPointIdeaIds, ["b"]);
});
test("cada nodo identifica su componente cíclico sin persistir auto-referencias", () => {
  const projectId = "literary-analysis-test";
  const makeIdea = (ideaId, relatedIdeaIds = []) => ({
    projectId,
    ideaId,
    text: "Idea " + ideaId,
    status: "IDEA",
    relatedIdeaIds,
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  });
  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-one",
    revision: 1,
    text: "Escena 1\nUna idea permanece.",
    knownProjectIdeas: [
      makeIdea("alpha", ["beta"]),
      makeIdea("beta", ["alpha"]),
      makeIdea("self", ["self-peer"]),
      makeIdea("self-peer", ["self"]),
      makeIdea("outside-cycle")
    ]
  }).ideaGraph;
  const node = id => graph.nodes.find(item => item.ideaId === id);
  assert.equal(node("alpha").cycleMembership, "cyclic-component");
  assert.equal(node("alpha").cycleComponentSize, 2);
  assert.equal(node("beta").cycleComponentSize, 2);
  assert.equal(node("self").cycleMembership, "cyclic-component");
  assert.equal(node("self").cycleComponentSize, 2);
  assert.equal(node("self-peer").cycleMembership, "cyclic-component");
  assert.equal(node("self-peer").cycleComponentSize, 2);
  assert.equal(node("outside-cycle").cycleMembership, "acyclic-within-snapshot");
  assert.equal(node("outside-cycle").cycleComponentSize, 0);
});


test("reconoce conectores causales españoles terminados en vocal acentuada", () => {
  const connectors = ["provocó", "causó", "desencadenó", "originó"];
  for (const connector of connectors) {
    const text = `La tormenta ${connector} el derrumbe.`;
    const evidence = phrase => {
      const start = text.indexOf(phrase);
      assert.notEqual(start, -1);
      return {
        documentId: "chapter-one",
        revision: 1,
        start,
        end: start + phrase.length,
        excerpt: phrase
      };
    };
    const result = analyzeLiteraryFragment({
      projectId: "literary-analysis-test",
      documentId: "chapter-one",
      revision: 1,
      text,
      knownEvents: [
        {
          eventId: "storm",
          label: "La tormenta",
          participants: ["ana"],
          evidence: [evidence("La tormenta")]
        },
        {
          eventId: "collapse",
          label: "El derrumbe",
          participants: ["ana"],
          evidence: [evidence("el derrumbe")]
        }
      ]
    });
    assert.equal(result.eventDependencyAnalysis.candidateCount, 1, connector);
    assert.equal(result.eventDependencyAnalysis.candidates[0].connector, connector);
    assert.equal(result.eventDependencyAnalysis.candidates[0].direction, "cause-before-consequence");
  }
});

