import { mkdirSync, rmSync, existsSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Buffer } from 'buffer';
import { extract } from 'tar';
import { tmpdir } from 'os';

/**
 * Decode base64 frontend_codebase → extract tar.gz → place files in targetDir.
 * Handles varying tar structures (files at root, single top-level dir, nested).
 */
export async function extractFrontend(base64Data, targetDir) {
  const tempDir = join(tmpdir(), `feenix-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    mkdirSync(tempDir, { recursive: true });

    // Decode base64 → write tar.gz
    const tarBytes = Buffer.from(base64Data, 'base64');
    const tarPath = join(tempDir, 'frontend.tar.gz');
    writeFileSync(tarPath, tarBytes);

    // Extract tar.gz
    const extractDir = join(tempDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    await extract({ file: tarPath, cwd: extractDir });

    // Determine the actual root of the frontend files
    const frontendRoot = findFrontendRoot(extractDir);

    // Clear target and move files
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });

    // Move contents from frontendRoot to targetDir
    const items = readdirSync(frontendRoot);
    for (const item of items) {
      renameSync(join(frontendRoot, item), join(targetDir, item));
    }

    return true;
  } finally {
    // Clean up temp dir
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Find the directory containing frontend files.
 * If there's a single top-level directory, descend into it.
 * If there's an index.html, that's our root.
 */
function findFrontendRoot(dir) {
  const items = readdirSync(dir);

  // If index.html is here, this is the root
  if (items.includes('index.html') || items.includes('auth.html')) {
    return dir;
  }

  // If single top-level directory, descend
  if (items.length === 1) {
    const single = join(dir, items[0]);
    const stat = readdirSync(single);
    if (stat) {
      return findFrontendRoot(single);
    }
  }

  // Check if any subdirectory contains index.html (e.g., "frontend/" dir)
  for (const item of items) {
    const sub = join(dir, item);
    try {
      const subItems = readdirSync(sub);
      if (subItems.includes('index.html') || subItems.includes('auth.html')) {
        return sub;
      }
    } catch {
      // Not a directory, skip
    }
  }

  // Fallback: return the dir as-is
  return dir;
}
