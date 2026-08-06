// test/e2e/chatWizardApi.test.ts
// Feature 44 — Programmatic / Extension API

import * as assert from 'assert';
import type { ChatWizardApi, ApiSessionSummary, ApiSession, ApiMessage } from '../../src/api/chatWizardApi';
import { SessionIndex } from '../../src/index/sessionIndex';
import type { Session } from '../../src/types/index';

/**
 * Create a mock implementation of ChatWizardApi backed by a real SessionIndex.
 * This tests the API contract without needing VS Code runtime.
 */
function createMockApi(index: SessionIndex, mcpRunning = false, mcpPort = 0): ChatWizardApi {
    return {
        version: '1.5.0',
        get sessionCount() { return index.size; },
        getRecentSessions(limit = 10): ApiSessionSummary[] {
            return index.getAllSummaries()
                .slice(0, limit)
                .map(s => ({
                    id: s.id,
                    title: s.title,
                    source: s.source,
                    messageCount: s.messageCount,
                    updatedAt: s.updatedAt,
                    workspacePath: s.workspacePath,
                }));
        },
        searchSessions(query: string, limit = 20): ApiSessionSummary[] {
            return index.search(query)
                .slice(0, limit)
                .map(s => ({
                    id: s.id,
                    title: s.title,
                    source: s.source,
                    messageCount: s.messageCount,
                    updatedAt: s.updatedAt,
                    workspacePath: s.workspacePath,
                }));
        },
        getSession(sessionId: string): ApiSession | undefined {
            const session = index.get(sessionId);
            if (!session) { return undefined; }
            return {
                id: session.id,
                title: session.title,
                source: session.source,
                messages: session.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                } as ApiMessage)),
                updatedAt: session.updatedAt,
                createdAt: session.createdAt,
                workspacePath: session.workspacePath,
                model: session.model,
            };
        },
        isMcpServerRunning: () => mcpRunning,
        getMcpServerPort: () => mcpPort,
    };
}

function makeSession(id: string): Session {
    return {
        id,
        title: `Test Session ${id}`,
        source: 'claude',
        workspaceId: 'ws1',
        workspacePath: '/project',
        messages: [
            { id: `${id}-u0`, role: 'user', content: `User content in ${id}`, codeBlocks: [] },
            { id: `${id}-a0`, role: 'assistant', content: `Assistant response in ${id}`, codeBlocks: [] },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
    };
}

suite('Feature 44 — ChatWizard API Contract', () => {
    let index: SessionIndex;
    let api: ChatWizardApi;

    setup(() => {
        index = new SessionIndex();
        index.batchUpsert([
            makeSession('api-s1'),
            makeSession('api-s2'),
            makeSession('api-s3'),
        ]);
        api = createMockApi(index);
    });

    test('version is a string', () => {
        assert.ok(typeof api.version === 'string' && api.version.length > 0);
    });

    test('sessionCount reflects indexed sessions', () => {
        assert.strictEqual(api.sessionCount, 3);
    });

    test('getRecentSessions returns session summaries', () => {
        const sessions = api.getRecentSessions();
        assert.ok(sessions.length > 0, 'should return sessions');
    });

    test('getRecentSessions respects limit parameter', () => {
        const sessions = api.getRecentSessions(2);
        assert.strictEqual(sessions.length, 2, 'should respect limit');
    });

    test('getRecentSessions returns correct ApiSessionSummary shape', () => {
        const sessions = api.getRecentSessions(1);
        const s = sessions[0];
        assert.ok(typeof s.id === 'string', 'id should be a string');
        assert.ok(typeof s.title === 'string', 'title should be a string');
        assert.ok(typeof s.source === 'string', 'source should be a string');
        assert.ok(typeof s.messageCount === 'number', 'messageCount should be a number');
        assert.ok(typeof s.updatedAt === 'string', 'updatedAt should be a string');
    });

    test('searchSessions returns matching sessions', () => {
        const results = api.searchSessions('User content');
        assert.ok(results.length > 0, 'should find sessions containing "User content"');
    });

    test('searchSessions returns empty for no matches', () => {
        const results = api.searchSessions('XYZZY_NO_MATCH_12345');
        assert.strictEqual(results.length, 0, 'should return empty array for no matches');
    });

    test('getSession returns full session by ID', () => {
        const session = api.getSession('api-s1');
        assert.ok(session !== undefined, 'should return a session for valid ID');
        assert.strictEqual(session!.id, 'api-s1');
        assert.ok(Array.isArray(session!.messages), 'messages should be an array');
        assert.strictEqual(session!.messages.length, 2, 'should have 2 messages');
    });

    test('getSession returns undefined for unknown ID', () => {
        const session = api.getSession('nonexistent-session');
        assert.strictEqual(session, undefined, 'should return undefined for unknown ID');
    });

    test('getSession message shape has role, content, and optional timestamp', () => {
        const session = api.getSession('api-s1');
        const msg = session!.messages[0];
        assert.ok(msg.role === 'user' || msg.role === 'assistant', 'role should be user or assistant');
        assert.ok(typeof msg.content === 'string', 'content should be a string');
    });

    test('isMcpServerRunning returns false for stopped server', () => {
        assert.strictEqual(api.isMcpServerRunning(), false);
    });

    test('getMcpServerPort returns 0 for stopped server', () => {
        assert.strictEqual(api.getMcpServerPort(), 0);
    });

    test('isMcpServerRunning returns true when server is running', () => {
        const runningApi = createMockApi(index, true, 6789);
        assert.strictEqual(runningApi.isMcpServerRunning(), true);
        assert.strictEqual(runningApi.getMcpServerPort(), 6789);
    });
});