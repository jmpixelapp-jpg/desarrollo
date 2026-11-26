import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeObservationCandidates } from "../dist/motor-literario.js";

const character = {
  projectId: "book-1", id: "entity:character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const other = {
  projectId: "book-1", id: "entity:object:espada", kind: "object",
  canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const context = {
  projectId: "book-1", documentId: "chapter-1", revision: 7,
  entities: [character, other]
};

test("detecta acciones explícitas de un personaje conocido y conserva la frase probatoria", () => {
  const text = "Ana cruzó el puente y abrió la Espada Solar.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.deepEqual(found.map(item => item.action), ["cruzar", "abrir"]);
  assert.ok(found.every(item => item.singleMentionedCharacterId === character.id));
  assert.ok(found.every(item => item.mentionedEntityIds.includes(other.id)));
  const characterMention = found[0].entityMentionEvidence.find(item => item.entityId === character.id);
  const objectMention = found[0].entityMentionEvidence.find(item => item.entityId === other.id);
  assert.equal(characterMention?.evidence.excerpt, "Ana");
  assert.equal(characterMention?.evidence.start, text.indexOf("Ana"));
  assert.equal(objectMention?.evidence.excerpt, "Espada Solar");
  assert.equal(objectMention?.evidence.start, text.indexOf("Espada Solar"));
  assert.equal(objectMention?.entityKind, "object");
  assert.ok(found.every(item => item.evidence.excerpt === text));
  assert.ok(found.every(item => item.evidence.revision === 7));
  assert.deepEqual(found.map(item => item.actionEvidence.excerpt), ["cruzó", "abrió"]);
  assert.deepEqual(found.map(item => item.actionEvidence.start), [
    text.indexOf("cruzó"), text.indexOf("abrió")
  ]);
  assert.ok(found.every(item => text.slice(item.actionEvidence.start, item.actionEvidence.end) ===
    item.actionEvidence.excerpt));
});

test("distingue formas verbales sin convertir el tiempo gramatical en cronología", () => {
  const forms = [
    ["Ana cruzó el puente.", "past-preterite"],
    ["Ana cruzaba el puente.", "past-imperfect"],
    ["Ana cruza el puente.", "present"],
    ["Ana cruzar el puente.", "infinitive"],
    ["Ana cruzando el puente.", "gerund"]
  ];
  for (const [text, expected] of forms) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found[0]?.grammaticalTense, expected, text);
    if (text === "Ana cruzar el puente.") assert.equal(found[0]?.surface, "cruzar");
    if (text === "Ana cruzando el puente.") assert.equal(found[0]?.surface, "cruzando");
  }
});

test("extrae una transferencia dirigida solo con sujeto, objeto y destinatario explícitos", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const text = "Ana entregó la Espada Solar a Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno, other], text, baseOffset: 40
  });
  assert.equal(found.length, 1);
  const relation = found[0].directedRelationCandidate;
  assert.ok(relation);
  assert.equal(relation.relation, "transfers-to");
  assert.equal(relation.fromEntityId, character.id);
  assert.equal(relation.toEntityId, bruno.id);
  assert.equal(relation.objectEntityId, other.id);
  assert.equal(relation.subjectEvidence.excerpt, "Ana");
  assert.equal(relation.objectEvidence.excerpt, "Espada Solar");
  assert.equal(relation.recipientEvidence.excerpt, "Bruno");
  assert.equal(relation.actionEvidence.excerpt, "entregó");
  for (const evidence of [relation.subjectEvidence, relation.objectEvidence,
    relation.recipientEvidence, relation.actionEvidence]) {
    assert.equal(evidence.start >= 40, true);
    assert.equal(evidence.revision, 7);
    assert.equal(text.slice(evidence.start - 40, evidence.end - 40), evidence.excerpt);
  }
});

