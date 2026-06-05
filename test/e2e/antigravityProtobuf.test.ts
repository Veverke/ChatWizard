// test/e2e/antigravityProtobuf.test.ts
// Feature 40 — Antigravity .pb (Protobuf) support

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanProtobufStrings, parseAntigravityPbFile } from '../../src/parsers/antigravityProtobuf';

/**
 * Build a minimal protobuf buffer with one wire-type 2 field containing the given text.
 * Field number: 1, wire type: 2 (length-delimited)
 */
function buildSimpleProtoWithString(text: string): Buffer {
    const textBytes = Buffer.from(text, 'utf8');
    const tag = Buffer.from([0x0a]); // field 1, wire type 2: (1 << 3) | 2 = 0x0a
    const len = Buffer.alloc(1);
    len.writeUInt8(textBytes.length, 0);
    return Buffer.concat([tag, len, textBytes]);
}

suite('Feature 40 — Antigravity Protobuf Scanner', () => {
    test('scanProtobufStrings returns non-empty strings from a valid protobuf buffer', () => {
        const text = 'This is a test message that is longer than twenty characters';
        const buffer = buildSimpleProtoWithString(text);
        const { strings, lowFidelity } = scanProtobufStrings(buffer);
        assert.ok(strings.length > 0, 'should find at least one string');
        assert.ok(strings.some(s => s.includes('test message')), 'should contain the text content');
        assert.strictEqual(lowFidelity, true, 'lowFidelity should always be true');
    });

    test('scanProtobufStrings does not throw on a zero-byte buffer', () => {
        const { strings } = scanProtobufStrings(Buffer.alloc(0));
        assert.strictEqual(strings.length, 0, 'empty buffer should produce no strings');
    });

    test('scanProtobufStrings does not throw on random binary data', () => {
        // Create some random binary data
        const random = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80, 0xaa, 0xbb]);
        assert.doesNotThrow(() => {
            scanProtobufStrings(random);
        }, 'should not throw on random binary data');
    });

    test('scanProtobufStrings filters out strings shorter than 20 chars', () => {
        // Build proto with a short string (< 20 chars)
        const shortText = 'short';
        const buffer = buildSimpleProtoWithString(shortText);
        const { strings } = scanProtobufStrings(buffer);
        assert.ok(!strings.includes(shortText), 'short strings should be filtered out');
    });

    test('lowFidelity is always true', () => {
        const { lowFidelity } = scanProtobufStrings(Buffer.alloc(0));
        assert.strictEqual(lowFidelity, true);
    });
});

suite('Feature 40 — Antigravity .pb File Parser', () => {
    let tmpDir: string;

    suiteSetup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pb-test-'));
    });

    suiteTeardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('parseAntigravityPbFile returns a session with messages for a valid .pb file', () => {
        const text = 'This is a long enough test string to pass the twenty char filter.';
        const buffer = buildSimpleProtoWithString(text);
        const pbPath = path.join(tmpDir, 'test-session.pb');
        fs.writeFileSync(pbPath, buffer);

        const { session, errors } = parseAntigravityPbFile(pbPath);
        assert.ok(!errors.some(e => e.includes('Failed to read')), 'should not have read errors');
        assert.ok(session.messages.length > 0, 'should have at least one message');
    });

    test('parseAntigravityPbFile returns errors for unreadable file', () => {
        const { errors } = parseAntigravityPbFile('/nonexistent/path/test.pb');
        assert.ok(errors.length > 0, 'should have errors for nonexistent file');
        assert.ok(errors[0].includes('Failed to read'), 'error should mention read failure');
    });

    test('parseAntigravityPbFile sets source to "antigravity"', () => {
        const text = 'This is a long enough test string for the protobuf parser filter.';
        const buffer = buildSimpleProtoWithString(text);
        const pbPath = path.join(tmpDir, 'source-test.pb');
        fs.writeFileSync(pbPath, buffer);

        const { session } = parseAntigravityPbFile(pbPath);
        assert.strictEqual(session.source, 'antigravity', 'source should be antigravity');
    });

    test('parseAntigravityPbFile handles empty .pb file gracefully', () => {
        const pbPath = path.join(tmpDir, 'empty.pb');
        fs.writeFileSync(pbPath, Buffer.alloc(0));

        const { session, errors } = parseAntigravityPbFile(pbPath);
        assert.ok(session !== undefined, 'should return a session even for empty file');
        assert.ok(errors.length > 0, 'should have errors for empty file with no strings');
    });

    test('title is derived from first extracted string (truncated to 80 chars)', () => {
        const longText = 'a'.repeat(100) + ' This is additional text in the string';
        const buffer = buildSimpleProtoWithString(longText);
        const pbPath = path.join(tmpDir, 'long-title.pb');
        fs.writeFileSync(pbPath, buffer);

        const { session } = parseAntigravityPbFile(pbPath);
        assert.ok(session.title.length <= 80, 'title should be at most 80 characters');
    });
});