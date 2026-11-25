import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

class MemoryLanguageStore {
  profiles = new Map();
  resources = new Map();

  key(projectId, id) {
    return projectId + ":" + id;
  }

  async loadLanguageProfiles(projectId) {
    return [...this.profiles.values()]
      .filter(profile => profile.projectId === projectId)
      .map(profile => structuredClone(profile));
  }

  async saveLanguageProfile(profile, expectedCurrent) {
    const key = this.key(profile.projectId, profile.id);
    const current = this.profiles.get(key);
    if (expectedCurrent) {
      if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
        throw new Error("El perfil lingüístico cambió en otra instancia.");
      }
    } else if (current) {
      throw new Error("El perfil lingüístico ya existe.");
    }
    this.profiles.set(key, structuredClone(profile));
  }

  async loadLanguageResourceRefs(projectId, profileId) {
    return [...this.resources.values()]
      .filter(resource => resource.projectId === projectId &&
        (profileId === undefined || resource.profileId === profileId))
      .map(resource => structuredClone(resource));
  }

  async saveLanguageResourceRef(resource, expectedCurrent) {
    if (resource.profileId !== undefined &&
        !this.profiles.has(this.key(resource.projectId, resource.profileId))) {
      throw new Error("El perfil lingüístico asociado no existe en el proyecto.");
    }
    const key = this.key(resource.projectId, resource.id);
    const current = this.resources.get(key);
    if (expectedCurrent) {
      if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
        throw new Error("La referencia de recurso cambió en otra instancia.");
      }
    } else if (current) {
      throw new Error("La referencia de recurso ya existe.");
    }
    this.resources.set(key, structuredClone(resource));
  }
}

function installLanguageIndexedDbMock() {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const profiles = new Map();
  const resources = new Map();
  const keyOf = (projectId, id) => JSON.stringify([projectId, id]);

  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      assert.ok(names.length > 0);
      assert.ok(mode === "readonly" || mode === "readwrite");
      let settled = false;
      let pending = 0;
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
        maybeComplete() {
          if (settled || pending !== 0) return;
          queueMicrotask(() => {
            if (settled || pending !== 0) return;
            settled = true;
            tx.oncomplete?.();
          });
        },
        request(resultFactory) {
          pending++;
          const request = {};
          queueMicrotask(() => {
            if (settled) return;
            request.result = resultFactory();
            request.onsuccess?.();
            pending--;
            tx.maybeComplete();
          });
          return request;
        },
        write(operation) {
          pending++;
          queueMicrotask(() => {
            if (settled) return;
            try {
              operation();
              pending--;
              tx.maybeComplete();
            } catch (error) {
              tx.error = error;
              tx.abort();
            }
          });
        },
        objectStore(name) {
          if (name === "language-profiles") {
            return {
              get(key) {
                return tx.request(() => {
                  const value = profiles.get(keyOf(key[0], key[1]));
                  return value ? structuredClone(value) : undefined;
                });
              },
              put(profile) {
                tx.write(() => profiles.set(
                  keyOf(profile.projectId, profile.id), structuredClone(profile)
                ));
              },
              index(indexName) {
                assert.ok(["by-project", "by-project-language", "by-project-active"].includes(indexName));
                return {
                  getAll(key) {
                    const projectId = Array.isArray(key) ? key[0] : key;
                    const languageIdentifier = Array.isArray(key) ? key[1] : undefined;
                    return tx.request(() => [...profiles.values()]
                      .filter(profile => profile.projectId === projectId &&
                        (languageIdentifier === undefined || profile.languageIdentifier === languageIdentifier))
                      .map(profile => structuredClone(profile)));
                  }
                };
              }
            };
          }
          if (name === "language-resource-refs") {
            return {
              get(key) {
                return tx.request(() => {
                  const value = resources.get(keyOf(key[0], key[1]));
                  return value ? structuredClone(value) : undefined;
                });
              },
              put(resource) {
                tx.write(() => resources.set(
                  keyOf(resource.projectId, resource.id), structuredClone(resource)
                ));
              },
              index(indexName) {
                assert.ok(["by-project", "by-profile", "by-resource-database"].includes(indexName));
                return {
                  getAll(key) {
                    const projectId = Array.isArray(key) ? key[0] : key;
                    const profileId = indexName === "by-profile" ? key[1] : undefined;
                    return tx.request(() => [...resources.values()]
                      .filter(resource => resource.projectId === projectId &&
                        (profileId === undefined || resource.profileId === profileId))
                      .map(resource => structuredClone(resource)));
                  }
                };
              }
            };
          }
          throw new Error("Object store no esperado: " + name);
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
    profiles,
    resources,
    restore() {
      if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
      else delete globalThis.indexedDB;
    }
  };
}