test("no crea transferencias dirigidas con negación o roles ambiguos", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const negated = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno, other],
    text: "Ana no entregó la Espada Solar a Bruno."
  });
  assert.equal(negated[0]?.directedRelationCandidate, undefined);
  const ambiguous = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno, other],
    text: "Ana entregó la Espada Solar."
  });
  assert.equal(ambiguous[0]?.directedRelationCandidate, undefined);
  const passive = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno, other],
    text: "La Espada Solar fue entregada a Bruno por Ana."
  });
  assert.equal(passive[0]?.directedRelationCandidate, undefined);
});

test("no atribuye un sujeto cuando aparecen varios personajes", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const text = "Ana ayudó a Bruno durante la huida.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].singleMentionedCharacterId, undefined);
  assert.deepEqual(found[0].mentionedCharacterIds.sort(), [character.id, bruno.id].sort());
});

test("detecta pronombres narrativos y conserva candidatos de antecedente sin resolverlos", () => {
  const text = "Ana entró en la habitación. Ella corrió hacia la ventana.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  const pronounAction = found.find(item => item.action === "correr");
  assert.ok(pronounAction);
  assert.deepEqual(pronounAction.mentionedCharacterIds, []);
  assert.equal(pronounAction.unresolvedReferences?.[0]?.pronoun, "Ella");
  assert.deepEqual(pronounAction.unresolvedReferences?.[0]?.candidateEntityIds, [character.id]);
  assert.equal(pronounAction.unresolvedReferences?.[0]?.antecedentEvidence?.excerpt,
    "Ana entró en la habitación.");
  assert.equal(pronounAction.unresolvedReferences?.[0]?.evidence.excerpt,
    "Ella");
});

test("reconoce pronombre con espacios iniciales y conserva offsets UTF-16 exactos", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "   Ella cruzó el puente.";
  const found = discoverNarrativeObservationCandidates({
    ...context, text, baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  const reference = found[0].unresolvedReferences?.[0];
  assert.equal(reference?.pronoun, "Ella");
  assert.equal(reference?.evidence.start, prefix.length + 3);
  assert.equal(reference?.evidence.end, prefix.length + 7);
  assert.equal(reference?.evidence.excerpt, "Ella");
});

test("no inventa un antecedente cuando el pronombre aparece sin contexto previo", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ella corrió hacia la ventana."
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].unresolvedReferences?.[0]?.candidateEntityIds, []);
});

test("no presenta al único personaje mencionado como agente gramatical", () => {
  const text = "Ana fue encontrada por el guardia.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].singleMentionedCharacterId, character.id);
  assert.equal("actorEntityId" in found[0], false);
});

test("propone sujeto gramatical solo con patrón local explícito y distingue voz pasiva", () => {
  const active = discoverNarrativeObservationCandidates({
    ...context, text: "Ana no abrió la puerta."
  })[0];
  assert.equal(active?.grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(active?.grammaticalSubjectCandidate?.voice, "active");
  assert.equal(active?.grammaticalSubjectCandidate?.evidence.excerpt, "Ana");

  const passive = discoverNarrativeObservationCandidates({
    ...context, text: "Ana fue encontrada por el guardia."
  })[0];
  assert.equal(passive?.grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(passive?.grammaticalSubjectCandidate?.voice, "passive");
  assert.equal(passive?.singleMentionedCharacterId, character.id);
  assert.equal("actorEntityId" in (passive ?? {}), false);
});

test("no atribuye sujeto cuando el personaje aparece después del verbo o como complemento", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "A Ana la encontró Bruno."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.grammaticalSubjectCandidate, undefined);
});

test("reconoce imperfecto plural y participios irregulares de abrir", () => {
  const plural = discoverNarrativeObservationCandidates({
    ...context, text: "Ana y Bruno cruzaban el puente."
  });
  assert.equal(plural.length, 1);
  assert.equal(plural[0]?.surface, "cruzaban");
  assert.equal(plural[0]?.grammaticalTense, "past-imperfect");
  assert.equal(plural[0]?.grammaticalSubjectCandidate, undefined);

  const passive = discoverNarrativeObservationCandidates({
    ...context, text: "Ana fue abierta paso a paso."
  });
  assert.equal(passive.length, 1);
  assert.equal(passive[0]?.action, "abrir");
  assert.equal(passive[0]?.surface, "abierta");
  assert.equal(passive[0]?.grammaticalTense, "participle");
});

