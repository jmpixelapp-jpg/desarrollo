#!/usr/bin/env node

import { resolve } from "node:path";
import { SqliteProjectStore } from "./sqlite-project-store.mjs";

const PROTOCOL_VERSION = "1.0.0";
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const projects = new Map();
const inFlight = new Set();
const activeIds = new Set();
const activeDispatches = new Set();
let store;
let shuttingDown = false;
let inputBuffer = "";
let knowledgeSyncInterval;
let lastObservedDataVersion;
let knowledgeSyncTail = Promise.resolve();
const lastNarrativeVersions = new Map();
const pendingNarrativeSyncs = new Set();
const lastWriterLibraryVersions = new Map();
const pendingWriterLibrarySyncs = new Map();
const KNOWLEDGE_SYNC_INTERVAL_MS = 500;

const PUBLIC_API_METHODS = new Set([
  "extractNarrativeKnowledge",
  "addNarrativeEntityAlias",
  "getNarrativeEntityIdentityCandidates",
  "mergeNarrativeEntities",
  "getNarrativeEntities",
  "getNarrativeRelations",
  "getNarrativeEvents",
  "getEventLifecycleHistory",
  "updateNarrativeEvent",
  "setNarrativeEventTimelineTrack",
  "getNarrativeTimeline",
  "getNarrativeContradictions",
  "analyzeLiteraryDocument",
  "resolveNarrativeEntityId",
  "getNarrativeEntityHistory",
  "getNarrativeAssertions",
  "getProjectSettings",
  "setProjectSetting",
  "getLanguageProfiles",
  "saveLanguageProfile",
  "getLanguageResourceRefs",
  "saveLanguageResourceRef",
  "getRecordLifecycleHistory",
  "appendRecordLifecycle",
  "getRelationLifecycleHistory",
  "appendRelationLifecycle",
  "getManuscriptFragments",
  "saveManuscriptFragment",
  "getProjectRecords",
  "saveProjectRecord",
  "getRecordNames",
  "saveRecordName",
  "getProjectRelations",
  "saveProjectRelation",
  "getProjectEvidences",
  "saveProjectEvidence",
  "getTimelineOccurrences",
  "saveTimelineOccurrence",
  "getRecordAttributes",
  "saveRecordAttribute",
  "getRelationAttributes",
  "saveRelationAttribute",
  "getActiveSuggestions",
  "saveActiveSuggestion",
  "getImportAuthorizations",
  "authorizeImportBetweenProjects",
  "getSchemaMigrations",
  "getStyleProfiles",
  "saveStyleProfile",
  "getTimelineTracks",
  "saveTimelineTrack",
  "getProjectDictionaries",
  "saveProjectDictionary",
  "getDictionaryEntries",
  "saveDictionaryEntry",
  "getDictionaryEntryEntityLinks",
  "setDictionaryEntryEntityLink",
  "getNarrativeIdeas",
  "refreshNarrativeKnowledge",
  "setNarrativeIdeaEntityLink",
  "setNarrativeIdeaLink",
  "archiveUnincorporatedIdeas",
  "finalizeProjectToIdeaLibrary",
  "getPersonalIdeaLibrary",
  "getPersonalIdeaLibraryPage",
  "getProjectFinalizationReceipt",
  "setNarrativeIdeaStatus"
]);

function send(message) {
  const line = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("La respuesta supera el límite de 16 MiB del puente.");
  }
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(line, error => error ? rejectWrite(error) : resolveWrite());
  });
}

function errorPayload(error) {
  const safe = error instanceof Error ? error : new Error(String(error));
  return {
    code: -32000,
    message: safe.message || "Error interno del Motor Literario.",
    data: { name: safe.name || "Error" }
  };
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " debe ser un objeto JSON.");
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(label + " es obligatorio.");
  return value;
}

function getProject(projectId) {
  const id = requireString(projectId, "projectId");
  const record = projects.get(id);
  if (!record) throw new Error("El proyecto no está abierto en el puente.");
  return record.api;
}

