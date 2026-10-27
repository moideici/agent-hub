import fs from 'node:fs';
import path from 'node:path';
import { run, die } from './util.mjs';
import { loadGlobal, loadRepo, GLOBAL_CONFIG } from './config.mjs';
import { loginStatus, limitedUntil, isLoggedIn } from './accounts.mjs';
import { resolveCodex } from './codex.mjs';
import { mainRoot } from './git.mjs';
import { HUB_DIR, HOME, writeJson } from './util.mjs';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function cmdAccounts(opts) {
  const cfg = loadGlobal();
  const rows = cfg.accounts.map((a) => ({
    name: a.name,
    home: a.home,
    loggedIn: isLoggedIn(a),
    status: loginStatus(a),
    limitedUntil: limitedUntil(a.name),
    default: a.name === cfg.defaultAccount,
  }));
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) console.log('Aucun compte Codex trouvé.');
  for (const r of rows) {
    const lim = r.limitedUntil ? `  ⏸ quota jusqu'à ${new Date(r.limitedUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '';
    console.log(`${r.default ? '*' : ' '} ${r.name.padEnd(8)} ${r.status.padEnd(28)} ${r.home}${lim}`);
  }
  console.log(`\nAjouter un compte (OAuth ChatGPT) :
  1. choisis un nom, ex. "c" :  $env:CODEX_HOME="$HOME\\.codex-accounts\\c"; codex login --device-auth
  2. ouvre le lien dans une fenêtre privée avec LE BON compte ChatGPT
  Les dossiers de ~/.codex-accounts/* sont découverts automatiquement.`);
}

export function cmdDoctor(opts) {
  const lines = [];
  const ok = (m) => lines.push(`✔ ${m}`);
  const ko = (m) => lines.push(`✘ ${m}`);
  const node = process.versions.node;
  +node.split('.')[0] >= 20 ? ok(`node ${node}`) : ko(`node ${node} (>= 20 requis)`);
  const g = run('git', ['--version']);
  g.code === 0 ? ok(g.stdout.trim()) : ko('git introuvable');
  const { cmd, pre, shell } = resolveCodex();
  const c = run(cmd, [...pre, '--version'], { shell });
  c.code === 0 ? ok(`codex ${c.stdout.trim()}`) : ko('codex introuvable (npm i -g @openai/codex)');
  const cfg = loadGlobal();
  if (!cfg.accounts.length) ko('aucun compte Codex (lance `ah accounts`)');
  for (const a of cfg.accounts) {
    isLoggedIn(a) ? ok(`compte ${a.name}: ${loginStatus(a)}`) : ko(`compte ${a.name}: non connecté (${a.home})`);
  }
  ok(`dossier du hub: ${HUB_DIR}`);
  const root = mainRoot(path.resolve(opts.repo || process.cwd()));
  if (root) {
    const r = loadRepo(root);
    ok(`dépôt: ${root}`);
    ok(`projet: ${r.detected.kinds.join(', ') || 'type inconnu'} · tests: ${r.test || '(aucun détecté)'}${r.hasConfig ? ' · .agent-hub.json présent' : ''}`);
  } else {
    lines.push('· (pas dans un dépôt git)');
  }
  console.log(lines.join('\n'));
  if (lines.some((l) => l.startsWith('✘'))) process.exit(1);
}

/** ah init : prépare le dépôt courant (.agent-hub.json + AGENTS.md s'ils n'existent pas). */
export function cmdInit(opts) {
  const root = mainRoot(path.resolve(opts.repo || process.cwd()));
  if (!root) die('pas un dépôt git.');
  const r = loadRepo(root);
  const created = [];
  const cfgFile = path.join(root, '.agent-hub.json');
  if (!fs.existsSync(cfgFile)) {
    writeJson(cfgFile, { test: r.test, setup: null, link: r.link, sandbox: 'workspace-write' });
    created.push('.agent-hub.json');
  }
  const agents = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(agents)) {
    const tpl = fs.readFileSync(path.join(TEMPLATES, 'AGENTS.md'), 'utf8').replace('{{TEST}}', r.test || '(à renseigner)');
    fs.writeFileSync(agents, tpl);
    created.push('AGENTS.md');
  }
  console.log(created.length ? `créé: ${created.join(', ')} (à relire puis commiter)` : 'rien à créer, tout existe déjà.');
}

export function cmdConfigPath() {
  console.log(GLOBAL_CONFIG);
}
