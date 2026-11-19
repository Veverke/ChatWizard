import { readFileSync } from 'fs';
import { basename } from 'path';

const want = process.argv.slice(2);
const lcov = readFileSync('coverage/lcov.info', 'utf8').split(/\r?\n/);

const files = [];
let cur = null;
for (const line of lcov) {
    if (line.startsWith('SF:')) {
        cur = { file: line.slice(3), missing: [], branchMiss: [] };
        files.push(cur);
    } else if (!cur) { continue; }
    else if (line.startsWith('DA:')) {
        const [ln, hits] = line.slice(3).split(',').map(Number);
        if (hits === 0) { cur.missing.push(ln); }
    } else if (line.startsWith('BRDA:')) {
        const [ln, , , taken] = line.slice(5).split(',');
        if (taken === '0' || taken === '-') { cur.branchMiss.push(Number(ln)); }
    }
}

for (const f of files) {
    const name = basename(f.file);
    if (want.length && !want.includes(name)) { continue; }
    const src = (() => { try { return readFileSync(f.file, 'utf8').split(/\r?\n/); } catch { return []; } })();
    console.log(`\n=== ${name} (${f.file})  uncoveredLines=${f.missing.length} uncoveredBranchLines=${new Set(f.branchMiss).size}`);
    console.log('lines: ' + f.missing.slice(0, 120).join(','));
    console.log('branchLines: ' + [...new Set(f.branchMiss)].slice(0, 120).join(','));
    if (src.length && process.env.SHOW_SRC) {
        const set = new Set([...f.missing, ...f.branchMiss]);
        for (const ln of [...set].sort((a, b) => a - b).slice(0, 80)) {
            console.log(`  ${ln}: ${(src[ln - 1] ?? '').trim().slice(0, 140)}`);
        }
    }
}
