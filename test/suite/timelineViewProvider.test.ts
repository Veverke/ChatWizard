// test/suite/timelineViewProvider.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { TimelineViewProvider, TimelineFilter } from '../../src/timeline/timelineViewProvider';
import { TimelineEntry } from '../../src/timeline/timelineBuilder';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TimelineEntry>): TimelineEntry {
    return {
        sessionId: 'session-1',
        sessionTitle: 'Test Session',
        source: 'copilot',
        workspacePath: '/workspace/project',
        workspaceName: 'project',
        date: '2026-03-11',
        timestamp: 1741651200000,
        firstPrompt: 'Hello world',
        messageCount: 4,
        promptCount: 2,
        ...overrides,
    };
}

// ── getHtml — empty state ─────────────────────────────────────────────────────

suite('TimelineViewProvider.getHtml', () => {

    test('empty entries renders empty-state, no entry class', () => {
        const html = TimelineViewProvider.getHtml([]);
        assert.ok(html.includes('empty-state'), 'should have class empty-state');
        assert.ok(!html.includes('class="entry"'), 'should not have any entry divs');
    });

    // ── single entry ─────────────────────────────────────────────────────────

    test('single entry renders title, workspaceName, date, and firstPrompt', () => {
        const entry = makeEntry({
            sessionTitle: 'My First Session',
            workspaceName: 'my-project',
            date: '2026-01-15',
            firstPrompt: 'Explain closures in JS',
        });
        const html = TimelineViewProvider.getHtml([entry]);
        assert.ok(html.includes('My First Session'), 'should contain session title');
        assert.ok(html.includes('my-project'), 'should contain workspace name');
        assert.ok(html.includes('2026-01-15'), 'should contain date');
        assert.ok(html.includes('Explain closures in JS'), 'should contain firstPrompt');
    });

    // ── month grouping ────────────────────────────────────────────────────────

    test('multiple entries in same month produce a single month-group', () => {
        const entries = [
            makeEntry({ sessionId: 's1', date: '2026-03-10', timestamp: 1741564800000 }),
            makeEntry({ sessionId: 's2', date: '2026-03-05', timestamp: 1741132800000 }),
        ];
        const html = TimelineViewProvider.getHtml(entries);
        const monthGroupMatches = html.match(/class="month-group"/g) ?? [];
        assert.strictEqual(monthGroupMatches.length, 1, 'should have exactly 1 month-group');
    });

    test('entries from 2 different months produce 2 month-group divs', () => {
        const entries = [
            makeEntry({ sessionId: 's1', date: '2026-03-10', timestamp: 1741564800000 }),
            makeEntry({ sessionId: 's2', date: '2026-02-05', timestamp: 1738713600000 }),
        ];
        const html = TimelineViewProvider.getHtml(entries);
        const monthGroupMatches = html.match(/class="month-group"/g) ?? [];
        assert.strictEqual(monthGroupMatches.length, 2, 'should have 2 month-group divs');
    });

    // ── source labels ─────────────────────────────────────────────────────────

    test('copilot source entry contains "Copilot" label', () => {
        const entry = makeEntry({ source: 'copilot' });
        const html = TimelineViewProvider.getHtml([entry]);
        assert.ok(html.includes('Copilot'), 'should show Copilot label');
    });

    test('claude source entry contains "Claude" label', () => {
        const entry = makeEntry({ source: 'claude' });
        const html = TimelineViewProvider.getHtml([entry]);
        assert.ok(html.includes('Claude'), 'should show Claude label');
    });

    // ── filter bar pre-selection ──────────────────────────────────────────────

    test('filter.source = copilot marks copilot option as selected', () => {
        const filter: TimelineFilter = { source: 'copilot' };
        const html = TimelineViewProvider.getHtml([], filter);
        assert.ok(html.includes('value="copilot" selected'), 'copilot option should be selected');
    });

    test('filter.workspacePath = /foo/bar marks that workspace option as selected', () => {
        const entries = [
            makeEntry({ workspacePath: '/foo/bar', workspaceName: 'bar' }),
        ];
        const filter: TimelineFilter = { workspacePath: '/foo/bar' };
        const html = TimelineViewProvider.getHtml(entries, filter);
        assert.ok(html.includes('selected'), 'workspace option should be selected');
        // The option value should be the escaped path and marked selected
        assert.ok(html.includes('/foo/bar'), 'workspace path should appear in option');
    });

    // ── empty firstPrompt ─────────────────────────────────────────────────────

    test('entry with empty firstPrompt shows (no prompt)', () => {
        const entry = makeEntry({ firstPrompt: '' });
        const html = TimelineViewProvider.getHtml([entry]);
        assert.ok(html.includes('(no prompt)'), 'should show (no prompt) placeholder');
    });

    // ── HTML escaping ─────────────────────────────────────────────────────────

    test('entry title containing <script> is HTML-escaped', () => {
        const entry = makeEntry({ sessionTitle: '<script>alert("xss")</script>' });
        const html = TimelineViewProvider.getHtml([entry]);
        assert.ok(!html.includes('<script>alert'), 'raw script tag must not appear in output');
        assert.ok(html.includes('&lt;script&gt;'), 'angle brackets must be escaped');
    });

    // ── script tag presence ───────────────────────────────────────────────────

    test('HTML output contains the jumpToDate function', () => {
        const html = TimelineViewProvider.getHtml([]);
        assert.ok(html.includes('function jumpToDate'), 'should contain jumpToDate function');
    });

    // ── unique workspace options ──────────────────────────────────────────────

    test('two entries with same workspacePath produce only one workspace option', () => {
        const entries = [
            makeEntry({ sessionId: 's1', workspacePath: '/shared/ws', workspaceName: 'ws' }),
            makeEntry({ sessionId: 's2', workspacePath: '/shared/ws', workspaceName: 'ws' }),
        ];
        const html = TimelineViewProvider.getHtml(entries);
        // Count occurrences of the workspace path as an option value
        const optionMatches = html.match(/value="\/shared\/ws"/g) ?? [];
        assert.strictEqual(optionMatches.length, 1, 'should have exactly one option for the shared workspace');
    });
});
