/**
 * test/unit/sessionIndex.test.ts
 *
 * Unit tests for sessionIndex.ts — pure functions and SessionIndex class.
 * Covers estimateTokens, toSummary, byUpdatedAtDesc, and SessionIndex methods.
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import { SessionIndex, toSummary } from '../../src/index/sessionIndex';
import { Session, Message } from '../../src/types/index';
import { SidecarMetadataStore } from '../../src/index/sidecarMetadataStore';

/** Minimal message factory. */
function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: crypto.randomUUID(), role, content, codeBlocks: [] };
}

/** Minimal session factory. */
function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: 'Test Session',
        source: 'copilot',
        workspaceId: 'ws-1',
        workspacePath: '/ws',
        messages: [],
        filePath: '/ws/file.md',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

suite('sessionIndex', () => {
    suite('toSummary', () => {
        test('counts user and assistant messages correctly', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Hello'),
                    msg('assistant', 'Hi there'),
                    msg('user', 'How are you?'),
                ],
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.messageCount, 3);
            assert.strictEqual(summary.userMessageCount, 2);
            assert.strictEqual(summary.assistantMessageCount, 1);
        });

        test('detects interrupted session (last msg is user)', () => {
            const session = makeSession({
                id: 's2',
                messages: [
                    msg('user', 'Q1'),
                    msg('assistant', 'A1'),
                    msg('user', 'Q2'),
                ],
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.interrupted, true);
        });

        test('does not set interrupted when last msg is assistant', () => {
            const session = makeSession({
                id: 's3',
                messages: [
                    msg('user', 'Q1'),
                    msg('assistant', 'A1'),
                ],
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.interrupted, undefined);
        });

        test('marks hasParseErrors when session has errors', () => {
            const session = makeSession({
                id: 's4',
                messages: [msg('user', 'Hello')],
                parseErrors: ['Something went wrong'],
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.hasParseErrors, true);
        });

        test('does not set hasParseErrors when no errors', () => {
            const session = makeSession({
                id: 's5',
                messages: [msg('user', 'Hello')],
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.hasParseErrors, undefined);
        });

        test('includes git branch from gitContext', () => {
            const session = makeSession({
                id: 's6',
                messages: [msg('user', 'Hello')],
                gitContext: { branch: 'feature-x' },
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.branch, 'feature-x');
        });

        test('includes branch from chronicleData when no gitContext', () => {
            const session = makeSession({
                id: 's7',
                messages: [msg('user', 'Hello')],
                chronicleData: { branch: 'main' } as any,
            });
            const summary = toSummary(session);
            assert.strictEqual(summary.branch, 'main');
        });
    });

    suite('SessionIndex', () => {
        test('starts empty', () => {
            const idx = new SessionIndex();
            assert.strictEqual(idx.size, 0);
            assert.deepStrictEqual(idx.getAllSummaries(), []);
        });

        test('upsert adds a session', () => {
            const idx = new SessionIndex();
            const session = makeSession({ id: 's1', messages: [msg('user', 'Hi')] });
            idx.upsert(session);
            assert.strictEqual(idx.size, 1);
            assert.strictEqual(idx.get('s1')?.id, 's1');
        });

        test('upsert replaces existing session with same id', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', title: 'Old', messages: [msg('user', 'Hi')] }));
            idx.upsert(makeSession({ id: 's1', title: 'New', messages: [msg('user', 'Hi'), msg('assistant', 'Hello')] }));
            assert.strictEqual(idx.size, 1);
            assert.strictEqual(idx.get('s1')?.title, 'New');
        });

        test('remove returns true and removes session', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'Hi')] }));
            const removed = idx.remove('s1');
            assert.strictEqual(removed, true);
            assert.strictEqual(idx.size, 0);
        });

        test('remove returns false for non-existent session', () => {
            const idx = new SessionIndex();
            const removed = idx.remove('nonexistent');
            assert.strictEqual(removed, false);
        });

        test('batchUpsert adds multiple sessions', () => {
            const idx = new SessionIndex();
            idx.batchUpsert([
                makeSession({ id: 's1', messages: [msg('user', 'A')] }),
                makeSession({ id: 's2', messages: [msg('user', 'B')] }),
            ]);
            assert.strictEqual(idx.size, 2);
        });

        test('batchUpsert with empty array does nothing', () => {
            const idx = new SessionIndex();
            idx.batchUpsert([]);
            assert.strictEqual(idx.size, 0);
        });

        test('clear removes all sessions', () => {
            const idx = new SessionIndex();
            idx.batchUpsert([
                makeSession({ id: 's1', messages: [msg('user', 'A')] }),
                makeSession({ id: 's2', messages: [msg('user', 'B')] }),
            ]);
            idx.clear();
            assert.strictEqual(idx.size, 0);
        });

        test('version increments on upsert', () => {
            const idx = new SessionIndex();
            const v0 = idx.version;
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            assert.ok(idx.version > v0);
        });

        test('version increments on remove', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            const v1 = idx.version;
            idx.remove('s1');
            assert.ok(idx.version > v1);
        });

        test('version increments on batchUpsert', () => {
            const idx = new SessionIndex();
            const v0 = idx.version;
            idx.batchUpsert([makeSession({ id: 's1', messages: [msg('user', 'A')] })]);
            assert.ok(idx.version > v0);
        });

        test('version increments on clear', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            const v1 = idx.version;
            idx.clear();
            assert.ok(idx.version > v1);
        });

        test('getAllSummaries returns summaries sorted by updatedAt desc', () => {
            const idx = new SessionIndex();
            const earlier = makeSession({ id: 's1', messages: [msg('user', 'Earlier')], updatedAt: '2024-01-01T00:00:00.000Z' });
            const later = makeSession({ id: 's2', messages: [msg('user', 'Later')], updatedAt: '2024-06-01T00:00:00.000Z' });
            idx.batchUpsert([earlier, later]);
            const summaries = idx.getAllSummaries();
            assert.strictEqual(summaries.length, 2);
            assert.strictEqual(summaries[0].id, 's2');
            assert.strictEqual(summaries[1].id, 's1');
        });

        test('search finds matching messages', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'Find this text')] }));
            idx.upsert(makeSession({ id: 's2', messages: [msg('user', 'Other content')] }));
            const results = idx.search('find');
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].id, 's1');
        });

        test('search filters by source', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', source: 'copilot', messages: [msg('user', 'hello')] }));
            idx.upsert(makeSession({ id: 's2', source: 'cursor', messages: [msg('user', 'hello')] }));
            const results = idx.search('hello', { source: 'cursor', searchResponses: false });
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].id, 's2');
        });

        test('search respects searchPrompts and searchResponses flags', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({
                id: 's1',
                messages: [msg('user', 'user text'), msg('assistant', 'assistant text')],
            }));
            const userOnly = idx.search('user text', { searchResponses: false });
            assert.strictEqual(userOnly.length, 1);
            const asstOnly = idx.search('assistant text', { searchPrompts: false });
            assert.strictEqual(asstOnly.length, 1);
        });

        test('getSummariesBySource filters correctly', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', source: 'copilot', messages: [msg('user', 'A')] }));
            idx.upsert(makeSession({ id: 's2', source: 'cursor', messages: [msg('user', 'B')] }));
            const copilotSummaries = idx.getSummariesBySource('copilot');
            assert.strictEqual(copilotSummaries.length, 1);
            assert.strictEqual(copilotSummaries[0].id, 's1');
        });

        test('getSummariesByWorkspace filters correctly', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', workspaceId: 'ws-1', messages: [msg('user', 'A')] }));
            idx.upsert(makeSession({ id: 's2', workspaceId: 'ws-2', messages: [msg('user', 'B')] }));
            const ws1Summaries = idx.getSummariesByWorkspace('ws-1');
            assert.strictEqual(ws1Summaries.length, 1);
            assert.strictEqual(ws1Summaries[0].id, 's1');
        });

        test('getAllPrompts returns user messages only', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Prompt 1'),
                    msg('assistant', 'Response 1'),
                    msg('user', 'Prompt 2'),
                ],
            }));
            const prompts = idx.getAllPrompts();
            assert.strictEqual(prompts.length, 2);
            assert.strictEqual(prompts[0].content, 'Prompt 1');
            assert.strictEqual(prompts[1].content, 'Prompt 2');
        });

        test('getAllCodeBlocks returns indexed code blocks', () => {
            const idx = new SessionIndex();
            const session = makeSession({
                id: 's1',
                messages: [
                    {
                        ...msg('assistant', '```ts\nlet x = 1;\n```'),
                        codeBlocks: [{ language: 'ts', content: 'let x = 1;\n', sessionId: 's1', messageIndex: 0, blockIndexInMessage: 0 }],
                    },
                ],
            });
            idx.upsert(session);
            const blocks = idx.getAllCodeBlocks();
            assert.strictEqual(blocks.length, 1);
            assert.strictEqual(blocks[0].language, 'ts');
        });

        test('getCodeBlockCount returns count without building full array', () => {
            const idx = new SessionIndex();
            const session = makeSession({
                id: 's1',
                messages: [
                    {
                        ...msg('assistant', '```ts\nlet x = 1;\n```'),
                        codeBlocks: [
                            { language: 'ts', content: 'let x = 1;\n', sessionId: 's1', messageIndex: 0, blockIndexInMessage: 0 },
                            { language: 'ts', content: 'let y = 2;\n', sessionId: 's1', messageIndex: 0, blockIndexInMessage: 1 },
                        ],
                    },
                ],
            });
            idx.upsert(session);
            assert.strictEqual(idx.getCodeBlockCount(), 2);
        });

        test('getCodeBlockCount returns 0 when no code blocks', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'Hello')] }));
            assert.strictEqual(idx.getCodeBlockCount(), 0);
        });

        test('addChangeListener fires on upsert', () => {
            const idx = new SessionIndex();
            let count = 0;
            idx.addChangeListener(() => { count++; });
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            assert.strictEqual(count, 1);
        });

        test('addChangeListener fires on remove', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            let count = 0;
            idx.addChangeListener(() => { count++; });
            idx.remove('s1');
            assert.strictEqual(count, 1);
        });

        test('addChangeListener fires on batchUpsert', () => {
            const idx = new SessionIndex();
            let count = 0;
            idx.addChangeListener(() => { count++; });
            idx.batchUpsert([makeSession({ id: 's1', messages: [msg('user', 'A')] })]);
            assert.strictEqual(count, 1);
        });

        test('typed change listener receives proper event type', () => {
            const idx = new SessionIndex();
            const events: string[] = [];
            idx.addTypedChangeListener((event) => { events.push(event.type); });
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            idx.remove('s1');
            idx.clear();
            assert.deepStrictEqual(events, ['upsert', 'remove', 'clear']);
        });

        test('mergeChronicleData attaches data to matching sessions', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            idx.mergeChronicleData([{ sessionId: 's1', data: { branch: 'main' } as any }]);
            const session = idx.get('s1');
            assert.strictEqual(session?.chronicleData?.branch, 'main');
        });

        test('mergeChronicleData ignores non-existent session ids', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', messages: [msg('user', 'A')] }));
            idx.mergeChronicleData([{ sessionId: 'nonexistent', data: { branch: 'main' } as any }]);
            assert.strictEqual(idx.size, 1); // unchanged
        });

        test('setRetentionDays filters old sessions from summaries', () => {
            const idx = new SessionIndex();
            const oldSession = makeSession({
                id: 'old',
                messages: [msg('user', 'Old')],
                updatedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(), // 1 year ago
            });
            const newSession = makeSession({
                id: 'new',
                messages: [msg('user', 'New')],
                updatedAt: new Date().toISOString(),
            });
            idx.batchUpsert([oldSession, newSession]);
            idx.setRetentionDays(30); // only last 30 days
            const summaries = idx.getAllSummaries();
            assert.strictEqual(summaries.length, 1);
            assert.strictEqual(summaries[0].id, 'new');
        });

        test('setRetentionDays(0) disables filtering', () => {
            const idx = new SessionIndex();
            const oldSession = makeSession({
                id: 'old',
                messages: [msg('user', 'Old')],
                updatedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
            });
            idx.upsert(oldSession);
            idx.setRetentionDays(0);
            assert.strictEqual(idx.getAllSummaries().length, 1);
        });

        test('removeSessionsForStateFileNotIn removes stale sessions', () => {
            const idx = new SessionIndex();
            idx.batchUpsert([
                makeSession({ id: 'keep', filePath: '/ws/state.vscdb', source: 'cursor', messages: [msg('user', 'A')] }),
                makeSession({ id: 'stale', filePath: '/ws/state.vscdb', source: 'cursor', messages: [msg('user', 'B')] }),
                makeSession({ id: 'other', filePath: '/ws/other.vscdb', source: 'windsurf', messages: [msg('user', 'C')] }),
            ]);
            idx.removeSessionsForStateFileNotIn('/ws/state.vscdb', 'cursor', new Set(['keep']));
            assert.strictEqual(idx.size, 2);
            assert.strictEqual(idx.get('keep')?.id, 'keep');
            assert.strictEqual(idx.get('stale'), undefined);
        });

        test('getTitleFor returns custom title from sidecar cache', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', title: 'Original', messages: [msg('user', 'A')] }));
            // Inject sidecar cache manually via setSidecarStore
            const store = new SidecarMetadataStore('/tmp/test-meta');
            const cache = new Map<string, any>();
            cache.set('s1', { customTitle: 'Custom Title' });
            idx.setSidecarStore(store, cache);
            assert.strictEqual(idx.getTitleFor('s1'), 'Custom Title');
        });

        test('getTitleFor falls back to session title when no sidecar', () => {
            const idx = new SessionIndex();
            idx.upsert(makeSession({ id: 's1', title: 'Original', messages: [msg('user', 'A')] }));
            assert.strictEqual(idx.getTitleFor('s1'), 'Original');
        });

        test('getSidecarMeta returns metadata from cache', () => {
            const idx = new SessionIndex();
            const store = new SidecarMetadataStore('/tmp/test-meta');
            const cache = new Map<string, any>();
            cache.set('s1', { customTitle: 'My Title', isPinned: true });
            idx.setSidecarStore(store, cache);
            const meta = idx.getSidecarMeta('s1');
            assert.strictEqual(meta?.customTitle, 'My Title');
            assert.strictEqual(meta?.isPinned, true);
        });
    });
});