import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MotorLiterarioBridgeClient } from "../dist/motor-literario.js";
import { SqliteProjectStore } from "../bridge/sqlite-project-store.mjs";

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


test("el archivo de ideas conserva contexto independiente para cada entrada de biblioteca", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-idea-context-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const { child, client } = startBridge(databasePath);
  try {
    await client.hello();
    await client.openProject({
      projectId: "idea-context-project",
      projectName: "Libro de contextos",
      writerId: "writer-context"
    });
    await client.openDocument("idea-context-project", {
      documentId: "chapter-context",
      text: "personaje Ana\npersonaje Anita\nIDEA: La campana debe sonar.\nIDEA: La puerta debe permanecer cerrada.",
      revision: 0,
      sequence: 0
    });
    await client.flushProject("idea-context-project");
    const entities = await client.request("project.call", {
      projectId: "idea-context-project", method: "getNarrativeEntities", args: []
    });
    const ana = entities.find(item => item.canonicalName === "Ana");
    const anita = entities.find(item => item.canonicalName === "Anita");
    assert.ok(ana);
    assert.ok(anita);
    const ideas = await client.request("project.call", {
      projectId: "idea-context-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(ideas.length, 2);
    const campana = ideas.find(item => item.text.includes("campana"));
    const puerta = ideas.find(item => item.text.includes("puerta"));
    assert.ok(campana);
    assert.ok(puerta);
    await client.request("project.call", {
      projectId: "idea-context-project", method: "setNarrativeIdeaEntityLink",
      args: [campana.id, ana.id, true]
    });
    await client.request("project.call", {
      projectId: "idea-context-project", method: "setNarrativeIdeaEntityLink",
      args: [puerta.id, anita.id, true]
    });
    const archived = await client.request("project.call", {
      projectId: "idea-context-project", method: "archiveUnincorporatedIdeas", args: []
    });
    assert.equal(archived.length, 2);
    const campanaEntry = archived.find(entry => entry.idea.id === campana.id);
    const puertaEntry = archived.find(entry => entry.idea.id === puerta.id);
    assert.deepEqual(campanaEntry.context.relatedEntities.map(entity => entity.id), [ana.id]);
    assert.deepEqual(puertaEntry.context.relatedEntities.map(entity => entity.id), [anita.id]);
    assert.equal(campanaEntry.context.relatedIdeas.length, 0);
    assert.equal(puertaEntry.context.relatedIdeas.length, 0);

    const repeated = await client.request("project.call", {
      projectId: "idea-context-project", method: "archiveUnincorporatedIdeas", args: []
    });
    assert.equal(repeated.length, 2);
    assert.deepEqual(repeated.map(entry => entry.idea.id).sort(), [campana.id, puerta.id].sort());

    const exited = waitForExit(child);
    await client.shutdown();
    assert.equal(await exited, 0);
  } finally {
    try {
      const exited = waitForExit(child);
      await client.shutdown();
      await exited;
    } catch { child.kill(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("el archivo rechaza referencias desde ideas que permanecerán en el libro", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-idea-graph-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const { child, client } = startBridge(databasePath);
  try {
    await client.hello();
    await client.openProject({
      projectId: "idea-graph-project",
      projectName: "Libro de grafo",
      writerId: "writer-graph"
    });
    await client.openDocument("idea-graph-project", {
      documentId: "chapter-graph",
      text: "IDEA: La campana debe sonar.\nIDEA: La puerta debe permanecer cerrada.",
      revision: 0,
      sequence: 0
    });
    await client.flushProject("idea-graph-project");
    const ideas = await client.request("project.call", {
      projectId: "idea-graph-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(ideas.length, 2);
    const retained = ideas.find(item => item.text.includes("campana"));
    const pending = ideas.find(item => item.text.includes("puerta"));
    await client.request("project.call", {
      projectId: "idea-graph-project", method: "setNarrativeIdeaLink",
      args: [retained.id, pending.id, true]
    });
    await client.request("project.call", {
      projectId: "idea-graph-project", method: "setNarrativeIdeaStatus",
      args: [retained.id, "incorporated"]
    });
    await assert.rejects(
      client.request("project.call", {
        projectId: "idea-graph-project", method: "archiveUnincorporatedIdeas", args: []
      }),
      error => error?.code === -32000 && /depende de una idea que se trasladaría/.test(error.message)
    );
    const library = await client.request("project.call", {
      projectId: "idea-graph-project", method: "getPersonalIdeaLibrary", args: []
    });
    const remaining = await client.request("project.call", {
      projectId: "idea-graph-project", method: "getNarrativeIdeas", args: []
    });
    const receipt = await client.request("project.call", {
      projectId: "idea-graph-project", method: "getProjectFinalizationReceipt", args: []
    });
    assert.equal(library.length, 0);
    assert.equal(remaining.length, 2);
    assert.equal(receipt, null);

    const exited = waitForExit(child);
    await client.shutdown();
    assert.equal(await exited, 0);
  } finally {
    try {
      const exited = waitForExit(child);
      await client.shutdown();
      await exited;
    } catch { child.kill(); }
    await rm(directory, { recursive: true, force: true });
  }
});


test("una instancia recibe una notificación y actualiza sus cachés por cambios narrativos externos", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-auto-sync-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let first;
  let second;
  try {
    first = startBridge(databasePath);
    await first.client.hello();
    await first.client.openProject({
      projectId: "shared-project",
      projectName: "Libro compartido",
      writerId: "writer-shared"
    });
    await first.client.openDocument("shared-project", {
      documentId: "chapter-shared",
      text: "IDEA: La campana debe sonar antes del amanecer.",
      revision: 0,
      sequence: 0
    });
    await first.client.flushProject("shared-project");
    const firstIdeas = await first.client.request("project.call", {
      projectId: "shared-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(firstIdeas.length, 1);
    assert.equal(firstIdeas[0].status, "IDEA");

    second = startBridge(databasePath);
    await second.client.hello();
    await second.client.openProject({
      projectId: "shared-project",
      projectName: "Libro compartido",
      writerId: "writer-shared"
    });
    const secondIdeas = await second.client.request("project.call", {
      projectId: "shared-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(secondIdeas.length, 1);

    const knowledgeChanged = new Promise((resolveNotice, rejectNotice) => {
      const timer = setTimeout(
        () => rejectNotice(new Error("No llegó la notificación de conocimiento narrativo.")),
        10_000
      );
      first.client.onNotification("engine.knowledgeChanged", params => {
        if (params?.projectId === "shared-project") {
          clearTimeout(timer);
          resolveNotice(params);
        }
      });
    });
    await second.client.request("project.call", {
      projectId: "shared-project",
      method: "setNarrativeIdeaStatus",
      args: [secondIdeas[0].id, "incorporated"]
    });
    const notice = await knowledgeChanged;
    assert.equal(notice.projectId, "shared-project");

    const automaticallyRefreshed = await first.client.request("project.call", {
      projectId: "shared-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(automaticallyRefreshed[0].status, "incorporated");

    await first.client.request("project.call", {
      projectId: "shared-project", method: "refreshNarrativeKnowledge", args: []
    });
    const explicitlyRefreshed = await first.client.request("project.call", {
      projectId: "shared-project", method: "getNarrativeIdeas", args: []
    });
    assert.equal(explicitlyRefreshed[0].status, "incorporated");

    const firstExit = waitForExit(first.child);
    await first.client.shutdown();
    assert.equal(await firstExit, 0);
    first = undefined;
    const secondExit = waitForExit(second.child);
    await second.client.shutdown();
    assert.equal(await secondExit, 0);
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

test("SQLite rechaza una escritura de entidad narrativa basada en una versión obsoleta", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-entity-cas-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let firstStore;
  let secondStore;
  const entity = {
    id: "entity:character:ana",
    projectId: "entity-cas-project",
    kind: "character",
    canonicalName: "Ana",
    normalizedName: "ana",
    aliases: [],
    evidence: [{
      documentId: "chapter-cas",
      revision: 0,
      start: 0,
      end: 3,
      excerpt: "Ana"
    }],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  };
  try {
    firstStore = await SqliteProjectStore.open(databasePath);
    secondStore = await SqliteProjectStore.open(databasePath);
    await firstStore.saveEntityIfUnchanged(entity);
    const secondRead = (await secondStore.loadEntities("entity-cas-project"))[0];
    assert.ok(secondRead);

    const updated = { ...secondRead, aliases: ["Anita"] };
    await secondStore.saveEntityIfUnchanged(updated, secondRead);

    const staleUpdate = { ...entity, aliases: ["Ana antigua"] };
    await assert.rejects(
      firstStore.saveEntityIfUnchanged(staleUpdate, entity),
      /cambió en otra instancia/
    );

    const persisted = (await secondStore.loadEntities("entity-cas-project"))[0];
    assert.deepEqual(persisted.aliases, ["Anita"]);
  } finally {
    firstStore?.close();
    secondStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite rechaza historiales de identidad con IDs de origen duplicados sin modificar las fichas", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-identity-history-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const store = await SqliteProjectStore.open(databasePath);
  const entity = (id, canonicalName, mergedFromIds = []) => ({
    id,
    projectId: "identity-history-project",
    kind: "character",
    canonicalName,
    normalizedName: canonicalName.toLocaleLowerCase("es"),
    aliases: [],
    mergedFromIds,
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  });
  try {
    store.saveEntity(entity("target", "Ana", ["legacy-id", "legacy-id"]));
    store.saveEntity(entity("source", "Anita"));
    assert.throws(
      () => store.mergeNarrativeEntityIdentity(
        "identity-history-project", "target", "source", "writer-history"
      ),
      /entidad malformada/
    );
    const persisted = await store.loadEntities("identity-history-project");
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.find(item => item.id === "target").mergedFromIds, ["legacy-id", "legacy-id"]);
    assert.ok(persisted.some(item => item.id === "source"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
