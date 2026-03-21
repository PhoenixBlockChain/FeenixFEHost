import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadState, saveState } from './state.js';
import { extractFrontend } from './extractor.js';

const BLOCKCHAIN_API = process.env.BLOCKCHAIN_API_URL || 'http://api.feenix.network';
const MIDDLEWARE_API = process.env.MIDDLEWARE_API_URL || 'https://middleware.feenix.network';
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
      const height = item.Height ?? 0;
      for (const tx of item.Transactions) {
        transactions.push({ ...tx, _height: height });
      }
    } else if (item) {
      // Flat transaction / projected object
      transactions.push({ ...item, _height: item.Height ?? 0 });
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
 * Resolve a sender's public key to a Feenix username via middleware.
 */
async function getUsername(senderAddr) {
  const pk = encodeURIComponent(senderAddr);
  const url = `${MIDDLEWARE_API}/get-username?pk=${pk}`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.username || null;
  } catch {
    return null;
  }
}

/**
 * Check if a backend host is running for the given app author username.
 * Returns true only if /find-hosts returns a non-localhost HostURL
 * that actually responds to requests.
 */
async function isBackendRunning(username) {
  // Step 1: Ask middleware for hosts
  const findUrl = `${MIDDLEWARE_API}/find-hosts?username=${encodeURIComponent(username)}&num_hosts=1`;
  let hosts;
  try {
    const res = await fetch(findUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    hosts = await res.json();
  } catch {
    return false;
  }

  if (!Array.isArray(hosts) || hosts.length === 0) return false;

  const hostUrl = hosts[0].HostURL;
  if (!hostUrl) return false;

  // Step 2: Reject localhost URLs
  try {
    const parsed = new URL(hostUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      console.log(`[poll] Backend for "${username}" is localhost (${hostUrl}) — skipping`);
      return false;
    }
  } catch {
    return false;
  }

  // Step 3: Verify the host is actually responding
  try {
    await fetch(hostUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    // Any response (even 404) means the server is running at that port
    return true;
  } catch {
    console.log(`[poll] Backend for "${username}" at ${hostUrl} is not responding — skipping`);
    return false;
  }
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

  // Keep the newest tx per sender (highest block height wins)
  const latestBySender = new Map();
  for (const tx of allTxs) {
    const sender = tx.senderAddr || tx.sender_addr;
    if (!sender) continue;
    const prev = latestBySender.get(sender);
    if (!prev || tx._height > prev._height) {
      latestBySender.set(sender, tx);
    }
  }

  console.log(`[poll] ${latestBySender.size} unique app author(s)`);

  let newCount = 0;
  let updateCount = 0;

  for (const [senderAddr, tx] of latestBySender) {
    const txHash = tx.tx_hash;
    const appName = tx.app_name || 'unnamed';
    const existing = state.apps[senderAddr];

    // Skip if already deployed at this version
    if (existing && existing.txHash === txHash && existing.deployed) continue;

    // "pending" = we know about this tx but backend wasn't ready yet
    const isPending = existing && existing.txHash === txHash && !existing.deployed;
    // "update" = deployed at an older txHash — needs delist
    const isUpdate = existing && existing.deployed && existing.txHash !== txHash;

    const subdomain = resolveSubdomain(appName, senderAddr, state);
    const targetDir = join(APPS_DIR, subdomain);

    try {
      // On update: immediately delist — remove files and clear from state entirely
      if (isUpdate) {
        const oldSubdomain = existing.subdomain;
        const oldDir = join(APPS_DIR, oldSubdomain);
        if (existsSync(oldDir)) {
          rmSync(oldDir, { recursive: true, force: true });
        }
        if (state.subdomains[oldSubdomain] === senderAddr) {
          delete state.subdomains[oldSubdomain];
        }
        delete state.apps[senderAddr];
        saveState(STATE_FILE, state);
        console.log(`[poll] Delisted "${appName}" at ${oldSubdomain}.feenix.network — waiting for backend`);
      }

      if (!isPending) {
        console.log(`[poll] ${isUpdate ? 'Re-listing' : 'New app'}: "${appName}" → ${subdomain}.feenix.network`);
      }

      // Verify backend is running before hosting frontend
      const username = await getUsername(senderAddr);
      if (!username) {
        console.warn(`[poll] Could not resolve username for "${appName}" — skipping`);
        continue;
      }

      const backendUp = await isBackendRunning(username);
      if (!backendUp) {
        // Save as pending so we don't re-log "New app" every cycle
        if (!isPending) {
          console.log(`[poll] No running backend for "${appName}" (author: ${username}) — waiting`);
          state.apps[senderAddr] = {
            txHash,
            appName,
            subdomain,
            deployed: false,
            lastUpdated: new Date().toISOString(),
          };
          saveState(STATE_FILE, state);
        } else {
          console.log(`[poll] Still waiting for backend: "${appName}" (author: ${username})`);
        }
        continue;
      }

      console.log(`[poll] Backend confirmed for "${appName}" (author: ${username})`);

      // Fetch frontend codebase
      const frontendBase64 = await fetchFrontendCodebase(txHash);
      if (!frontendBase64) {
        console.warn(`[poll] No frontend_codebase for "${appName}" (tx: ${txHash})`);
        continue;
      }

      // Extract to target dir
      await extractFrontend(frontendBase64, targetDir);

      // Update state — mark as deployed
      state.apps[senderAddr] = {
        txHash,
        appName,
        subdomain,
        deployed: true,
        lastUpdated: new Date().toISOString(),
      };
      state.subdomains[subdomain] = senderAddr;
      saveState(STATE_FILE, state);

      if (isUpdate || isPending) updateCount++;
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
