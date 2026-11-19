/**
 * test/unit/entityExtractor.test.ts
 *
 * Unit tests for entityExtractor — pure regex-based entity extraction.
 */

import * as assert from 'assert';
import { extractEntities } from '../../src/analytics/entityExtractor';
import type { Session, Message } from '../../src/types/index';

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: overrides.source ?? 'copilot',
        title: overrides.title ?? 'Test',
        messages: overrides.messages ?? [],
        createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${overrides.id}.jsonl`,
    };
}

suite('entityExtractor', () => {
    suite('extractEntities', () => {
        test('extracts file paths from content', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Check src/utils/helper.ts for the bug'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(result.filePaths.length > 0);
            assert.ok(result.filePaths.some(p => p.includes('helper.ts')));
        });

        test('extracts function and class names from content', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'The function calculateTotal is buggy. Also check class UserService.'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(result.functionNames.includes('calculateTotal'));
            assert.ok(result.functionNames.includes('UserService'));
        });

        test('extracts function names from backtick pattern', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Call `validateInput()` before processing'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(result.functionNames.includes('validateInput'));
        });

        test('extracts error messages from content', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Getting TypeError: Cannot read property of undefined'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(result.errors.length > 0);
        });

        test('does not treat plain uppercase words as error codes', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'The ENTITIES functionality lists README files, API docs and TODO items.'),
                ],
            });
            const result = extractEntities(session);
            assert.deepStrictEqual(
                result.errors,
                [],
                `Uppercase words must not be errors, got: ${result.errors.join('; ')}`,
            );
        });

        test('extracts known errno and structured error codes', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'ENOENT: no such file, SQLITE_BUSY and ERR_MODULE_NOT_FOUND keep appearing.'),
                ],
            });
            const result = extractEntities(session);
            const joined = result.errors.join('; ');
            assert.ok(result.errors.some(e => e.includes('ENOENT')), joined);
            assert.ok(result.errors.some(e => e.includes('SQLITE_BUSY')), joined);
            assert.ok(result.errors.some(e => e.includes('ERR_MODULE_NOT_FOUND')), joined);
        });

        test('extracts HTTP statuses only with a canonical reason phrase', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Getting 403 Forbidden and 500 Internal Server Error; the team has 503 employees.'),
                ],
            });
            const result = extractEntities(session);
            const joined = result.errors.join('; ');
            assert.ok(result.errors.some(e => e.includes('403 Forbidden')), joined);
            assert.ok(result.errors.some(e => e.includes('500 Internal Server Error')), joined);
            assert.ok(!result.errors.some(e => e.includes('employees')), joined);
        });

        test('extracts named exceptions with their message', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'It failed with JsonWebTokenError: invalid signature when logging in.'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(
                result.errors.some(e => e.includes('JsonWebTokenError: invalid signature')),
                `Expected the named exception, got: ${result.errors.join('; ')}`,
            );
        });

        test('extracts decision phrases from content', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'I decided to use PostgreSQL for the database layer'),
                ],
            });
            const result = extractEntities(session);
            assert.ok(result.decisions.length > 0);
        });

        test('returns empty arrays for empty session', () => {
            const session = makeSession({
                id: 's1',
                messages: [],
            });
            const result = extractEntities(session);
            assert.deepStrictEqual(result.filePaths, []);
            assert.deepStrictEqual(result.functionNames, []);
            assert.deepStrictEqual(result.errors, []);
            assert.deepStrictEqual(result.decisions, []);
        });

        test('deduplicates extracted entities', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Fix `calculateTotal()`. Also check `calculateTotal()` for overflow.'),
                ],
            });
            const result = extractEntities(session);
            const matches = result.functionNames.filter(f => f === 'calculateTotal');
            assert.strictEqual(matches.length, 1);
        });

        test('limits file paths to 50 items', () => {
            const manyPaths = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`).join(' ');
            const session = makeSession({
                id: 's1',
                messages: [msg('user', manyPaths)],
            });
            const result = extractEntities(session);
            assert.ok(result.filePaths.length <= 50);
        });
    });
});