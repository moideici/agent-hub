import fs from 'node:fs';
import path from 'node:path';
import { HUB_DIR, HOME, expandHome, readJson } from './util.mjs';
import { detectProject } from './detect.mjs';

export const GLOBAL_CONFIG = path.join(HUB_DIR, 'config.json');
export const STATE_FILE = path.join(HUB_DIR, 'state.json');

/**
 * Comptes Codex = un dossier CODEX_HOME par compte ChatGPT (login OAuth).
 * Sans config, on découvre : ~/.codex => "a", ~/.codex-accounts/<nom> => "<nom>".
 */
function discoverAccounts() {
  const list = [];
  if (fs.existsSync(path.join(HOME, '.codex', 'auth.json'))) {
    list.push({ name: 'a', home: path.join(HOME, '.codex') });
  }
  const dir = path.join(HOME, '.codex-accounts');
  if (fs.existsSync(dir)) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) list.push({ name: d.name, home: path.join(dir, d.name) });
    }
  }
  return list;
}

/**
 * Modèle local (Ollama) déclaré dans ~/.agent-hub/config.json -> "local": [{ name, model, base, role, ctx, think, ... }].
 * Agent d'identifiant `ollama:<name>`. Les valeurs par défaut conviennent à un petit modèle de code (voir docs/OLLAMA.md).
 */
export function normalizeLocal(l) {
  const name = String(l.name);
  return {
    name,
    id: `ollama:${name}`,
    kind: 'ollama',
    label: l.label || `Ollama ${name}`,
    model: l.model, // étiquette Ollama utilisée pour les runs (ex. bonsai-code:9b)
    base: l.base || null, // modèle de départ dont `ah ollama setup` dérive `model`
    host: l.host || 'http://127.0.0.1:11434',
    role: l.role || 'coder', // coder = ouvrier rapide ; reviewer = relecture et tâches plus dures
    ctx: l.ctx ?? 32768,
    think: l.think, // false | true | "low" | "medium" | "high" (selon le modèle) ; absent = valeur du modèle
    temperature: l.temperature ?? 0.3,
    topP: l.topP ?? 0.9,
    topK: l.topK ?? 20,
    presencePenalty: l.presencePenalty ?? 0,
    numPredict: l.numPredict ?? 4096,
    maxSteps: l.maxSteps ?? 40,
    stepTimeoutSec: l.stepTimeoutSec ?? 600,
    timeoutMin: l.timeoutMin ?? 45,
    keepAlive: l.keepAlive ?? '30m',
    fixAttempts: l.fixAttempts ?? 2,
    protectTests: l.protectTests ?? true, // les fichiers de test existants sont en lecture seule pour l'agent
    noVision: l.noVision ?? false, // dérivé sans le module vision (économise de la VRAM)
    vramMiB: l.vramMiB ?? null, // VRAM estimée nécessaire : le planificateur attend qu'elle soit libre
  };
}

export function loadGlobal() {
  const user = readJson(GLOBAL_CONFIG, {}) || {};
  const accounts = (user.accounts?.length ? user.accounts : discoverAccounts()).map((a) => ({
    name: a.name,
    home: path.resolve(expandHome(a.home)),
  }));
  // AH_LOCAL_OVERRIDE='{"think":true,"ctx":16384,"model":"…"}' : réglages d'essai appliqués à tous les modèles locaux (ah bench --set …)
  let override = {};
  try {
    override = process.env.AH_LOCAL_OVERRIDE ? JSON.parse(process.env.AH_LOCAL_OVERRIDE) : {};
  } catch {
    /* ignoré : un essai mal formé ne doit pas casser le hub */
  }
  const local = (user.local || []).filter((l) => l?.name && l?.model).map((l) => normalizeLocal({ ...l, ...override }));
  return {
    accounts,
    local,
    localMaxParallel: user.localMaxParallel ?? 1, // la carte est partagée : un seul run local à la fois
    fixAttempts: user.fixAttempts,
    defaultAccount: user.defaultAccount || accounts[0]?.name || null,
    // Bascule automatique vers un autre compte quand le quota est atteint (uniquement avec --acct auto).
    autoRotate: user.autoRotate ?? false,
    model: user.model || null,
    effort: user.effort || null,
    timeoutMin: user.timeoutMin ?? 30,
    testTimeoutMin: user.testTimeoutMin ?? 15,
    useUserConfig: user.useUserConfig ?? false,
    windowsSandbox: user.windowsSandbox || 'auto',
  };
}

/** Config optionnelle d'un projet : <repo>/.agent-hub.json. Tout est auto-détecté sinon. */
export function loadRepo(root) {
  const user = readJson(path.join(root, '.agent-hub.json'), {}) || {};
  const detected = detectProject(root);
  return {
    test: user.test === undefined ? detected.test : user.test, // null/"" = pas de tests
    setup: user.setup ?? null,
    link: user.link ?? detected.link,
    sandbox: user.sandbox || 'workspace-write',
    detected,
    hasConfig: fs.existsSync(path.join(root, '.agent-hub.json')),
  };
}
