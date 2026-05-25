// test/e2e/sessionTreeViewSummary.test.ts
//
// Tests for the AI-generated summary displayed in session tree-item tooltips
// (Feature 18-C: Summary in tree tooltip).
//
// The summary is stored in SidecarMetadataStore and forwarded to SessionTreeItem
// as the 5th constructor argument.  These tests verify the full path:
//   SidecarMetadataStore → index.getSidecarMeta() → SessionTreeProvider → SessionTreeItem.tooltip

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SessionIndex } from '../../src/index/sessionIndex';
import { SessionTreeProvider, SessionTreeItem, DateGroupTreeItem } from '../../src/views/sessionTreeProvider';
import { SidecarMetadataStore } from '../../src/index/sidecarMetadataStore';
import { Session } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
        id,
        title:       overrides.title       ?? `Session ${id}`,
        source:      overrides.source      ?? 'copilot',
        workspaceId: overrides.workspaceId ?? 'ws-default',
        workspacePath: '/home/user/project',
        messages: [
            { id: `${id}-u`, role: 'user',      content: 'Hello', codeBlocks: [] },
            { id: `${id}-a`, role: 'assistant', content: 'Hi',    codeBlocks: [] },
        ],
        filePath:   `/tmp/${id}.jsonl`,
        createdAt:  '2026-01-01T00:00:00.000Z',
        updatedAt:  overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    };
}

