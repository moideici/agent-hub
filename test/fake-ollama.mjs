// Faux serveur Ollama pour tester l'agent local sans modèle ni carte graphique.
// Les réponses de /api/chat sont lues dans un scénario : chaque entrée est un objet message ou une fonction (corps de la requête) -> message.
import http from 'node:http';

/** Appel d'outil tel que le renvoie Ollama. */
export const call = (name, args = {}) => ({ function: { name, arguments: args } });

/** Message d'assistant contenant des appels d'outils (ou du texte). */
export const say = (content, ...calls) => ({ content, tool_calls: calls });

export async function startFakeOllama({ script = [], models = ['fake:1b'], delayMs = 0 } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/api/version') return send(200, { version: '0.40.16' });
    if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: models.map((name) => ({ name })) });
    if (req.method === 'GET' && req.url === '/api/ps') return send(200, { models: [] });
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        requests.push(parsed);
        const entry = script[n++];
        const message = typeof entry === 'function' ? entry(parsed, n - 1) : entry || say('', call('finish', { summary: 'fin du scénario' }));
        const reply = () => send(200, { model: parsed.model, message: { role: 'assistant', ...message }, done: true, prompt_eval_count: 100, eval_count: 20, eval_duration: 1e9, load_duration: 5e8 });
        delayMs ? setTimeout(reply, delayMs) : reply();
      });
      return;
    }
    send(404, { error: 'route inconnue' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  return {
    host,
    requests,
    calls: () => n,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
