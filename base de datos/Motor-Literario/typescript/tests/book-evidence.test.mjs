import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestBookReaderBlocks,
  resolveBookEvidence
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
