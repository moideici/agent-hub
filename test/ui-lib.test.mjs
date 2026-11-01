import test from 'node:test';
import assert from 'node:assert/strict';
import {relativeTime,shortPath,groupTasks,sortSessions,agentName,formatDuration,canDispatch} from '../ui/lib.js';
const now=Date.parse('2026-11-01T12:00:00Z');
test('temps relatif : dates absentes, invalides, futures et unités',()=>{
  for(const date of [null,undefined,'','invalide'])assert.equal(relativeTime(date,now),'Date inconnue');
  assert.equal(relativeTime(now,now),'à l’instant');
  assert.equal(relativeTime(now+1000,now),'à l’instant');
  assert.equal(relativeTime(now-180000,now),'il y a 3 min');
  assert.equal(relativeTime(now-7200000,now),'il y a 2 h');
  assert.equal(relativeTime(now-172800000,now),'il y a 2 j');
});
test('noms de chemins POSIX et Windows',()=>{
  assert.equal(shortPath('/home/code/projet/'),'projet');
  assert.equal(shortPath('C:\\code\\projet\\'),'projet');
  for(const p of ['',null,undefined,'/'])assert.equal(shortPath(p),'—');
});
test('colonnes : tous les statuts et dépendances absentes',()=>{
  const tasks=['todo','claimed','running','review','done','blocked','failed'].map((status,i)=>({id:i,status}));
  const result=groupTasks(tasks);
  assert.deepEqual(Object.values(result).map(x=>x.length),[1,2,1,1,2]);
  assert.equal(result.todo[0],tasks[0]);
  assert.deepEqual(groupTasks().todo,[]);
});
test('sessions : en cours puis activité décroissante, sans mutation',()=>{
  const items=[{id:1,status:'idle',lastActivityAt:now},{id:2,status:'running',lastActivityAt:null},{id:3,status:'running',lastActivityAt:now-1000},{id:4,status:'idle',lastActivityAt:null}];
  assert.deepEqual(sortSessions(items).map(s=>s.id),[3,2,1,4]);assert.equal(items[0].id,1);assert.deepEqual(sortSessions(),[]);
});
test('noms lisibles et agents inconnus',()=>{
  assert.equal(agentName('claude:1',[{id:'claude:1',title:'Refonte'}]),'Refonte');
  assert.equal(agentName('claude:absent'),'claude:absent');assert.equal(agentName(null),'Non assignée');
  assert.equal(agentName('*'),'Tous');assert.equal(agentName('user'),'Vous');assert.equal(agentName('codex:a'),'Codex A');
  assert.equal(agentName('codex:b',[],[{id:'codex:b',name:'Travail'}]),'Travail');
});
test('durées : limites et valeurs invalides',()=>{
  for(const n of [null,undefined,-1,NaN,Infinity])assert.equal(formatDuration(n),'—');
  assert.equal(formatDuration(0),'0 s');assert.equal(formatDuration(59.9),'59 s');assert.equal(formatDuration(61),'1 min 1 s');assert.equal(formatDuration(3661),'1 h 1 min');
});
test('lancement : projet, statut, compte, quota et concurrence',()=>{
  const task={status:'todo',project:'/repo'};
  const state={accounts:[{id:'codex:a',loggedIn:true}],runs:[],limits:{maxParallelCodex:2}};
  assert.deepEqual(canDispatch(task,state,'a',now),{ok:true,raison:''});
  for(const invalid of [null,{...task,project:''},{...task,project:'  '},{...task,status:'running'},{...task,status:'review'},{...task,status:'done'}])assert.equal(canDispatch(invalid,state).ok,false);
  assert.equal(canDispatch(task,state,'b').ok,false);
  assert.equal(canDispatch(task,{...state,accounts:[{id:'codex:a',loggedIn:false}]}).ok,false);
  assert.equal(canDispatch(task,{...state,accounts:[{id:'codex:a',loggedIn:true,limitedUntil:now+1000}]},'a',now).ok,false);
  assert.equal(canDispatch(task,{...state,accounts:[{id:'codex:a',loggedIn:true,limitedUntil:now-1000}]},'a',now).ok,true);
  assert.equal(canDispatch(task,{...state,runs:[{status:'running'},{status:'running'}]}).ok,false);
  assert.equal(canDispatch(task,{...state,runs:[{status:'completed'}]}).ok,true);
  assert.ok(canDispatch(null,state).raison);
});
