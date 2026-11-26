import test from "node:test";
import assert from "node:assert/strict";
import {
  EpubBookReader,
  ingestBookWithReader
} from "../dist/motor-literario.js";

const encoder = new TextEncoder();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function storedZip(entries) {
  const locals = [], centrals = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBytes = encoder.encode(name), data = encoder.encode(value), crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 0, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, localOffset, true);
    central.set(nameBytes, 46); centrals.push(central);
    localOffset += local.length;
  }
  const centralBytes = concat(centrals);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, localOffset, true);
  return concat([...locals, centralBytes, end]);
}
function sampleEpub() {
  return storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["OPS/book.opf", '<?xml version="1.0"?><package><metadata><dc:title>La novela &amp; el viaje</dc:title><dc:creator>Ana Autora</dc:creator><dc:language>es</dc:language><dc:identifier>urn:test:book</dc:identifier></metadata><manifest><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'],
    ["OPS/nav.xhtml", '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Parte primera</a><ol><li><a href="chapter2.xhtml">Parte segunda</a></li></ol></li></ol></nav></body></html>'],
    ["OPS/chapter1.xhtml", '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><h1>Capítulo primero</h1><p>Una <em>historia</em> &amp; su comienzo.</p><p>Segunda línea.</p><pre>Verso uno\nVerso dos</pre><aside epub:type="footnote"><p>Nota al pie.</p></aside><script>texto que no debe entrar</script></body></html>'],
    ["OPS/chapter2.xhtml", '<html><body><h1>Capítulo segundo</h1><p>El viaje continúa.</p><h2>Una sección</h2><p>Y termina.</p></body></html>']
  ]);
}

test("lee EPUB, metadatos, orden spine, encabezados y párrafos conservando localizadores", async () => {
  const reader = new EpubBookReader();
  const bytes = sampleEpub();
  const inspection = await reader.inspect(bytes);
  assert.deepEqual(inspection.metadata, {
    title: "La novela & el viaje", author: "Ana Autora",
    language: "es", identifier: "urn:test:book"
  });
  assert.equal(inspection.spineItems, 2);
  assert.deepEqual(inspection.navigation.map(item => [item.label, item.targetPath, item.depth]), [
    ["Parte primera", "OPS/chapter1.xhtml", 0],
    ["Parte segunda", "OPS/chapter2.xhtml", 1]
  ]);
  assert.ok(inspection.extractedBlocks >= 6);
  assert.deepEqual(inspection.emptySpineItems, []);
  const ingested = await ingestBookWithReader(reader, bytes, { sourceId: "epub-test" });
  assert.equal(ingested.metadata.title, "La novela & el viaje");
  assert.equal(ingested.chapters.length, 2);
  assert.equal(ingested.chapters[0].heading, "Capítulo primero");
  assert.equal(ingested.chapters[0].text, "Una historia & su comienzo.\\n\\nSegunda línea.\\nVerso uno\\nVerso dos\\n\\nNota al pie.");
  assert.equal(ingested.chapters[1].heading, "Capítulo segundo");
  assert.match(ingested.chapters[1].text, /Una sección/);
  assert.ok(ingested.chapters[0].sourceSpans.every(span => span.location.locator.startsWith("OPS/chapter1.xhtml#")));
  assert.ok(!ingested.chapters[0].text.includes("texto que no debe entrar"));
});

test("rechaza archivos que no son EPUB y rutas internas inseguras", async () => {
  const badMime = storedZip([["mimetype", "text/plain"]]);
  await assert.rejects(new EpubBookReader().inspect(badMime), /mimetype no identifica/);
  const badPath = storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfile full-path="../book.opf"/></container>']
  ]);
  await assert.rejects(new EpubBookReader().inspect(badPath), /ruta interna no segura/);
});

test("detecta corrupción de contenido mediante CRC32", async () => {
  const bytes = sampleEpub();
  // Corrompe el primer byte del contenido de chapter1.xhtml sin tocar el directorio.
  const marker = encoder.encode("Una ");
  let found = -1;
  outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    found = i; break;
  }
  assert.notEqual(found, -1);
  bytes[found] ^= 1;
  await assert.rejects(async () => {
    for await (const _block of new EpubBookReader().read(bytes)) { /* consume full spine */ }
  }, /CRC32 incorrecto/);
});

test("conserva límites entre documentos del spine aunque no tengan h1", async () => {
  const bytes = storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfile full-path="book.opf"/></container>'],
    ["book.opf", '<package><metadata><dc:title>Sin encabezados</dc:title></metadata><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'],
    ["a.xhtml", "<html><body><p>Primera parte.</p></body></html>"],
    ["b.xhtml", "<html><body><p>Segunda parte.</p></body></html>"]
  ]);
  const result = await ingestBookWithReader(new EpubBookReader(), bytes, { sourceId: "no-headings" });
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].text, "Primera parte.");
  assert.equal(result.chapters[1].text, "Segunda parte.");
});


test("aplica límites de tamaño y número de entradas del contenedor", async () => {
  const bytes = sampleEpub();
  await assert.rejects(new EpubBookReader({ maxArchiveBytes: 32 }).inspect(bytes), /tamaño del archivo/);
  await assert.rejects(new EpubBookReader({ maxEntries: 2 }).inspect(bytes), /directorio central inválido o excesivo/);
});


test("la inspección identifica documentos del spine sin contenido textual", async () => {
  const bytes = storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfile full-path="book.opf"/></container>'],
    ["book.opf", '<package><metadata><dc:title>Vacío</dc:title></metadata><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>'],
    ["a.xhtml", "<html><body><img src='cover.jpg'/></body></html>"]
  ]);
  const report = await new EpubBookReader().inspect(bytes);
  assert.deepEqual(report.emptySpineItems, ["a.xhtml"]);
  assert.ok(report.warnings.some(warning => warning.includes("no produjo bloques")));
});


test("recupera tabla de contenidos NCX cuando no existe EPUB 3 nav", async () => {
  const bytes = storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfile full-path="OPS/book.opf"/></container>'],
    ["OPS/book.opf", '<package><metadata><dc:title>Índice NCX</dc:title></metadata><manifest><item id="c" href="chapter.xhtml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="c"/></spine></package>'],
    ["OPS/toc.ncx", '<ncx><navMap><navPoint id="n1"><navLabel><text>Capítulo inicial</text></navLabel><content src="chapter.xhtml#inicio"/></navPoint></navMap></ncx>'],
    ["OPS/chapter.xhtml", "<html><body><p>Texto del capítulo.</p></body></html>"]
  ]);
  const report = await new EpubBookReader().inspect(bytes);
  assert.deepEqual(report.navigation.map(item => [item.label, item.href, item.targetPath, item.depth]), [
    ["Capítulo inicial", "chapter.xhtml#inicio", "OPS/chapter.xhtml", 0]
  ]);
});


test("preserva saltos de línea XHTML br y nombres de elemento con prefijo", async () => {
  const bytes = storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfile full-path="book.opf"/></container>'],
    ["book.opf", '<package><metadata><dc:title>Saltos</dc:title></metadata><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>'],
    ["chapter.xhtml", '<xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:body><xhtml:h1>Inicio</xhtml:h1><xhtml:p>Primera línea.<xhtml:br/>Segunda línea.</xhtml:p></xhtml:body></xhtml:html>']
  ]);
  const result = await ingestBookWithReader(new EpubBookReader(), bytes, { sourceId: "br-test" });
  assert.equal(result.chapters[0].text, "Primera línea.\\nSegunda línea.");
});

