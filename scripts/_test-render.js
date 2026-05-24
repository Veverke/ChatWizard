const { renderMessage } = require('./_renderer_test.cjs');

const msg1 = { id: 'm1', role: 'user',      content: 'Hello world\nSecond line', codeBlocks: [] };
const msg2 = { id: 'm2', role: 'assistant', content: 'Hi there',                 codeBlocks: [] };
const msg3 = { id: 'm3', role: 'user',      content: 'Another question',          codeBlocks: [] };
const visible = [
    { msg: msg1, origIdx: 0 },
    { msg: msg2, origIdx: 1 },
    { msg: msg3, origIdx: 2 },
];

const h1 = renderMessage(msg1, 0, 0, visible, 'Copilot', undefined);
const h2 = renderMessage(msg2, 1, 1, visible, 'Copilot', undefined);
const h3 = renderMessage(msg3, 2, 2, visible, 'Copilot', undefined);

// Extract message-header contents
const hdr = (s) => {
    const m = s.match(/<div class="message-header">([\s\S]*?)<\/div>/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '(no header found)';
};

console.log('--- P1 header ---');
console.log(hdr(h1));
console.log('\n--- R1 header ---');
console.log(hdr(h2));
console.log('\n--- P2 header ---');
console.log(hdr(h3));

const checks = [
    ['cw-turn-label in P1',  h1.includes('cw-turn-label')],
    ['>P1< in P1',           h1.includes('>P1<')],
    ['cw-copy-ref-btn in P1', h1.includes('cw-copy-ref-btn')],
    ['data-turn="P1"',       h1.includes('data-turn="P1"')],
    ['id="cw-msg-P1"',       h1.includes('id="cw-msg-P1"')],
    ['cw-turn-label in R1',  h2.includes('cw-turn-label')],
    ['>R1< in R1',           h2.includes('>R1<')],
    ['id="cw-msg-R1"',       h2.includes('id="cw-msg-R1"')],
    ['cw-turn-label in P2',  h3.includes('cw-turn-label')],
    ['>P2< in P2',           h3.includes('>P2<')],
];

console.log('\n--- Checks ---');
let allPass = true;
for (const [name, pass] of checks) {
    console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name);
    if (!pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
