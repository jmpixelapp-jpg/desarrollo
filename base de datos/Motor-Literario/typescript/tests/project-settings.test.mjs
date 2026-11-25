import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

class MemoryProjectSettingsStore {
  settings = new Map();

  async loadProjectSettings(projectId) {
    return [...this.settings.values()]
      .filter(setting => setting.projectId === projectId)
      .map(setting => structuredClone(setting));
  }

  async saveProjectSetting(setting, expectedCurrent) {
    const key = setting.projectId + ":" + setting.key;
    const current = this.settings.get(key);
    if (expectedCurrent) {
      if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
        throw new Error("La configuración cambió en otra instancia.");
      }
    } else if (current) {
      throw new Error("La configuración ya existe.");
    }
    this.settings.set(key, structuredClone(setting));
  }
}

function installIndexedDbSettingsMock() {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const records = new Map();
  const keyOf = (projectId, key) => JSON.stringify([projectId, key]);

  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      assert.ok((Array.isArray(storeNames) ? storeNames : [storeNames]).includes("project-settings"));
      assert.ok(mode === "readonly" || mode === "readwrite");
      let settled = false;
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          if (settled) return;
          settled = true;
          queueMicrotask(() => tx.onabort?.());
        },
        complete() {
          if (settled) return;
          settled = true;
          queueMicrotask(() => tx.oncomplete?.());
        },
        objectStore(name) {
          assert.equal(name, "project-settings");
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = records.get(keyOf(key[0], key[1]));
                request.onsuccess?.();
                tx.complete();
              });
              return request;
            },
            put(setting) {
              records.set(keyOf(setting.projectId, setting.key), structuredClone(setting));
              tx.complete();
            },
            index(indexName) {
              assert.equal(indexName, "by-project");
              return {
                getAll(projectId) {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = [...records.values()]
                      .filter(setting => setting.projectId === projectId)
                      .map(setting => structuredClone(setting));
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
    records,
    restore() {
      if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
      else delete globalThis.indexedDB;
    }
  };
}

test("HostEngineApi guarda configuraciones JSON por proyecto y conserva su aislamiento", async () => {
  const store = new MemoryProjectSettingsStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({
    projectId: "settings-book-a",
    projectName: "Libro A",
    writerId: "writer-settings"
  });
  const second = new HostEngineApi({ store });
  second.initializeProject({
    projectId: "settings-book-b",
    projectName: "Libro B",
    writerId: "writer-settings"
  });

  await first.setProjectSetting("language.primary", {
    identifier: "es-AR",
    variants: ["rioplatense", "neutro"],
    enabled: true
  }, "WRITER");
  await first.setProjectSetting("editorial.options", {
    punctuation: { dialogue: "long-dash" },
    preferredTerms: ["personaje", "acontecimiento"]
  }, "WRITER");
  await second.setProjectSetting("language.primary", {
    identifier: "pt-BR",
    enabled: true
  }, "WRITER");

  const firstSettings = await first.getProjectSettings();
  const secondSettings = await second.getProjectSettings();
  assert.equal(firstSettings.length, 2);
  assert.equal(secondSettings.length, 1);
  assert.equal(firstSettings.find(item => item.key === "language.primary").value.identifier, "es-AR");
  assert.equal(secondSettings[0].value.identifier, "pt-BR");
  assert.ok(firstSettings.every(item => item.projectId === "settings-book-a"));
  assert.ok(secondSettings.every(item => item.projectId === "settings-book-b"));

  firstSettings[0].value.identifier = "tampered";
  assert.equal((await first.getProjectSettings()).find(item => item.key === "language.primary").value.identifier, "es-AR");
});

test("HostEngineApi exige identidad de escritor para cambios declarados por WRITER", async () => {
  const api = new HostEngineApi({ store: new MemoryProjectSettingsStore() });
  api.initializeProject({ projectId: "settings-host-only", projectName: "Libro del anfitrión" });

  await assert.rejects(
    api.setProjectSetting("editor.theme", "light", "WRITER"),
    /identificador estable del escritor/
  );
  const saved = await api.setProjectSetting("editor.theme", "light", "HOST");
  assert.equal(saved.source, "HOST");
  assert.equal((await api.getProjectSettings())[0].value, "light");
});

test("HostEngineApi rechaza valores no JSON, valores cíclicos y valores excesivos", async () => {
  const api = new HostEngineApi({ store: new MemoryProjectSettingsStore() });
  api.initializeProject({
    projectId: "settings-validation",
    projectName: "Libro validado",
    writerId: "writer-validation"
  });

  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    api.setProjectSetting("bad.function", () => "no", "WRITER"),
    /Configuración del proyecto inválida/
  );
  await assert.rejects(
    api.setProjectSetting("bad.cycle", cyclic, "WRITER"),
    /Configuración del proyecto inválida/
  );
  await assert.rejects(
    api.setProjectSetting("bad.large", "x".repeat(1_048_577), "WRITER"),
    /máximo 1 MiB/
  );
  assert.deepEqual(await api.getProjectSettings(), []);
});

test("IndexedDB persiste configuraciones por proyecto y rechaza actualizaciones obsoletas", async () => {
  const mock = installIndexedDbSettingsMock();
  try {
    const store = new IndexedDbProjectStore();
    const initial = {
      projectId: "indexed-settings",
      key: "language.primary",
      value: { identifier: "es-AR", enabled: true },
      source: "WRITER",
      updatedAt: 10
    };
    await store.saveProjectSetting(initial);
    const loaded = await store.loadProjectSettings("indexed-settings");
    assert.deepEqual(loaded, [initial]);

    const updated = {
      ...initial,
      value: { identifier: "es-AR", enabled: false },
      updatedAt: 20
    };
    await store.saveProjectSetting(updated, initial);
    assert.deepEqual(await store.loadProjectSettings("indexed-settings"), [updated]);
    await assert.rejects(
      store.saveProjectSetting({ ...updated, value: { enabled: true }, updatedAt: 30 }, initial),
      /cambió en otra instancia/
    );
    assert.deepEqual(await store.loadProjectSettings("another-project"), []);
    assert.equal(mock.records.size, 1);
  } finally {
    mock.restore();
  }
});
