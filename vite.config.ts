import { defineConfig, loadEnv } from 'vite';
import { gameServer } from './server/plugin';

export default defineConfig(({ mode }) => {
  // Reads ANTHROPIC_API_KEY from .env.local (never sent to the browser).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [gameServer(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)],
    build: { target: 'es2022' },
  };
});
