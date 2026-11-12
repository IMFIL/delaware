import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GameServer } from './game';
import { handleMod, MAX_BODY } from './modapi';

/**
 * Production server: serves the built game, answers the Architect, and runs the
 * multiplayer game, all from one process. All players must reach the same process,
 * so this is deployed as a single instance.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? path.resolve(here, '../dist');
const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Cloud Run's proxy, so req.ip is the visitor's address

const game = new GameServer();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, players: game.playerCount });
});

app.post('/api/mod', express.text({ type: '*/*', limit: MAX_BODY }), async (req, res) => {
  const reply = await handleMod(
    typeof req.body === 'string' ? req.body : '',
    process.env.ANTHROPIC_API_KEY,
    req.ip ?? 'unknown',
  );
  res.status(reply.status).json(reply.body);
});

// Hashed build files never change, so browsers may keep them; the page itself is always re-checked.
app.use('/assets', express.static(path.join(STATIC_DIR, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(STATIC_DIR, { maxAge: '1h', index: 'index.html' }));

const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/game') game.handleUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Delaware listening on :${PORT}, serving ${STATIC_DIR}`);
});

// Cloud Run sends SIGTERM before stopping an instance.
process.on('SIGTERM', () => {
  game.close();
  server.close(() => process.exit(0));
});
