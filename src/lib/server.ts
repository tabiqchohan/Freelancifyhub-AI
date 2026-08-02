import { createServer } from 'node:http';
import type { Server } from 'node:http';

export function createAppServer(): Server {
  return createServer((req, res) => {
    const isHealthCheck = req.url === '/healthz' || req.url === '/health';

    res.writeHead(isHealthCheck ? 200 : 404, {
      'Content-Type': 'application/json',
    });

    res.end(
      JSON.stringify(
        isHealthCheck ? { status: 'ok', uptime: process.uptime() } : { status: 'not_found' },
      ),
    );
  });
}
