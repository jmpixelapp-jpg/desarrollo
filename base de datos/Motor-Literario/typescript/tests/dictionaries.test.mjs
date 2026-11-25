import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class DictionaryMemoryStore {
  dictionaries = new Map();
  entries = new Map();
  entities = new Map();
  async loadDictionaries(projectId) {
    return [...this.dictionaries.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveDictionary(dictionary, expectedCurrent) {
    const key = JSON.stringify([dictionary.projectId, dictionary.id]);
    const current = this.dictionaries.get(key);
    if (expectedCurrent === undefined) {
      if (current) throw new Error("dictionary_exists");
    } else if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
      throw new Error("dictionary_conflict");
    }
    const duplicate = [...this.dictionaries.values()].find(item =>
      item.projectId === dictionary.projectId && item.id !== dictionary.id &&
      item.languageIdentifier === dictionary.languageIdentifier && item.normalizedName === dictionary.normalizedName
    );
    if (duplicate) throw new Error("duplicate_dictionary_name");
    this.dictionaries.set(key, structuredClone(dictionary));
  }
  async loadDictionaryEntries(projectId, dictionaryId) {
    if (!this.dictionaries.has(JSON.stringify([projectId, dictionaryId]))) throw new Error("El diccionario no existe en el proyecto activo.");
    return [...this.entries.values()].filter(item => item.projectId === projectId && item.dictionaryId === dictionaryId)
      .map(item => structuredClone(item));
  }
  async saveDictionaryEntry(entry, expectedCurrent) {
    if (!this.dictionaries.has(JSON.stringify([entry.projectId, entry.dictionaryId]))) throw new Error("El diccionario no existe en el proyecto activo.");
    const key = JSON.stringify([entry.projectId, entry.id]);
    const current = this.entries.get(key);
    if (expectedCurrent === undefined) {
      if (current) throw new Error("entry_exists");
    } else if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
      throw new Error("entry_conflict");
    }
    if (current && current.dictionaryId !== entry.dictionaryId) throw new Error("dictionary_change");
    for (const id of entry.relatedEntityIds) {
      if (!this.entities.has(JSON.stringify([entry.projectId, id]))) throw new Error("entity_missing");
    }
    const duplicate = [...this.entries.values()].find(item =>
      item.projectId === entry.projectId && item.dictionaryId === entry.dictionaryId &&
      item.id !== entry.id && item.normalizedForm === entry.normalizedForm
    );
    if (duplicate) throw new Error("duplicate_form");
    this.entries.set(key, structuredClone(entry));
  }
  async saveEntity(entity) {
    this.entities.set(JSON.stringify([entity.projectId, entity.id]), structuredClone(entity));
  }
  async loadEntities(projectId) {
    return [...this.entities.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
}

const project = { projectId: "book-one", projectName: "Libro Uno", writerId: "writer-one" };
const dictionaryInput = (overrides = {}) => ({
  id: "dict-es", languageIdentifier: "es", name: "Español propio",
  kind: "REAL", provenanceKind: "WRITER", createdAt: 10, updatedAt: 10, ...overrides
});
const entryInput = (overrides = {}) => ({
  id: "entry-casa", dictionaryId: "dict-es", surfaceForm: "  Cása  ",
  definition: "Edificio destinado a vivienda.", status: "WRITER_CONFIRMED",
  provenanceKind: "WRITER", createdAt: 20, updatedAt: 20,
  attributes: { gender: "feminine", senses: ["dwelling", "home"] },
  relatedEntityIds: [], ...overrides
});
const entity = {
  projectId: "book-one", id: "entity:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
  firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};

test("guarda diccionarios del libro activo y deriva el nombre normalizado", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  const saved = await api.saveProjectDictionary(dictionaryInput());
  assert.equal(saved.projectId, project.projectId);
  assert.equal(saved.normalizedName, "español propio");
  assert.deepEqual(await api.getProjectDictionaries(), [saved]);
});

test("aísla diccionarios por proyecto aunque compartan el mismo ID", async () => {
  const store = new DictionaryMemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject(project);
  await first.saveProjectDictionary(dictionaryInput());
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "book-two", projectName: "Libro Dos", writerId: "writer-one" });
  assert.deepEqual(await second.getProjectDictionaries(), []);
  await second.saveProjectDictionary(dictionaryInput({ name: "Otro idioma" }));
  assert.equal((await first.getProjectDictionaries()).length, 1);
  assert.equal((await second.getProjectDictionaries()).length, 1);
});

