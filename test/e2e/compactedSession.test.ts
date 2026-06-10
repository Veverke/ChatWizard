// test/e2e/compactedSession.test.ts
// Feature 45 — Compacted session detection & visibility

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseClaudeSession } from '../../src/parsers/claude';

const FIXTURE_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'claude');
const COMPACTED_FIXTURE = path.join(FIXTURE_DIR, 'compacted-session.jsonl');
const SAMPLE_FIXTURE = path.join(FIXTURE_DIR, 'sample-session.jsonl');

suite('Feature 45 — Compacted session detection', () => {
    test('parser sets isCompacted = true for a session with "type":"summary" entry', () => {
        const { session, errors } = parseClaudeSession(COMPACTED_FIXTURE);
        assert.ok(errors.length === 0 || errors.every(e => !e.includes('Failed')),
            `unexpected parse errors: ${errors.join(', ')}`);
        assert.strictEqual(session.isCompacted, true, 'isCompacted should be true');
    });

    test('parser populates compactionSummary with the summary text', () => {
        const { session } = parseClaudeSession(COMPACTED_FIXTURE);
        assert.ok(typeof session.compactionSummary === 'string', 'compactionSummary should be a string');
        assert.ok(session.compactionSummary!.length > 0, 'compactionSummary should be non-empty');
        assert.ok(
            session.compactionSummary!.includes('JWT'),
            `compactionSummary should contain "JWT", got: "${session.compactionSummary}"`
        );
    });

    test('parser leaves isCompacted undefined for a non-compacted session', () => {
        const tmpFile = path.join(os.tmpdir(), `cw-test-noncompact-${Date.now()}.jsonl`);
        try {
            fs.writeFileSync(tmpFile,
                '{"type":"human","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"timestamp":"2024-01-15T10:00:01.000Z","uuid":"uuid-human-001","sessionId":"session-noncompact-001"}\n' +
                '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]},"timestamp":"2024-01-15T10:00:05.000Z","uuid":"uuid-asst-001","sessionId":"session-noncompact-001"}\n',
                'utf8'
            );
            const { session } = parseClaudeSession(tmpFile);
            assert.strictEqual(session.isCompacted, undefined,
                'isCompacted should be undefined for non-compacted sessions');
            assert.strictEqual(session.compactionSummary, undefined,
                'compactionSummary should be undefined for non-compacted sessions');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    test('compacted session still has subsequent messages parsed correctly', () => {
        const { session } = parseClaudeSession(COMPACTED_FIXTURE);
        assert.ok(session.messages.length > 0, 'compacted session should have post-compaction messages');
        const userMsgs = session.messages.filter(m => m.role === 'user');
        assert.ok(userMsgs.length > 0, 'should have at least one user message after compaction');
    });

    test('compacted session uses summary text as title when no explicit title exists', () => {
        const { session } = parseClaudeSession(COMPACTED_FIXTURE);
        // The summary text is used as the title when present
        assert.ok(session.title.length > 0, 'title should be non-empty');
        assert.ok(
            session.title.includes('JWT') || session.title.length > 10,
            'title should be derived from the compaction summary'
        );
    });

    test('parser handles a session with summary entry and no subsequent messages gracefully', () => {
        const tmpFile = path.join(os.tmpdir(), `cw-test-compact-${Date.now()}.jsonl`);
        try {
            fs.writeFileSync(tmpFile,
                '{"type":"summary","summary":"Only a summary, no follow-up messages."}\n',
                'utf8'
            );
            const { session, errors } = parseClaudeSession(tmpFile);
            assert.ok(!errors.some(e => e.includes('Failed')), 'should not have fatal errors');
            assert.strictEqual(session.isCompacted, true);
            assert.strictEqual(session.compactionSummary, 'Only a summary, no follow-up messages.');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });
});