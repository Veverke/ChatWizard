// test/suite/semanticWiring.test.ts
//
// Tests for the message-splitting behaviour in SemanticIndexer.scheduleSession().
// The wiring inside activate() depends heavily on VS Code APIs and is verified
// through manual Extension Development Host testing (see docs/).

import * as assert from 'assert';
import { SemanticIndexer, SemanticIndexerVsCodeApi } from '../../src/search/semanticIndexer';
import { IEmbeddingEngine, ISemanticIndex, SEMANTIC_DIMS } from '../../src/search/semanticContracts';
import { SemanticMessageResult } from '../../src/search/types';
import { Session, Message } from '../../src/types/index';

// ── Fixture builders ───────────────────────────────────────────────────────

let _idCounter = 0;

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { messages?: Message[] } = {}): Session {
    return {
        id:          overrides.id          ?? 'sess-1',
        title:       overrides.title       ?? 'Test Session',
        source:      overrides.source      ?? 'copilot',
        workspaceId: overrides.workspaceId ?? 'ws-default',
        messages:    overrides.messages    ?? [],
        filePath:    overrides.filePath    ?? '/fake/sess-1.jsonl',
        createdAt:   overrides.createdAt   ?? '2025-01-01T00:00:00.000Z',
        updatedAt:   overrides.updatedAt   ?? '2025-06-01T00:00:00.000Z',
    };
}

// ── Stubs ──────────────────────────────────────────────────────────────────

function makeVsCodeApiStub(): SemanticIndexerVsCodeApi {
    return {
        async showConsentDialog() { return true; },
        isFirstUse() { return false; },
        async loadModelWithProgress(task) { await task(() => {}); },
        async runIndexingProgress(task) { await task(() => {}); },
        showIndexingComplete() {},
    };
}

type EmbedCall = { text: string };

function makeEngineStub(): IEmbeddingEngine & { calls: EmbedCall[] } {
    const calls: EmbedCall[] = [];
    let ready = false;
    return {
        get isReady() { return ready; },
        async load() { ready = true; },
        async embed(text: string) {
            calls.push({ text });
            return new Float32Array(SEMANTIC_DIMS).fill(0.1);
        },
        calls,
    };
}

type IndexAddCall = { sessionId: string; role: 'user' | 'assistant'; messageIndex: number; paragraphIndex: number };

function makeIndexStub(): ISemanticIndex & { addCalls: IndexAddCall[] } {
    const addCalls: IndexAddCall[] = [];
    const entries = new Map<string, Float32Array>();
    return {
        addCalls,
        get size() { return entries.size; },
        add(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number, embedding: Float32Array) {
            addCalls.push({ sessionId, role, messageIndex, paragraphIndex });
            entries.set(`${sessionId}::${role}::${messageIndex}::${paragraphIndex}`, embedding);
        },
        remove(id: string) {
            for (const k of entries.keys()) {
                if (k.startsWith(`${id}::`)) { entries.delete(k); }
            }
        },
        has(id: string) { return [...entries.keys()].some(k => k.startsWith(`${id}::`)); },
        search(_q: Float32Array, topK: number): SemanticMessageResult[] {
            return [...entries.entries()].slice(0, topK).map(([k]) => {
                const parts = k.split('::');
                return {
                    sessionId: parts.slice(0, parts.length - 3).join('::'),
                    role: parts[parts.length - 3] as 'user' | 'assistant',
                    messageIndex: parseInt(parts[parts.length - 2], 10),
                    paragraphIndex: parseInt(parts[parts.length - 1], 10),
                    score: 1,
                };
            });
        },
        async save() {},
        async load() {},
    };
}

async function makeReadyIndexer() {
    const engine = makeEngineStub();
    const index = makeIndexStub();
    const api = makeVsCodeApiStub();
    const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
    await indexer.initialize();
    return { indexer, engine, index };
}

// ── scheduleSession() message splitting ────────────────────────────────────

suite('scheduleSession — message splitting', () => {
    test('user message produces exactly one embed call', async () => {
        const { indexer, engine } = await makeReadyIndexer();
        const session = makeSession({ messages: [makeMessage('user', 'How do I implement JWT auth?')] });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(engine.calls.length, 1);
        assert.strictEqual(engine.calls[0].text, 'How do I implement JWT auth?');
        indexer.dispose();
    });

    test('assistant response with 3 paragraphs produces 3 embed calls', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        const session = makeSession({
            messages: [makeMessage('assistant', 'Para one.\n\nPara two.\n\nPara three.')],
        });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(engine.calls.length, 3);
        assert.strictEqual(index.addCalls.filter(c => c.role === 'assistant').length, 3);
        assert.ok(index.addCalls.some(c => c.paragraphIndex === 0));
        assert.ok(index.addCalls.some(c => c.paragraphIndex === 1));
        assert.ok(index.addCalls.some(c => c.paragraphIndex === 2));
        indexer.dispose();
    });

    test('mixed session: user+assistant produces correct entry counts', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        const session = makeSession({
            messages: [
                makeMessage('user', 'Question'),
                makeMessage('assistant', 'Answer part 1.\n\nAnswer part 2.'),
            ],
        });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 30));
        // 1 user + 2 assistant paragraphs = 3 total
        assert.strictEqual(engine.calls.length, 3);
        assert.strictEqual(index.addCalls.filter(c => c.role === 'user').length, 1);
        assert.strictEqual(index.addCalls.filter(c => c.role === 'assistant').length, 2);
        indexer.dispose();
    });

    test('sessions already in index are skipped', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        // Pre-populate index
        index.add('sess-1', 'user', 0, 0, new Float32Array(SEMANTIC_DIMS));
        const session = makeSession({ id: 'sess-1', messages: [makeMessage('user', 'hello')] });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.calls.length, 0, 'should skip already-indexed session');
        indexer.dispose();
    });

    test('empty message content is skipped', async () => {
        const { indexer, engine } = await makeReadyIndexer();
        const session = makeSession({ messages: [makeMessage('user', '   ')] });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.calls.length, 0, 'whitespace-only message should be skipped');
        indexer.dispose();
    });

    test('messageIndex matches position in messages array', async () => {
        const { indexer, index } = await makeReadyIndexer();
        const session = makeSession({
            messages: [
                makeMessage('user', 'First'),
                makeMessage('assistant', 'Second'),
                makeMessage('user', 'Third'),
            ],
        });
        indexer.scheduleSession(session);
        await new Promise(r => setTimeout(r, 30));
        const userCalls = index.addCalls.filter(c => c.role === 'user');
        assert.strictEqual(userCalls[0].messageIndex, 0);
        assert.strictEqual(userCalls[1].messageIndex, 2);
        indexer.dispose();
    });
});