function openProject(params) {
  requireObject(params, "params");
  const projectId = requireString(params.projectId, "projectId");
  const projectName = requireString(params.projectName, "projectName");
  if (params.writerId !== undefined) requireString(params.writerId, "writerId");
  const identity = {
    projectId,
    projectName,
    ...(params.writerId === undefined ? {} : { writerId: params.writerId })
  };
  const existing = projects.get(projectId);
  if (existing) {
    existing.api.initializeProject(identity);
    return { projectId, alreadyOpen: true, capabilities: existing.api.getCapabilities() };
  }

  const { HostEngineApi } = globalThis.__motorLiterarioModule;
  const api = new HostEngineApi({
    store,
    callbacks: {
      onAnalysis(result) {
        void send({ jsonrpc: "2.0", method: "engine.analysis", params: result }).catch(writeError);
      },
      onCommit(result) {
        void send({ jsonrpc: "2.0", method: "engine.commit", params: { projectId, result } }).catch(writeError);
      },
      onKnowledgeError(error) {
        void send({
          jsonrpc: "2.0",
          method: "engine.knowledgeError",
          params: {
            projectId,
            error: {
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error)
            }
          }
        }).catch(writeError);
      },
      onPersonalIdeaLibraryChanged(writerId) {
        notifyPersonalIdeaLibraryChanged(writerId);
      }
    }
  });
  api.initializeProject(identity);
  const record = { api, identity };
  projects.set(projectId, record);
  lastNarrativeVersions.set(projectId, store.getNarrativeVersion(projectId));
  if (identity.writerId && store.getWriterLibraryVersion &&
      ![...projects.values()].some(item => item !== record &&
        item.identity.writerId === identity.writerId)) {
    lastWriterLibraryVersions.set(identity.writerId, store.getWriterLibraryVersion(identity.writerId));
  }
  return { projectId, alreadyOpen: false, capabilities: api.getCapabilities() };
}

function notifyPersonalIdeaLibraryChanged(writerId) {
  if (typeof writerId !== "string" || !writerId.trim()) return;
  if (store?.getWriterLibraryVersion) {
    lastWriterLibraryVersions.set(writerId, store.getWriterLibraryVersion(writerId));
    pendingWriterLibrarySyncs.delete(writerId);
  }
  for (const [projectId, record] of projects) {
    if (record.identity.writerId !== writerId) continue;
    void send({
      jsonrpc: "2.0",
      method: "engine.personalIdeaLibraryChanged",
      params: { projectId, writerId }
    }).catch(writeError);
  }
}

function writeError(error) {
  process.stderr.write("[motor-literario-bridge] " + String(error?.message ?? error) + "\n");
}

