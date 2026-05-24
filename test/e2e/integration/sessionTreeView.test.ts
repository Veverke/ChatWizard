// test/suite/integration/sessionTreeView.test.ts
//
// Integration tests — Sessions Tree View (scenarios 11–19)
//
// Exercises SessionTreeProvider directly (no VS Code host required for most
// assertions). The provider is constructed with a live SessionIndex so the
// tests verify the full sort → filter → group → paginate pipeline.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionIndex } from '../../../src/index/sessionIndex';
import { SessionTreeProvider, SessionTreeItem, DateGroupTreeItem, LoadMoreTreeItem } from '../../../src/views/sessionTreeProvider';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import { parseClaudeSession } from '../../../src/parsers/claude';
import { writeCopilotSessions } from '../../helpers/fixtureFactory';
import { Session } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX = path.join(FIXTURES, 'copilot');
const CLAUDE_FX  = path.join(FIXTURES, 'claude');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal session suitable for tree-view tests. */
function makeSession(overrides: Partial<Session> & { id: string }): Session {
    const { id, ...rest } = overrides;
    return {
        id,
        title: rest.title ?? `Session ${id}`,
        source: rest.source ?? 'copilot',
        workspaceId: rest.workspaceId ?? 'ws-default',
        workspacePath: rest.workspacePath ?? '/home/user/project',
        messages: rest.messages ?? [
            { id: `${id}-u`, role: 'user',      content: 'Hello', codeBlocks: [] },
            { id: `${id}-a`, role: 'assistant', content: 'Hi',    codeBlocks: [] },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt:  rest.createdAt  ?? '2026-01-01T00:00:00.000Z',
        updatedAt:  rest.updatedAt  ?? '2026-01-01T00:00:00.000Z',
        model:      rest.model,
    };
}

/**
 * Call getChildren(undefined) on the provider and collect all SessionTreeItems
 * from the flat list or from inside DateGroupTreeItems, so tests always get
 * the leaf items regardless of grouping mode.
 */
async function collectSessionItems(
    provider: SessionTreeProvider,
    element?: Parameters<SessionTreeProvider['getChildren']>[0]
): Promise<SessionTreeItem[]> {
    const rootChildren = await provider.getChildren(element);
    const items: SessionTreeItem[] = [];
    for (const child of rootChildren) {
        if (child instanceof SessionTreeItem) {
            items.push(child);
        } else if (child instanceof DateGroupTreeItem) {
            const nested = await provider.getChildren(child);
            for (const n of nested) {
                if (n instanceof SessionTreeItem) { items.push(n); }
            }
        }
    }
    return items;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Sessions Tree View', function () {
    this.timeout(20_000);

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-treeview-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Test 11: Population ───────────────────────────────────────────────

    test('11 — tree view is non-empty after indexing fixture data', async () => {
        const index = new SessionIndex();
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-11'
        );
        index.upsert(session);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none'); // flat list for simplicity

        const items = await collectSessionItems(provider);
        assert.ok(items.length >= 1, 'expected at least one session item');
    });

    // ── Test 12: Sort by date desc ────────────────────────────────────────

    test('12 — sort by date desc places newest session first', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-old', updatedAt: '2024-01-01T00:00:00.000Z', title: 'Old' }));
        index.upsert(makeSession({ id: 's-new', updatedAt: '2026-01-01T00:00:00.000Z', title: 'New' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        // Default sortStack is already { key: 'date', direction: 'desc' };
        // do NOT call setSortMode('date') here as it would toggle to 'asc'.

        const items = await collectSessionItems(provider);
        assert.ok(items.length >= 2);
        assert.strictEqual(items[0].summary.id, 's-new', 'newest should be first');
        assert.strictEqual(items[1].summary.id, 's-old');
    });

    test('12b — toggling sort to asc reverses order', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-old', updatedAt: '2024-01-01T00:00:00.000Z' }));
        index.upsert(makeSession({ id: 's-new', updatedAt: '2026-01-01T00:00:00.000Z' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setSortMode('date'); // one call toggles default 'desc' → 'asc'

        const items = await collectSessionItems(provider);
        assert.strictEqual(items[0].summary.id, 's-old', 'oldest should be first in asc mode');
    });

    // ── Test 13: Sort by workspace ────────────────────────────────────────

    test('13 — sort by workspace groups sessions by workspace path basename', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-z', workspacePath: '/home/user/zebra-project' }));
        index.upsert(makeSession({ id: 's-a', workspacePath: '/home/user/alpha-project' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setSortMode('workspace'); // asc by default

        const items = await collectSessionItems(provider);
        assert.strictEqual(items[0].summary.id, 's-a', 'alpha should sort before zebra');
    });

    // ── Test 14: Sort by model ────────────────────────────────────────────

    test('14 — sort by model groups gpt-4o before gpt-4o-mini (alphabetically)', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-mini', model: 'gpt-4o-mini' }));
        index.upsert(makeSession({ id: 's-full', model: 'gpt-4o' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setSortMode('model'); // asc

        const items = await collectSessionItems(provider);
        // 'gpt-4o' < 'gpt-4o-mini' lexicographically
        assert.strictEqual(items[0].summary.id, 's-full');
        assert.strictEqual(items[1].summary.id, 's-mini');
    });

    // ── Test 15: Group by date ────────────────────────────────────────────

    test('15 — groupMode=date produces DateGroupTreeItem nodes at root', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'sg-1', updatedAt: new Date().toISOString() }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('date');

        const root = await provider.getChildren(undefined);
        const groups = root.filter(n => n instanceof DateGroupTreeItem);
        assert.ok(groups.length >= 1, 'expected at least one date group');
    });

    // ── Test 16: Flat list toggle ─────────────────────────────────────────

    test('16 — groupMode=none produces only SessionTreeItems at root', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'sf-1', updatedAt: new Date().toISOString() }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const root = await provider.getChildren(undefined);
        const dateGroups = root.filter(n => n instanceof DateGroupTreeItem);
        assert.strictEqual(dateGroups.length, 0, 'expected no date group nodes in flat mode');
    });

    // ── Test 17: Pagination ───────────────────────────────────────────────

    test('17 — loadMore() exposes additional sessions beyond page-size 200', async () => {
        const paginationDir = path.join(tmpDir, 'pagination');
        writeCopilotSessions(paginationDir, 201);

        const index = new SessionIndex();
        for (const file of fs.readdirSync(paginationDir)) {
            const { session } = parseCopilotSession(path.join(paginationDir, file), 'ws-pagination');
            index.upsert(session);
        }

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const rootBefore = await provider.getChildren(undefined);
        const loadMoreItems = rootBefore.filter(n => n instanceof LoadMoreTreeItem);
        assert.ok(loadMoreItems.length === 1, 'expected exactly one LoadMore item when > 200 sessions');

        // Simulate clicking "Load More"
        provider.loadMore();

        const rootAfter = await provider.getChildren(undefined);
        const loadMoreAfter = rootAfter.filter(n => n instanceof LoadMoreTreeItem);
        assert.strictEqual(loadMoreAfter.length, 0, 'all 201 sessions should now be visible');

        const sessionItems = rootAfter.filter(n => n instanceof SessionTreeItem);
        assert.strictEqual(sessionItems.length, 201, 'all 201 sessions should be present');
    });

    // ── Test 18: Pin / Unpin ──────────────────────────────────────────────

    test('18 — pinned session appears first regardless of sort', async () => {
        const index = new SessionIndex();
        const newer = makeSession({ id: 's-newer', updatedAt: '2026-06-01T00:00:00.000Z', title: 'Newer' });
        const older = makeSession({ id: 's-older', updatedAt: '2024-01-01T00:00:00.000Z', title: 'Older (pinned)' });
        index.upsert(newer);
        index.upsert(older);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setSortMode('date'); // desc → newer first by default

        // Pin the older session
        provider.pin('s-older');

        const items = await collectSessionItems(provider);
        assert.strictEqual(items[0].summary.id, 's-older', 'pinned session should be first');
        assert.ok(items[0].pinned, 'pinned property should be true');
    });

    test('18b — unpinned session returns to sort order', async () => {
        const index = new SessionIndex();
        const newer = makeSession({ id: 's-newer', updatedAt: '2026-06-01T00:00:00.000Z' });
        const older = makeSession({ id: 's-older', updatedAt: '2024-01-01T00:00:00.000Z' });
        index.upsert(newer);
        index.upsert(older);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        // Default is already { key: 'date', direction: 'desc' }; no setSortMode needed.
        provider.pin('s-older');
        provider.unpin('s-older');

        const items = await collectSessionItems(provider);
        assert.strictEqual(items[0].summary.id, 's-newer', 'after unpin, sort order is restored');
    });

    // ── Test 19: Filter ───────────────────────────────────────────────────

    test('19 — setFilter(title) narrows results to matching sessions only', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-css', title: 'How to center a div in CSS' }));
        index.upsert(makeSession({ id: 's-ts',  title: 'TypeScript generic constraints' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ title: 'CSS' });

        const items = await collectSessionItems(provider);
        assert.strictEqual(items.length, 1, 'filter should return only the CSS session');
        assert.strictEqual(items[0].summary.id, 's-css');
    });

    test('19b — setFilter(source) restricts to a single source', async () => {
        const index = new SessionIndex();
        const { session: copilotSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-19'
        );
        const { session: claudeSession } = parseClaudeSession(
            path.join(CLAUDE_FX, 'sample-session.jsonl')
        );
        index.upsert(copilotSession);
        index.upsert(claudeSession);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ source: 'copilot' });

        const items = await collectSessionItems(provider);
        assert.ok(items.every(i => i.summary.source === 'copilot'), 'all items should be copilot');
        assert.ok(items.length >= 1);
    });

    test('19c — setFilter(model) restricts to sessions with matching model', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's-gpt',    model: 'gpt-4o',     title: 'GPT session' }));
        index.upsert(makeSession({ id: 's-claude', model: 'claude-3-opus', title: 'Claude session' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ model: 'gpt' });

        const items = await collectSessionItems(provider);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].summary.id, 's-gpt');
    });

    test('19d — clearFilter restores all sessions', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 's1', title: 'Alpha' }));
        index.upsert(makeSession({ id: 's2', title: 'Beta' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ title: 'Alpha' });

        const filtered = await collectSessionItems(provider);
        assert.strictEqual(filtered.length, 1);

        provider.clearFilter();
        const all = await collectSessionItems(provider);
        assert.strictEqual(all.length, 2);
    });

    test('19e — hasActiveFilter returns true when filter is set', () => {
        const index = new SessionIndex();
        const provider = new SessionTreeProvider(index);

        assert.strictEqual(provider.hasActiveFilter(), false);
        provider.setFilter({ title: 'test' });
        assert.strictEqual(provider.hasActiveFilter(), true);
        provider.clearFilter();
        assert.strictEqual(provider.hasActiveFilter(), false);
    });

    // ── Archived session display ─────────────────────────────────────────

    test('20a — archived session shows "· archived" suffix in description', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'arch-tree-1', archived: true, title: 'Archived Session' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        const items = await collectSessionItems(provider);
        const item = items.find(i => i.summary.id === 'arch-tree-1');
        assert.ok(item !== undefined, 'archived session should appear in the tree');
        assert.ok(
            typeof item!.description === 'string' && item!.description.includes('· archived'),
            `Expected description to contain "· archived", got: "${item!.description}"`
        );
    });

    test('20b — non-archived session does NOT show "· archived" in description', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'live-tree-1', title: 'Live Session' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        const items = await collectSessionItems(provider);
        const item = items.find(i => i.summary.id === 'live-tree-1');
        assert.ok(item !== undefined, 'live session should appear in the tree');
        assert.ok(
            typeof item!.description !== 'string' || !item!.description.includes('· archived'),
            `Expected description NOT to contain "· archived", got: "${item!.description}"`
        );
    });

    test('20c — archived session has contextValue "session.archived"', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'arch-ctx-1', archived: true }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        const items = await collectSessionItems(provider);
        const item = items.find(i => i.summary.id === 'arch-ctx-1');
        assert.ok(item !== undefined);
        assert.strictEqual(item!.contextValue, 'session.archived');
    });

    test('20d — non-archived session has contextValue "session"', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'live-ctx-1' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        const items = await collectSessionItems(provider);
        const item = items.find(i => i.summary.id === 'live-ctx-1');
        assert.ok(item !== undefined);
        assert.strictEqual(item!.contextValue, 'session');
    });

    test('20e — pinned session retains contextValue "session.pinned" even when archived=true', async () => {
        // Pinned takes precedence over archived in the contextValue logic
        const index = new SessionIndex();
        const session = makeSession({ id: 'pinned-arch-1', archived: true });
        index.upsert(session);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setPinnedIds(['pinned-arch-1']);
        const items = await collectSessionItems(provider);
        const item = items.find(i => i.summary.id === 'pinned-arch-1');
        assert.ok(item !== undefined);
        assert.strictEqual(item!.contextValue, 'session.pinned',
            'pinned takes precedence over archived in contextValue');
    });

    test('20f — archived and non-archived sessions coexist in same flat list', async () => {
        const index = new SessionIndex();
        index.upsert(makeSession({ id: 'mixed-live', title: 'Live' }));
        index.upsert(makeSession({ id: 'mixed-arch', title: 'Archived', archived: true }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        const items = await collectSessionItems(provider);

        assert.strictEqual(items.length, 2, 'both sessions should appear');
        const liveItem = items.find(i => i.summary.id === 'mixed-live');
        const archItem = items.find(i => i.summary.id === 'mixed-arch');

        assert.strictEqual(liveItem!.contextValue, 'session');
        assert.strictEqual(archItem!.contextValue, 'session.archived');
    });

});
