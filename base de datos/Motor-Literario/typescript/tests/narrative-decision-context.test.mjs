import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeDecisionContexts } from "../dist/motor-literario.js";

const evidence=(excerpt,start=0)=>({documentId:"chapter-1",revision:1,start,end:start+excerpt.length,excerpt});
const knowledge=(overrides={})=>({
  id:"knowledge-action:info-1:action-1",projectId:"book-1",characterEntityId:"mara",
  informationId:"info-1",actionId:"action-1",relation:"knowledge-precedes-action",
  chronology:"same-document-position",knowledgeAssessment:"unassessed",
  knowledgeChannel:"visual-observation",knowledgeStatus:"observed",
  knowledgeEvidence:evidence("Mara vio el puente caído.",0),
  actionEvidence:evidence("Mara protegió a Elian.",80),reviewStatus:"candidate",...overrides
});
const consistency=(overrides={})=>({
  id:"intent-action:intent-1:action-1",projectId:"book-1",characterEntityId:"mara",
  intentId:"intent-1",actionId:"action-1",relation:"supports-intent",
  reviewStatus:"candidate",intentEvidence:evidence("Mara quiere proteger a Elian.",30),
  actionEvidence:evidence("Mara protegió a Elian.",80),...overrides
});

test("triangula conocimiento e intención anteriores a la misma acción",()=>{
  const [result]=buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency()]
  });
  assert.equal(result.alignment,"supports-intent");
  assert.equal(result.characterEntityId,"mara");
  assert.equal(result.informationId,"info-1");
  assert.equal(result.intentId,"intent-1");
  assert.equal(result.actionId,"action-1");
  assert.equal(result.knowledgeEvidence.excerpt,"Mara vio el puente caído.");
  assert.equal(result.intentEvidence.excerpt,"Mara quiere proteger a Elian.");
  assert.equal(result.actionEvidence.excerpt,"Mara protegió a Elian.");
  assert.equal(result.reviewStatus,"candidate");
});

test("conserva contradicción y condición sin transformarlas en decisión causal",()=>{
  const [opposes]=buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({relation:"opposes-intent"})]
  });
  const [conditional]=buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({relation:"conditional-intent"})]
  });
  assert.equal(opposes.alignment,"opposes-intent");
  assert.equal(conditional.alignment,"conditional-intent");
});

test("no cruza acciones de personajes distintos ni acciones diferentes",()=>{
  assert.deepEqual(buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({characterEntityId:"elian"})]
  }),[]);
  assert.deepEqual(buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({actionId:"action-2"})]
  }),[]);
});

test("rechaza referencias duplicadas, proyectos ajenos y relaciones mal formadas",()=>{
  assert.throws(()=>buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge(),knowledge()],
    intentActionConsistency:[consistency()]
  }));
  assert.throws(()=>buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({projectId:"other"})]
  }));
  assert.throws(()=>buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge({relation:"caused"})],
    intentActionConsistency:[consistency()]
  }));
});

test("rechaza dos evidencias incompatibles para el mismo ID de acción",()=>{
  assert.throws(()=>buildNarrativeDecisionContexts({
    projectId:"book-1",knowledgeActionLinks:[knowledge()],
    intentActionConsistency:[consistency({
      actionEvidence:evidence("Mara abrió otra puerta.",120)
    })]
  }),/evidencia idéntica/);
});
