import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import { GameServer } from './game';
import { handleMod, MAX_BODY } from './modapi';

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * In development the Vite server also plays the part of the game server:
 * it answers POST /api/mod and accepts multiplayer connections on /game.
 * In production `server/index.ts` does the same job on its own.
 */
export function gameServer(apiKey: string | undefined): Plugin {
  return {
    name: 'delaware-game-server',
    configureServer(server) {
      const game = new GameServer();
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.split('?')[0] === '/game') game.handleUpgrade(req, socket, head);
      });
      server.httpServer?.on('close', () => game.close());

      server.middlewares.use('/api/mod', async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        };
        if (req.method !== 'POST') return send(405, { error: 'POST only' });
        try {
          const reply = await handleMod(
            await readBody(req),
            apiKey,
            req.socket.remoteAddress ?? 'local',
            (line) => server.config.logger.error(line),
          );
          send(reply.status, reply.body);
        } catch {
          send(400, { error: 'Bad request.' });
        }
      });
    },
  };
}
