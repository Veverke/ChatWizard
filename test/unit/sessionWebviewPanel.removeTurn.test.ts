/**
 * test/unit/sessionWebviewPanel.removeTurn.test.ts
 *
 * Unit tests for Feature 51 — the reader's "select a turn → remove it" flow:
 * the rendered remove affordances, the persistence call and the re-render that
 * drops the removed turn from the conversation, plus the generated
 * "original full conversation" file.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';
import { renderMessage, VisibleMessage } from '../../src/views/sessionRenderer';
import type { Message, RemovedTurn, Session } from '../../src/types/index';

type Posted = { [key: string]: any };

const PANEL_ID = 'remove-turn-session';

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
    return { id, role, content, codeBlocks: [], timestamp: '2024-01-01T00:00:00Z' };
}

function makeSession(): Session {
    return {
        id: PANEL_ID,
        title: 'Turn removal',
        source: 'copilot',
        workspaceId: 'ws1',
        filePath: path.join(os.tmpdir(), `${PANEL_ID}.jsonl`),
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        model: 'gpt-4',
        messages: [
            msg('m1', 'user', 'first prompt'),
            msg('m2', 'assistant', 'first answer haystack'),
            msg('m3', 'user', 'second prompt'),
            msg('m4', 'assistant', 'second answer'),
        ],
    };
}

function visibleOf(session: Session): VisibleMessage[] {
    return session.messages
        .map((m, i) => ({ msg: m, origIdx: i, nextRemoved: session.messages[i + 1]?.removed === true }))
        .filter(v => !v.msg.removed);
}

interface Harness {
    session: Session;
    posted: Posted[];
}

function makeHarness(): Harness {
    const session = makeSession();
    const visibleMessages = visibleOf(session);
    const posted: Posted[] = [];
    const state: any = {
        session,
        visibleMessages,
        renderedMessages: new Array(visibleMessages.length).fill(null),
        windowStart: 0,
        windowEnd: visibleMessages.length,
        streamVersion: 1,
        assistantLabel: 'Copilot',
        panel: { webview: { postMessage: (m: Posted) => { posted.push(m); return true; } } },
    };
    (SessionWebviewPanel as any)._panelState.set(PANEL_ID, state);
    return { session, posted };
}

/** Minimal stand-in for the SQLite cache (the chat DB). */
function makeFakeStore(session: Session, dir: string): any {
    const removed: RemovedTurn[] = [];
    return {
        dbPath: path.join(dir, 'chatwizard-cache.db'),
        removeTurn(sessionId: string, messageIndex: number, message: Message): RemovedTurn {
            const record: RemovedTurn = {
                messageId: message.id,
                messageIndex,
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
                removedAt: '2024-01-02T00:00:00Z',
            };
            removed.push(record);
            return record;
        },
        getRemovedTurns: () => [...removed],
        getRemovedTurnCount: () => removed.length,
        getOriginalSession: () => session,
    };
}

suite('SessionWebviewPanel – turn removal (Feature 51)', () => {
    const originalStore = SessionWebviewPanel._cacheStore;
    const originalMutated = SessionWebviewPanel._onSessionMutated;

    teardown(() => {
        (SessionWebviewPanel as any)._panelState.delete(PANEL_ID);
        (SessionWebviewPanel as any)._panels.delete(PANEL_ID);
        SessionWebviewPanel._renderCache.clear();
        SessionWebviewPanel._cacheStore = originalStore;
        SessionWebviewPanel._onSessionMutated = originalMutated;
    });

    test('every rendered turn carries a remove button bound to its original index', () => {
        const session = makeSession();
        const visible = visibleOf(session);
        const html = renderMessage(session.messages[2], 2, 1, visible, 'Copilot', undefined, 'P2');

        assert.ok(html.includes('class="cw-remove-btn"'), 'remove button is rendered');
        assert.ok(html.includes('data-msg-orig-idx="2"'), 'button points at the original index');
    });


    test('a prompt whose reply was removed does not show the "Response not available" notice', () => {
        const session = makeSession();
        session.messages[1].removed = true;
        const visible = visibleOf(session);

        const html = renderMessage(session.messages[0], 0, 0, visible, 'Copilot', undefined, 'P1');

        assert.ok(!html.includes('Response not available'), 'no misleading cancelled-response banner');
    });

    test('a genuinely unanswered prompt still shows the notice', () => {
        const session = makeSession();
        const visible = visibleOf(session);
        // Truncate the list so m3 really is the last (unanswered) prompt.
        const truncated = visible.slice(0, 2);
        const unanswered = renderMessage(session.messages[2], 2, 1, truncated, 'Copilot', undefined, 'P2');

        assert.ok(unanswered.includes('Response not available'));
    });

    test('_removeTurn persists the removal and re-renders without the turn', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-remove-ui-'));
        const { session, posted } = makeHarness();
        SessionWebviewPanel._cacheStore = makeFakeStore(session, dir);
        let mutated: Session | undefined;
        SessionWebviewPanel._onSessionMutated = (s: Session) => { mutated = s; };

        try {
            await SessionWebviewPanel._removeTurn(PANEL_ID, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }

        assert.strictEqual(session.messages[1].removed, true, 'the turn is flagged as removed');
        assert.strictEqual(mutated?.id, PANEL_ID, 'the mutated session is re-published to the index');

        const renders = posted.filter(m => m.type === 'render');
        assert.strictEqual(renders.length, 1, 'the reader is re-rendered once');
        const render = renders[0];
        assert.ok(!render.messagesHtml.includes('first answer haystack'), 'the removed turn is gone');
        assert.ok(render.messagesHtml.includes('first prompt'), 'the other turns stay');
        assert.strictEqual(render.removedTurnCount, 1, 'the metadata reports the removed turn');
        assert.strictEqual(render.total, 3);
    });

    test('_removeTurn ignores an index that does not exist', async () => {
        const { session, posted } = makeHarness();
        SessionWebviewPanel._cacheStore = makeFakeStore(session, os.tmpdir());

        await SessionWebviewPanel._removeTurn(PANEL_ID, 99);

        assert.strictEqual(posted.length, 0, 'nothing is re-rendered');
        assert.ok(session.messages.every(m => !m.removed));
    });

    test('_openOriginalConversation writes the full chat (removed turns included)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-original-'));
        const { session } = makeHarness();
        SessionWebviewPanel._cacheStore = makeFakeStore(session, dir);

        try {
            await SessionWebviewPanel._openOriginalConversation(PANEL_ID);

            const outDir = path.join(dir, 'original-conversations');
            const files = fs.readdirSync(outDir);
            assert.strictEqual(files.length, 1, 'one original-conversation file is written');
            const content = fs.readFileSync(path.join(outDir, files[0]), 'utf-8');
            assert.ok(content.includes('first prompt'));
            assert.ok(content.includes('first answer haystack'));
            assert.ok(content.includes('second answer'));
            assert.ok(/Original conversation/i.test(content));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
