import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

class MemoryStyleTimelineStore {
  styles = new Map();
  tracks = new Map();
  key(projectId, id) { return projectId + ":" + id; }

  async loadStyleProfiles(projectId) {
    return [...this.styles.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveStyleProfile(item, expected) {
    const key = this.key(item.projectId, item.id);
    const old = this.styles.get(key);
    if (expected && (!old || JSON.stringify(old) !== JSON.stringify(expected))) {
      throw new Error("El perfil de estilo cambió en otra instancia.");
    }
    if (!expected && old) throw new Error("El perfil de estilo ya existe.");
    this.styles.set(key, structuredClone(item));
  }
  async loadTimelineTracks(projectId) {
    return [...this.tracks.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveTimelineTrack(item, expected) {
    const key = this.key(item.projectId, item.id);
    const old = this.tracks.get(key);
    if (expected && (!old || JSON.stringify(old) !== JSON.stringify(expected))) {
      throw new Error("La pista cronológica cambió en otra instancia.");
    }
    if (!expected && old) throw new Error("La pista cronológica ya existe.");
    this.tracks.set(key, structuredClone(item));
  }
}

function installStyleTimelineIndexedDbMock() {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const styles = new Map();
  const tracks = new Map();
  const keyOf = (projectId, id) => JSON.stringify([projectId, id]);
  const collections = {
    "style-profiles": styles,
    "timeline-tracks": tracks
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      assert.ok(mode === "readonly" || mode === "readwrite");
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      let settled = false;
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        complete() {
          if (settled) return;
          settled = true;
          queueMicrotask(() => tx.oncomplete?.());
        },
        abort() {
          if (settled) return;
          settled = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name) {
          assert.ok(names.includes(name));
          const collection = collections[name];
          if (!collection) throw new Error("Object store inesperado: " + name);
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => {
                if (settled) return;
                const value = collection.get(keyOf(key[0], key[1]));
                request.result = value ? structuredClone(value) : undefined;
                request.onsuccess?.();
                tx.complete();
              });
              return request;
            },
            put(value) {
              collection.set(keyOf(value.projectId, value.id), structuredClone(value));
              tx.complete();
            },
            index(indexName) {
              assert.ok(["by-project", "by-project-name"].includes(indexName));
              return {
                getAll(projectId) {
                  const request = {};
                  queueMicrotask(() => {
                    if (settled) return;
                    request.result = [...collection.values()]
                      .filter(item => item.projectId === projectId)
                      .map(item => structuredClone(item));
                    request.onsuccess?.();
                    tx.complete();
                  });
                  return request;
                }
              };
            }
          };
        }
      };
      return tx;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });
  return {
    styles,
    tracks,
    restore() {
      if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
      else delete globalThis.indexedDB;
    }
  };
}

const styleInput = {
  id: "style-narrator",
  profileName: "Narrador sobrio",
  styleData: {
    pointOfView: "third-person-limited",
    tense: "past",
    dialogue: { punctuation: "long-dash", tags: "minimal" },
    rhythm: { sentenceLength: "varied", paragraphs: "medium" }
  },
  provenanceKind: "WRITER",
  updatedAt: 100
};

const trackInput = {
  id: "calendar-main",
  trackName: "Calendario principal",
  trackKind: "CALENDAR",
  rules: {
    calendar: "fictional-aurorian",
    epoch: "year-zero",
    ordering: "explicit-reference-only",
    units: ["year", "month", "day"]
  },
  provenanceKind: "WRITER"
};

test("HostEngineApi guarda perfiles de estilo y pistas temporales por libro", async () => {
  const store = new MemoryStyleTimelineStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "style-book-a", projectName: "Libro A", writerId: "writer-a" });
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "style-book-b", projectName: "Libro B", writerId: "writer-a" });

  const style = await first.saveStyleProfile(styleInput);
  const track = await first.saveTimelineTrack(trackInput);
  await second.saveStyleProfile({
    ...styleInput,
    id: "style-b",
    profileName: "Voz experimental"
  });

  assert.equal(style.projectId, "style-book-a");
  assert.equal(track.projectId, "style-book-a");
  assert.equal((await first.getStyleProfiles()).length, 1);
  assert.equal((await first.getTimelineTracks())[0].trackName, "Calendario principal");
  assert.equal((await second.getStyleProfiles())[0].profileName, "Voz experimental");
  assert.deepEqual(await second.getTimelineTracks(), []);
});

test("HostEngineApi rechaza perfiles de estilo y pistas con reglas no JSON", async () => {
  const api = new HostEngineApi({ store: new MemoryStyleTimelineStore() });
  api.initializeProject({ projectId: "style-invalid", projectName: "Libro", writerId: "writer" });
  await assert.rejects(
    api.saveStyleProfile({ ...styleInput, styleData: () => "invalid" }),
    /datos del perfil de estilo/
  );
  await assert.rejects(
    api.saveTimelineTrack({ ...trackInput, rules: null }),
    /reglas de una pista cronológica/
  );
  assert.deepEqual(await api.getStyleProfiles(), []);
  assert.deepEqual(await api.getTimelineTracks(), []);
});

test("IndexedDB persiste perfiles y pistas y rechaza actualizaciones obsoletas", async () => {
  const mock = installStyleTimelineIndexedDbMock();
  try {
    const store = new IndexedDbProjectStore();
    const style = { projectId: "indexed-style-book", ...styleInput };
    const track = { projectId: "indexed-style-book", ...trackInput };
    await store.saveStyleProfile(style);
    await store.saveTimelineTrack(track);
    assert.deepEqual(await store.loadStyleProfiles(style.projectId), [style]);
    assert.deepEqual(await store.loadTimelineTracks(style.projectId), [track]);

    const nextStyle = { ...style, styleData: { ...style.styleData, tense: "present" }, updatedAt: 200 };
    await store.saveStyleProfile(nextStyle, style);
    await assert.rejects(
      store.saveStyleProfile({ ...nextStyle, updatedAt: 300 }, style),
      /cambió en otra instancia/
    );
    const nextTrack = { ...track, rules: { ...track.rules, ordering: "calendar-date-only" } };
    await store.saveTimelineTrack(nextTrack, track);
    await assert.rejects(
      store.saveTimelineTrack({ ...nextTrack, trackName: "Cambio obsoleto" }, track),
      /cambió en otra instancia/
    );
    assert.equal(mock.styles.size, 1);
    assert.equal(mock.tracks.size, 1);
  } finally {
    mock.restore();
  }
});