function fantasyProfile(id = "fantasy-language") {
  return {
    id,
    languageIdentifier: "qwv-x-aurorian",
    languageName: "Auroriano",
    regionalVariant: "dialecto de las islas",
    profileKind: "FICTIONAL_DEVELOPED",
    editorialPreferences: {
      orthography: { accentMarks: "custom", apostrophe: false },
      morphology: { pluralSuffix: "en" },
      punctuation: { dialogue: "long-dash" }
    },
    coverageStatus: "writer-reviewed-partial",
    isActive: true
  };
}

test("HostEngineApi guarda perfiles de idiomas ficticios y conserva su configuración", async () => {
  const store = new MemoryLanguageStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "language-profile-book",
    projectName: "Las islas del alba",
    writerId: "writer-language"
  });

  const saved = await api.saveLanguageProfile(fantasyProfile());
  assert.equal(saved.projectId, "language-profile-book");
  assert.equal(saved.profileKind, "FICTIONAL_DEVELOPED");
  assert.equal(saved.languageIdentifier, "qwv-x-aurorian");
  assert.equal((await api.getLanguageProfiles()).length, 1);
  assert.deepEqual(
    (await api.getLanguageProfiles())[0].editorialPreferences,
    fantasyProfile().editorialPreferences
  );
});

test("HostEngineApi mantiene perfiles y referencias aislados por proyecto", async () => {
  const store = new MemoryLanguageStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "language-book-a", projectName: "Libro A", writerId: "writer-a" });
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "language-book-b", projectName: "Libro B", writerId: "writer-a" });

  await first.saveLanguageProfile(fantasyProfile("aurorian"));
  await second.saveLanguageProfile({
    ...fantasyProfile("portuguese"),
    languageIdentifier: "pt-BR",
    languageName: "Português brasileiro",
    regionalVariant: "Brasil",
    profileKind: "REAL"
  });
  const reference = await first.saveLanguageResourceRef({
    id: "aurorian-lexicon-v2",
    profileId: "aurorian",
    resourceDatabaseId: "writer-lexicon-001",
    resourceKind: "LEXICON",
    resourceSchemaVersion: "2.0",
    resourceStatus: "VERIFIED_BY_WRITER"
  });

  assert.equal(reference.projectId, "language-book-a");
  assert.equal((await first.getLanguageResourceRefs("aurorian")).length, 1);
  assert.deepEqual(await second.getLanguageResourceRefs(), []);
  assert.equal((await second.getLanguageProfiles())[0].languageName, "Português brasileiro");
});

test("HostEngineApi rechaza perfiles y referencias malformados o huérfanos", async () => {
  const store = new MemoryLanguageStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "language-invalid", projectName: "Libro", writerId: "writer" });

  await assert.rejects(
    api.saveLanguageProfile({ ...fantasyProfile(), editorialPreferences: () => "invalid" }),
    /preferencias editoriales/
  );
  await assert.rejects(
    api.saveLanguageResourceRef({
      id: "orphan-resource",
      profileId: "missing-profile",
      resourceDatabaseId: "resource-db",
      resourceKind: "LEXICON",
      resourceSchemaVersion: "1",
      resourceStatus: "READY"
    }),
    /perfil lingüístico asociado no existe/
  );
  assert.deepEqual(await api.getLanguageProfiles(), []);
  assert.deepEqual(await api.getLanguageResourceRefs(), []);
});

test("IndexedDB persiste perfiles lingüísticos y exige que las referencias tengan perfil válido", async () => {
  const mock = installLanguageIndexedDbMock();
  try {
    const store = new IndexedDbProjectStore();
    const profile = {
      projectId: "indexed-language-book",
      ...fantasyProfile()
    };
    await store.saveLanguageProfile(profile);
    assert.deepEqual(await store.loadLanguageProfiles(profile.projectId), [profile]);

    const resource = {
      projectId: profile.projectId,
      id: "lexicon-ref",
      profileId: profile.id,
      resourceDatabaseId: "resource-db-a",
      resourceKind: "LEXICON",
      resourceSchemaVersion: "2",
      resourceStatus: "VERIFIED"
    };
    await store.saveLanguageResourceRef(resource);
    assert.deepEqual(await store.loadLanguageResourceRefs(profile.projectId), [resource]);
    assert.deepEqual(
      await store.loadLanguageResourceRefs(profile.projectId, profile.id),
      [resource]
    );
    await assert.rejects(
      store.saveLanguageResourceRef({
        ...resource,
        id: "orphan",
        profileId: "not-found"
      }),
      /perfil lingüístico asociado no existe/
    );
    assert.equal(mock.profiles.size, 1);
    assert.equal(mock.resources.size, 1);
  } finally {
    mock.restore();
  }
});