async function pollExternalNarrativeChanges() {
  if (!store || store.closed || shuttingDown) return;

  // Lee una instantánea estable: si otra conexión confirma una escritura
  // mientras se consultan las versiones de proyectos, se reintenta en el
  // siguiente ciclo sin avanzar el punto de control ni perder el aviso.
  const dataVersionBefore = store.getDataVersion();
  const narrativeVersions = new Map();
  for (const projectId of projects.keys()) {
    narrativeVersions.set(projectId, store.getNarrativeVersion(projectId));
  }
  const writerLibraryVersions = new Map();
  if (store.getWriterLibraryVersion) {
    for (const record of projects.values()) {
      const writerId = record.identity.writerId;
      if (writerId && !writerLibraryVersions.has(writerId)) {
        writerLibraryVersions.set(writerId, store.getWriterLibraryVersion(writerId));
      }
    }
  }
  const dataVersionAfter = store.getDataVersion();
  if (dataVersionBefore !== dataVersionAfter) return;

  const externalCommit = lastObservedDataVersion !== undefined &&
    dataVersionAfter !== lastObservedDataVersion;
  lastObservedDataVersion = dataVersionAfter;

  if (externalCommit) {
    for (const [writerId, currentVersion] of writerLibraryVersions) {
      const previousVersion = lastWriterLibraryVersions.get(writerId);
      if (previousVersion !== undefined && currentVersion !== previousVersion) {
        pendingWriterLibrarySyncs.set(writerId, currentVersion);
      }
    }
  } else {
    for (const [writerId, currentVersion] of writerLibraryVersions) {
      if (!pendingWriterLibrarySyncs.has(writerId)) {
        lastWriterLibraryVersions.set(writerId, currentVersion);
      }
    }
  }

  for (const [writerId, targetVersion] of pendingWriterLibrarySyncs) {
    const currentVersion = writerLibraryVersions.get(writerId);
    if (currentVersion === undefined) continue;
    let delivered = true;
    for (const [projectId, record] of projects) {
      if (record.identity.writerId !== writerId) continue;
      try {
        await send({
          jsonrpc: "2.0",
          method: "engine.personalIdeaLibraryChanged",
          params: { projectId, writerId }
        });
      } catch (error) {
        delivered = false;
        writeError(error);
        break;
      }
    }
    if (delivered) {
      lastWriterLibraryVersions.set(writerId, currentVersion);
      if (pendingWriterLibrarySyncs.get(writerId) === targetVersion) {
        pendingWriterLibrarySyncs.delete(writerId);
      }
    }
  }

  for (const [projectId, record] of projects) {
    const currentNarrativeVersion = narrativeVersions.get(projectId);
    if (currentNarrativeVersion === undefined) continue;
    const previousNarrativeVersion = lastNarrativeVersions.get(projectId);
    if (externalCommit && previousNarrativeVersion !== undefined &&
        currentNarrativeVersion !== previousNarrativeVersion) {
      pendingNarrativeSyncs.add(projectId);
    }
    if (!pendingNarrativeSyncs.has(projectId)) {
      lastNarrativeVersions.set(projectId, currentNarrativeVersion);
      continue;
    }

    try {
      await record.api.invalidateNarrativeKnowledgeFromExternalChange();
      lastNarrativeVersions.set(projectId, currentNarrativeVersion);
      pendingNarrativeSyncs.delete(projectId);
      if (projects.get(projectId) === record) {
        await send({
          jsonrpc: "2.0",
          method: "engine.knowledgeChanged",
          params: { projectId }
        });
      }
    } catch (error) {
      writeError(error);
    }
  }
}

function startKnowledgeSync(preserveObservedVersion = false) {
  if (!preserveObservedVersion || lastObservedDataVersion === undefined) {
    lastObservedDataVersion = store.getDataVersion();
  }
  if (knowledgeSyncInterval) clearInterval(knowledgeSyncInterval);
  knowledgeSyncInterval = setInterval(() => {
    knowledgeSyncTail = knowledgeSyncTail
      .then(() => pollExternalNarrativeChanges())
      .catch(writeError);
  }, KNOWLEDGE_SYNC_INTERVAL_MS);
  knowledgeSyncInterval.unref?.();
}

function stopKnowledgeSync() {
  if (knowledgeSyncInterval) clearInterval(knowledgeSyncInterval);
  knowledgeSyncInterval = undefined;
}

async function drainKnowledgeSync() {
  stopKnowledgeSync();
  await knowledgeSyncTail;
}

