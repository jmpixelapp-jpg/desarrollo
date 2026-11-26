import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestBookReaderBlocks,
  resolveBookEvidence,
  resolveNarrativeTextEvidence,
  resolveNarrativeEvidenceCollection
} from "../dist/motor-literario.js";

test("resuelve evidencia literaria a bloques y localizadores originales", async () => {
  const book = await ingestBookReaderBlocks({
    sourceId: "novela-1", sourceFormat: "fixture",
    title: "La novela", author: "Autora"
  }, [
    { blockId: "heading", sequence: 0, kind: "chapter-heading", text: "Capítulo I", location: { locator: "book.xhtml#h1", spineIndex: 0 } },
    { blockId: "p1", sequence: 1, kind: "paragraph", text: "La protagonista llega.", location: { locator: "book.xhtml#p1", spineIndex: 0, sectionIndex: 1 } },
    { blockId: "p2", sequence: 2, kind: "paragraph", text: "La ciudad está vacía.", location: { locator: "book.xhtml#p2", spineIndex: 0, sectionIndex: 2 } }
  ]);
  const chapter = book.chapters[0];
  const start = chapter.text.indexOf("llega");
  const end = chapter.text.indexOf("ciudad") + "ciudad".length;
  const evidence = resolveBookEvidence(book, chapter, start, end);
  assert.equal(evidence.sourceId, "novela-1");
  assert.equal(evidence.bookTitle, "La novela");
  assert.equal(evidence.excerpt, "llega.\n\nLa ciudad");
  assert.deepEqual(evidence.fragments.map(fragment => fragment.blockId), ["p1", "p2"]);
  assert.deepEqual(evidence.fragments.map(fragment => fragment.locator), ["book.xhtml#p1", "book.xhtml#p2"]);
  assert.deepEqual(evidence.fragments.map(fragment => fragment.quote), ["llega.", "La ciudad"]);
  assert.equal(evidence.fragments[1].blockStart, 0);
});

test("rechaza rangos inválidos y mantiene explícitos los separadores sintéticos", async () => {
  const book = await ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
    { blockId: "a", sequence: 1, kind: "paragraph", text: "Uno", location: { locator: "a" } },
    { blockId: "b", sequence: 2, kind: "paragraph", text: "Dos", location: { locator: "b" } }
  ]);
  const chapter = book.chapters[0];
  const resolved = resolveBookEvidence(book, chapter, 3, 6);
  assert.equal(resolved.excerpt, "\n\nD");
  assert.equal(resolved.fragments.length, 1);
  assert.equal(resolved.fragments[0].quote, "D");
  assert.throws(() => resolveBookEvidence(book, chapter, -1, 2), RangeError);
  assert.throws(() => resolveBookEvidence(book, chapter, 2, 2), RangeError);
  assert.throws(() => resolveBookEvidence(book, chapter, 0, chapter.text.length + 1), RangeError);
});


test("resuelve evidencias persistidas del conocimiento narrativo con verificación exacta de cita", async () => {
  const book = await ingestBookReaderBlocks({ sourceId: "novela", sourceFormat: "fixture", revision: 3 }, [
    { blockId: "p", sequence: 1, kind: "paragraph", text: "La puerta se abrió.", location: { locator: "chapter.xhtml#p" } }
  ]);
  const chapter = book.chapters[0];
  const start = chapter.text.indexOf("puerta");
  const evidence = resolveNarrativeTextEvidence(book, {
    documentId: chapter.documentId, revision: 3, start, end: start + 6, excerpt: "puerta"
  });
  assert.equal(evidence.excerpt, "puerta");
  assert.equal(evidence.fragments[0].locator, "chapter.xhtml#p");
  assert.throws(() => resolveNarrativeTextEvidence(book, {
    documentId: chapter.documentId, revision: 3, start, end: start + 6, excerpt: "ventana"
  }), /no coincide/u);
  assert.throws(() => resolveNarrativeTextEvidence(book, {
    documentId: chapter.documentId, revision: 2, start, end: start + 6, excerpt: "puerta", status: "stale"
  }), /obsoleta/u);
  assert.throws(() => resolveNarrativeTextEvidence(book, {
    documentId: chapter.documentId, revision: 2, start, end: start + 6, excerpt: "puerta"
  }), /no coincide/u);
  assert.throws(() => resolveNarrativeTextEvidence(book, {
    documentId: "otro-documento", revision: 3, start: 0, end: 2, excerpt: "La"
  }), /no pertenece/u);
});



test("resuelve colecciones completas y no devuelve resultados parciales ante evidencia inválida", async () => {
  const book = await ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture", revision: 7 }, [
    { blockId: "p", sequence: 1, kind: "paragraph", text: "Una escena termina." }
  ]);
  const chapter = book.chapters[0];
  const valid = { documentId: chapter.documentId, revision: 7, start: 0, end: 3, excerpt: "Una" };
  const results = resolveNarrativeEvidenceCollection(book, [valid, { ...valid, start: 4, end: 9, excerpt: "escena" }]);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.excerpt), ["Una", "escena"]);
  assert.throws(() => resolveNarrativeEvidenceCollection(book, [valid, { ...valid, excerpt: "otra" }]), /no coincide/u);
});

test("no resuelve evidencia narrativa si el snapshot no tiene revisión declarada", async () => {
  const book = await ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
    { blockId: "p", sequence: 1, kind: "paragraph", text: "Texto." }
  ]);
  const chapter = book.chapters[0];
  assert.throws(() => resolveNarrativeTextEvidence(book, {
    documentId: chapter.documentId, revision: 1, start: 0, end: 5, excerpt: "Texto"
  }), /no declara revisión/u);
});

