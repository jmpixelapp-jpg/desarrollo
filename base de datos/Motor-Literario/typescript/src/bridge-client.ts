import type {
  PersonalIdeaLibraryCursor, PersonalIdeaLibraryPage,
  ProjectFinalizationSummary, StoredProjectFinalizationReceipt
} from "./contracts";
import type { NarrativeEntity, NarrativeIdea, PersonalIdeaLibraryEntry } from "./narrative-knowledge";
import type { RecordLifecycle, RelationLifecycle } from "./project-data";

export interface BridgeReadable {
  on(event: "data" | "error", listener: (value: unknown) => void): unknown;
  setEncoding?(encoding: "utf8"): unknown;
}

export interface BridgeWritable {
  write(value: string): boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "drain", listener: () => void): unknown;
  end?(): void;
}

export interface BridgeChildProcess {
  readonly stdin: BridgeWritable;
  readonly stdout: BridgeReadable;
  readonly stderr?: BridgeReadable;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class MotorLiterarioBridgeError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = "MotorLiterarioBridgeError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

export interface MotorLiterarioBridgeClientOptions {
  readonly requestTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly onStderr?: (text: string) => void;
  readonly onProtocolError?: (error: Error, line: string) => void;
}

type NotificationHandler = (params: unknown) => void;

/**
 * Cliente JSON-RPC 2.0 por stdio para hablar con el proceso compañero.
 * Acepta un ChildProcess de Node/Electron sin importar tipos de Node en el núcleo.
 */
export class MotorLiterarioBridgeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<NotificationHandler>>();
  private readonly outboundQueue: string[] = [];
  private outboundBytes = 0;
  private writeBlocked = false;
  private buffer = "";
  private nextId = 0;
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(
    private readonly child: BridgeChildProcess,
    private readonly options: MotorLiterarioBridgeClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs debe ser un entero positivo.");
    }
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1024) {
      throw new Error("maxMessageBytes debe ser un entero de al menos 1024 bytes.");
    }

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", chunk => this.receiveChunk(String(chunk)));
    child.stdout.on("error", error => this.failAll(this.asError(error)));
    child.stdin.on("error", error => this.failAll(this.asError(error)));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", chunk => options.onStderr?.(String(chunk)));
    child.on("error", error => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error("El proceso Motor Literario terminó (código " +
        String(code) + ", señal " + String(signal) + ")."));
    });
  }

  private asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
  }

  private byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private receiveChunk(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.byteLength(this.buffer) > this.maxMessageBytes * 2) {
      this.failAll(new Error("El proceso puente envió un búfer sin delimitador superior al límite."));
      return;
    }

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.receiveLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private receiveLine(line: string): void {
    if (this.byteLength(line) > this.maxMessageBytes) {
      this.options.onProtocolError?.(new Error("La respuesta supera el límite del puente."), line);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.options.onProtocolError?.(this.asError(error), line);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.options.onProtocolError?.(new Error("Mensaje JSON-RPC no es un objeto."), line);
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.jsonrpc !== "2.0") {
      this.options.onProtocolError?.(new Error("Versión JSON-RPC inesperada."), line);
      return;
    }

    if (typeof record.method === "string") {
      const handlers = this.listeners.get(record.method);
      for (const handler of handlers ?? []) {
        try { handler(record.params); } catch (error) {
          this.options.onProtocolError?.(this.asError(error), line);
        }
      }
      return;
    }

    if (typeof record.id !== "string" || !this.pending.has(record.id)) {
      this.options.onProtocolError?.(new Error("Respuesta sin ID de solicitud pendiente."), line);
      return;
    }
    const pending = this.pending.get(record.id)!;
    this.pending.delete(record.id);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);

    if (record.error && typeof record.error === "object") {
      pending.reject(new MotorLiterarioBridgeError(record.error as JsonRpcError));
    } else if (Object.prototype.hasOwnProperty.call(record, "result")) {
      pending.resolve(record.result);
    } else {
      pending.reject(new Error("Respuesta JSON-RPC sin result ni error."));
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("El cliente del puente está cerrado."));
    if (typeof method !== "string" || !method.trim()) {
      return Promise.reject(new TypeError("El método JSON-RPC es obligatorio."));
    }
    const id = "ml-bridge-" + (++this.nextId);
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (this.byteLength(message) > this.maxMessageBytes) {
      return Promise.reject(new Error("La solicitud supera el límite de 16 MiB del puente."));
    }

    if (this.pending.size >= 4096) {
      return Promise.reject(new Error("El límite del cliente es de 4096 solicitudes pendientes."));
    }
    return new Promise<T>((resolve, reject) => {
      const duration = timeoutMs ?? this.requestTimeoutMs;
      if (!Number.isSafeInteger(duration) || duration < 1) {
        reject(new TypeError("El timeout debe ser un entero positivo."));
        return;
      }
      const messageBytes = this.byteLength(message);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const queuedIndex = this.outboundQueue.indexOf(message);
        if (queuedIndex >= 0) {
          this.outboundQueue.splice(queuedIndex, 1);
          this.outboundBytes -= messageBytes;
        }
        reject(new Error("Tiempo de espera agotado para la solicitud " + method + "."));
      }, duration);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout
      });

      if (this.outboundBytes + messageBytes > this.maxMessageBytes * 4) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error("La cola de salida del puente superó 64 MiB; aplique contrapresión en el anfitrión."));
        return;
      }
      this.outboundQueue.push(message);
      this.outboundBytes += messageBytes;
      this.drainWrites();
    });
  }

  private drainWrites(): void {
    if (this.closed || this.writeBlocked) return;
    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift()!;
      this.outboundBytes -= this.byteLength(message);
      try {
        const canContinue = this.child.stdin.write(message);
        if (!canContinue) {
          this.writeBlocked = true;
          this.child.stdin.once("drain", () => {
            this.writeBlocked = false;
            this.drainWrites();
          });
          return;
        }
      } catch (error) {
        this.failAll(this.asError(error));
        this.outboundQueue.length = 0;
        this.outboundBytes = 0;
        return;
      }
    }
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    if (typeof method !== "string" || !method.trim() || typeof handler !== "function") {
      throw new TypeError("Se requiere un método de notificación y un callback.");
    }
    const handlers = this.listeners.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(method);
    };
  }

  async hello(): Promise<{
    bridgeProtocolVersion: string;
    motorApiVersion: string;
    transport: string;
    storage: string;
  }> {
    return this.request("bridge.hello");
  }

  openProject(identity: {
    projectId: string;
    projectName: string;
    writerId?: string;
  }): Promise<unknown> {
    return this.request("project.open", identity);
  }

  openDocument(projectId: string, snapshot: {
    documentId: string;
    text: string;
    revision: number;
    sequence: number;
  }): Promise<unknown> {
    return this.request("document.open", { projectId, snapshot });
  }

  recoverDocument(projectId: string, documentId: string): Promise<unknown> {
    return this.request("document.recover", { projectId, documentId });
  }

  submitChange(projectId: string, change: {
    documentId: string;
    sequence: number;
    baseRevision: number;
    start: number;
    end: number;
    replacement: string;
  }): Promise<unknown> {
    return this.request("document.change", { projectId, change });
  }

  /** Lee las fichas narrativas del proyecto activo para resolver vínculos desde la interfaz. */
  getNarrativeEntities(projectId: string): Promise<readonly NarrativeEntity[]> {
    return this.request<readonly NarrativeEntity[]>("project.call", {
      projectId,
      method: "getNarrativeEntities",
      args: []
    });
  }

  /** Lee el catálogo de ideas del proyecto activo, sin mezclar bibliotecas de otros libros. */
  getNarrativeIdeas(projectId: string): Promise<readonly NarrativeIdea[]> {
    return this.request<readonly NarrativeIdea[]>("project.call", {
      projectId,
      method: "getNarrativeIdeas",
      args: []
    });
  }

  /** Cambia una arista dirigida entre dos ideas del mismo proyecto. */
  setNarrativeIdeaLink(
    projectId: string,
    ideaId: string,
    relatedIdeaId: string,
    linked: boolean
  ): Promise<NarrativeIdea> {
    return this.request<NarrativeIdea>("project.call", {
      projectId,
      method: "setNarrativeIdeaLink",
      args: [ideaId, relatedIdeaId, linked]
    });
  }

  /** Vincula o desvincula una idea de una ficha narrativa del mismo libro. */
  setNarrativeIdeaEntityLink(
    projectId: string,
    ideaId: string,
    entityId: string,
    linked: boolean
  ): Promise<NarrativeIdea> {
    return this.request<NarrativeIdea>("project.call", {
      projectId,
      method: "setNarrativeIdeaEntityLink",
      args: [ideaId, entityId, linked]
    });
  }

  /** Registra una decisión editorial explícita del escritor. */
  setNarrativeIdeaStatus(
    projectId: string,
    ideaId: string,
    status: NarrativeIdea["status"]
  ): Promise<NarrativeIdea> {
    return this.request<NarrativeIdea>("project.call", {
      projectId,
      method: "setNarrativeIdeaStatus",
      args: [ideaId, status]
    });
  }

  /** Lectura completa de compatibilidad; para bibliotecas grandes se recomienda la API paginada. */
  getPersonalIdeaLibrary(projectId: string): Promise<readonly PersonalIdeaLibraryEntry[]> {
    return this.request<readonly PersonalIdeaLibraryEntry[]>("project.call", {
      projectId,
      method: "getPersonalIdeaLibrary",
      args: []
    });
  }

  finalizeProjectToIdeaLibrary(projectId: string): Promise<ProjectFinalizationSummary> {
    return this.request<ProjectFinalizationSummary>("project.call", {
      projectId,
      method: "finalizeProjectToIdeaLibrary",
      args: []
    });
  }

  getProjectFinalizationReceipt(
    projectId: string
  ): Promise<StoredProjectFinalizationReceipt | null> {
    return this.request<StoredProjectFinalizationReceipt | null>("project.call", {
      projectId,
      method: "getProjectFinalizationReceipt",
      args: []
    });
  }

  getPersonalIdeaLibraryPage(
    projectId: string,
    cursor: PersonalIdeaLibraryCursor | null = null,
    limit = 50
  ): Promise<PersonalIdeaLibraryPage> {
    return this.request<PersonalIdeaLibraryPage>("project.call", {
      projectId,
      method: "getPersonalIdeaLibraryPage",
      args: [cursor, limit]
    });
  }

  getRecordLifecycleHistory(projectId: string, recordId: string): Promise<readonly RecordLifecycle[]> {
    return this.request<readonly RecordLifecycle[]>("project.call", {
      projectId,
      method: "getRecordLifecycleHistory",
      args: [recordId]
    });
  }

  appendRecordLifecycle(
    projectId: string,
    input: Omit<RecordLifecycle, "projectId">
  ): Promise<RecordLifecycle> {
    return this.request<RecordLifecycle>("project.call", {
      projectId,
      method: "appendRecordLifecycle",
      args: [input]
    });
  }

  getRelationLifecycleHistory(projectId: string, relationId: string): Promise<readonly RelationLifecycle[]> {
    return this.request<readonly RelationLifecycle[]>("project.call", {
      projectId,
      method: "getRelationLifecycleHistory",
      args: [relationId]
    });
  }

  appendRelationLifecycle(
    projectId: string,
    input: Omit<RelationLifecycle, "projectId">
  ): Promise<RelationLifecycle> {
    return this.request<RelationLifecycle>("project.call", {
      projectId,
      method: "appendRelationLifecycle",
      args: [input]
    });
  }

  getEventLifecycleHistory(projectId: string, eventId: string): Promise<unknown> {
    return this.request("project.call", {
      projectId,
      method: "getEventLifecycleHistory",
      args: [eventId]
    });
  }

  updateNarrativeEvent(projectId: string, input: {
    eventId: string;
    label?: string;
    participants?: readonly string[];
    changedBy: string;
    changeReason?: string | null;
    changedAt?: number;
  }): Promise<unknown> {
    return this.request("project.call", {
      projectId,
      method: "updateNarrativeEvent",
      args: [input]
    });
  }

  async flushProject(projectId: string): Promise<void> {
    await this.request("engine.flush", { projectId });
  }

  async closeProject(projectId: string): Promise<void> {
    await this.request("project.close", { projectId });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.request("bridge.shutdown", {}, Math.max(this.requestTimeoutMs, 120_000));
    this.child.stdin.end?.();
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.outboundQueue.length = 0;
    this.outboundBytes = 0;
    this.writeBlocked = false;
  }
}