async function flushAll() {
  const failures = [];
  for (const [projectId, record] of projects) {
    try {
      await record.api.flushPendingChanges();
    } catch (error) {
      failures.push({ projectId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failures.length) {
    throw new Error("No se pudo vaciar completamente la cola de todos los proyectos: " +
      failures.map(item => item.projectId + ": " + item.message).join("; "));
  }
}

async function dispatch(method, rawParams) {
  const params = rawParams === undefined ? {} : requireObject(rawParams, "params");

  switch (method) {
    case "bridge.hello":
      return {
        bridgeProtocolVersion: PROTOCOL_VERSION,
        motorApiVersion: globalThis.__motorLiterarioModule.MOTOR_LITERARIO_API_VERSION,
        runtime: "node",
        transport: "json-rpc-2.0-stdio-jsonl",
        storage: "sqlite-local",
        sqliteDatabase: store.databasePath,
        processIsolation: true,
        notifications: ["engine.analysis", "engine.commit", "engine.knowledgeError", "engine.knowledgeChanged", "engine.personalIdeaLibraryChanged"],
        maxMessageBytes: MAX_LINE_BYTES
      };

    case "bridge.health":
      return {
        storage: store.health(),
        openProjects: [...projects.keys()],
        inFlightRequests: activeIds.size
      };

    case "project.open":
      return openProject(params);

    case "project.close": {
      const projectId = requireString(params.projectId, "projectId");
      const record = projects.get(projectId);
      if (!record) return { projectId, alreadyClosed: true };
      await record.api.flushPendingChanges();
      record.api.dispose();
      projects.delete(projectId);
      lastNarrativeVersions.delete(projectId);
      pendingNarrativeSyncs.delete(projectId);
      const writerId = record.identity.writerId;
      if (writerId && ![...projects.values()].some(item => item.identity.writerId === writerId)) {
        lastWriterLibraryVersions.delete(writerId);
        pendingWriterLibrarySyncs.delete(writerId);
      }
      return { projectId, closed: true };
    }

    case "document.open": {
      const api = getProject(params.projectId);
      await api.openDocument(requireObject(params.snapshot, "snapshot"));
      return api.getSnapshot(params.snapshot.documentId) ?? null;
    }

    case "document.recover": {
      const api = getProject(params.projectId);
      const documentId = requireString(params.documentId, "documentId");
      await api.recoverDocument(documentId);
      return api.getSnapshot(documentId) ?? null;
    }

    case "document.change": {
      const api = getProject(params.projectId);
      return api.onEditorChange(requireObject(params.change, "change"));
    }

    case "document.commit":
      return getProject(params.projectId).pollCommit(requireString(params.ticketId, "ticketId")) ?? null;

    case "document.snapshot":
      return getProject(params.projectId).getSnapshot(requireString(params.documentId, "documentId")) ?? null;

    case "document.syncState":
      return getProject(params.projectId).getDocumentSyncState(requireString(params.documentId, "documentId"));

    case "document.diagnostics":
      return getProject(params.projectId).getDocumentDiagnostics(requireString(params.documentId, "documentId"));

    case "engine.flush":
      await getProject(params.projectId).flushPendingChanges();
      return { flushed: true };

    case "engine.metrics":
      return getProject(params.projectId).getLiveAnalysisMetrics();

    case "engine.capabilities":
      return getProject(params.projectId).getCapabilities();

    case "project.call": {
      const api = getProject(params.projectId);
      const methodName = requireString(params.method, "method");
      if (!PUBLIC_API_METHODS.has(methodName)) {
        const error = new Error("Método de HostEngineApi no permitido por el puente: " + methodName);
        error.code = -32601;
        throw error;
      }
      if (typeof api[methodName] !== "function") {
        const error = new Error("El método no está disponible en esta versión de HostEngineApi: " + methodName);
        error.code = -32601;
        throw error;
      }
      if (params.args !== undefined && !Array.isArray(params.args)) throw new TypeError("args debe ser un arreglo.");
      const args = params.args ?? [];
      if (args.length > 32) throw new TypeError("Una llamada del proyecto no puede contener más de 32 argumentos.");
      return await Reflect.apply(api[methodName], api, args);
    }

    case "bridge.shutdown":
      await drainKnowledgeSync();
      await flushAll();
      shuttingDown = true;
      for (const record of projects.values()) record.api.dispose();
      projects.clear();
      lastNarrativeVersions.clear();
      pendingNarrativeSyncs.clear();
      lastWriterLibraryVersions.clear();
      pendingWriterLibrarySyncs.clear();
      return { shutdown: true, storage: store.health() };

    default: {
      const error = new Error("Método JSON-RPC desconocido: " + method);
      error.code = -32601;
      throw error;
    }
  }
}

async function processRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
      !request.method.trim() ||
      (request.id !== undefined && !["string", "number"].includes(typeof request.id))) {
    return send({
      jsonrpc: "2.0",
      id: request && (typeof request.id === "string" || typeof request.id === "number") ? request.id : null,
      error: { code: -32600, message: "Solicitud JSON-RPC 2.0 inválida." }
    });
  }

  if (request.id === undefined) {
    // Este puente usa solicitudes con respuesta para que el anfitrión pueda
    // correlacionar confirmaciones. No admite notificaciones sin ID.
    return;
  }

  if (shuttingDown) {
    return send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "El puente está cerrando y ya no admite nuevas solicitudes." }
    });
  }
  const idKey = String(request.id);
  if (activeIds.has(idKey)) {
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "ID de solicitud duplicado en curso." } });
  }
  const shutdownRequest = request.method === "bridge.shutdown";
  activeIds.add(idKey);
  let shutdownDispatched = false;

  try {
    if (shutdownRequest) {
      // Cierra la admisión antes de esperar: las solicitudes ya aceptadas
      // terminan sus escrituras y transferencias antes del flush final.
      shuttingDown = true;
      await Promise.allSettled([...activeDispatches]);
    }
    const operation = dispatch(request.method, request.params);
    if (!shutdownRequest) activeDispatches.add(operation);
    let result;
    try {
      result = await operation;
      if (shutdownRequest) shutdownDispatched = true;
    } finally {
      if (!shutdownRequest) activeDispatches.delete(operation);
    }
    await send({ jsonrpc: "2.0", id: request.id, result: result === undefined ? null : result });
  } catch (error) {
    if (shutdownRequest && !shutdownDispatched) {
      // Un fallo de vaciado no debe cerrar una base que aún puede tener trabajo
      // pendiente. Reabre la admisión y el sondeo para que el anfitrión reintente.
      shuttingDown = false;
      try { startKnowledgeSync(true); } catch (restartError) { writeError(restartError); }
    }
    const payload = errorPayload(error);
    if (Number.isInteger(error?.code)) payload.code = error.code;
    await send({ jsonrpc: "2.0", id: request.id, error: payload });
  } finally {
    activeIds.delete(idKey);
    if (shutdownRequest && shutdownDispatched) {
      store.close();
      process.stdin.pause();
      process.exitCode = 0;
    }
  }
}

