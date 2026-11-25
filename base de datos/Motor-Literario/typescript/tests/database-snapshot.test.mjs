import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SqliteProjectStore } from "../bridge/sqlite-project-store.mjs";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup
} from "../bridge/database-snapshot.mjs";

const makeEntity = (projectId, id, name) => ({
  projectId,
  id,
  kind: "character",
  canonicalName: name,
  normalizedName: name.toLocaleLowerCase("es"),
  aliases: [],
  evidence: [],
  firstSeenAt: 1,
  lastSeenAt: 1,
  extractionVersion: 1
});

test("la copia SQLite restaura manuscrito, conocimiento, biblioteca e historial durable", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-database-snapshot-"));
  const sourcePath = resolve(directory, "source", "motor.sqlite");
  const backupPath = resolve(directory, "backups", "motor-backup.sqlite");
  const destinationPath = resolve(directory, "restored", "motor.sqlite");
  const projectId = "snapshot-project";
  const writerId = "snapshot-writer";
  const projectName = "Libro de respaldo";
  const entity = makeEntity(projectId, "character-ana", "Ana");
  let source;
  let target;
  let restored;
  let previous;
  try {
    source = await SqliteProjectStore.open(sourcePath);
    source.saveDocument({
      projectId,
      documentId: "chapter-one",
      text: "Ana guarda la llave bajo la piedra.",
      revision: 0,
      sequence: 0,
      updatedAt: 10
    });
    source.saveEntity(entity);
    source.saveIdea({
      projectId,
      id: "idea-key",
      text: "La llave abre la puerta del jardín.",
      status: "IDEA",
      originDocumentId: "chapter-one",
      sourceProjectName: projectName,
      evidence: [{
        documentId: "chapter-one",
        revision: 0,
        start: 0,
        end: 3,
        excerpt: "Ana guarda la llave bajo la piedra."
      }],
      relatedEntityIds: [entity.id],
      relatedIdeaIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 10 }]
    });

    const finalized = source.archiveUnincorporatedIdeasSummary(
      projectId, writerId, projectName, 20
    );
    assert.equal(finalized.archivedCount, 1);
    source.close();
    source = undefined;

    const created = await createDatabaseBackup(sourcePath, backupPath);
    assert.equal(created.format, "motor-literario-sqlite-backup");
    assert.equal(created.formatVersion, 1);
    assert.equal(created.databaseSchemaVersion, "1");
    assert.ok(created.recordCount > 0);

    const verified = await verifyDatabaseBackup(backupPath);
    assert.equal(verified.recordCount, created.recordCount);
    await assert.rejects(
      createDatabaseBackup(sourcePath, backupPath),
      /ya existe/
    );

    // Cambios posteriores a la copia no pueden filtrarse dentro del respaldo.
    source = await SqliteProjectStore.open(sourcePath);
    source.saveEntity(makeEntity(projectId, "character-later", "Bruno"));
    source.close();
    source = undefined;

    target = await SqliteProjectStore.open(destinationPath);
    target.saveEntity(makeEntity("previous-project", "previous-character", "Estado anterior"));
    target.close();
    target = undefined;

    const restoredSummary = await restoreDatabaseBackup(backupPath, destinationPath);
    assert.equal(restoredSummary.recordCount, created.recordCount);
    assert.ok(restoredSummary.recoveryPath, "debe conservar la base que existía antes de restaurar");

    restored = await SqliteProjectStore.open(destinationPath);
    const document = await restored.loadDocument(projectId, "chapter-one");
    assert.equal(document.text, "Ana guarda la llave bajo la piedra.");
    assert.equal(document.revision, 0);
    assert.equal(document.sequence, 0);

    const entities = await restored.loadEntities(projectId);
    assert.deepEqual(entities.map(item => item.id), [entity.id]);
    assert.equal(
      (await restored.loadEntities("previous-project")).length,
      0,
      "la restauración reemplaza el contenido de destino, no lo mezcla"
    );
    assert.deepEqual(await restored.loadIdeas(projectId), []);

    const page = restored.loadPersonalIdeasPage(writerId, null, 10);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].idea.id, "idea-key");
    assert.deepEqual(page.items[0].idea.evidence, [{
      documentId: "chapter-one",
      revision: 0,
      start: 0,
      end: 3,
      excerpt: "Ana guarda la llave bajo la piedra."
    }]);
    assert.deepEqual(page.items[0].idea.statusHistory, [
      { status: "IDEA", reason: "initial", changedAt: 10 }
    ]);
    assert.deepEqual(page.items[0].idea.relatedEntityIds, [entity.id]);
    assert.equal(page.items[0].context.relatedEntities[0].canonicalName, "Ana");

    const receipt = restored.loadProjectFinalizationReceipt(writerId, projectId);
    assert.deepEqual(receipt.archivedIdeaIds, ["idea-key"]);
    assert.equal(receipt.finalizedAt, 20);

    previous = await SqliteProjectStore.open(restoredSummary.recoveryPath);
    assert.equal(
      (await previous.loadEntities("previous-project"))[0].canonicalName,
      "Estado anterior",
      "la base previa queda disponible para recuperación manual"
    );
  } finally {
    source?.close();
    target?.close();
    restored?.close();
    previous?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rechaza un respaldo corrupto sin alterar la base que se pretendía restaurar", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-corrupt-snapshot-"));
  const backupPath = resolve(directory, "corrupt.sqlite");
  const destinationPath = resolve(directory, "destination.sqlite");
  let target;
  let verification;
  try {
    target = await SqliteProjectStore.open(destinationPath);
    target.saveEntity(makeEntity("safe-project", "safe-character", "Conservado"));
    target.close();
    target = undefined;

    await writeFile(backupPath, "esto no es una base SQLite", "utf8");
    await assert.rejects(
      verifyDatabaseBackup(backupPath),
      /SQLite|database|archivo/i
    );
    await assert.rejects(
      restoreDatabaseBackup(backupPath, destinationPath),
      /SQLite|database|archivo/i
    );

    verification = await SqliteProjectStore.open(destinationPath);
    const entities = await verification.loadEntities("safe-project");
    assert.deepEqual(entities.map(item => item.canonicalName), ["Conservado"]);
  } finally {
    target?.close();
    verification?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
