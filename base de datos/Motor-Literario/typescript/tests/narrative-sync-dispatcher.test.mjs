import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeSyncOperationDispatcher,
  createNarrativeSyncOperationEnvelope
} from "../dist/motor-literario.js";

test("dispatcher solo ejecuta el handler registrado con payload válido", async () => {
  const applied = [];
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "dispatch-1", projectId: "project-a", writerId: "writer-a",
    sequence: 1, kind: "idea-upsert", payload: { id: "idea-1", text: "Memoria" }
  });
  const dispatch = createNarrativeSyncOperationDispatcher([{
    kind: "idea-upsert",
    validate: payload => Boolean(payload && typeof payload === "object" &&
      typeof payload.id === "string" && typeof payload.text === "string"),
    apply: async value => { applied.push(value.operationId); }
  }]);
  await dispatch(operation);
  assert.deepEqual(applied, ["dispatch-1"]);
});

test("dispatcher rechaza kinds desconocidos sin ejecutar handlers", async () => {
  let calls = 0;
  const rejected = [];
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "dispatch-2", projectId: "project-a", writerId: "writer-a",
    sequence: 1, kind: "unregistered-kind", payload: {}
  });
  const dispatch = createNarrativeSyncOperationDispatcher([{
    kind: "idea-upsert", validate: () => true,
    apply: async () => { calls++; }
  }], { onRejected: (_operation, reason) => rejected.push(reason) });
  await assert.rejects(() => dispatch(operation), /No existe un handler/u);
  assert.equal(calls, 0);
  assert.deepEqual(rejected, ["unknown-kind"]);
});

test("dispatcher rechaza payload inválido y registra el motivo", async () => {
  let calls = 0;
  const rejected = [];
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "dispatch-3", projectId: "project-a", writerId: "writer-a",
    sequence: 1, kind: "idea-upsert", payload: { id: 7 }
  });
  const dispatch = createNarrativeSyncOperationDispatcher([{
    kind: "idea-upsert",
    validate: payload => Boolean(payload && typeof payload.id === "string"),
    apply: async () => { calls++; }
  }], { onRejected: (_operation, reason) => rejected.push(reason) });
  await assert.rejects(() => dispatch(operation), /no cumple/u);
  assert.equal(calls, 0);
  assert.deepEqual(rejected, ["invalid-payload"]);
});

test("dispatcher rechaza handlers duplicados y validadores que lanzan", async () => {
  const handler = { kind: "idea-upsert", validate: () => true, apply: async () => {} };
  assert.throws(() => createNarrativeSyncOperationDispatcher([handler, handler]), /más de un handler/u);
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "dispatch-4", projectId: "project-a", writerId: "writer-a",
    sequence: 1, kind: "idea-upsert", payload: {}
  });
  const dispatch = createNarrativeSyncOperationDispatcher([{
    kind: "idea-upsert", validate: () => { throw new Error("bad validator"); },
    apply: async () => { throw new Error("must not apply"); }
  }]);
  await assert.rejects(() => dispatch(operation), /no cumple/u);
});