async function closeGracefully() {
  if (!store || store.closed) return;
  // La entrada STDIN también puede terminar por EOF o por una línea excesiva.
  // En ambos casos no se cierra SQLite mientras quede una petición aceptada.
  shuttingDown = true;
  await Promise.allSettled([...inFlight]);
  await Promise.allSettled([...activeDispatches]);
  if (!store || store.closed) return;
  try { await drainKnowledgeSync(); } catch (error) { writeError(error); }
  try { await flushAll(); } catch (error) { writeError(error); }
  for (const record of projects.values()) record.api.dispose();
  projects.clear();
  lastNarrativeVersions.clear();
  pendingNarrativeSyncs.clear();
  pendingWriterLibrarySyncs.clear();
  lastWriterLibraryVersions.clear();
  try { store.close(); } catch (error) { writeError(error); }
}

async function main() {
  const nodeParts = process.versions.node.split(".").map(Number);
  if (nodeParts[0] < 22 || (nodeParts[0] === 22 && nodeParts[1] < 13)) {
    throw new Error("El puente requiere Node.js 22.13.0 o posterior para node:sqlite.");
  }

  let databasePath = process.env.MOTOR_LITERARIO_DB;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--db") databasePath = args[index + 1];
  }
  if (!databasePath) {
    throw new Error("Indique la ruta local con --db <archivo.sqlite> o MOTOR_LITERARIO_DB.");
  }

  const moduleUrl = new URL("../dist/motor-literario.js", import.meta.url);
  const motorModule = await import(moduleUrl.href);
  globalThis.__motorLiterarioModule = motorModule;
  store = await SqliteProjectStore.open(resolve(databasePath));
  startKnowledgeSync();

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    inputBuffer += chunk;
    if (Buffer.byteLength(inputBuffer, "utf8") > MAX_LINE_BYTES * 2) {
      writeError(new Error("El búfer de entrada supera el límite de seguridad."));
      process.exitCode = 1;
      process.stdin.pause();
      void closeGracefully();
      return;
    }
    let newline;
    while ((newline = inputBuffer.indexOf("\n")) >= 0) {
      const line = inputBuffer.slice(0, newline).replace(/\r$/u, "");
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        void send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Solicitud superior a 16 MiB." } });
        continue;
      }
      let request;
      try { request = JSON.parse(line); } catch {
        void send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido." } });
        continue;
      }
      const task = processRequest(request).catch(writeError);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
  });

  process.stdin.on("end", () => {
    void (async () => {
      await Promise.allSettled([...inFlight]);
      await closeGracefully();
    })();
  });
}

main().catch(error => {
  process.stderr.write("[motor-literario-bridge] " + String(error?.stack ?? error) + "\n");
  process.exitCode = 1;
  process.stdin.pause();
});
