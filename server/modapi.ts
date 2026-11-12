import Anthropic from '@anthropic-ai/sdk';
import { architect, NotConnected, type ModRequest } from './architect';

export const MAX_BODY = 16 * 1024;
const MAX_TEXT = 300;
/** Each visitor may ask the Architect this often; every request costs real money. */
const MIN_GAP_MS = Number(process.env.MOD_MIN_GAP_SECONDS ?? 8) * 1000;
/** Ceiling on requests per day across everyone, so a public game cannot run up an unbounded bill. */
const DAILY_LIMIT = Number(process.env.MOD_DAILY_LIMIT ?? 2000);

const lastAsk = new Map<string, number>();
let day = '';
let askedToday = 0;

function parse(body: string): ModRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const r = raw as Partial<ModRequest>;
  if (!r || typeof r.text !== 'string' || !r.text.trim()) return null;
  return {
    text: r.text.trim().slice(0, MAX_TEXT),
    mana: Number.isFinite(r.mana) ? Math.max(0, Math.floor(r.mana as number)) : 0,
    you: String(r.you ?? '').slice(0, 16),
    players: Array.isArray(r.players) ? r.players.slice(0, 16).map((n) => String(n).slice(0, 16)) : [],
    active: Array.isArray(r.active)
      ? r.active.slice(0, 12).map((a) => ({
          name: String(a?.name ?? '').slice(0, 32),
          secondsLeft: Math.max(0, Math.round(Number(a?.secondsLeft) || 0)),
          summary: String(a?.summary ?? '').slice(0, 200),
        }))
      : [],
  };
}

export interface ApiReply {
  status: number;
  body: unknown;
}

/**
 * Answer one POST /api/mod. `who` identifies the caller for rate limiting (their address).
 * The API key stays on this side; the browser only ever sees the finished, priced mod.
 */
export async function handleMod(
  bodyText: string,
  apiKey: string | undefined,
  who: string,
  log: (line: string) => void = console.error,
): Promise<ApiReply> {
  const request = parse(bodyText);
  if (!request) return { status: 400, body: { error: 'Send { text, mana, active }.' } };

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    askedToday = 0;
    lastAsk.clear();
  }
  const wait = MIN_GAP_MS - (now - (lastAsk.get(who) ?? 0));
  if (wait > 0) {
    return {
      status: 429,
      body: { error: 'slow_down', message: `The Architect needs ${Math.ceil(wait / 1000)}s before your next request.` },
    };
  }
  if (askedToday >= DAILY_LIMIT) {
    return { status: 429, body: { error: 'closed', message: 'The Architect has closed for the day.' } };
  }
  lastAsk.set(who, now);
  askedToday++;

  try {
    return { status: 200, body: await architect(request, apiKey) };
  } catch (err) {
    lastAsk.delete(who); // a failed request should not cost them their turn
    if (err instanceof NotConnected) {
      if (err.message) log(`[mod] not connected: ${err.message}`);
      return {
        status: 503,
        body: { error: 'not_connected', message: 'The Architect is offline: no Anthropic API key is set up.' },
      };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { status: 429, body: { error: 'busy', message: 'The Architect is busy. Try again shortly.' } };
    }
    log(`[mod] ${err instanceof Error ? err.message : String(err)}`);
    return { status: 502, body: { error: 'failed', message: 'The Architect could not be reached.' } };
  }
}