test("reconoce participios pasivos sin atribuir el papel de agente al personaje", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ana fue encontrada por el guardia."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "encontrar");
  assert.equal(found[0].grammaticalTense, "participle");
  assert.equal(found[0].singleMentionedCharacterId, character.id);
});

test("marca negación explícita sin convertirla en acción afirmada", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ana no abrió la puerta."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "abrir");
  assert.equal(found[0].polarity, "negated");
});

test("mantiene offsets UTF-16 absolutos y no inventa acciones sin personajes conocidos", () => {
  const prefix = "Prólogo.\n";
  const text = "Ana encontró la carta.";
  const found = discoverNarrativeObservationCandidates({
    ...context, text, baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.start, prefix.length);
  assert.equal(found[0].evidence.end, prefix.length + text.length);
  assert.deepEqual(discoverNarrativeObservationCandidates({
    ...context, entities: [], text
  }), []);
});

test("rechaza entidades ajenas al proyecto y límites inválidos", () => {
  assert.throws(() => discoverNarrativeObservationCandidates({
    ...context, entities: [{ ...character, projectId: "another-book" }], text: "Ana corrió."
  }));
  assert.throws(() => discoverNarrativeObservationCandidates({
    ...context, baseOffset: -1, text: "Ana corrió."
  }));
});

test("no confunde nombres con secuencias de letras dentro de otras palabras", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "La ventana se abrió."
  });
  assert.deepEqual(found, []);
});

test("reconoce futuro en acciones vinculadas a personajes sin convertirlo en fecha", () => {
  const forms = [
    ["Ana cruzará el puente.", "cruzar", "cruzará"],
    ["Ana llegará mañana.", "llegar", "llegará"],
    ["Ana caminará hasta el puerto.", "caminar", "caminará"],
    ["Ana entrará al castillo.", "entrar", "entrará"]
  ];
  for (const [text, action, surface] of forms) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found.length, 1, text);
    assert.equal(found[0].action, action, text);
    assert.equal(found[0].surface, surface, text);
    assert.equal(found[0].grammaticalTense, "future", text);
    assert.equal(found[0].singleMentionedCharacterId, character.id, text);
  }
});

test("detecta futuro regular en todo el inventario y formas irregulares frecuentes", () => {
  const forms = [
    ["Ana abrirá la puerta.", "abrir", "abrirá"],
    ["Ana responderá mañana.", "responder", "responderá"],
    ["Ana dirá la verdad.", "decir", "dirá"],
    ["Ana saldrá al amanecer.", "salir", "saldrá"],
    ["Ana protegerá a Bruno.", "proteger", "protegerá"]
  ];
  for (const [text, action, surface] of forms) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found.length, 1, text);
    assert.equal(found[0].action, action, text);
    assert.equal(found[0].surface, surface, text);
    assert.equal(found[0].grammaticalTense, "future", text);
  }
});

test("no reconoce futuros como prefijos de otras palabras", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ana abrirá la puerta; el abrirámetro no existe."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].surface, "abrirá");
});

test("identifica un agente explícito en pasiva sin confundirlo con el sujeto paciente", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Ana fue encontrada por Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(found[0].grammaticalSubjectCandidate?.voice, "passive");
  assert.equal(found[0].passiveAgentCandidate?.entityId, bruno.id);
  assert.equal(found[0].passiveAgentCandidate?.marker, "por");
  const evidence = found[0].passiveAgentCandidate.evidence;
  assert.equal(text.slice(evidence.start, evidence.end), "Bruno");
});

test("no inventa agente pasivo si el complemento por no identifica una entidad conocida", () => {
  const text = "Ana fue encontrada por un desconocido.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].grammaticalSubjectCandidate?.voice, "passive");
  assert.equal(found[0].passiveAgentCandidate, undefined);
});

