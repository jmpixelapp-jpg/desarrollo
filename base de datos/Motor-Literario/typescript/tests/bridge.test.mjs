import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MotorLiterarioBridgeClient } from "../dist/motor-literario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../bridge/stdio-server.mjs");

function startBridge(databasePath) {
  const child = spawn(process.execPath, [SERVER, "--db", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const client = new MotorLiterarioBridgeClient(child, {
    requestTimeoutMs: 30_000,
    onStderr: text => { stderr += text; }
  });
  return { child, client, getStderr: () => stderr };
}

function waitForExit(child) {
  return new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit(child.exitCode);
    child.once("exit", code => resolveExit(code));
  });
}

test("el puente stdio mantiene un proceso, confirma cambios y recupera el journal en otro proceso", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-"));
  const databasePath = resolve(directory, "private", "motor-literario.sqlite");
  let first;
  let second;
  try {
    first = startBridge(databasePath);
    const hello = await first.client.hello();
    assert.equal(hello.bridgeProtocolVersion, "1.0.0");
    assert.equal(hello.motorApiVersion, "0.1.0");
    assert.equal(hello.transport, "json-rpc-2.0-stdio-jsonl");
    assert.equal(hello.storage, "sqlite-local");

    const opened = await first.client.openProject({
      projectId: "bridge-project-1",
      projectName: "Libro de prueba",
      writerId: "writer-bridge-1"
    });
    assert.equal(opened.alreadyOpen, false);

    await first.client.openDocument("bridge-project-1", {
      documentId: "chapter-1",
      text: "Hola",
      revision: 0,
      sequence: 0
    });

    const commitNotice = new Promise((resolveNotice, rejectNotice) => {
      const timer = setTimeout(() => rejectNotice(new Error("No llegó la notificación de commit.")), 15_000);
      first.client.onNotification("engine.commit", params => {
        if (params?.projectId === "bridge-project-1") {
          clearTimeout(timer);
          resolveNotice(params.result);
        }
      });
    });

    const admission = await first.client.submitChange("bridge-project-1", {
      documentId: "chapter-1",
      sequence: 1,
      baseRevision: 0,
      start: 4,
      end: 4,
      replacement: " mundo"
    });
    assert.equal(admission.status, "queued");
    assert.equal(typeof admission.ticketId, "string");

    const commit = await commitNotice;
    assert.equal(commit.status, "applied");
    assert.equal(commit.revision, 1);
    await first.client.flushProject("bridge-project-1");

    const liveSnapshot = await first.client.request("document.snapshot", {
      projectId: "bridge-project-1",
      documentId: "chapter-1"
    });
    assert.equal(liveSnapshot.text, "Hola mundo");
    assert.equal(liveSnapshot.revision, 1);
    assert.equal(liveSnapshot.sequence, 1);

    const health = await first.client.request("bridge.health");
    assert.equal(health.storage.integrity, "ok");

    const firstExit = waitForExit(first.child);
    await first.client.shutdown();
    assert.equal(await firstExit, 0);
    first = undefined;

    second = startBridge(databasePath);
    await second.client.hello();
    await second.client.openProject({
      projectId: "bridge-project-1",
      projectName: "Libro de prueba",
      writerId: "writer-bridge-1"
    });
    await second.client.recoverDocument("bridge-project-1", "chapter-1");
    const recovered = await second.client.request("document.snapshot", {
      projectId: "bridge-project-1",
      documentId: "chapter-1"
    });
    assert.equal(recovered.text, "Hola mundo");
    assert.equal(recovered.revision, 1);
    assert.equal(recovered.sequence, 1);

    const secondExit = waitForExit(second.child);
    await second.client.shutdown();
    assert.equal(await secondExit, 0);
    second = undefined;
  } finally {
    if (first) {
      try {
        const exited = waitForExit(first.child);
        await first.client.shutdown();
        await exited;
      } catch {
        first.child.kill();
      }
    }
    if (second) {
      try {
        const exited = waitForExit(second.child);
        await second.client.shutdown();
        await exited;
      } catch {
        second.child.kill();
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("el puente separa libros y rechaza una llamada sin proyecto abierto", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-scope-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const { child, client } = startBridge(databasePath);
  try {
    await client.hello();
    await assert.rejects(
      client.request("document.snapshot", { projectId: "not-open", documentId: "chapter" }),
      error => error?.code === -32000
    );

    await client.openProject({ projectId: "p-one", projectName: "Uno", writerId: "writer-one" });
    await client.openProject({ projectId: "p-two", projectName: "Dos", writerId: "writer-two" });
    await client.openDocument("p-one", { documentId: "same-id", text: "Libro uno", revision: 0, sequence: 0 });
    await client.openDocument("p-two", { documentId: "same-id", text: "Libro dos", revision: 0, sequence: 0 });

    const [one, two] = await Promise.all([
      client.request("document.snapshot", { projectId: "p-one", documentId: "same-id" }),
      client.request("document.snapshot", { projectId: "p-two", documentId: "same-id" })
    ]);
    assert.equal(one.text, "Libro uno");
    assert.equal(two.text, "Libro dos");

    const exited = waitForExit(child);
    await client.shutdown();
    assert.equal(await exited, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("el puente conserva ideas del libro y permite finalizarlas en la biblioteca privada", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-ideas-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const { child, client } = startBridge(databasePath);
  try {
    await client.hello();
    await client.openProject({
      projectId: "idea-project",
      projectName: "Libro ideas",
      writerId: "writer-private"
    });
    await client.openDocument("idea-project", {
      documentId: "chapter-ideas",
      text: "IDEA: La campana debe sonar antes del amanecer.",
      revision: 0,
      sequence: 0
    });
    await client.flushProject("idea-project");

    const ideas = await client.request("project.call", {
      projectId: "idea-project",
      method: "getNarrativeIdeas",
      args: []
    });
    assert.equal(ideas.length, 1);
    assert.equal(ideas[0].status, "IDEA");

    const archived = await client.request("project.call", {
      projectId: "idea-project",
      method: "archiveUnincorporatedIdeas",
      args: []
    });
    assert.equal(archived.length, 1);
    assert.equal(archived[0].writerId, "writer-private");
    assert.equal(archived[0].category, "Libro ideas");
    assert.equal(archived[0].context.version, 1);

    const library = await client.request("project.call", {
      projectId: "idea-project",
      method: "getPersonalIdeaLibrary",
      args: []
    });
    assert.equal(library.length, 1);
    assert.equal(library[0].idea.text, "La campana debe sonar antes del amanecer.");

    const receipt = await client.request("project.call", {
      projectId: "idea-project",
      method: "getProjectFinalizationReceipt",
      args: []
    });
    assert.equal(receipt.sourceProjectId, "idea-project");
    assert.equal(receipt.writerId, "writer-private");

    const exited = waitForExit(child);
    await client.shutdown();
    assert.equal(await exited, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("el puente SQLite consolida identidades y actualiza atómicamente la biblioteca personal", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-merge-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let first;
  let second;
  try {
    first = startBridge(databasePath);
    await first.client.hello();
    await first.client.openProject({
      projectId: "merge-library-project",
      projectName: "Libro de identidades",
      writerId: "writer-merge-library"
    });
    await first.client.openDocument("merge-library-project", {
      documentId: "chapter-identities",
      text: "personaje Ana\npersonaje Anita\nIDEA: La campana debe sonar antes del amanecer.",
      revision: 0,
      sequence: 0
    });
    await first.client.flushProject("merge-library-project");

    const capabilities = await first.client.request("engine.capabilities", {
      projectId: "merge-library-project"
    });
    assert.equal(capabilities.narrativeEntityConsolidation, true);

    const entities = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "getNarrativeEntities", args: []
    });
    const target = entities.find(entity => entity.canonicalName === "Ana");
    const source = entities.find(entity => entity.canonicalName === "Anita");
    assert.ok(target, "Debe extraerse la ficha explícita de Ana.");
    assert.ok(source, "Debe extraerse la ficha explícita de Anita.");

    const ideas = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(ideas.length, 1);
    await first.client.request("project.call", {
      projectId: "merge-library-project",
      method: "setNarrativeIdeaEntityLink",
      args: [ideas[0].id, source.id, true]
    });
    const archived = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "archiveUnincorporatedIdeas", args: []
    });
    assert.equal(archived.length, 1);
    assert.deepEqual(archived[0].idea.relatedEntityIds, [source.id]);
    assert.equal(archived[0].context.relatedEntities[0].id, source.id);

    const merged = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "mergeNarrativeEntities",
      args: [target.id, source.id]
    });
    assert.equal(merged.id, target.id);
    assert.ok(merged.aliases.includes("Anita"));
    assert.ok(merged.mergedFromIds.includes(source.id));

    const activeEntities = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "getNarrativeEntities", args: []
    });
    assert.equal(activeEntities.some(entity => entity.id === source.id), false);
    assert.ok(activeEntities.some(entity => entity.id === target.id));

    const library = await first.client.request("project.call", {
      projectId: "merge-library-project", method: "getPersonalIdeaLibrary", args: []
    });
    assert.equal(library.length, 1);
    assert.deepEqual(library[0].idea.relatedEntityIds, [target.id]);
    assert.deepEqual(library[0].context.relatedEntities.map(entity => entity.id), [target.id]);
    assert.ok(library[0].context.relatedEntities[0].mergedFromIds.includes(source.id));
    assert.equal(library[0].idea.text, archived[0].idea.text);
    assert.deepEqual(library[0].idea.evidence, archived[0].idea.evidence);
    assert.deepEqual(library[0].idea.statusHistory, archived[0].idea.statusHistory);
    assert.equal(library[0].archivedAt, archived[0].archivedAt);

    const exitFirst = waitForExit(first.child);
    await first.client.shutdown();
    assert.equal(await exitFirst, 0);
    first = undefined;

    second = startBridge(databasePath);
    await second.client.hello();
    await second.client.openProject({
      projectId: "merge-library-project",
      projectName: "Libro de identidades",
      writerId: "writer-merge-library"
    });
    const recoveredLibrary = await second.client.request("project.call", {
      projectId: "merge-library-project", method: "getPersonalIdeaLibrary", args: []
    });
    const recoveredEntities = await second.client.request("project.call", {
      projectId: "merge-library-project", method: "getNarrativeEntities", args: []
    });
    assert.equal(recoveredLibrary.length, 1);
    assert.deepEqual(recoveredLibrary[0].idea.relatedEntityIds, [target.id]);
    assert.deepEqual(recoveredLibrary[0].context.relatedEntities.map(entity => entity.id), [target.id]);
    assert.ok(recoveredEntities.some(entity => entity.id === target.id));
    assert.equal(recoveredEntities.some(entity => entity.id === source.id), false);

    const exitSecond = waitForExit(second.child);
    await second.client.shutdown();
    assert.equal(await exitSecond, 0);
    second = undefined;
  } finally {
    for (const active of [first, second]) {
      if (!active) continue;
      try {
        const exited = waitForExit(active.child);
        await active.client.shutdown();
        await exited;
      } catch { active.child.kill(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
