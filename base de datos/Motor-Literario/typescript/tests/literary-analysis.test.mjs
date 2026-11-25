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
