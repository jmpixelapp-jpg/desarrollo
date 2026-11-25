import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const projectId = "idea-batch-sync";
const projectName = "Libro de sincronización por lote";

const idea = (id, extra = {}) => ({
  projectId,
  id,
  text: `Idea narrativa ${id}.`,
  status: "IDEA",
  originDocumentId: "chapter-1",
  sourceProjectName: projectName,
  evidence: [],
  relatedEntityIds: [],
  relatedIdeaIds: [],
  statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
  ...extra
});

const entity = (id, name) => ({
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

class AtomicIdeaStore {
  ideas = new Map();
  entities = new Map();
  writes = 0;
  onNextConflict;

  constructor(ideas = [], entities = []) {
    for (const item of ideas) this.ideas.set(this.key(item), structuredClone(item));
    for (const item of entities) this.entities.set(this.key(item), structuredClone(item));
  }

  key(item) {
    return item.projectId + ":" + item.id;
  }

  async loadIdeas(id) {
    return [...this.ideas.values()]
      .filter(item => item.projectId === id)
      .map(item => structuredClone(item));
  }

  async loadEntities(id) {
    return [...this.entities.values()]
      .filter(item => item.projectId === id)
      .map(item => structuredClone(item));
  }

  async saveIdea(item) {
    this.ideas.set(this.key(item), structuredClone(item));
  }

  async saveIdeaIfUnchanged(next, expected) {
    this.writes++;
    const key = this.key(next);
    const current = this.ideas.get(key);
    if (this.onNextConflict) {
      const mutate = this.onNextConflict;
      this.onNextConflict = undefined;
      this.ideas.set(key, structuredClone(mutate(structuredClone(current))));
      throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
    }
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
    }
    for (const id of next.relatedIdeaIds ?? []) {
      if (id === next.id || !this.ideas.has(next.projectId + ":" + id)) {
        throw new Error("La idea enlaza una idea inexistente o se enlaza a sí misma.");
      }
    }
    for (const id of next.relatedEntityIds ?? []) {
      if (!this.entities.has(next.projectId + ":" + id)) {
        throw new Error("La idea enlaza una ficha inexistente.");
      }
    }
    this.ideas.set(key, structuredClone(next));
  }
}

function createApi(store) {
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName, writerId: "writer-batch-sync" });
  return api;
}

function links(relatedIdeaIds = [], relatedEntityIds = []) {
  return { relatedIdeaIds, relatedEntityIds };
}

test("sincroniza ambos conjuntos de vínculos en una sola escritura CAS", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source", { relatedIdeaIds: ["idea-old"], relatedEntityIds: ["character-old"] }),
      idea("idea-old"),
      idea("idea-next"),
      idea("idea-third")
    ],
    [entity("character-old", "Ana"), entity("character-next", "Beatriz")]
  );
  const api = createApi(store);

  try {
    const updated = await api.synchronizeNarrativeIdeaLinks(
      "source",
      links(["idea-old"], ["character-old"]),
      links(["idea-third", "idea-next"], ["character-next"])
    );

    assert.deepEqual(updated.relatedIdeaIds, ["idea-third", "idea-next"]);
    assert.deepEqual(updated.relatedEntityIds, ["character-next"]);
    assert.deepEqual(store.ideas.get(projectId + ":source").relatedIdeaIds, ["idea-third", "idea-next"]);
    assert.deepEqual(store.ideas.get(projectId + ":source").relatedEntityIds, ["character-next"]);
    assert.equal(store.writes, 1);
  } finally {
    api.dispose();
  }
});

test("compara los vínculos como conjuntos y conserva el orden solicitado al guardar", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source", { relatedIdeaIds: ["idea-a", "idea-b"] }),
      idea("idea-a"),
      idea("idea-b"),
      idea("idea-c")
    ],
    []
  );
  const api = createApi(store);

  try {
    const updated = await api.synchronizeNarrativeIdeaLinks(
      "source",
      links(["idea-b", "idea-a"], []),
      links(["idea-c", "idea-a"], [])
    );
    assert.deepEqual(updated.relatedIdeaIds, ["idea-c", "idea-a"]);
    assert.equal(store.writes, 1);
  } finally {
    api.dispose();
  }
});

test("rechaza una instantánea antigua sin perder vínculos añadidos por otra instancia", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source", { relatedIdeaIds: ["idea-a"] }),
      idea("idea-a"),
      idea("idea-b"),
      idea("idea-concurrent")
    ],
    []
  );
  const api = createApi(store);

  try {
    store.ideas.set(projectId + ":source", idea("source", {
      relatedIdeaIds: ["idea-a", "idea-concurrent"]
    }));

    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links(["idea-a"], []),
        links(["idea-b"], [])
      ),
      /cambió en otra instancia/
    );

    const refreshed = (await api.getNarrativeIdeas()).find(item => item.id === "source");
    assert.deepEqual(refreshed.relatedIdeaIds, ["idea-a", "idea-concurrent"]);
    assert.equal(store.writes, 0);
  } finally {
    api.dispose();
  }
});

