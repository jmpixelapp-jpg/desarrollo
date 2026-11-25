import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class TimelineOccurrenceStore {
  events = new Map();
  tracks = new Map();
  entities = new Map();

  async loadEvents(projectId) {
    return [...this.events.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveEvent(event) {
    if (event.timelineTrackId !== undefined &&
        !this.tracks.has(JSON.stringify([event.projectId, event.timelineTrackId]))) {
      throw new Error("La pista cronológica no existe en el mismo proyecto.");
    }
    for (const id of event.participants) {
      if (!this.entities.has(JSON.stringify([event.projectId, id]))) {
        throw new Error("Un participante del acontecimiento no existe en el proyecto.");
      }
    }
    this.events.set(JSON.stringify([event.projectId, event.id]), structuredClone(event));
  }
  async loadTimelineTracks(projectId) {
    return [...this.tracks.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveTimelineTrack(track, expectedCurrent) {
    const key = JSON.stringify([track.projectId, track.id]);
    const current = this.tracks.get(key);
    if (expectedCurrent === undefined && current) throw new Error("La pista ya existe.");
    if (expectedCurrent && (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent))) {
      throw new Error("La pista cronológica cambió en otra instancia.");
    }
    this.tracks.set(key, structuredClone(track));
  }
  async loadEntities(projectId) {
    return [...this.entities.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveEntity(entity) {
    this.entities.set(JSON.stringify([entity.projectId, entity.id]), structuredClone(entity));
  }
}

const project = { projectId: "timeline-occurrences-book", projectName: "Libro temporal", writerId: "timeline-writer" };
const event = {
  projectId: project.projectId,
  id: "event:festival",
  label: "Festival de la cosecha",
  participants: [],
  evidence: [],
  timeReference: { basis: "calendar", precision: "year", raw: "año 1290", orderValue: 1290 }
};
const track = {
  id: "track:calendar",
  trackName: "Calendario civil",
  trackKind: "calendar",
  rules: { basis: "calendar", unit: "year" },
  provenanceKind: "WRITER"
};

test("asocia un acontecimiento a una pista cronológica explícita del mismo libro", async () => {
  const store = new TimelineOccurrenceStore();
  store.events.set(JSON.stringify([project.projectId, event.id]), structuredClone(event));
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveTimelineTrack(track);
  const updated = await api.setNarrativeEventTimelineTrack(event.id, track.id);
  assert.equal(updated.timelineTrackId, track.id);
  const loaded = await api.getNarrativeEvents();
  assert.equal(loaded[0].timelineTrackId, track.id);
  assert.deepEqual(loaded[0].timeReference, event.timeReference);
});

test("rechaza asociar un acontecimiento a una pista inexistente", async () => {
  const store = new TimelineOccurrenceStore();
  store.events.set(JSON.stringify([project.projectId, event.id]), structuredClone(event));
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await assert.rejects(
    api.setNarrativeEventTimelineTrack(event.id, "track:missing"),
    /no existe en el mismo proyecto/
  );
  assert.equal((await api.getNarrativeEvents())[0].timelineTrackId, undefined);
});

test("rechaza usar una pista que pertenece a otro libro", async () => {
  const store = new TimelineOccurrenceStore();
  store.events.set(JSON.stringify([project.projectId, event.id]), structuredClone(event));
  store.tracks.set(JSON.stringify(["other-book", track.id]), {
    ...structuredClone(track), projectId: "other-book"
  });
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await assert.rejects(
    api.setNarrativeEventTimelineTrack(event.id, track.id),
    /no existe en el mismo proyecto/
  );
});

test("permite retirar una asociación de pista sin alterar la fecha explícita", async () => {
  const store = new TimelineOccurrenceStore();
  store.events.set(JSON.stringify([project.projectId, event.id]), {
    ...structuredClone(event), timelineTrackId: track.id
  });
  store.tracks.set(JSON.stringify([project.projectId, track.id]), {
    ...structuredClone(track), projectId: project.projectId
  });
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const updated = await api.setNarrativeEventTimelineTrack(event.id, undefined);
  assert.equal(Object.hasOwn(updated, "timelineTrackId"), false);
  assert.deepEqual(updated.timeReference, event.timeReference);
});

test("rechaza exponer acontecimientos con referencias a pistas huérfanas", async () => {
  const store = new TimelineOccurrenceStore();
  store.events.set(JSON.stringify([project.projectId, event.id]), {
    ...structuredClone(event), timelineTrackId: "track:missing"
  });
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await assert.rejects(api.getNarrativeEvents(), /pista cronológica inexistente o ajena/);
});