async function collectAllItems(provider: SessionTreeProvider): Promise<SessionTreeItem[]> {
    const rootChildren = await provider.getChildren(undefined);
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

/** Extract the raw tooltip string from a SessionTreeItem (works for both MarkdownString and plain string). */
function tooltipText(item: SessionTreeItem): string {
    const tt = item.tooltip;
    if (!tt) { return ''; }
    if (typeof tt === 'string') { return tt; }
    return (tt as vscode.MarkdownString).value;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('SessionTreeItem — summary in tooltip (Feature 18-C)', function () {
    this.timeout(10_000);

    let tmpDir: string;
    let store: SidecarMetadataStore;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-summary-tree-test-'));
        store = new SidecarMetadataStore(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── No summary → tooltip DOES NOT contain "**Summary:**" ────────────────

    test('tooltip has no Summary section when sidecarMeta has no summary', async () => {
        const index = new SessionIndex();
        const session = makeSession('no-sum-1');
        index.upsert(session);

        // Wire the store but do NOT set a summary for this session.
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const items = await collectAllItems(provider);
        const item = items.find(i => i.summary.id === 'no-sum-1');
        assert.ok(item, 'session item must exist');

        const tt = tooltipText(item!);
        assert.ok(!tt.includes('**Summary:**'), `tooltip must NOT contain "**Summary:**" when no summary set, got:\n${tt}`);
    });

    // ── Summary present → tooltip DOES contain "**Summary:** <text>" ────────

    test('tooltip contains Summary section when summary is stored', async () => {
        const index = new SessionIndex();
        const session = makeSession('sum-1');
        index.upsert(session);

        // Store a summary for this session.
        await store.patch('sum-1', { summary: 'Fixed the auth middleware regression in production.' });
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const items = await collectAllItems(provider);
        const item = items.find(i => i.summary.id === 'sum-1');
        assert.ok(item, 'session item must exist');

        const tt = tooltipText(item!);
        assert.ok(tt.includes('**Summary:**'), `tooltip must contain "**Summary:**", got:\n${tt}`);
        assert.ok(tt.includes('Fixed the auth middleware regression'), `tooltip must contain the summary text, got:\n${tt}`);
    });

    // ── Summary appears AFTER tags line ──────────────────────────────────────

    test('summary section appears after tags line in tooltip', async () => {
        const index = new SessionIndex();
        const session = makeSession('order-1');
        index.upsert(session);

        await store.patch('order-1', {
            tags: ['bugfix', 'auth'],
            summary: 'Debugged the OAuth token expiry issue.',
        });
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const items = await collectAllItems(provider);
        const item = items.find(i => i.summary.id === 'order-1');
        assert.ok(item, 'session item must exist');

        const tt = tooltipText(item!);
        const tagsIdx    = tt.indexOf('**Tags:**');
        const summaryIdx = tt.indexOf('**Summary:**');

        assert.ok(tagsIdx    >= 0, `tooltip must contain "**Tags:**", got:\n${tt}`);
        assert.ok(summaryIdx >= 0, `tooltip must contain "**Summary:**", got:\n${tt}`);
        assert.ok(summaryIdx > tagsIdx, `"**Summary:**" must appear after "**Tags:**", tagsIdx=${tagsIdx}, summaryIdx=${summaryIdx}`);
    });

    // ── Summary visible with no tags (tagsLine is empty) ────────────────────

    test('summary section appears correctly when session has no tags', async () => {
        const index = new SessionIndex();
        const session = makeSession('notags-sum-1');
        index.upsert(session);

        await store.patch('notags-sum-1', { summary: 'Refactored the API client to use fetch.' });
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const items = await collectAllItems(provider);
        const item  = items.find(i => i.summary.id === 'notags-sum-1');
        assert.ok(item, 'session item must exist');

        const tt = tooltipText(item!);
        assert.ok(!tt.includes('**Tags:**'), 'no tags → no Tags section');
        assert.ok(tt.includes('**Summary:**'), 'summary must still appear without tags');
        assert.ok(tt.includes('Refactored the API client to use fetch.'), 'summary text must appear');
    });

    // ── Summary survives provider.refresh() ──────────────────────────────────

    test('summary persists after provider.refresh()', async () => {
        const index = new SessionIndex();
        const session = makeSession('refresh-sum-1');
        index.upsert(session);

        await store.patch('refresh-sum-1', { summary: 'Explored the new bundler configuration.' });
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        // First read to confirm it is there.
        let items = await collectAllItems(provider);
        let item = items.find(i => i.summary.id === 'refresh-sum-1');
        assert.ok(tooltipText(item!).includes('**Summary:**'), 'summary must appear before refresh');

        // Refresh the provider.
        provider.refresh();

        items = await collectAllItems(provider);
        item  = items.find(i => i.summary.id === 'refresh-sum-1');
        assert.ok(item, 'item must still exist after refresh');
        const tt = tooltipText(item!);
        assert.ok(tt.includes('**Summary:**'), 'summary must still appear after refresh');
        assert.ok(tt.includes('Explored the new bundler configuration.'), 'summary text must survive refresh');
    });

    // ── Two sessions: only the one with a summary shows the section ──────────

    test('only the session with a summary has the Summary section', async () => {
        const index = new SessionIndex();
        const sWithSum  = makeSession('both-sum',    { updatedAt: '2026-02-01T00:00:00.000Z' });
        const sNoSum    = makeSession('both-no-sum', { updatedAt: '2026-01-01T00:00:00.000Z' });
        index.upsert(sWithSum);
        index.upsert(sNoSum);

        await store.patch('both-sum', { summary: 'Implemented the new payment integration.' });
        const cache = await store.load();
        index.setSidecarStore(store, cache);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        const items = await collectAllItems(provider);
        const itemWithSum = items.find(i => i.summary.id === 'both-sum');
        const itemNoSum   = items.find(i => i.summary.id === 'both-no-sum');

        assert.ok(itemWithSum,  '"both-sum" item must exist');
        assert.ok(itemNoSum,    '"both-no-sum" item must exist');
        assert.ok(tooltipText(itemWithSum!).includes('**Summary:**'),
            '"both-sum" tooltip must contain summary section');
        assert.ok(!tooltipText(itemNoSum!).includes('**Summary:**'),
            '"both-no-sum" tooltip must NOT contain summary section');
    });

    // ── Realistic developer workflow: generate summary then inspect tooltip ──

    test('developer workflow: regenerated summary is visible in tree tooltip', async () => {
        // Simulate: developer runs "Regenerate Summary" which writes a new summary to the store.
        // Then the provider re-reads it on next render.
        const index = new SessionIndex();
        const session = makeSession('regen-sum-1', { title: 'Fix flaky WebSocket tests' });
        index.upsert(session);

        // Initially no summary.
        const cacheInitial = await store.load();
        index.setSidecarStore(store, cacheInitial);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');

        let items = await collectAllItems(provider);
        let item = items.find(i => i.summary.id === 'regen-sum-1');
        assert.ok(!tooltipText(item!).includes('**Summary:**'), 'no summary before regeneration');

        // Simulate regeneration: patch the store and re-wire the cache.
        await store.patch('regen-sum-1', { summary: 'Investigated WebSocket disconnects under high load; added retry logic.' });
        const cacheUpdated = await store.load();
        index.setSidecarStore(store, cacheUpdated);

        provider.refresh();
        items = await collectAllItems(provider);
        item  = items.find(i => i.summary.id === 'regen-sum-1');

        const tt = tooltipText(item!);
        assert.ok(tt.includes('**Summary:**'), 'summary must appear after regeneration');
        assert.ok(tt.includes('retry logic'), 'regenerated summary text must appear in tooltip');
    });
});
