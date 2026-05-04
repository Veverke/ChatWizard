// test/suite/mcp/tools/listRecentTool.test.ts

import * as assert from 'assert';
import { ListRecentTool } from '../../../../src/mcp/tools/listRecentTool';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { Session, Message } from '../../../../src/types/index';

// ── Fixture helpers ─────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, source: Session['source'] = 'copilot', updatedAt = '2026-01-01T00:00:00.000Z'): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId: 'ws-default',
        messages: [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi')],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

suite('ListRecentTool', () => {

    let sessionIndex: SessionIndex;
    let tool: ListRecentTool;

    setup(() => {
        sessionIndex = new SessionIndex();
        tool = new ListRecentTool(sessionIndex);
    });

    test('returns no-results message when index is empty', async () => {
        const result = await tool.execute({});
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No sessions'));
    });

    test('returns session summaries with title, source, date, message count, and ID', async () => {
        const session = makeSession('s1', 'copilot', '2026-03-01T00:00:00.000Z');
        sessionIndex.upsert(session);

        const result = await tool.execute({});
        const text = result.content[0].text;

        assert.ok(text.includes('Session s1'));
        assert.ok(text.includes('copilot'));
        assert.ok(text.includes('2026-03-01'));
        assert.ok(text.includes('ID: s1'));
        assert.ok(text.includes('Messages: 2'));
    });

    test('results are sorted newest first', async () => {
        sessionIndex.upsert(makeSession('old', 'copilot', '2025-01-01T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('new', 'copilot', '2026-06-01T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('mid', 'copilot', '2025-06-01T00:00:00.000Z'));

        const result = await tool.execute({});
        const text = result.content[0].text;

        const newPos = text.indexOf('ID: new');
        const midPos = text.indexOf('ID: mid');
        const oldPos = text.indexOf('ID: old');

        assert.ok(newPos < midPos, 'newest should appear before mid');
        assert.ok(midPos < oldPos, 'mid should appear before oldest');
    });

    test('source filter restricts to matching sessions', async () => {
        sessionIndex.upsert(makeSession('c1', 'copilot', '2026-01-01T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('c2', 'claude',  '2026-01-02T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('c3', 'cursor',  '2026-01-03T00:00:00.000Z'));

        const result = await tool.execute({ source: 'claude' });
        const text = result.content[0].text;

        assert.ok(text.includes('ID: c2'), 'claude session should be included');
        assert.ok(!text.includes('ID: c1'), 'copilot session should be excluded');
        assert.ok(!text.includes('ID: c3'), 'cursor session should be excluded');
    });

    test('since filter excludes sessions before the cutoff date', async () => {
        sessionIndex.upsert(makeSession('before', 'copilot', '2024-12-31T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('after',  'copilot', '2025-01-15T00:00:00.000Z'));

        const result = await tool.execute({ since: '2025-01-01' });
        const text = result.content[0].text;

        assert.ok(text.includes('ID: after'));
        assert.ok(!text.includes('ID: before'));
    });

    test('limit caps the number of returned sessions', async () => {
        for (let i = 0; i < 20; i++) {
            sessionIndex.upsert(makeSession(`s${i}`, 'copilot', `2026-0${(i % 9) + 1}-01T00:00:00.000Z`));
        }

        const result = await tool.execute({ limit: 5 });
        const ids = (result.content[0].text.match(/^ID:/gm) ?? []);
        assert.strictEqual(ids.length, 5);
    });

    test('limit is clamped to MIN (1)', async () => {
        sessionIndex.upsert(makeSession('only', 'copilot'));

        const result = await tool.execute({ limit: -10 });
        const ids = (result.content[0].text.match(/^ID:/gm) ?? []);
        assert.strictEqual(ids.length, 1);
    });

    test('limit is clamped to MAX (50)', async () => {
        for (let i = 0; i < 60; i++) {
            sessionIndex.upsert(makeSession(`s${i}`, 'copilot', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
        }
        const result = await tool.execute({ limit: 9999 });
        const ids = (result.content[0].text.match(/^ID:/gm) ?? []);
        assert.ok(ids.length <= 50);
    });

    test('tool has correct name', () => {
        assert.strictEqual(tool.name, 'chatwizard_list_recent');
    });

    test('inputSchema has no required fields', () => {
        const schema = tool.inputSchema as { required?: string[] };
        assert.deepStrictEqual(schema.required ?? [], []);
    });
});
