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
