import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeInformationProvenance } from "../dist/motor-literario.js";

const entities = [
  {
    projectId:"book-1", id:"character:mara", kind:"character",
    canonicalName:"Mara", normalizedName:"mara", aliases:["La Guardiana"],
    evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
  },
  {
    projectId:"book-1", id:"character:elian", kind:"character",
    canonicalName:"Elian", normalizedName:"elian", aliases:[],
    evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
  }
];
const context = {
  projectId:"book-1", documentId:"chapter-provenance", revision:4, entities
};

test("distingue observación visual de afirmación factual", () => {
  const text = "Mara vio que el puente había caído.";
  const found = extractNarrativeInformationProvenance({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].informationHolderEntityId, "character:mara");
  assert.equal(found[0].sourceEntityId, undefined);
  assert.equal(found[0].channel, "visual-observation");
  assert.equal(found[0].status, "observed");
  assert.equal(found[0].content, "el puente había caído");
});

test("distingue información oída de información leída", () => {
  const text = "Mara escuchó que Elian había escapado. Elian leyó que la ciudad estaba sitiada.";
  const found = extractNarrativeInformationProvenance({ ...context, text });
  assert.deepEqual(found.map(item => item.channel), [
    "auditory-observation", "written-source"
  ]);
  assert.deepEqual(found.map(item => item.informationHolderEntityId), [
    "character:mara", "character:elian"
  ]);
});

test("conserva la fuente y el receptor de un informe explícito", () => {
  const text = "Elian le contó a Mara que el puente había caído.";
  const found = extractNarrativeInformationProvenance({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].sourceEntityId, "character:elian");
  assert.equal(found[0].informationHolderEntityId, "character:mara");
  assert.equal(found[0].channel, "reported-speech");
  assert.equal(found[0].status, "reported");
  assert.equal(found[0].sourceEvidence.excerpt, "Elian");
  assert.equal(found[0].holderEvidence.excerpt, "Mara");
});

test("un rumor impersonal no inventa un personaje que lo conozca o lo origine", () => {
  const found = extractNarrativeInformationProvenance({
    ...context, text:"Se rumorea que el rey ha muerto."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].channel, "rumor");
  assert.equal(found[0].informationHolderEntityId, undefined);
  assert.equal(found[0].sourceEntityId, undefined);
  assert.equal(found[0].status, "rumored");
});

test("preserva offsets absolutos y procedencia de fragmentos", () => {
  const prefix = "Prólogo.\n";
  const text = "Mara vio que la torre ardía.";
  const found = extractNarrativeInformationProvenance({
    ...context, text, baseOffset:prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].contentEvidence.start,
    prefix.length + text.indexOf("la torre ardía"));
  assert.equal(found[0].contentEvidence.excerpt, "la torre ardía");
  assert.equal(found[0].evidence.documentId, "chapter-provenance");
  assert.equal(found[0].evidence.revision, 4);
});

test("rechaza nombres ambiguos y entidades de otro proyecto", () => {
  const ambiguous = [
    ...entities,
    {
      projectId:"book-1", id:"character:other", kind:"character",
      canonicalName:"Mara", normalizedName:"mara", aliases:[],
      evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
    }
  ];
  assert.deepEqual(extractNarrativeInformationProvenance({
    ...context, entities:ambiguous, text:"Mara vio que el puente cayó."
  }), []);
  assert.throws(() => extractNarrativeInformationProvenance({
    ...context, entities:[{ ...entities[0], projectId:"other" }],
    text:"Mara vio que el puente cayó."
  }));
});
