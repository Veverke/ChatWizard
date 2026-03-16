// test/suite/timelineViewProvider.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { TimelineViewProvider } from '../../src/timeline/timelineViewProvider';

// ── getShellHtml — structure ───────────────────────────────────────────────────

suite('TimelineViewProvider.getShellHtml', () => {

    test('returns a valid DOCTYPE html document', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
        assert.ok(html.includes('<html>'), 'should have html tag');
        assert.ok(html.includes('</html>'), 'should close html tag');
    });

    test('uses unsafe-inline CSP (no nonce)', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes("'unsafe-inline'"), 'should use unsafe-inline');
        assert.ok(!html.includes('nonce-'), 'should not use nonce-based CSP');
    });

    test('filter bar has source, workspace, and jump-to-month dropdowns', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="srcFilter"'), 'should have source filter');
        assert.ok(html.includes('id="wsFilter"'), 'should have workspace filter');
        assert.ok(html.includes('id="jumpDate"'), 'should have month jump dropdown');
    });

    test('jump-to control is a select element (not a date input)', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(!html.includes('type="date"'), 'should not have date input');
        assert.ok(html.includes('id="jumpDate"'), 'should have jumpDate select');
        // The jumpDate element should be a select (check for onchange="jumpToMonth")
        assert.ok(html.includes('jumpToMonth'), 'should call jumpToMonth function');
    });

    test('contains freshness-bar element', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="freshness-bar"'), 'should have freshness-bar');
    });

    test('contains timeline-content container', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="timeline-content"'), 'should have timeline-content div');
    });

    test('contains load-more-container', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="load-more-container"'), 'should have load-more-container');
    });

    test('script contains acquireVsCodeApi and ready signal', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('acquireVsCodeApi'), 'should acquire VS Code API');
        assert.ok(html.includes("'ready'"), 'should signal ready to extension');
    });

    test('script contains renderTimeline and appendMonths functions', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderTimeline'), 'should have renderTimeline');
        assert.ok(html.includes('function appendMonths'), 'should have appendMonths');
    });

    test('script contains jumpToMonth function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function jumpToMonth'), 'should have jumpToMonth function');
    });

    test('script contains keyboard handler for Enter/Space', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('keydown'), 'should have keydown listener');
        assert.ok(html.includes("'Enter'") || html.includes('"Enter"'), 'should handle Enter key');
    });

    test('entry elements have role=button and tabindex', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('role="button"'), 'entries should have role=button');
        assert.ok(html.includes('tabindex="0"'), 'entries should be keyboard focusable');
    });

    test('empty-state-guided CSS is present', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('empty-state-guided'), 'should have empty-state-guided CSS class');
    });

    test('cw-badge-copilot and cw-badge-claude are referenced in script', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('cw-badge-copilot'), 'should reference copilot badge class');
        assert.ok(html.includes('cw-badge-claude'), 'should reference claude badge class');
    });

    test('openSettings command is wired to configure-paths CTA', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('openSettings'), 'should post openSettings command');
    });

    test('skeleton placeholder is present for initial loading state', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('cw-tl-skeleton') || html.includes('cw-skeleton'), 'should have skeleton placeholder');
    });
});
