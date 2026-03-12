import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadState, saveState } from './state.js';
import { extractFrontend } from './extractor.js';

const BLOCKCHAIN_API = process.env.BLOCKCHAIN_API_URL || 'http://api.feenix.network';
const APPS_DIR = process.env.APPS_DIR || './apps';
const STATE_FILE = process.env.STATE_FILE || './state.json';

/**
 * Sanitize app name for use as a DNS subdomain label.
 * - Lowercase
 * - Replace non-alphanumeric with hyphens
 * - Collapse multiple hyphens
 * - Trim hyphens from ends
 * - Max 63 chars (DNS label limit)
 */
function sanitizeSubdomain(appName) {
  return appName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/**
 * Flatten blockchain API response into a flat list of transactions.
 * Handles both block-wrapped and flat formats.
 */
function flattenTransactions(response) {
  const transactions = [];
  if (!Array.isArray(response)) return transactions;

  for (const item of response) {
    if (item && Array.isArray(item.Transactions)) {
      for (const tx of item.Transactions) {
        transactions.push(tx);
      }
    } else if (item) {
      // Flat transaction / projected object
      transactions.push(item);
    }
  }
  return transactions;
}

/**
 * Phase 1: Fetch metadata for all APP_BE transactions.
 * Uses JMESPath projection to avoid downloading huge codebase blobs.
 */
async function fetchMetadata() {
  const query = `[?Body.Data.type=='APP_BE'].{tx_hash: Hash, senderAddr: Body."Sender Address", app_name: Body.Data.app_name, app_description: Body.Data.app_description}`;
  const url = `${BLOCKCHAIN_API}/api/v1/get?lastBlockHash=0&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Metadata fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return flattenTransactions(data);
}

/**
 * Phase 2: Fetch frontend_codebase for a specific transaction hash.
 */
async function fetchFrontendCodebase(txHash) {
  const query = `[?Hash=='${txHash}'].{frontend_codebase: Body.Data.frontend_codebase}`;
  const url = `${BLOCKCHAIN_API}/api/v1/get?lastBlockHash=0&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`Frontend fetch failed for ${txHash}: ${res.status}`);
  const data = await res.json();
  const txs = flattenTransactions(data);
  if (txs.length === 0) return null;
  return txs[0].frontend_codebase || null;
}

/**
 * Resolve subdomain for an app, handling collisions.
 * First-come-first-served: if the clean name is taken by another sender, suffix with short hash.
 */
function resolveSubdomain(appName, senderAddr, state) {
  const clean = sanitizeSubdomain(appName);
  if (!clean) return senderAddr.slice(0, 12); // Fallback if name sanitizes to empty

  const existing = state.subdomains[clean];

  // Clean name available or already owned by this sender
  if (!existing || existing === senderAddr) {
    return clean;
  }

  // Collision — append short sender hash
  const suffix = senderAddr.slice(0, 8).toLowerCase();
  return sanitizeSubdomain(`${clean}-${suffix}`);
}

/**
 * Main poll cycle. Called every POLL_INTERVAL.
 */
export async function poll() {
  const state = loadState(STATE_FILE);

  if (!existsSync(APPS_DIR)) {
    mkdirSync(APPS_DIR, { recursive: true });
  }

  // Phase 1: Get metadata
  console.log('[poll] Fetching app metadata from blockchain...');
  const allTxs = await fetchMetadata();
  console.log(`[poll] Found ${allTxs.length} total APP_BE transaction(s)`);

  // Group by sender, keep latest per sender (last wins = newest)
  const latestBySender = new Map();
  for (const tx of allTxs) {
    const sender = tx.senderAddr || tx.sender_addr;
    if (!sender) continue;
    latestBySender.set(sender, tx);
  }

  console.log(`[poll] ${latestBySender.size} unique app author(s)`);

  let newCount = 0;
  let updateCount = 0;

  for (const [senderAddr, tx] of latestBySender) {
    const txHash = tx.tx_hash;
    const appName = tx.app_name || 'unnamed';
    const existing = state.apps[senderAddr];

    // Skip if already deployed at this version
    if (existing && existing.txHash === txHash) continue;

    const isUpdate = !!existing;
    const subdomain = resolveSubdomain(appName, senderAddr, state);
    const targetDir = join(APPS_DIR, subdomain);

    console.log(`[poll] ${isUpdate ? 'Updating' : 'New app'}: "${appName}" → ${subdomain}.feenix.network`);

    try {
      // Phase 2: Fetch frontend codebase
      const frontendBase64 = await fetchFrontendCodebase(txHash);
      if (!frontendBase64) {
        console.warn(`[poll] No frontend_codebase for "${appName}" (tx: ${txHash})`);
        continue;
      }

      // Extract to target dir
      await extractFrontend(frontendBase64, targetDir);

      // Release old subdomain if name changed — remove stale directory too
      if (existing && existing.subdomain !== subdomain && state.subdomains[existing.subdomain] === senderAddr) {
        const oldDir = join(APPS_DIR, existing.subdomain);
        if (existsSync(oldDir)) {
          rmSync(oldDir, { recursive: true, force: true });
          console.log(`[poll] Removed stale directory for old subdomain: ${existing.subdomain}`);
        }
        delete state.subdomains[existing.subdomain];
      }

      // Update state
      state.apps[senderAddr] = {
        txHash,
        appName,
        subdomain,
        lastUpdated: new Date().toISOString(),
      };
      state.subdomains[subdomain] = senderAddr;
      saveState(STATE_FILE, state);

      if (isUpdate) updateCount++;
      else newCount++;

      console.log(`[poll] Deployed "${appName}" at ${subdomain}.feenix.network`);
    } catch (err) {
      console.error(`[poll] Failed to deploy "${appName}":`, err.message);
    }
  }

  if (newCount || updateCount) {
    console.log(`[poll] Cycle complete: ${newCount} new, ${updateCount} updated`);
  } else {
    console.log(`[poll] No changes detected`);
  }
}
