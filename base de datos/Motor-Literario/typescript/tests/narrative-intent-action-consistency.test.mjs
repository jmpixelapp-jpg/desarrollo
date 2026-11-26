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
  const extraEntity = {projectId:"novel",id:"nara",kind:"character",canonicalName:"Nara",normalizedName:"nara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1};
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities:[...entities,extraEntity],intents:[intent("proteger a Elian")],
    actions:[action("traicionó","affirmed",70,"mara","nara")]
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

test("conserva ambigüedad cuando el nombre objetivo pertenece a dos personajes", () => {
  const duplicate = {...entities[1],id:"elian-2"};
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities:[...entities,duplicate],
    intents:[intent("proteger a Elian")],actions:[action("protegió")]
  });
  assert.equal(result.relation,"ambiguous-target");
  assert.equal(result.matchedTargetEntityId,undefined);
});

test("contrasta una meta de un capítulo anterior con una acción posterior", () => {
  const prior = {
    ...intent("proteger a Elian"),
    id:"prior-goal",
    evidence:{...intent("proteger a Elian").evidence,documentId:"chapter-1",start:20,end:38}
  };
  const laterAction = {
    ...action("traicionó"),
    id:"later-action",
    evidence:{...action("traicionó").evidence,documentId:"chapter-2",start:5,end:25}
  };
  const [result] = compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[],priorIntents:[prior],
    actions:[laterAction],orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.relation,"opposes-intent");
  assert.equal(result.intentId,"prior-goal");
  assert.equal(result.actionId,"later-action");
});

test("no compara metas de otros capítulos cuando no se declaró el orden documental", () => {
  const prior = {
    ...intent("proteger a Elian"),
    id:"prior-goal",
    evidence:{...intent("proteger a Elian").evidence,documentId:"chapter-1",start:20,end:38}
  };
  const laterAction = {
    ...action("traicionó"),
    evidence:{...action("traicionó").evidence,documentId:"chapter-2",start:5,end:25}
  };
  assert.deepEqual(compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[],priorIntents:[prior],actions:[laterAction]
  }),[]);
});

test("rechaza IDs duplicados entre objetivos actuales e históricos", () => {
  const current = intent("proteger a Elian");
  const prior = {...current,evidence:{...current.evidence,documentId:"chapter-0"}};
  assert.throws(() => compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[current],priorIntents:[prior],actions:[]
  }));
});

test("rechaza órdenes documentales con identificadores repetidos", () => {
  assert.throws(() => compareNarrativeIntentsWithActions({
    projectId:"novel",entities,intents:[],actions:[],
    orderedDocumentIds:["chapter-1","chapter-1"]
  }));
});
