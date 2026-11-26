import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestBookReaderBlocks,
  ingestBookWithReader
} from "../dist/motor-literario.js";

async function* stream(items) {
  for (const item of items) yield item;
}

const location = pageNumber => ({ locator: "page:" + pageNumber, pageNumber });

test("ingesta capítulos en orden y conserva procedencia y offsets UTF-16", async () => {
  const result = await ingestBookReaderBlocks({
    sourceId: "book-1", sourceFormat: "fixture", title: "El libro"
  }, stream([
    { blockId: "title", sequence: 0, kind: "book-title", text: "  Título leído  " },
    { blockId: "h1", sequence: 1, kind: "chapter-heading", text: "Capítulo I", location: location(1) },
    { blockId: "p1", sequence: 2, kind: "paragraph", text: "A\r\nB", location: location(1) },
    { blockId: "p2", sequence: 3, kind: "paragraph", text: "😀 final", location: location(2) },
    { blockId: "h2", sequence: 4, kind: "chapter-heading", text: "Capítulo II", location: location(3) },
    { blockId: "p3", sequence: 5, kind: "paragraph", text: "Otro capítulo", location: location(3) }
  ]));
  assert.equal(result.metadata.title, "Título leído");
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].text, "A\nB\n\n😀 final");
  assert.equal(result.chapters[0].heading, "Capítulo I");
  assert.equal(result.chapters[0].headingSource.blockId, "h1");
  assert.deepEqual(result.chapters[0].sourceSpans.map(span => [span.blockId, span.start, span.end]), [
    ["p1", 0, 3], ["p2", 5, 13]
  ]);
  assert.equal(result.chapters[1].text, "Otro capítulo");
  assert.equal(result.statistics.blocksRead, 6);
  assert.equal(result.statistics.charactersRead, "Título leídoCapítulo I A\nB😀 finalCapítulo IIOtro capítulo".length);
});

test("no inventa límites de capítulo por saltos de párrafo o encabezados de sección", async () => {
  const result = await ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
    { blockId: "a", sequence: 1, kind: "paragraph", text: "Uno" },
    { blockId: "s", sequence: 2, kind: "section-heading", text: "Una sección" },
    { blockId: "b", sequence: 3, kind: "paragraph", text: "Dos" }
  ]);
  assert.equal(result.chapters.length, 1);
  assert.equal(result.chapters[0].text, "Uno\n\nUna sección\n\nDos");
});

test("rechaza IDs de bloque duplicados y secuencias fuera de orden", async () => {
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "x", sequence: 1, kind: "paragraph", text: "Uno" },
      { blockId: "x", sequence: 2, kind: "paragraph", text: "Dos" }
    ]),
    /repitió el blockId/
  );
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "x", sequence: 2, kind: "paragraph", text: "Uno" },
      { blockId: "y", sequence: 2, kind: "paragraph", text: "Dos" }
    ]),
    /estrictamente creciente/
  );
});

test("aplica límites antes de aceptar un bloque excesivo", async () => {
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "x", sequence: 1, kind: "paragraph", text: "12345" }
    ], { maxBlockCharacters: 4 }),
    /máximo de caracteres/
  );
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "x", sequence: 1, kind: "paragraph", text: "1234" },
      { blockId: "y", sequence: 2, kind: "paragraph", text: "5678" }
    ], { maxChapterCharacters: 6 }),
    /supera el máximo analizable/
  );
});

test("el adaptador de lector conserva el formato y permite cancelación", async () => {
  const adapter = {
    format: "plain-text-fixture",
    async *read(source) {
      yield { blockId: "p", sequence: 1, kind: "paragraph", text: source };
    }
  };
  const result = await ingestBookWithReader(adapter, "Contenido", { sourceId: "source" });
  assert.equal(result.metadata.sourceFormat, "plain-text-fixture");
  assert.equal(result.chapters[0].text, "Contenido");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, stream([
      { blockId: "x", sequence: 1, kind: "paragraph", text: "No debe ingresar" }
    ]), { signal: controller.signal }),
    error => error?.name === "AbortError"
  );
});

test("el BOM inicial y CRLF se normalizan sin quitar guiones ni notas", async () => {
  const result = await ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
    { blockId: "x", sequence: 1, kind: "paragraph", text: "\uFEFFlínea-\r\nnota al pie¹" }
  ]);
  assert.equal(result.chapters[0].text, "línea-\nnota al pie¹");
});

test("rechaza encabezados de capítulo vacíos e identidades de capítulo reutilizadas", async () => {
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "h", sequence: 1, kind: "chapter-heading", text: "   " }
    ]),
    /encabezado de capítulo vacío/
  );
  await assert.rejects(
    ingestBookReaderBlocks({ sourceId: "b", sourceFormat: "fixture" }, [
      { blockId: "h1", sequence: 1, kind: "chapter-heading", chapterId: "same", text: "Uno" },
      { blockId: "p1", sequence: 2, kind: "paragraph", chapterId: "same", text: "Texto" },
      { blockId: "h2", sequence: 3, kind: "chapter-heading", chapterId: "same", text: "Dos" }
    ]),
    /reutilizó el identificador de capítulo/
  );
});

