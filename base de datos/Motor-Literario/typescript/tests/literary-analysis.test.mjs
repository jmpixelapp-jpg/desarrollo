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
        evidence: [evidence("La tormenta"), evidence("la tormenta", 1)]
      },
      {
        eventId: "collapse",
        label: "El derrumbe",
        participants: ["ana", "luisa"],
        evidence: [evidence("el derrumbe"), evidence("El derrumbe", 1)]
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
  assert.equal(ana.documentedDecisions[0].writerDecisionCount, 1);
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
    text: "Escena 1\\nAna espera.",
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
