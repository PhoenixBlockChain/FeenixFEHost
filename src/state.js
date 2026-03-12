import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * State tracks which apps are deployed and at which version (tx hash).
 * Format:
 * {
 *   "apps": {
 *     "<senderAddr>": {
 *       "txHash": "abc123",
 *       "appName": "My App",
 *       "subdomain": "my-app",
 *       "lastUpdated": "2026-03-11T..."
 *     }
 *   },
 *   "subdomains": {
 *     "my-app": "<senderAddr>"
 *   }
 * }
 */

const DEFAULT_STATE = { apps: {}, subdomains: {} };

export function loadState(stateFile) {
  if (!existsSync(stateFile)) return structuredClone(DEFAULT_STATE);
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(stateFile, state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
