#!/usr/bin/env node
/**
 * Test that better-sqlite3 loads inside VS Code's Electron runtime.
 * Usage: ELECTRON_RUN_AS_NODE=1 Code.exe scripts/test-vsix-load.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

try {
  const b = require('C:\\Users\\ay250177\\.vscode\\extensions\\veverke.chatwizard-1.5.0\\node_modules\\better-sqlite3');
  const db = new b(':memory:');
  const rows = db.prepare('SELECT 1').all();
  console.log('SQLITE_OK:', JSON.stringify(rows));
  process.exit(0);
} catch (e) {
  console.log('SQLITE_ERROR:', e.message);
  process.exit(1);
}