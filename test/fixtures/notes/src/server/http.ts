import { createServer, type ServerResponse } from 'node:http';
import { listNotes } from './notes';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startServer(port: number) {
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'use GET' });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/notes') return sendJson(res, 200, listNotes());
    return sendJson(res, 404, { error: 'not found' });
  }).listen(port);
}
