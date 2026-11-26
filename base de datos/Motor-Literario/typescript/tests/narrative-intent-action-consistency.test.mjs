import test from "node:test";
import assert from "node:assert/strict";
import { compareNarrativeIntentsWithActions } from "../dist/motor-literario.js";

const entities = [
  {projectId:"novel",id:"mara",kind:"character",canonicalName:"Mara",normalizedName:"mara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1},
  {projectId:"novel",id:"elian",kind:"character",canonicalName:"Elian",normalizedName:"elian",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1}
];
function intent(text, polarity = "affirmed", start = 20) {
  return {
    id:"intent-1",projectId:"novel",characterEntityId:"mara",kind:"goal",
    text,polarity,reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start,end:start+text.length,excerpt:"Mara quiere " + text + ". Mara actuó."}
  };
}
function action(actionName, polarity = "affirmed", start = 70, actor = "mara", target = "elian") {
  return {
    id:"action-1",projectId:"novel",actorEntityId:actor,action:actionName,
    targetEntityId:target,polarity,reviewStatus:"candidate",
    evidence:{documentId:"chapter-1",revision:1,start,end:start+20,excerpt:"Mara " + actionName + " a Elian."}
  };
}

test("reconoce una acción explícita que apoya la meta del personaje", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("protegió")]
  });
  assert.equal(result.relation,"supports-intent");
  assert.equal(result.matchedTargetEntityId,"elian");
});

test("reconoce oposición léxica sin atribuir engaño o intención oculta", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("traicionó")]
  });
  assert.equal(result.relation,"opposes-intent");
});

test("no compara una acción negada como si hubiera ocurrido", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("traicionó","negated")]
  });
  assert.equal(result.relation,"not-comparable");
});

test("no enlaza acciones de otro personaje", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("traicionó","affirmed",70,"elian","mara")]
  });
  assert.equal(result,undefined);
});

test("no enlaza acciones de otra revisión ni anteriores a la intención", () => {
  const previous = {...action("traicionó"),evidence:{...action("traicionó").evidence,start:5,end:25}};
  const otherRevision = {...action("protegió"),evidence:{...action("protegió").evidence,revision:2}};
  assert.deepEqual(compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[previous,otherRevision]
  }),[]);
});

test("no infiere oposición para verbos fuera del vocabulario validado", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("destruyó")]
  });
  assert.equal(result.relation,"unrelated-action");
});

test("conserva negación y condicionalidad de la intención sin reinterpretarlas", () => {
  const [negative] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian","negated")],
    actions:[action("protegió")]
  });
  const [conditional] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian","conditional")],
    actions:[action("protegió")]
  });
  assert.equal(negative.relation,"intent-negated");
  assert.equal(conditional.relation,"conditional-intent");
});

test("no compara como oposición una acción dirigida a otro objetivo", () => {
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[intent("proteger a Elian")],
    actions:[action("traicionó","affirmed",70,"mara","mara")]
  });
  assert.equal(result.relation,"unrelated-action");
});

test("no usa evidencia marcada como obsoleta para declarar coherencia o contradicción", () => {
  const staleIntent = {...intent("proteger a Elian"),evidence:{...intent("proteger a Elian").evidence,status:"stale"}};
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[staleIntent],actions:[action("traicionó")]
  });
  assert.equal(result.relation,"not-comparable");
});
