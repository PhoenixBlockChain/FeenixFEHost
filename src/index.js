import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { poll } from './poller.js';

// Load .env manually (no dotenv dependency)
function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv(resolve(process.cwd(), '.env'));

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60000', 10);

async function runPoll() {
  try {
    await poll();
  } catch (err) {
    console.error('[main] Poll cycle failed:', err.message);
  }
}

console.log('=== Feenix FE Host ===');
console.log(`Apps dir:       ${process.env.APPS_DIR || './apps'}`);
console.log(`Poll interval:  ${POLL_INTERVAL / 1000}s`);
console.log(`Blockchain API: ${process.env.BLOCKCHAIN_API_URL || 'http://api.feenix.network'}`);
console.log('');

// Run immediately on startup, then every POLL_INTERVAL
await runPoll();
setInterval(runPoll, POLL_INTERVAL);

console.log(`[main] Polling every ${POLL_INTERVAL / 1000}s. Press Ctrl+C to stop.`);
