// Runs the real app server (berlin-divided/server.js: static files, byte ranges, group WebSocket)
// on a free port for the tests.
import { createRequire } from 'node:module';
import path from 'node:path';

export function start(root) {
  const { createServer } = createRequire(import.meta.url)(path.join(root, 'server.js'));
  const server = createServer();
  return new Promise(ok => server.listen(0, '127.0.0.1', () =>
    ok({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}
