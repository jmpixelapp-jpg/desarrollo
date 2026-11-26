import test from "node:test";
import assert from "node:assert/strict";
import {
  auditNarrativeExtractionCoverage,
  ingestNarrativeBookText
} from "../dist/motor-literario.js";

test("la ingesta expone frases no cubiertas por acciones o acontecimientos extraídos", () => {
  const text = "Capítulo I\nAna llegó al puerto.\nLa torre parecía abandonada.\nEVENTO: La campana sonó.";
  const ana = {
    projectId: "p", id: "character:ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const result = ingestNarrativeBookText({
    projectId: "p", documentId: "d", revision: 2, text, entities: [ana]
  });
  assert.equal(result.extractionAudit.sentenceCount, 3);
  assert.equal(result.extractionAudit.sentencesWithActionOrEventEvidence, 2);
  assert.equal(result.extractionAudit.sentencesWithoutActionOrEventEvidence, 1);
  assert.equal(result.extractionAudit.uncoveredSentences[0].evidence.excerpt, "La torre parecía abandonada.");
  assert.equal(result.extractionAudit.interpretation,
    "coverage-of-current-extractors-not-semantic-completeness");
});

test("la auditoría conserva offsets absolutos y verifica evidencia literal", () => {
  const text = "Una frase sin extracción. Otra frase cubierta.";
  const evidence = {
    documentId: "d", revision: 1,
    start: 100 + text.indexOf("cubierta"),
    end: 100 + text.indexOf("cubierta") + "cubierta".length,
    excerpt: "cubierta"
  };
  const result = auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text, baseOffset: 100,
    observations: [{ evidence }], events: []
  });
  assert.equal(result.sentenceCount, 2);
  assert.equal(result.sentencesWithActionOrEventEvidence, 1);
  assert.equal(result.uncoveredSentences[0].evidence.start, 100);
});

test("rechaza evidencia de otra revisión o que no coincide con el texto", () => {
  const text = "Ana llegó.";
  assert.throws(() => auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text,
    observations: [{
      evidence: {
        documentId: "d", revision: 0, start: 0, end: 3, excerpt: "Ana"
      }
    }],
    events: []
  }));
  assert.throws(() => auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text,
    observations: [{
      evidence: {
        documentId: "d", revision: 1, start: 0, end: 3, excerpt: "Eva"
      }
    }],
    events: []
  }));
});

test("la cobertura global incluye evidencias de otros extractores sin alterar el subtotal de acciones", () => {
  const text = "Ana está herida. La torre parece abandonada.";
  const additional = {
    documentId: "d", revision: 1,
    start: 0, end: "Ana está herida".length,
    excerpt: "Ana está herida"
  };
  const result = auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text,
    observations: [], events: [],
    additionalEvidence: [{ evidence: additional }]
  });
  assert.equal(result.sentencesWithActionOrEventEvidence, 0);
  assert.equal(result.sentencesWithAdditionalEvidence, 1);
  assert.equal(result.sentencesWithAnyExtractedEvidence, 1);
  assert.equal(result.sentencesWithoutAnyExtractedEvidence, 1);
  assert.equal(result.coverageRatio, 0.5);
  assert.equal(result.uncoveredSentences[0].evidence.excerpt, "La torre parece abandonada.");
});

test("un texto vacío tiene cobertura neutral completa y no genera pendientes", () => {
  const result = auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text: "",
    observations: [], events: []
  });
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.sentenceCount, 0);
  assert.deepEqual(result.uncoveredSentences, []);
});


test("segmenta CRLF y limita la cola de revisión sin ocultar omisiones", () => {
  const text = "Primera frase.\r\nSegunda frase.\r\n" +
    Array.from({ length: 1_002 }, (_, index) => "Pendiente " + index + ".").join("\n");
  const result = auditNarrativeExtractionCoverage({
    documentId: "d", revision: 1, text,
    observations: [], events: []
  });
  assert.equal(result.sentenceCount, 1_004);
  assert.equal(result.uncoveredSentences.length, 1_000);
  assert.equal(result.omittedUncoveredSentences, 4);
  assert.equal(result.truncated, true);
});
