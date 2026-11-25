import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SqliteProjectStore } from "../bridge/sqlite-project-store.mjs";

function checksum(ids) {
  const serialized = JSON.stringify([...ids].sort());
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return "fnv1a64:" + hash.toString(16).padStart(16, "0");
}

async function withStore(work) {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-finalization-receipt-"));
  const store = await SqliteProjectStore.open(resolve(directory, "motor.sqlite"));
  try {
    await work(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite rechaza recibos con checksum alterado", async () => {
  await withStore(store => {
    const writerId = "writer-integrity";
    const projectId = "book-integrity";
    store.put("writer-library-finalization-receipts", [writerId, projectId, "finalization-v1"], {
      writerId,
      sourceProjectId: projectId,
      receiptId: "finalization-v1",
      sourceProjectName: "Libro de integridad",
      finalizedAt: 10,
      archivedIdeaIds: ["idea-a"],
      archiveChecksum: "fnv1a64:0000000000000000"
    });
    assert.throws(
      () => store.loadProjectFinalizationReceipt(writerId, projectId),
      /checksum inválidos/
    );
  });
});

test("SQLite exige el orden determinista de IDs del recibo", async () => {
  await withStore(store => {
    const writerId = "writer-order";
    const projectId = "book-order";
    const ids = ["A", "a"];
    const receipt = {
      writerId,
      sourceProjectId: projectId,
      receiptId: "finalization-v1",
      sourceProjectName: "Libro de orden",
      finalizedAt: 10,
      archivedIdeaIds: ids,
      archiveChecksum: checksum(ids)
    };
    store.put("writer-library-finalization-receipts", [writerId, projectId, "finalization-v1"], receipt);
    assert.deepEqual(
      store.loadProjectFinalizationReceipt(writerId, projectId).archivedIdeaIds,
      ["A", "a"]
    );

    const reordered = { ...receipt, archivedIdeaIds: ["a", "A"] };
    store.put("writer-library-finalization-receipts", [writerId, projectId, "finalization-v1"], reordered);
    assert.throws(
      () => store.loadProjectFinalizationReceipt(writerId, projectId),
      /IDs o checksum inválidos/
    );
  });
});
