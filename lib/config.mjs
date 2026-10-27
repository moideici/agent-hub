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

export function loadGlobal() {
  const user = readJson(GLOBAL_CONFIG, {}) || {};
  const accounts = (user.accounts?.length ? user.accounts : discoverAccounts()).map((a) => ({
    name: a.name,
    home: path.resolve(expandHome(a.home)),
  }));
  return {
    accounts,
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