test("conserva offsets de la primera mención de cada alias de entidad", () => {
  const sword = { ...other, aliases: ["la Espada Solar"] };
  const text = "Ana miró la Espada Solar y después la Espada Solar brilló.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, sword], text
  });
  assert.equal(found.length, 1);
  const mention = found[0].entityMentionEvidence.find(item => item.entityId === sword.id);
  assert.equal(mention?.evidence.excerpt, "la Espada Solar");
  assert.equal(mention?.evidence.start, text.indexOf("la Espada Solar"));
  assert.equal(mention?.evidence.end, text.indexOf("la Espada Solar") + "la Espada Solar".length);
});

test("identifica objeto directo conocido con evidencia literal sin inferir posesión", () => {
  const text = "Ana perdió la Espada Solar.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "perder");
  assert.equal(found[0].grammaticalObjectCandidate?.entityId, other.id);
  const evidence = found[0].grammaticalObjectCandidate.evidence;
  assert.equal(evidence.excerpt, "Espada Solar");
  assert.equal(text.slice(evidence.start, evidence.end), "Espada Solar");
});

test("no asigna objeto gramatical si la entidad no sigue al verbo con marcador nominal", () => {
  const text = "La Espada Solar desapareció. Ana perdió la paciencia.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].grammaticalObjectCandidate, undefined);
});

test("reconoce un complemento personal explícito sin inventar la relación semántica", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Ana encontró a Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].personalObjectCandidate?.entityId, bruno.id);
  assert.equal(found[0].personalObjectCandidate?.marker, "a");
  const evidence = found[0].personalObjectCandidate.evidence;
  assert.equal(text.slice(evidence.start, evidence.end), "Bruno");
});

test("detecta destinatario después del objeto en una entrega explícita", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Ana entregó la Espada Solar a Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno, other], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "entregar");
  assert.equal(found[0].grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(found[0].grammaticalObjectCandidate?.entityId, other.id);
  assert.equal(found[0].personalObjectCandidate?.entityId, bruno.id);
  const evidence = found[0].personalObjectCandidate.evidence;
  assert.equal(text.slice(evidence.start, evidence.end), "Bruno");
});

test("no confunde una mención directa sin marcador a con complemento personal", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Ana encontró Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].personalObjectCandidate, undefined);
});

test("no propone complemento personal si el personaje solo se menciona antes del verbo", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Bruno encontró a Ana.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].personalObjectCandidate?.entityId, character.id);
  assert.equal(found[0].grammaticalSubjectCandidate?.entityId, bruno.id);
  assert.equal(found[0].grammaticalSubjectCandidate?.voice, "active");
});

test("detecta una acción completa en un fragmento sin punto final mientras se escribe", () => {
  const text = "Ana corrió";
  const baseOffset = 120;
  const found = discoverNarrativeObservationCandidates({
    ...context, text, baseOffset
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "correr");
  assert.equal(found[0].actionEvidence.excerpt, "corrió");
  assert.equal(found[0].actionEvidence.start, baseOffset + text.indexOf("corrió"));
  assert.equal(found[0].actionEvidence.end, baseOffset + text.length);
  assert.equal(found[0].reviewStatus, "candidate");
});

test("no anticipa una acción cuando el autor todavía está escribiendo el verbo", () => {
  const text = "Ana corri";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 0);
});

test("extrae interacciones dirigidas con roles explícitos y diferenciados", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const cases = [
    ["Ana atacó a Bruno.", "atacar", "attacks", "target"],
    ["Ana ayudó a Bruno.", "ayudar", "helps", "beneficiary"],
    ["Ana protegió a Bruno.", "proteger", "protects", "protected"],
    ["Ana salvó a Bruno.", "salvar", "saves", "beneficiary"]
  ];
  for (const [text, action, relation, targetRole] of cases) {
    const found = discoverNarrativeObservationCandidates({
      ...context, entities: [character, bruno, other], text, baseOffset: 25
    });
    const observation = found.find(item => item.action === action);
    assert.ok(observation, text);
    const candidate = observation.directedInteractionCandidate;
    assert.ok(candidate, text);
    assert.equal(candidate.relation, relation);
    assert.equal(candidate.targetRole, targetRole);
    assert.equal(candidate.fromEntityId, character.id);
    assert.equal(candidate.toEntityId, bruno.id);
    assert.equal(candidate.subjectEvidence.excerpt, "Ana");
    assert.equal(candidate.targetEvidence.excerpt, "Bruno");
    assert.equal(candidate.actionEvidence.excerpt, text.match(/atacó|ayudó|protegió|salvó/u)[0]);
    for (const evidence of [candidate.subjectEvidence, candidate.targetEvidence, candidate.actionEvidence]) {
      assert.equal(text.slice(evidence.start - 25, evidence.end - 25), evidence.excerpt);
      assert.equal(evidence.revision, 7);
    }
    assert.equal(observation.reviewStatus, "candidate");
  }
});

