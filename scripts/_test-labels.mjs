// Quick test: verify turn labels are emitted by renderMessage
// Run: node scripts/_test-labels.mjs

// We need to compile first; use the dist bundle indirectly by extracting
// the standalone rendering logic via dynamic require of compiled output.

// Since dist/extension.js is a CJS bundle, let's use require() to load it
// but renderMessage is not exported – so compile with esbuild on the fly.

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';

const tmpEntry = path.resolve('scripts/_test-labels-entry.ts');
const tmpOut   = path.resolve('scripts/_test-labels-out.mjs');

writeFileSync(tmpEntry, `
import { renderMessage } from '../src/views/sessionRenderer';

const msg1 = { id: 'm1', role: 'user' as const,      content: 'Hello world\\nSecond line', codeBlocks: [] };
const msg2 = { id: 'm2', role: 'assistant' as const, content: 'Hi there',                  codeBlocks: [] };
const msg3 = { id: 'm3', role: 'user' as const,      content: 'Another question',           codeBlocks: [] };

const visible = [
  { msg: msg1, origIdx: 0 },
  { msg: msg2, origIdx: 1 },
  { msg: msg3, origIdx: 2 },
];

const h1 = renderMessage(msg1, 0, 0, visible, 'Copilot', undefined);
const h2 = renderMessage(msg2, 1, 1, visible, 'Copilot', undefined);
const h3 = renderMessage(msg3, 2, 2, visible, 'Copilot', undefined);

console.log('=== P1 header snippet ===');
const hdr1 = h1.match(/<div class="message-header">([\s\S]*?)<\\/div>/)?.[1] ?? '(no header)';
console.log(hdr1.replace(/\\s+/g, ' ').trim());

console.log('\\n=== R1 header snippet ===');
const hdr2 = h2.match(/<div class="message-header">([\s\S]*?)<\\/div>/)?.[1] ?? '(no header)';
console.log(hdr2.replace(/\\s+/g, ' ').trim());

console.log('\\n=== P2 header snippet ===');
const hdr3 = h3.match(/<div class="message-header">([\s\S]*?)<\\/div>/)?.[1] ?? '(no header)';
console.log(hdr3.replace(/\\s+/g, ' ').trim());

const checks = [
  ['P1 label present', h1.includes('cw-turn-label') && h1.includes('>P1<')],
  ['R1 label present', h2.includes('cw-turn-label') && h2.includes('>R1<')],
  ['P2 label present', h3.includes('cw-turn-label') && h3.includes('>P2<')],
  ['P1 id attr',       h1.includes('id="cw-msg-P1"')],
  ['R1 id attr',       h2.includes('id="cw-msg-R1"')],
  ['copy btn on P1',   h1.includes('cw-copy-ref-btn')],
  ['copy btn on R1',   h2.includes('cw-copy-ref-btn')],
];

console.log('\\n=== Checks ===');
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? '✓' : '✗') + ' ' + name);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
`);

try {
  execSync(
    `npx esbuild ${tmpEntry} --bundle=false --platform=node --format=esm ` +
    `--loader:.ts=ts --out-extension:.js=.mjs --outfile=${tmpOut}`,
    { stdio: 'inherit' }
  );
  const mod = await import(tmpOut + '?t=' + Date.now());
} catch (e) {
  process.exit(1);
} finally {
  try { unlinkSync(tmpEntry); } catch {}
  try { unlinkSync(tmpOut); } catch {}
}
