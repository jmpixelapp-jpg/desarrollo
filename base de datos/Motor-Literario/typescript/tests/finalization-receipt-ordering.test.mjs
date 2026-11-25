import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const projectId = "archive-receipt-read-order";
const writerId = "writer-receipt-order";
const projectName = "Libro con recibo";

class ArchiveGateStore {
  constructor() {
    this.receipt = undefined;
    this.receiptRead = false;
    this.archiveStarted = new Promise(resolve => { this.markArchiveStarted = resolve; });
    this.archiveGate = new Promise(resolve => { this.releaseArchive = resolve; });
  }

  async archiveUnincorporatedIdeas(sourceProjectId, archivedWriterId, sourceProjectName, archivedAt) {
    this.markArchiveStarted();
    await this.archiveGate;
    const entry = {
      writerId: archivedWriterId,
      sourceProjectId,
      sourceProjectName,
      category: sourceProjectName,
      idea: {
        projectId: sourceProjectId,
        id: "idea-1",
        text: "Una idea que se conserva al cerrar el libro.",
        status: "IDEA",
        originDocumentId: "chapter-1",
        sourceProjectName,
        evidence: [],
        relatedEntityIds: [],
        relatedIdeaIds: []
      },
      context: { version: 1, relatedIdeas: [], relatedEntities: [] },
      archivedAt
    };
    this.receipt = {
      writerId: archivedWriterId,
      sourceProjectId,
      receiptId: "project-finalization-v1",
      sourceProjectName,
      finalizedAt: archivedAt,
      archivedIdeaIds: [entry.idea.id],
      archiveChecksum: "test-checksum"
    };
    return [entry];
  }

  async loadProjectFinalizationReceipt(requestedWriterId, requestedProjectId) {
    this.receiptRead = true;
    assert.equal(requestedWriterId, writerId);
    assert.equal(requestedProjectId, projectId);
    return this.receipt ? structuredClone(this.receipt) : undefined;
  }

  async loadPersonalIdeas() { return []; }
}

test("la lectura del recibo de finalización espera a que termine la transferencia", async () => {
  const store = new ArchiveGateStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName, writerId });

  const archiving = api.archiveUnincorporatedIdeas();
  await store.archiveStarted;

  let receiptResolved = false;
  const readingReceipt = api.getProjectFinalizationReceipt().then(receipt => {
    receiptResolved = true;
    return receipt;
  });

  await Promise.resolve();
  assert.equal(store.receiptRead, false, "la lectura no debe adelantarse al archivo en curso");
  assert.equal(receiptResolved, false, "la consulta debe esperar su turno en la cola serial");

  store.releaseArchive();
  const archived = await archiving;
  assert.equal(archived.length, 1);

  const receipt = await readingReceipt;
  assert.equal(receipt?.receiptId, "project-finalization-v1");
  assert.deepEqual(receipt?.archivedIdeaIds, ["idea-1"]);
  assert.equal(store.receiptRead, true);
  api.dispose();
});