test("una carrera durante CAS conserva la mutación concurrente y no aplica el lote obsoleto", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source", { relatedIdeaIds: ["idea-a"] }),
      idea("idea-a"),
      idea("idea-b"),
      idea("idea-concurrent")
    ],
    []
  );
  const api = createApi(store);

  try {
    store.onNextConflict = current => ({
      ...current,
      relatedIdeaIds: [...current.relatedIdeaIds, "idea-concurrent"]
    });

    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links(["idea-a"], []),
        links(["idea-b"], [])
      ),
      /cambió en otra instancia/
    );

    assert.deepEqual(
      store.ideas.get(projectId + ":source").relatedIdeaIds,
      ["idea-a", "idea-concurrent"]
    );
    assert.equal(store.writes, 1);
  } finally {
    api.dispose();
  }
});

test("rechaza destinos inexistentes y listas duplicadas antes de escribir", async () => {
  const store = new AtomicIdeaStore([idea("source"), idea("idea-a")], []);
  const api = createApi(store);

  try {
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["missing-idea"], [])
      ),
      /idea de destino inexistente/
    );
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["idea-a", "idea-a"], [])
      ),
      /duplicado/
    );
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["source"], [])
      ),
      /autorreferente/
    );
    assert.equal(store.writes, 0);
  } finally {
    api.dispose();
  }
});

test("rechaza fichas inexistentes y listas que superan el límite por categoría", async () => {
  const store = new AtomicIdeaStore(
    [idea("source"), idea("idea-a")],
    [entity("character-a", "Ana")]
  );
  const api = createApi(store);

  try {
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links([], ["missing-character"])
      ),
      /ficha de destino inexistente/
    );
    const tooManyIdeas = Array.from({ length: 501 }, (_, index) => "idea-" + index);
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(tooManyIdeas, [])
      ),
      /excede el límite/
    );
    assert.equal(store.writes, 0);
  } finally {
    api.dispose();
  }
});

test("una sincronización sin cambios es idempotente y no necesita CAS", async () => {
  const store = {
    ideas: [idea("source", { relatedIdeaIds: ["idea-a"] }), idea("idea-a")],
    async loadIdeas(id) {
      return this.ideas.filter(item => item.projectId === id).map(item => structuredClone(item));
    },
    async loadEntities(id) {
      return id === projectId ? [] : [];
    },
    async saveIdea(item) {
      this.ideas = this.ideas.map(current => current.id === item.id ? structuredClone(item) : current);
    }
  };
  const api = createApi(store);

  try {
    const unchanged = await api.synchronizeNarrativeIdeaLinks(
      "source",
      links(["idea-a"], []),
      links(["idea-a"], [])
    );
    assert.deepEqual(unchanged.relatedIdeaIds, ["idea-a"]);
    assert.deepEqual(store.ideas.find(item => item.id === "source").relatedIdeaIds, ["idea-a"]);
  } finally {
    api.dispose();
  }
});

test("exige CAS cuando la sincronización cambiaría el registro", async () => {
  const store = {
    ideas: [idea("source"), idea("idea-a")],
    async loadIdeas(id) {
      return this.ideas.filter(item => item.projectId === id).map(item => structuredClone(item));
    },
    async loadEntities(id) {
      return id === projectId ? [] : [];
    },
    async saveIdea(item) {
      this.ideas = this.ideas.map(current => current.id === item.id ? structuredClone(item) : current);
    }
  };
  const api = createApi(store);

  try {
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["idea-a"], [])
      ),
      /requiere escritura CAS/
    );
    assert.deepEqual(store.ideas.find(item => item.id === "source").relatedIdeaIds, []);
  } finally {
    api.dispose();
  }
});


test("aborta el lote si un destino desaparece entre la validación y la escritura CAS", async () => {
  for (const targetKind of ["idea", "entity"]) {
    const store = new AtomicIdeaStore(
      [
        idea("source", { relatedIdeaIds: [], relatedEntityIds: [] }),
        idea("idea-target")
      ],
      [entity("entity-target", "Ana")]
    );
    const api = createApi(store);

    try {
      store.onNextConflict = current => {
        if (targetKind === "idea") {
          store.ideas.delete(projectId + ":idea-target");
        } else {
          store.entities.delete(projectId + ":entity-target");
        }
        return {
          ...current,
          status: "incorporated",
          statusHistory: [
            ...current.statusHistory,
            { status: "incorporated", reason: "writer", changedAt: 2 }
          ]
        };
      };

      await assert.rejects(
        api.synchronizeNarrativeIdeaLinks(
          "source",
          links([], []),
          targetKind === "idea"
            ? links(["idea-target"], [])
            : links([], ["entity-target"])
        ),
        /cambió en otra instancia/
      );

      const persisted = store.ideas.get(projectId + ":source");
      assert.deepEqual(persisted.relatedIdeaIds, []);
      assert.deepEqual(persisted.relatedEntityIds, []);
      assert.equal(persisted.status, "incorporated");
      assert.deepEqual(persisted.statusHistory.map(change => change.status), [
        "IDEA", "incorporated"
      ]);
      assert.equal(store.writes, 1);
    } finally {
      api.dispose();
    }
  }
});