test("no crea interacciones dirigidas cuando hay negación, voz pasiva o roles incompletos", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const inputs = [
    "Ana no atacó a Bruno.",
    "Bruno fue atacado por Ana.",
    "Ana atacó.",
    "Ana ayudó a Ana."
  ];
  for (const text of inputs) {
    const found = discoverNarrativeObservationCandidates({
      ...context, entities: [character, bruno, other], text
    });
    assert.ok(found.every(item => item.directedInteractionCandidate === undefined), text);
  }
});

test("no confunde un nombre propio más largo con el prefijo de un personaje conocido", () => {
  const bruno = {
    ...character, id: "character:bruno", canonicalName: "Bruno",
    normalizedName: "bruno"
  };
  const text = "Anabel ayudó a Bruno.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].mentionedCharacterIds, [bruno.id]);
  assert.equal(found[0].grammaticalSubjectCandidate, undefined);
  assert.equal(found[0].personalObjectCandidate?.entityId, bruno.id);
});


test("mantiene límites Unicode al detectar verbos con grafías variables", () => {
  const validCases = [
    ["Ana atravesó el valle.", "atravesar", "atravesó"],
    ["Ana pasó la frontera.", "pasar", "pasó"],
    ["Ana recorrió el camino.", "recorrer", "recorrió"]
  ];
  for (const [text, action, surface] of validCases) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    const candidate = found.find(item => item.action === action);
    assert.ok(candidate, text);
    assert.equal(candidate.surface, surface);
    assert.equal(text.slice(candidate.actionEvidence.start, candidate.actionEvidence.end), surface);
  }
});

test("no reconoce un verbo como subcadena pegada a letras Unicode", () => {
  for (const text of ["Ana ñatravesó el valle.", "Ana repasó el texto."]) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found.length, 0, text);
  }
});

test("reconoce formas irregulares frecuentes sin depender de raíces regulares", () => {
  const forms = [
    ["Ana hizo una señal.", "hacer", "hizo"],
    ["Ana vino al refugio.", "venir", "vino"],
    ["Ana vio la señal.", "ver", "vio"],
    ["Ana puso la llave sobre la mesa.", "poner", "puso"],
    ["Ana habían visto la señal.", "ver", "visto"]
  ];
  for (const [text, action, surface] of forms) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    const candidate = found.find(item => item.action === action);
    assert.ok(candidate, text);
    assert.equal(candidate.surface, surface, text);
    assert.equal(text.slice(candidate.actionEvidence.start, candidate.actionEvidence.end), surface);
    if (["hizo", "vino", "vio", "puso"].includes(surface)) {
      assert.equal(candidate.grammaticalTense, "past-preterite", text);
    }
  }
});

test("no convierte auxiliares y verbos modales excluidos en acciones nuevas", () => {
  for (const text of [
    "Ana fue valiente.",
    "Ana estaba cansada.",
    "Ana pudo escapar.",
    "Ana quiso marcharse."
  ]) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found.length, 0, text);
  }
});

test("conserva el verbo léxico de una perífrasis y no extrae el auxiliar", () => {
  const text = "Ana había llegado al refugio.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.deepEqual(found.map(item => item.action), ["llegar"]);
  assert.equal(found[0].surface, "llegado");
  assert.equal(found[0].grammaticalTense, "participle");
});