test("rechaza dos diccionarios con el mismo nombre normalizado e idioma", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  await assert.rejects(
    api.saveProjectDictionary(dictionaryInput({ id: "dict-duplicate", name: "  ESPAÑOL   PROPIO " })),
    /nombre de diccionario/
  );
});

test("normaliza la forma y conserva atributos JSON extensibles", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  const saved = await api.saveDictionaryEntry(entryInput());
  assert.equal(saved.normalizedForm, "cása");
  assert.equal(saved.surfaceForm, "  Cása  ");
  assert.deepEqual(saved.attributes.senses, ["dwelling", "home"]);
  assert.deepEqual(await api.getDictionaryEntries("dict-es"), [saved]);
});

test("rechaza formas normalizadas duplicadas dentro del mismo diccionario", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  await api.saveDictionaryEntry(entryInput());
  await assert.rejects(
    api.saveDictionaryEntry(entryInput({ id: "entry-duplicate", surfaceForm: "CÁSA" })),
    /forma normalizada/
  );
});

test("rechaza entradas cuyo diccionario padre no existe", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await assert.rejects(api.saveDictionaryEntry(entryInput()), /no existe/);
  await assert.rejects(api.getDictionaryEntries("missing"), /no existe/);
});

test("los vínculos solo admiten entidades del mismo libro", async () => {
  const store = new DictionaryMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  await api.saveDictionaryEntry(entryInput());
  store.entities.set(JSON.stringify(["book-one", "entity:ana"]), structuredClone(entity));
  const linked = await api.setDictionaryEntryEntityLink("dict-es", "entry-casa", "entity:ana", true);
  assert.deepEqual(linked.relatedEntityIds, ["entity:ana"]);
  const unlinked = await api.setDictionaryEntryEntityLink("dict-es", "entry-casa", "entity:ana", false);
  assert.deepEqual(unlinked.relatedEntityIds, []);
  await assert.rejects(
    api.setDictionaryEntryEntityLink("dict-es", "entry-casa", "foreign-entity", true),
    /no existe en el mismo libro/
  );
});

test("rechaza atributos que no sean JSON plano y finito", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(api.saveDictionaryEntry(entryInput({ attributes: cyclic })), /JSON plano y finito/);
  await assert.rejects(
    api.saveDictionaryEntry(entryInput({ attributes: { amount: Number.POSITIVE_INFINITY } })),
    /JSON plano y finito/
  );
});

test("rechaza resultados persistidos pertenecientes a otro proyecto", async () => {
  const store = new DictionaryMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  store.loadDictionaries = async () => [{
    ...dictionaryInput(), projectId: "foreign-book", normalizedName: "español propio"
  }];
  await assert.rejects(api.getProjectDictionaries(), /Violación de aislamiento/);
});

test("las respuestas no exponen referencias mutables a la persistencia", async () => {
  const api = new HostEngineApi({ store: new DictionaryMemoryStore() });
  api.initializeProject(project);
  await api.saveProjectDictionary(dictionaryInput());
  const saved = await api.saveDictionaryEntry(entryInput());
  saved.attributes.senses.push("mutated");
  const reread = await api.getDictionaryEntries("dict-es");
  assert.deepEqual(reread[0].attributes.senses, ["dwelling", "home"]);
});