test("no acepta destinos con el mismo ID pertenecientes a otro proyecto", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source"),
      idea("shared-idea-id", { projectId: "other-project" })
    ],
    [{ ...entity("shared-entity-id", "Ana"), projectId: "other-project" }]
  );
  const api = createApi(store);

  try {
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["shared-idea-id"], [])
      ),
      /idea de destino inexistente o ajena al proyecto/
    );
    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links([], ["shared-entity-id"])
      ),
      /ficha de destino inexistente o ajena al proyecto/
    );
    assert.equal(store.writes, 0);
    assert.deepEqual(store.ideas.get(projectId + ":source").relatedIdeaIds, []);
    assert.deepEqual(store.ideas.get(projectId + ":source").relatedEntityIds, []);
  } finally {
    api.dispose();
  }
});


test("permite reintentar explícitamente con la instantánea refrescada tras un conflicto CAS", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source", { relatedIdeaIds: ["idea-a"] }),
      idea("idea-a"),
      idea("idea-b"),
      idea("idea-concurrent")
    ],
    []
  );
  const api = createApi(store);

  try {
    store.onNextConflict = current => ({
      ...current,
      status: "incorporated",
      statusHistory: [
        ...current.statusHistory,
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      relatedIdeaIds: [...current.relatedIdeaIds, "idea-concurrent"]
    });

    await assert.rejects(
      api.synchronizeNarrativeIdeaLinks(
        "source",
        links(["idea-a"], []),
        links(["idea-b"], [])
      ),
      /cambió en otra instancia/
    );

    const refreshed = (await api.getNarrativeIdeas()).find(item => item.id === "source");
    assert.deepEqual(refreshed.relatedIdeaIds, ["idea-a", "idea-concurrent"]);
    assert.equal(refreshed.status, "incorporated");

    const retried = await api.synchronizeNarrativeIdeaLinks(
      "source",
      links(refreshed.relatedIdeaIds, refreshed.relatedEntityIds),
      links(["idea-b", "idea-concurrent"], [])
    );

    assert.deepEqual(retried.relatedIdeaIds, ["idea-b", "idea-concurrent"]);
    assert.equal(retried.status, "incorporated");
    assert.deepEqual(retried.statusHistory.map(change => change.status), [
      "IDEA", "incorporated"
    ]);
    assert.equal(store.writes, 2);
  } finally {
    api.dispose();
  }
});


test("permite sincronizaciones simultáneas de ideas distintas sin mezclar sus vínculos", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source-a"),
      idea("source-b"),
      idea("target-a"),
      idea("target-b")
    ],
    []
  );
  const apiA = createApi(store);
  const apiB = createApi(store);

  try {
    const [updatedA, updatedB] = await Promise.all([
      apiA.synchronizeNarrativeIdeaLinks(
        "source-a",
        links([], []),
        links(["target-a"], [])
      ),
      apiB.synchronizeNarrativeIdeaLinks(
        "source-b",
        links([], []),
        links(["target-b"], [])
      )
    ]);

    assert.deepEqual(updatedA.relatedIdeaIds, ["target-a"]);
    assert.deepEqual(updatedB.relatedIdeaIds, ["target-b"]);
    assert.deepEqual(store.ideas.get(projectId + ":source-a").relatedIdeaIds, ["target-a"]);
    assert.deepEqual(store.ideas.get(projectId + ":source-b").relatedIdeaIds, ["target-b"]);
    assert.equal(store.writes, 2);
  } finally {
    apiA.dispose();
    apiB.dispose();
  }
});


test("dos lotes concurrentes sobre la misma idea no se sobrescriben entre sí", async () => {
  const store = new AtomicIdeaStore(
    [
      idea("source"),
      idea("target-a"),
      idea("target-b")
    ],
    []
  );
  const apiA = createApi(store);
  const apiB = createApi(store);

  try {
    const results = await Promise.allSettled([
      apiA.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["target-a"], [])
      ),
      apiB.synchronizeNarrativeIdeaLinks(
        "source",
        links([], []),
        links(["target-b"], [])
      )
    ]);

    const fulfilled = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter(result => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /cambió en otra instancia/);

    const persisted = store.ideas.get(projectId + ":source");
    assert.ok(
      JSON.stringify(persisted.relatedIdeaIds) === JSON.stringify(["target-a"]) ||
      JSON.stringify(persisted.relatedIdeaIds) === JSON.stringify(["target-b"])
    );
    assert.equal(store.writes, 2);
  } finally {
    apiA.dispose();
    apiB.dispose();
  }
});
