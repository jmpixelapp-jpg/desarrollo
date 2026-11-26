import test from "node:test";
import assert from "node:assert/strict";
import { detectNarrativePronounInputs } from "../dist/motor-literario.js";

const entities = [
  { projectId:"book", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:["Mar"], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"book", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

test("detecta menciones por nombre y alias y pronombres sujeto con offsets absolutos", () => {
  const text = "Mar llegó. Ella la saludó. Él esperó.";
  const result = detectNarrativePronounInputs(
    text, entities, "chapter", 2, 500,
    [{ characterId:"mara", grammaticalGender:"feminine" }]
  );
  assert.equal(result.mentions[0].start, 500);
  assert.equal(result.mentions[0].characterId, "mara");
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].surface, "Ella");
  assert.equal(result.references[0].grammaticalGender, "feminine");
  assert.equal(result.references[1].surface, "Él");
  assert.equal(result.references[1].grammaticalGender, "masculine");
});

test("omite nombres compartidos por identidades diferentes", () => {
  const duplicate = [
    ...entities,
    { ...entities[1], id:"another-elian", canonicalName:"Otro", aliases:["Mara"] }
  ];
  const result = detectNarrativePronounInputs("Mara llegó. Ella esperó.", duplicate, "chapter", 1);
  assert.equal(result.mentions.length, 0);
  assert.deepEqual(result.skippedAmbiguousNames, ["mara"]);
});

test("no interpreta pronombres plurales ni clíticos como antecedentes", () => {
  const text = "Mara llegó. Ellos salieron. La vio. Se marchó.";
  const result = detectNarrativePronounInputs(text, entities, "chapter", 1);
  assert.deepEqual(result.references.map(item => item.surface), []);
});

test("sin perfil explícito deja el género de la mención como desconocido", () => {
  const result = detectNarrativePronounInputs("Mara llegó. Ella salió.", entities, "chapter", 1);
  assert.equal(result.mentions[0].grammaticalGender, "unknown");
});
