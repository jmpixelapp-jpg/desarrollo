import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeInformationConcealmentCandidates as discover } from "../dist/motor-literario.js";
const character=(id,name,aliases=[])=>({projectId:"book",id,kind:"character",canonicalName:name,
 normalizedName:name.toLocaleLowerCase("es"),aliases,evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1});
const entities=[character("ana","Ana",["Anita"]),character("bruno","Bruno"),character("clara","Clara")];
const input=(text,extra={})=>({projectId:"book",documentId:"chapter-1",revision:1,text,entities,...extra});
test("detecta ocultación con actor y destinatario explícitos",()=>{
 const [item]=discover(input("Ana ocultó a Bruno que la carta estaba en el cajón."));
 assert.equal(item.signal,"concealed-proposition");
 assert.equal(item.actorEntityId,"ana");
 assert.equal(item.recipientEntityId,"bruno");
 assert.equal(item.propositionEvidence.excerpt,"la carta estaba en el cajón");
 assert.equal(item.deceptionEstablished,false);
});
test("detecta mentira explícita sin certificar que la afirmación sea falsa",()=>{
 const [item]=discover(input("Ana mintió a Bruno diciendo que Clara había partido."));
 assert.equal(item.signal,"lied-to-recipient");
 assert.equal(item.recipientEntityId,"bruno");
 assert.equal(item.propositionEvidence.excerpt,"Clara había partido");
});
test("detecta fingimiento e inducción explícitos",()=>{
 const results=discover(input("Ana fingió que estaba enferma. Bruno hizo creer a Clara que el tren llegaría."));
 assert.deepEqual(results.map(x=>x.signal),["feigned-proposition","induced-belief"]);
 assert.equal(results[1].recipientEntityId,"clara");
});
test("admite alias confirmados y conserva el fragmento literal",()=>{
 const [item]=discover(input("Anita escondió que la llave estaba rota."));
 assert.equal(item.actorEntityId,"ana");
 assert.equal(item.actorEvidence.excerpt,"Anita");
});
test("no inventa destinatario cuando se usa un pronombre",()=>{
 const [item]=discover(input("Ana ocultó que la carta había llegado."));
 assert.equal(item.recipientEntityId,undefined);
});
test("no atribuye nombres ambiguos entre entidades",()=>{
 const ambiguous=[...entities,character("ana-2","Ana")];
 assert.deepEqual(discover(input("Ana ocultó que la puerta estaba abierta.",{entities:ambiguous})),[]);
});
test("no confunde a la misma persona como actor y destinatario",()=>{
 assert.deepEqual(discover(input("Ana mintió a Ana diciendo que Bruno había vuelto.")),[]);
});
test("rechaza proyectos, entidades y rangos inválidos",()=>{
 assert.throws(()=>discover(input("Ana ocultó que Bruno había vuelto.",{projectId:"other"})));
 assert.throws(()=>discover(input("Ana ocultó que Bruno había vuelto.",{baseOffset:-1})));
});
test("aplica baseOffset a toda la evidencia",()=>{
 const [item]=discover(input("Ana ocultó que Bruno había vuelto.",{baseOffset:400}));
 assert.equal(item.evidence.start,400);
 assert.equal(item.actorEvidence.start,400);
 assert.equal(item.propositionEvidence.start,400+"Ana ocultó que ".length);
});
test("ignora una frase sin verbo explícito de ocultación o engaño",()=>{
 assert.deepEqual(discover(input("Ana sabía que Bruno había vuelto.")),[]);
});

test("preserva negación explícita sin etiquetarla como ocultación afirmada",()=>{
 const [item]=discover(input("Ana no mintió a Bruno diciendo que Clara había partido."));
 assert.equal(item.signal,"lied-to-recipient");
 assert.equal(item.polarity,"negated");
});
test("exige límites de palabra para nombres de personajes",()=>{
 assert.deepEqual(discover(input("Anabel ocultó que la carta llegó.")),[]);
});

test("reconoce fórmulas explícitas de secreto mantenido",()=>{
 const [maintained]=discover(input("Ana mantuvo en secreto que la carta estaba en el cajón."));
 const [guarded]=discover(input("Ana guardó en secreto que Bruno había vuelto."));
 assert.equal(maintained.signal,"concealed-proposition");
 assert.equal(maintained.propositionEvidence.excerpt,"la carta estaba en el cajón");
 assert.equal(guarded.signal,"concealed-proposition");
});
test("reconoce silencio dirigido a un personaje nombrado",()=>{
 const [item]=discover(input("Ana calló ante Bruno que la carta había llegado."));
 assert.equal(item.actorEntityId,"ana");
 assert.equal(item.recipientEntityId,"bruno");
 assert.equal(item.propositionEvidence.excerpt,"la carta había llegado");
});
test("reconoce silenciamiento explícito de una proposición",()=>{
 const [item]=discover(input("Ana silenció que Clara había regresado."));
 assert.equal(item.signal,"concealed-proposition");
 assert.equal(item.propositionEvidence.excerpt,"Clara había regresado");
});
