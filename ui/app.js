import {relativeTime, shortPath, columns, groupTasks, sortSessions, agentName, formatDuration, canDispatch} from './lib.js';
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls) => { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', action); return b; };
const label = (text, input) => { const l = el('label', text); l.append(input); return l; };
const field = (tag = 'input', value = '') => { const n = el(tag); n.value = value; return n; };
const statuses = {todo:'À faire', claimed:'Prise en charge', running:'En cours', review:'À relire', done:'Terminée', blocked:'Bloquée', failed:'Échec', completed:'Terminé', idle:'Inactive', stale:'Interrompu', limited:'Quota atteint', timeout:'Délai dépassé'};
let state = {sessions:[], accounts:[], runs:[], tasks:[], messages:[], limits:{}};
let followMessages = true, messageScroll = 0;
$('messages').addEventListener('scroll',()=>{if($('messages-view').hidden)return;const n=$('messages');messageScroll=n.scrollTop;followMessages=n.scrollHeight-n.scrollTop-n.clientHeight<60;});
const name = id => agentName(id, state.sessions, state.accounts);
const noteText = n => typeof n === 'string' ? n : n?.note || '';
const clock = t => t && Number.isFinite(new Date(t).getTime()) ? new Date(t).toLocaleString('fr-FR') : '—';
function error(e) { $('toast').firstElementChild.textContent = e.message || String(e); $('toast').hidden = false; }
$('toast').lastElementChild.onclick = () => { $('toast').hidden = true; };
async function api(path, method = 'GET', body, raw = false) {
  const response = await fetch(path, {method, credentials:'same-origin', ...(body !== undefined ? {headers:{'content-type':'application/json'}, body:JSON.stringify(body)} : {})});
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || text || `Erreur HTTP ${response.status}`);
  return raw ? text : data;
}
async function write(path, method, data) { await api(path, method, data); await refresh(); }
function select(options, value = '') { const s = el('select'); for (const [id,text] of options) { const o = el('option',text); o.value = id; s.append(o); } s.value = value; return s; }
function agentOptions(all = false) { return [[all ? '*' : '',all ? 'Tous' : 'Aucun'], ['codex:a',name('codex:a')], ['codex:b',name('codex:b')], ...state.sessions.map(s => [s.id,s.title || s.id])]; }
function syncOptions(s, options) {
  const key = JSON.stringify(options); if (s.dataset.options === key) return;
  const previous = s.value; s.replaceChildren(); for (const [id,text] of options) { const o = el('option',text); o.value=id; s.append(o); }
  if (options.some(([id]) => id === previous)) s.value=previous;
  s.dataset.options=key;
}
const hashes = new Map();
function block(id, data, render) { const key = JSON.stringify(data); if (hashes.get(id) === key) return; hashes.set(id,key); render($(id)); }
function empty(node, text) { node.append(el('p',text,'empty')); }
function badge(status) { return el('span', statuses[status] || status || 'Inconnu', `badge ${status || ''}`); }
function tests(t) { return !t || t.skipped || !t.cmd ? 'Tests non lancés' : t.passed ? 'Tests OK' : 'Tests en échec'; }
function sessionList() {
  const query = $('filter').value.toLocaleLowerCase('fr');
  block('sessions', [state.sessions,query], node => { node.replaceChildren();
    for (const s of sortSessions(state.sessions).filter(s => `${s.title} ${s.cwd}`.toLocaleLowerCase('fr').includes(query))) {
      const b = button('', () => openDetail('session',s.id),'card'); b.append(el('strong',s.title || s.id));
      const meta = el('div',null,'meta'); if(s.status === 'running') meta.append(el('span',null,'dot'));
      meta.append(document.createTextNode(`${shortPath(s.cwd)} · ${statuses[s.status] || s.status} · ${relativeTime(s.lastActivityAt)}`)); b.append(meta);
      if(s.now) { const n = el('div',s.now,'truncate'); n.title=s.now; b.append(n); }
      if(s.note) b.append(el('div',noteText(s.note),'meta prose')); node.append(b);
    } if(!node.children.length) empty(node,'Aucune session');
  });
}
function render() {
  $('counters').textContent = `${state.sessions.filter(s=>s.status==='running').length} sessions actives · ${state.runs.filter(r=>r.status==='running').length} runs Codex en cours · ${state.tasks.filter(t=>t.status!=='done').length} tâches ouvertes`;
  sessionList();
  block('accounts',state.accounts,node=>{node.replaceChildren(); for(const a of state.accounts){const c=el('div',null,'card'); c.append(el('strong',a.name),el('div',`${a.loggedIn?'Connecté':'Déconnecté'} · ${a.running || 0} runs en cours`,'meta')); if(a.limitedUntil) c.append(el('div',`Quota atteint jusqu’au ${clock(a.limitedUntil)}`,'limited')); if(a.note)c.append(el('div',noteText(a.note),'prose')); node.append(c);} if(!node.children.length)empty(node,'Aucun compte');});
  block('runs',state.runs,node=>{node.replaceChildren(); for(const r of [...state.runs].sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt)).slice(0,8)){const b=button('',()=>openDetail('run',r.id),'card');b.append(el('strong',r.title || r.id),badge(r.status),el('div',`${name(`codex:${r.account}`)} · ${formatDuration(r.durationSec ?? (r.status==='running'?(Date.now()-new Date(r.startedAt))/1000:null))}`,'meta'));if(r.changes)b.append(el('div',`+${r.changes.added}/-${r.changes.deleted} · ${r.changes.files} fichiers`,'meta'));b.append(el('div',tests(r.tests),'meta'));node.append(b);}if(!node.children.length)empty(node,'Aucun run');});
  block('board',[state.tasks,state.sessions,state.accounts],node=>{node.replaceChildren();const groups=groupTasks(state.tasks); for(const c of columns){const col=el('section',null,'column');col.dataset.column=c.id;col.append(el('h2',`${c.label} · ${groups[c.id].length}`));for(const t of groups[c.id]){const b=button('',()=>openDetail('task',t.id),'card');b.append(el('div',`${t.id} · Priorité ${t.priority ?? 0}`,'meta'),el('strong',t.title),el('div',name(t.assignee),'meta'),el('div',shortPath(t.project),'meta')); if(t.deps?.length)b.append(el('div',`Dépendances : ${t.deps.join(', ')}`,'meta')); col.append(b);}if(!groups[c.id].length)empty(col,'Aucune tâche');node.append(col);}});
  block('messages',[state.messages,state.sessions,state.accounts],node=>{node.replaceChildren();for(const m of [...state.messages].sort((a,b)=>new Date(a.ts)-new Date(b.ts))){const row=el('article',null,`message ${m.kind==='event'?'event':''}`);row.append(el('div',`${name(m.from)} → ${name(m.to)} · ${clock(m.ts)}`,'meta'));if(m.taskId)row.append(button(m.taskId,()=>openDetail('task',m.taskId)));row.append(el('p',m.body,'prose'));node.append(row);}if(!node.children.length)empty(node,'Aucun message');if(!$('messages-view').hidden)node.scrollTop=followMessages?node.scrollHeight:messageScroll;});
  for(const s of document.querySelectorAll('[data-agent-options]')) syncOptions(s,agentOptions(s.dataset.agentOptions==='all'));
  for(const s of document.querySelectorAll('[data-task-options]')) syncOptions(s,[['','Aucune tâche liée'],...state.tasks.map(t=>[t.id,`${t.id} · ${t.title}`])]);
  updatePanel();
}
$('filter').oninput=sessionList;
let messageForm;
function composer(to) {
  const form=el('form'); const recipient=select(agentOptions(true),to || '*'); if(to)recipient.disabled=true;else recipient.dataset.agentOptions='all';
  const body=field('textarea'); body.required=true; body.placeholder='Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne';
  const task=select([['','Aucune tâche liée'],...state.tasks.map(t=>[t.id,`${t.id} · ${t.title}`])]);task.dataset.taskOptions='true';
  form.append(label('Destinataire',recipient),label(to?'Écrire à cette session':'Message',body),label('Tâche liée (facultative)',task));const send=el('button','Envoyer','primary');send.type='submit';form.append(send);
  form.onsubmit=async e=>{e.preventDefault();if(!body.value.trim())return;send.disabled=true;try{await write('/api/messages','POST',{to:to || recipient.value,body:body.value,taskId:task.value || null});body.value='';}catch(e){error(e);}finally{send.disabled=false;}};
  body.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit();}};return form;
}
messageForm=composer();$('composer').append(messageForm);
for(const view of ['tasks','messages']) $(`${view}-tab`).onclick=()=>{for(const v of ['tasks','messages']){$(`${v}-view`).hidden=v!==view;$(`${v}-tab`).setAttribute('aria-pressed',String(v===view));}if(view==='messages')$('messages').scrollTop=followMessages?$('messages').scrollHeight:messageScroll;};
const dialog=$('detail');let panel=null, panelVersion=0, returnFocus=null;
function closeDetail(){dialog.close();}
$('close-detail').onclick=closeDetail;
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDetail();}});
dialog.addEventListener('close',()=>{panel=null;panelVersion++;document.body.append($('toast'));returnFocus?.focus();});
function begin(title){if(!dialog.open)returnFocus=document.activeElement;panelVersion++;$('detail-title').textContent=title;$('detail-body').replaceChildren();dialog.append($('toast'));if(!dialog.open)dialog.showModal();return $('detail-body');}
function metadata(node, pairs){node.replaceChildren();for(const [key,value] of pairs){node.append(el('dt',key),el('dd',value==null?'—':typeof value==='object'?JSON.stringify(value,null,2):String(value)));}}
function safeAction(b, action){b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){error(e);}finally{if(b.isConnected)b.disabled=false;}};}
function openDetail(kind,id){const body=begin(kind==='session'?'Session Claude':kind==='run'?'Run Codex':'Tâche');panel={kind,id};const meta=el('dl');body.append(meta);panel.meta=meta;
  if(kind==='session'){const transcript=el('div',null,'transcript');body.append(el('h3','Fil récent'),transcript,composer(id));panel.transcript=transcript;}
  if(kind==='run'){const content=el('div');body.append(content);panel.content=content;}
  if(kind==='task'){buildTaskPanel(body);}
  updatePanel();
}
function buildTaskPanel(body){
  const status=select(Object.entries(statuses).filter(([s])=>['todo','claimed','running','review','done','blocked','failed'].includes(s)));
  const assignee=select(agentOptions());assignee.dataset.agentOptions='single';const save=button('Enregistrer');
  safeAction(save,async()=>{await write(`/api/tasks/${encodeURIComponent(panel.id)}`,'PATCH',{status:status.value,assignee:assignee.value || null});});
  const note=field('textarea');const add=button('Ajouter une note');safeAction(add,async()=>{if(!note.value.trim())return;await write(`/api/tasks/${encodeURIComponent(panel.id)}`,'PATCH',{note:note.value});note.value='';});
  const notes=el('div');const account=select([['a','Compte A'],['b','Compte B']],'a');const launch=button('Lancer sur ChatGPT',null,'primary');const reason=el('p',null,'meta');
  const run=button('Ouvrir le run associé',()=>{const t=state.tasks.find(t=>t.id===panel.id);if(t?.runId)openDetail('run',t.runId);});
  body.append(label('Statut',status),label('Assignée à',assignee),save,run,el('h3','Notes'),notes,label('Nouvelle note',note),add,el('h3','Lancement ChatGPT'),label('Compte',account),reason,launch);
  Object.assign(panel,{status,assignee,notes,account,launch,reason,run}); account.onchange=updateDispatch;
  launch.onclick=async()=>{const p=panel;const t=state.tasks.find(t=>t.id===p.id);const allowed=canDispatch(t,state,p.account.value);if(!allowed.ok){error(new Error(allowed.raison));return;}if(!window.confirm('Cela consomme du quota ChatGPT. Confirmer le lancement de cette tâche ?'))return;p.busy=true;updateDispatch();try{await write(`/api/tasks/${encodeURIComponent(p.id)}/dispatch`,'POST',{account:p.account.value});}catch(e){error(e);}finally{p.busy=false;if(panel===p)updateDispatch();}};
}
function updateDispatch(){if(panel?.kind!=='task')return;const p=panel,t=state.tasks.find(t=>t.id===p.id);for(const o of p.account.options){const a=state.accounts.find(a=>a.id===`codex:${o.value}`);o.disabled=!a||!a.loggedIn||new Date(a.limitedUntil).getTime()>Date.now();}const result=canDispatch(t,state,p.account.value);p.launch.disabled=p.busy||!result.ok;p.reason.textContent=p.busy?'Lancement en cours…':result.raison || 'Une confirmation sera demandée avant de consommer du quota.';}
function detailKey(p) {
  if(p.kind==='session') { const {now,...content}=state; return JSON.stringify(content); }
  return JSON.stringify(state.runs.find(r=>r.id===p.id));
}
async function updatePanel(){
  if(!panel || panel.kind==='new')return;const p=panel,version=panelVersion;
  if(p.kind==='task'){const t=state.tasks.find(t=>t.id===p.id);if(!t){p.meta.textContent='Tâche introuvable';return;}
    const key=JSON.stringify(t);if(p.key!==key){p.key=key;const labels={id:'Identifiant',title:'Titre',brief:'Détail',project:'Projet',status:'Statut',assignee:'Assignée à',createdBy:'Créée par',deps:'Dépendances',priority:'Priorité',runId:'Run associé',createdAt:'Création',updatedAt:'Mise à jour'};metadata(p.meta,Object.entries(t).filter(([k])=>k!=='notes').map(([k,v])=>[labels[k] || k,k==='assignee'||k==='createdBy'?name(v):k==='status'?statuses[v] || v:v]));p.notes.replaceChildren();for(const n of t.notes || [])p.notes.append(el('p',`${name(n.by)} · ${clock(n.ts)}\n${n.text}`,'prose'));if(!p.notes.children.length)empty(p.notes,'Aucune note');if(!p.initialized){p.status.value=t.status;p.assignee.value=t.assignee || '';p.initialized=true;}p.run.hidden=!t.runId;}updateDispatch();return;
  }
  const data=p.kind==='session'?state.sessions.find(s=>s.id===p.id):state.runs.find(r=>r.id===p.id);
  if(p.kind==='session'&&data&&p.metaKey!==JSON.stringify(data)){p.metaKey=JSON.stringify(data);metadata(p.meta,[['Titre',data.title],['Dossier',data.cwd],['Modèle',data.model],['Tours',data.completedTurns],['Statut',statuses[data.status] || data.status],['Lien (copiable)',data.link]]);}
  const key=detailKey(p);if(p.key===key||p.loading)return;p.key=key;p.loading=true;
  try{const result=await api(p.kind==='session'?`/api/sessions/${encodeURIComponent(p.id)}/tail?n=60`:`/api/runs/${encodeURIComponent(p.id)}`);if(panel!==p||version!==panelVersion)return;
    if(p.kind==='session'){const entriesKey=JSON.stringify(result.entries);if(p.entriesKey===entriesKey)return;p.entriesKey=entriesKey;const n=p.transcript;const top=n.scrollTop;const bottom=n.scrollHeight-top-n.clientHeight<60;n.replaceChildren();for(const entry of result.entries || []){const row=el('article',null,'message');row.append(el('strong',`${({user:'Utilisateur',assistant:'Assistant',tool:'Outil'})[entry.role] || entry.role}${entry.name?` · ${entry.name}`:''}`),el('div',clock(entry.ts),'meta'),el('p',entry.text,'prose'));n.append(row);}if(!n.children.length)empty(n,'Aucun échange récent');n.scrollTop=bottom?n.scrollHeight:top;}
    else{metadata(p.meta,[['Identifiant',result.id],['Titre',result.title],['Statut',statuses[result.status] || result.status],['Compte',result.account],['Durée',formatDuration(result.durationSec)],['Tests',tests(result.tests)],['Résultat des tests',result.tests],['Résumé',result.summary],['Dernier message',result.lastMessage],['Erreurs',result.errors]]);if(!p.content.children.length){const diff=el('pre',null,'diff');diff.hidden=true;const show=button('Voir le diff');safeAction(show,async()=>{const patch=await api(`/api/runs/${encodeURIComponent(p.id)}/diff`,'GET',undefined,true);diff.replaceChildren();for(const line of patch.split('\n'))diff.append(el('span',line,line.startsWith('+')?'added':line.startsWith('-')?'deleted':''));diff.hidden=false;});const copy=button('Copier la commande de fusion');safeAction(copy,async()=>{await navigator.clipboard.writeText(`ah merge ${p.id}`);copy.textContent='Commande copiée';});p.content.append(show,copy,diff);}}
  }catch(e){p.key=null;error(e);}finally{p.loading=false; if(p.key!==null&&panel===p&&detailKey(p)!==key)updatePanel();}
}
$('new-task').onclick=()=>{const body=begin('Nouvelle tâche');panel={kind:'new'};const form=el('form'),title=field(),brief=field('textarea'),project=field(),assignee=select(agentOptions()),priority=select([['0','0'],['1','1'],['2','2'],['3','3']],'0');title.required=true;project.placeholder='Chemin local du dépôt git';assignee.dataset.agentOptions='single';form.append(label('Titre (requis)',title),label('Détail',brief),label('Projet',project),label('Assignée à',assignee),label('Priorité',priority));const deps=el('fieldset');deps.append(el('legend','Dépendances'));for(const t of state.tasks.filter(t=>t.status!=='done')){const c=field();c.type='checkbox';c.value=t.id;const l=label(`${t.id} · ${t.title}`,c);l.className='check';deps.append(l);}if(deps.children.length===1)empty(deps,'Aucune tâche ouverte');form.append(deps);const submit=el('button','Créer la tâche','primary');submit.type='submit';form.append(submit);form.onsubmit=async e=>{e.preventDefault();if(!title.value.trim())return;submit.disabled=true;try{await write('/api/tasks','POST',{title:title.value.trim(),brief:brief.value,project:project.value.trim(),assignee:assignee.value || null,priority:Number(priority.value),deps:[...deps.querySelectorAll('input:checked')].map(c=>c.value)});closeDetail();}catch(e){error(e);}finally{submit.disabled=false;}};body.append(form);};
let inFlight=false, pending=false, lastLoad=0, reloadTimer, fallback;
async function refresh(){if(inFlight){pending=true;return;}inFlight=true;lastLoad=Date.now();try{const next=await api('/api/state');state={...state,...next};render();}catch(e){error(e);}finally{inFlight=false;if(pending){pending=false;schedule();}}}
function schedule(){if(reloadTimer)return;reloadTimer=setTimeout(()=>{reloadTimer=null;refresh();},Math.max(0,400-(Date.now()-lastLoad)));}
function connection(connected){$('connection').textContent=connected?'Connecté':'Reconnexion · actualisation toutes les 5 s';$('connection').classList.toggle('connected',connected);if(connected){clearInterval(fallback);fallback=null;}else if(!fallback)fallback=setInterval(schedule,5000);}
refresh();
if(typeof EventSource!=='undefined'){const events=new EventSource('/api/events');events.onopen=()=>connection(true);events.onmessage=schedule;events.onerror=()=>connection(false);}else connection(false);
if(matchMedia('(max-width: 680px)').matches)document.querySelector('aside details').open=false;
