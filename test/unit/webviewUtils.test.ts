/**
 * test/unit/webviewUtils.test.ts
 *
 * Unit tests for the webview helpers every panel shares:
 *   - generateNonce()  → CSP nonce (SEC hardening, must be random per call)
 *   - validateColor()  → settings colours embedded in CSS (SEC-4 injection guard)
 */

import * as assert from 'assert';
import { generateNonce, validateColor } from '../../src/views/webviewUtils';

const FALLBACK = '#007acc';

suite('webviewUtils — generateNonce', () => {
    test('returns the base64 encoding of 16 random bytes', () => {
        const nonce = generateNonce();
        assert.strictEqual(typeof nonce, 'string');
        assert.ok(nonce.length > 0, 'nonce must not be empty');
        assert.strictEqual(Buffer.from(nonce, 'base64').length, 16);
        assert.match(nonce, /^[A-Za-z0-9+/]+={0,2}$/);
    });

    test('produces a different nonce on every call', () => {
        const nonces = new Set(Array.from({ length: 64 }, () => generateNonce()));
        assert.strictEqual(nonces.size, 64, 'every webview render needs a fresh nonce');
    });
});

suite('webviewUtils — validateColor', () => {
    test('accepts 3- and 6-digit hex colours', () => {
        assert.strictEqual(validateColor('#abc', FALLBACK), '#abc');
        assert.strictEqual(validateColor('#AABBCC', FALLBACK), '#AABBCC');
    });

    test('accepts rgb() and rgba() colours', () => {
        assert.strictEqual(validateColor('rgb(0, 122, 204)', FALLBACK), 'rgb(0, 122, 204)');
        assert.strictEqual(validateColor('rgba(1, 2, 3, 0.5)', FALLBACK), 'rgba(1, 2, 3, 0.5)');
        assert.strictEqual(validateColor('rgba(1,2,3,.25)', FALLBACK), 'rgba(1,2,3,.25)');
    });

    test('trims surrounding whitespace before validating', () => {
        assert.strictEqual(validateColor('  #ffffff  ', FALLBACK), '#ffffff');
    });

    test('rejects named colours (only hex/rgb/rgba are allowed)', () => {
        assert.strictEqual(validateColor('red', FALLBACK), FALLBACK);
        assert.strictEqual(validateColor('transparent', FALLBACK), FALLBACK);
    });

    test('rejects CSS injection attempts', () => {
        const injections = [
            "red; } body { background: url('https://attacker.com')",
            '#fff; background-image: url(x)',
            'rgb(0,0,0); color: red',
            '#abc}',
        ];
        for (const value of injections) {
            assert.strictEqual(validateColor(value, FALLBACK), FALLBACK, `must reject: ${value}`);
        }
    });

    test('rejects malformed hex and out-of-range rgb values', () => {
        for (const value of ['#ab', '#abcd', '#abcde', '#gggggg', '', 'rgb(1,2)', 'rgb(a,b,c)']) {
            assert.strictEqual(validateColor(value, FALLBACK), FALLBACK, `must reject: ${value}`);
        }
    });

    test('returns the caller-supplied fallback verbatim', () => {
        assert.strictEqual(validateColor('not-a-colour', ''), '');
        assert.strictEqual(validateColor('not-a-colour', '#123456'), '#123456');
    });
});
