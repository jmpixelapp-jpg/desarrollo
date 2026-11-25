import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostEngineApi, MotorLiterarioBridgeClient } from "../dist/motor-literario.js";
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


test("la finalización compacta devuelve un recibo y permite recuperar ideas por páginas", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-bridge-compact-finalization-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let child;
  let client;
  try {
    ({ child, client } = startBridge(databasePath));
    await client.hello();
    await client.openProject({
      projectId: "compact-finalization-project",
      projectName: "Libro compacto",
      writerId: "writer-compact"
    });
    await client.openDocument("compact-finalization-project", {
      documentId: "chapter-compact",
      text: "IDEA: Una ciudad conserva la memoria de sus habitantes.",
      revision: 0,
      sequence: 0
    });
    await client.flushProject("compact-finalization-project");

    const summary = await client.request("project.call", {
      projectId: "compact-finalization-project",
      method: "finalizeProjectToIdeaLibrary",
      args: []
    });
    assert.equal(summary.writerId, "writer-compact");
    assert.equal(summary.sourceProjectId, "compact-finalization-project");
    assert.equal(summary.sourceProjectName, "Libro compacto");
    assert.equal(summary.archivedCount, 1);
    assert.equal(summary.alreadyFinalized, false);
    assert.equal(typeof summary.archiveChecksum, "string");
    assert.equal(Array.isArray(summary), false);
    assert.equal(Object.hasOwn(summary, "items"), false);

    const page = await client.request("project.call", {
      projectId: "compact-finalization-project",
      method: "getPersonalIdeaLibraryPage",
      args: [null, 1]
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].idea.text, "Una ciudad conserva la memoria de sus habitantes.");
    assert.equal(page.nextCursor, null);
    assert.ok(Number.isSafeInteger(page.libraryVersion));
    assert.ok(page.libraryVersion >= 1);

    const retry = await client.request("project.call", {
      projectId: "compact-finalization-project",
      method: "finalizeProjectToIdeaLibrary",
      args: []
    });
    assert.equal(retry.alreadyFinalized, true);
    assert.deepEqual({ ...retry, alreadyFinalized: false }, summary);

    const unchangedPage = await client.request("project.call", {
      projectId: "compact-finalization-project",
      method: "getPersonalIdeaLibraryPage",
      args: [null, 1]
    });
    assert.equal(unchangedPage.libraryVersion, page.libraryVersion,
      "el reintento idempotente no incrementa la generación de la biblioteca");

    const exited = waitForExit(child);
    await client.shutdown();
    assert.equal(await exited, 0);
  } finally {
    if (child && client) {
      try {
        const exited = waitForExit(child);
        await client.shutdown();
        await exited;
      } catch {
        child.kill();
      }
    }
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
    assert.throws(
      () => firstStore.saveEntityIfUnchanged(staleUpdate, entity),
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

test("SQLite protege relaciones, acontecimientos, ideas y afirmaciones frente a escrituras obsoletas", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-narrative-cas-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let first;
  let second;
  const projectId = "narrative-cas-project";
  const entity = id => ({
    id,
    projectId,
    kind: "character",
    canonicalName: id === "entity-a" ? "Ana" : "Bruno",
    normalizedName: id === "entity-a" ? "ana" : "bruno",
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  });
  const evidence = {
    documentId: "chapter-cas",
    revision: 0,
    start: 0,
    end: 3,
    excerpt: "Ana"
  };
  try {
    first = await SqliteProjectStore.open(databasePath);
    second = await SqliteProjectStore.open(databasePath);
    await first.saveEntityIfUnchanged(entity("entity-a"));
    await first.saveEntityIfUnchanged(entity("entity-b"));

    const relation = {
      id: "relation-cas",
      projectId,
      fromEntityId: "entity-a",
      toEntityId: "entity-b",
      relationType: "knows",
      evidence: []
    };
    const event = {
      id: "event-cas",
      projectId,
      label: "Ana llega",
      participants: ["entity-a"],
      evidence: []
    };
    const idea = {
      id: "idea-cas",
      projectId,
      text: "La puerta debe permanecer cerrada.",
      status: "IDEA",
      originDocumentId: "chapter-cas",
      sourceProjectName: "Libro de prueba",
      evidence: [evidence]
    };
    const assertion = {
      id: "assertion-cas",
      projectId,
      entityId: "entity-a",
      entityName: "Ana",
      attribute: "role",
      value: "guardiana",
      evidence,
      capturedAt: 1
    };

    const cases = [
      {
        name: "relación",
        save: (record, expected) => first.saveRelationIfUnchanged(record, expected),
        otherSave: (record, expected) => second.saveRelationIfUnchanged(record, expected),
        original: relation,
        updated: { ...relation, relationType: "protects" },
        read: () => second.loadRelations(projectId),
        changed: records => records[0].relationType
      },
      {
        name: "acontecimiento",
        save: (record, expected) => first.saveEventIfUnchanged(record, expected),
        otherSave: (record, expected) => second.saveEventIfUnchanged(record, expected),
        original: event,
        updated: { ...event, label: "Ana abre la puerta" },
        read: () => second.loadEvents(projectId),
        changed: records => records[0].label
      },
      {
        name: "idea",
        save: (record, expected) => first.saveIdeaIfUnchanged(record, expected),
        otherSave: (record, expected) => second.saveIdeaIfUnchanged(record, expected),
        original: idea,
        updated: { ...idea, text: "La puerta debe permanecer abierta." },
        read: () => second.loadIdeas(projectId),
        changed: records => records[0].text
      },
      {
        name: "afirmación",
        save: (record, expected) => first.saveAssertionIfUnchanged(record, expected),
        otherSave: (record, expected) => second.saveAssertionIfUnchanged(record, expected),
        original: assertion,
        updated: { ...assertion, value: "capitana" },
        read: () => second.loadAssertions(projectId),
        changed: records => records[0].value
      }
    ];

    for (const item of cases) {
      await item.save(item.original);
      const secondRead = (await item.read())[0];
      assert.ok(secondRead, `Debe recuperarse la ${item.name} insertada.`);
      await item.otherSave(item.updated, secondRead);
      const stale = { ...item.original, ...(item.name === "relación" ? { relationType: "enemy" } :
        item.name === "acontecimiento" ? { label: "Versión obsoleta" } :
        item.name === "idea" ? { text: "Versión obsoleta" } : { value: "versión obsoleta" }) };
      assert.throws(() => item.save(stale, item.original), /cambió en otra instancia/);
      assert.equal(item.changed(await item.read()), item.name === "relación" ? "protects" :
        item.name === "acontecimiento" ? "Ana abre la puerta" :
        item.name === "idea" ? "La puerta debe permanecer abierta." : "capitana");
    }
  } finally {
    first?.close();
    second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dos almacenes SQLite finalizan el mismo libro sin duplicar ideas y conservan su historial", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-library-concurrent-finalization-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let first;
  let second;
  let reopened;
  const projectId = "library-concurrent-project";
  const writerId = "writer-library-concurrent";
  const sourceProjectName = "El libro de la campana";
  const evidence = {
    documentId: "chapter-library",
    revision: 3,
    start: 18,
    end: 48,
    excerpt: "La campana anunció su regreso."
  };
  const entity = {
    id: "entity:character:ana",
    projectId,
    kind: "character",
    canonicalName: "Ana",
    normalizedName: "ana",
    aliases: ["La viajera"],
    evidence: [evidence],
    firstSeenAt: 1,
    lastSeenAt: 3,
    extractionVersion: 1
  };
  const retainedIdea = {
    id: "idea:retained",
    projectId,
    text: "Ana regresará al pueblo.",
    status: "incorporated",
    originDocumentId: "chapter-library",
    sourceProjectName,
    evidence: [evidence],
    relatedEntityIds: [entity.id],
    statusHistory: [
      { status: "IDEA", changedAt: 10, reason: "initial" },
      { status: "incorporated", changedAt: 20, reason: "writer" }
    ]
  };
  const pendingIdea = {
    id: "idea:pending",
    projectId,
    text: "La campana debe sonar al amanecer.",
    status: "IDEA",
    originDocumentId: "chapter-library",
    sourceProjectName,
    evidence: [evidence],
    relatedEntityIds: [entity.id],
    relatedIdeaIds: [retainedIdea.id],
    statusHistory: [
      { status: "IDEA", changedAt: 11, reason: "initial" }
    ]
  };

  try {
    first = await SqliteProjectStore.open(databasePath);
    second = await SqliteProjectStore.open(databasePath);
    first.saveEntity(entity);
    first.saveIdea(retainedIdea);
    first.saveIdea(pendingIdea);

    // Dos instancias independientes intentan finalizar el mismo proyecto.
    const [firstTransfer, secondTransfer] = await Promise.all([
      new Promise((resolveTransfer, rejectTransfer) => {
        setImmediate(() => {
          try {
            resolveTransfer(first.archiveUnincorporatedIdeas(
              projectId, writerId, sourceProjectName, 100
            ));
          } catch (error) { rejectTransfer(error); }
        });
      }),
      new Promise((resolveTransfer, rejectTransfer) => {
        setImmediate(() => {
          try {
            resolveTransfer(second.archiveUnincorporatedIdeas(
              projectId, writerId, sourceProjectName, 200
            ));
          } catch (error) { rejectTransfer(error); }
        });
      })
    ]);

    assert.equal(firstTransfer.length, 1);
    assert.equal(secondTransfer.length, 1);
    assert.equal(firstTransfer[0].idea.id, pendingIdea.id);
    assert.equal(secondTransfer[0].idea.id, pendingIdea.id);
    assert.equal(secondTransfer[0].archivedAt, firstTransfer[0].archivedAt,
      "el segundo intento recupera la transferencia confirmada, no la reemplaza");
    assert.deepEqual(firstTransfer[0].idea.statusHistory, pendingIdea.statusHistory);
    assert.deepEqual(secondTransfer[0].idea.statusHistory, pendingIdea.statusHistory);
    assert.deepEqual(firstTransfer[0].context.relatedIdeas[0].statusHistory, retainedIdea.statusHistory);
    assert.deepEqual(firstTransfer[0].context.relatedEntities.map(item => item.id), [entity.id]);
    assert.equal(firstTransfer[0].writerId, writerId);
    assert.equal(firstTransfer[0].sourceProjectId, projectId);
    assert.equal(firstTransfer[0].category, sourceProjectName);

    const remaining = second.loadIdeas(projectId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, retainedIdea.id);
    assert.deepEqual(remaining[0].statusHistory, retainedIdea.statusHistory);
    assert.equal(second.loadPersonalIdeas(writerId).length, 1);
    const receipt = second.loadProjectFinalizationReceipt(writerId, projectId);
    assert.deepEqual(receipt.archivedIdeaIds, [pendingIdea.id]);

    first.close();
    first = undefined;
    second.close();
    second = undefined;
    reopened = await SqliteProjectStore.open(databasePath);
    const recoveredLibrary = reopened.loadPersonalIdeas(writerId);
    assert.equal(recoveredLibrary.length, 1);
    assert.deepEqual(recoveredLibrary[0].idea.statusHistory, pendingIdea.statusHistory);
    assert.deepEqual(recoveredLibrary[0].context.relatedIdeas[0].statusHistory, retainedIdea.statusHistory);
    assert.deepEqual(reopened.loadProjectFinalizationReceipt(writerId, projectId).archivedIdeaIds, [pendingIdea.id]);
  } finally {
    first?.close();
    second?.close();
    reopened?.close();
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


test("SQLite migra bibliotecas existentes y las lee por cursor keyset", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-sqlite-library-page-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const writerId = "writer-sqlite-page";
  const projectId = "book-sqlite-page";
  const database = new DatabaseSync(databasePath);
  const entry = id => ({
    writerId,
    sourceProjectId: projectId,
    sourceProjectName: "Libro SQLite",
    category: "Libro SQLite",
    idea: {
      projectId,
      id,
      text: "Idea " + id,
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Libro SQLite",
      evidence: []
    },
    archivedAt: 1
  });
  try {
    // Simula una base anterior a la columna sort_key.
    database.exec(
      "CREATE TABLE bridge_records (" +
      "collection TEXT NOT NULL, record_key TEXT NOT NULL, project_id TEXT, " +
      "writer_id TEXT, document_id TEXT, sequence INTEGER, value_json TEXT NOT NULL, " +
      "PRIMARY KEY (collection, record_key)) WITHOUT ROWID"
    );
    database.exec("CREATE INDEX bridge_records_writer ON bridge_records(collection, writer_id)");
    const insert = database.prepare(
      "INSERT INTO bridge_records(collection, record_key, project_id, writer_id, value_json) VALUES(?, ?, ?, ?, ?)"
    );
    for (const id of ["idea-c", "idea-a", "idea-b"]) {
      const value = entry(id);
      insert.run(
        "personal-idea-library",
        JSON.stringify([writerId, projectId, id]),
        null,
        writerId,
        JSON.stringify(value)
      );
    }

    const store = new SqliteProjectStore(database, databasePath);
    const first = store.loadPersonalIdeasPage(writerId, null, 2);
    assert.deepEqual(first.items.map(item => item.idea.id), ["idea-a", "idea-b"]);
    assert.equal(first.libraryVersion, 0);
    assert.deepEqual(first.nextCursor, {
      sourceProjectId: projectId,
      ideaId: "idea-b",
      libraryVersion: 0
    });

    const second = store.loadPersonalIdeasPage(writerId, first.nextCursor, 2);
    assert.deepEqual(second.items.map(item => item.idea.id), ["idea-c"]);
    assert.equal(second.nextCursor, null);
    assert.equal(second.libraryVersion, 0);

    // Inserta una idea que ordena antes del cursor ya entregado.
    // La página siguiente debe pedir reinicio para no omitirla silenciosamente.
    store.transaction(() => {
      store.put("personal-idea-library", [writerId, projectId, "idea-0"], entry("idea-0"));
    });
    const stale = store.loadPersonalIdeasPage(writerId, first.nextCursor, 2);
    assert.deepEqual(stale.items, []);
    assert.equal(stale.nextCursor, null);
    assert.equal(stale.libraryVersion, 1);
    assert.equal(stale.restartRequired, true);

    const restarted = store.loadPersonalIdeasPage(writerId, null, 2);
    assert.deepEqual(restarted.items.map(item => item.idea.id), ["idea-0", "idea-a"]);
    assert.equal(restarted.libraryVersion, 1);
    assert.deepEqual(restarted.nextCursor, {
      sourceProjectId: projectId,
      ideaId: "idea-a",
      libraryVersion: 1
    });
    const finalPage = store.loadPersonalIdeasPage(writerId, restarted.nextCursor, 2);
    assert.deepEqual(finalPage.items.map(item => item.idea.id), ["idea-b", "idea-c"]);
    assert.equal(finalPage.nextCursor, null);
    assert.equal(finalPage.libraryVersion, 1);
    assert.equal(
      store.loadPersonalIdea(writerId, projectId, "idea-b").idea.id,
      "idea-b"
    );
    assert.deepEqual(
      store.loadPersonalIdeasByKeys(writerId, [
        { sourceProjectId: projectId, ideaId: "idea-a" },
        { sourceProjectId: projectId, ideaId: "missing-idea" },
        { sourceProjectId: projectId, ideaId: "idea-c" }
      ]).map(item => item.idea.id),
      ["idea-a", "idea-c"]
    );

    const schema = database.prepare("PRAGMA table_info(bridge_records)").all();
    assert.ok(schema.some(column => column.name === "sort_key"));
    const plan = database.prepare(
      "EXPLAIN QUERY PLAN SELECT value_json FROM bridge_records " +
      "WHERE collection = 'personal-idea-library' AND writer_id = ? AND sort_key > ? " +
      "ORDER BY sort_key LIMIT ?"
    ).all(writerId, "", 3);
    assert.ok(
      plan.some(row => row.detail.includes("bridge_records_personal_library_page")),
      "la consulta keyset debe usar el índice parcial de biblioteca"
    );
    store.close();
  } finally {
    try { database.close(); } catch { /* El almacenamiento puede haber cerrado la conexión. */ }
    await rm(directory, { recursive: true, force: true });
  }
});



test("SQLite guarda cada cambio de acontecimiento junto con su historial append-only", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-event-lifecycle-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const projectId = "sqlite-event-history-project";
  const store = await SqliteProjectStore.open(databasePath);
  const original = {
    projectId,
    id: "event-guard-arrives",
    label: "La guardia llega a la puerta",
    participants: [],
    evidence: []
  };
  const api = new HostEngineApi({ store });
  try {
    store.saveEvent(original);
    api.initializeProject({
      projectId,
      projectName: "Libro de acontecimientos",
      writerId: "writer-event-history"
    });

    const loaded = await api.getNarrativeEvents();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].label, original.label);

    const firstUpdate = await api.updateNarrativeEvent({
      eventId: original.id,
      label: "La guardia abre la puerta",
      changedBy: "writer-event-history",
      changeReason: "El escritor ajustó el acontecimiento",
      changedAt: 100
    });
    assert.equal(firstUpdate.label, "La guardia abre la puerta");

    const firstHistory = await api.getEventLifecycleHistory(original.id);
    assert.equal(firstHistory.length, 1);
    assert.equal(firstHistory[0].revision, 1);
    assert.equal(firstHistory[0].previousLabel, original.label);
    assert.equal(firstHistory[0].newLabel, firstUpdate.label);
    assert.equal(firstHistory[0].changedBy, "writer-event-history");

    const secondUpdate = await api.updateNarrativeEvent({
      eventId: original.id,
      label: "La guardia protege la entrada",
      changedBy: "writer-event-history",
      changedAt: 200
    });
    const completeHistory = await store.loadProjectEventLifecycles(projectId);
    assert.deepEqual(completeHistory.map(item => item.revision), [1, 2]);
    assert.equal(completeHistory[1].previousLabel, firstUpdate.label);
    assert.equal(completeHistory[1].newLabel, secondUpdate.label);

    const invalidEvent = { ...secondUpdate, label: "Una versión que no debe publicarse" };
    const invalidLifecycle = {
      projectId,
      id: original.id + ":v3",
      eventId: original.id,
      revision: 3,
      previousLabel: secondUpdate.label,
      newLabel: invalidEvent.label,
      previousParticipants: [],
      newParticipants: [],
      changedBy: "writer-event-history",
      changedAt: 150
    };
    assert.throws(
      () => store.saveEventAndAppendLifecycleIfUnchanged(
        invalidEvent, secondUpdate, invalidLifecycle
      ),
      /no continúa la última revisión durable/
    );

    const persisted = (await store.loadEvents(projectId))[0];
    const afterRejectedWrite = await store.loadEventLifecycles(projectId, original.id);
    assert.equal(persisted.label, secondUpdate.label);
    assert.equal(afterRejectedWrite.length, 2);
    assert.deepEqual(afterRejectedWrite.map(item => item.revision), [1, 2]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});



test("sincroniza la biblioteca del escritor entre proyectos y procesos sin filtrar a otros escritores", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-writer-library-sync-"));
  const databasePath = resolve(directory, "motor.sqlite");
  let first;
  let second;
  try {
    first = startBridge(databasePath);
    second = startBridge(databasePath);
    await Promise.all([first.client.hello(), second.client.hello()]);

    await first.client.openProject({
      projectId: "writer-sync-source",
      projectName: "Libro de origen",
      writerId: "writer-shared"
    });
    await first.client.openProject({
      projectId: "writer-sync-sibling",
      projectName: "Otro libro del mismo escritor",
      writerId: "writer-shared"
    });
    await first.client.openProject({
      projectId: "writer-sync-private",
      projectName: "Libro de otro escritor",
      writerId: "writer-private"
    });
    await second.client.openProject({
      projectId: "writer-sync-peer",
      projectName: "Libro abierto en otro proceso",
      writerId: "writer-shared"
    });
    await second.client.openProject({
      projectId: "writer-sync-other",
      projectName: "Otro escritor en otro proceso",
      writerId: "writer-other"
    });

    const waitForProjects = (client, expectedCount) => new Promise((resolveNotice, rejectNotice) => {
      const received = [];
      const timer = setTimeout(() => {
        unsubscribe();
        rejectNotice(new Error("No llegaron todas las notificaciones de biblioteca esperadas: " +
          received.map(item => item.projectId).join(", ")));
      }, 15_000);
      const unsubscribe = client.onNotification("engine.personalIdeaLibraryChanged", params => {
        received.push(params);
        if (received.length >= expectedCount) {
          clearTimeout(timer);
          unsubscribe();
          resolveNotice(received);
        }
      });
    });

    const firstNotices = waitForProjects(first.client, 2);
    const secondNotices = waitForProjects(second.client, 1);

    await first.client.openDocument("writer-sync-source", {
      documentId: "chapter-ideas",
      text: "IDEA: La campana debe sonar antes del amanecer.",
      revision: 0,
      sequence: 0
    });
    await first.client.flushProject("writer-sync-source");

    const archived = await first.client.request("project.call", {
      projectId: "writer-sync-source",
      method: "archiveUnincorporatedIdeas",
      args: []
    });
    assert.equal(archived.length, 1);
    assert.equal(archived[0].writerId, "writer-shared");

    const [sameProcess, otherProcess] = await Promise.all([firstNotices, secondNotices]);
    assert.deepEqual(
      sameProcess.map(item => item.projectId).sort(),
      ["writer-sync-sibling", "writer-sync-source"]
    );
    assert.deepEqual(otherProcess.map(item => item.projectId), ["writer-sync-peer"]);
    assert.ok([...sameProcess, ...otherProcess].every(item => item.writerId === "writer-shared"));
    assert.ok(![...sameProcess, ...otherProcess].some(item =>
      item.projectId === "writer-sync-private" || item.projectId === "writer-sync-other"
    ));

    const peerPage = await second.client.getPersonalIdeaLibraryPage(
      "writer-sync-peer", null, 50
    );
    assert.equal(peerPage.items.length, 1);
    assert.equal(peerPage.items[0].idea.text, "La campana debe sonar antes del amanecer.");
    assert.ok(Number.isSafeInteger(peerPage.libraryVersion));
    assert.ok(peerPage.libraryVersion >= 1,
      "la página compartida devuelve la generación durable del escritor");

    const privatePage = await second.client.getPersonalIdeaLibraryPage(
      "writer-sync-other", null, 50
    );
    assert.equal(privatePage.items.length, 0);
    assert.equal(privatePage.libraryVersion, 0,
      "otro escritor mantiene una generación independiente");
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


test("SQLite finaliza libros grandes por páginas sin materializar todas las ideas ni entidades", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "motor-literario-library-paged-finalization-"));
  const databasePath = resolve(directory, "motor.sqlite");
  const store = await SqliteProjectStore.open(databasePath);
  const projectId = "paged-library-project";
  const writerId = "writer-paged-library";
  const sourceProjectName = "Libro paginado";
  const total = 300;

  try {
    for (let index = 0; index < total; index++) {
      const suffix = String(index).padStart(4, "0");
      const entityId = "entity:" + suffix;
      const canonicalName = "Personaje " + suffix;
      store.saveEntity({
        id: entityId,
        projectId,
        kind: "character",
        canonicalName,
        normalizedName: canonicalName.toLocaleLowerCase("es"),
        aliases: [],
        evidence: [],
        firstSeenAt: index,
        lastSeenAt: index,
        extractionVersion: 1
      });
      store.saveIdea({
        id: "idea:" + suffix,
        projectId,
        text: "Idea narrativa " + suffix,
        status: "IDEA",
        originDocumentId: "chapter-paged",
        sourceProjectName,
        evidence: [],
        relatedEntityIds: [entityId],
        relatedIdeaIds: [],
        statusHistory: [{ status: "IDEA", changedAt: index, reason: "initial" }]
      });
    }

    const aggregateIdeaLoader = store.loadIdeas;
    const aggregateEntityLoader = store.loadEntities;
    store.loadIdeas = () => { throw new Error("No debe materializar la colección completa de ideas."); };
    store.loadEntities = () => { throw new Error("No debe materializar la colección completa de entidades."); };

    let archived;
    try {
      archived = store.archiveUnincorporatedIdeas(projectId, writerId, sourceProjectName, 500);
    } finally {
      store.loadIdeas = aggregateIdeaLoader;
      store.loadEntities = aggregateEntityLoader;
    }

    assert.equal(archived.length, total);
    assert.equal(archived[0].context.relatedEntities.length, 1);
    assert.equal(archived[0].context.relatedEntities[0].id, "entity:0000");
    assert.equal(archived[total - 1].context.relatedEntities[0].id, "entity:0299");
    assert.equal(store.loadIdeas(projectId).length, 0);

    const receipt = store.loadProjectFinalizationReceipt(writerId, projectId);
    assert.equal(receipt.archivedIdeaIds.length, total);
    assert.equal(receipt.archivedIdeaIds[0], "idea:0000");
    assert.equal(receipt.archivedIdeaIds[total - 1], "idea:0299");
    assert.equal(store.loadPersonalIdeas(writerId).length, total);
    const retry = store.archiveUnincorporatedIdeas(projectId, writerId, sourceProjectName, 600);
    assert.deepEqual(retry, [], "un reintento valida el recibo sin volver a devolver todas las ideas");
    assert.equal(store.loadPersonalIdeas(writerId).length, total);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

