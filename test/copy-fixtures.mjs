// test/copy-fixtures.mjs
// Copies test fixtures from test/fixtures/ to out/test/fixtures/ after compilation.
// Run as part of the pretest step.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, 'fixtures');
const dest = path.resolve(__dirname, '..', 'out', 'test', 'fixtures');

function copyDir(srcDir, destDir) {
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDir(src, dest);
console.log(`[copy-fixtures] Copied fixtures from ${src} to ${dest}`);