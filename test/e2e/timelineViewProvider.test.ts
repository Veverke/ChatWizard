// test/suite/timelineViewProvider.test.ts

import * as assert from 'assert';
import { TimelineViewProvider } from '../../src/timeline/timelineViewProvider';

// â”€â”€ getShellHtml â€” structure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    test('filter bar has source and jump-to-month dropdowns', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="srcFilter"'), 'should have source filter');
        assert.ok(!html.includes('id="wsFilter"'), 'should not have workspace filter (managed at workspace level)');
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

// ── New feature elements ──────────────────────────────────────────────────────

suite('TimelineViewProvider.getShellHtml — new features', () => {

    test('contains stats-banner element', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="stats-banner"'), 'should have stats-banner');
    });

    test('contains on-this-day element', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="on-this-day"'), 'should have on-this-day');
    });

    test('contains drift-ribbon element', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="drift-ribbon"'), 'should have drift-ribbon');
    });

    test('contains heatmap-container element', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="heatmap-container"'), 'should have heatmap-container');
    });

    test('contains heatmap-section with day-filter-bar', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="heatmap-section"'), 'should have heatmap-section');
        assert.ok(html.includes('id="day-filter-bar"'), 'should have day-filter-bar');
    });

    test('contains search bar with tl-search input and tl-search-btn', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="tl-search"'), 'should have tl-search input');
        assert.ok(html.includes('id="tl-search-btn"'), 'should have tl-search-btn');
        assert.ok(html.includes('id="search-bar"'), 'should have search-bar');
    });

    test('script contains renderHeatMap function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderHeatMap'), 'should have renderHeatMap');
    });

    test('script contains renderStatsBanner function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderStatsBanner'), 'should have renderStatsBanner');
    });

    test('script contains renderOnThisDay function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderOnThisDay'), 'should have renderOnThisDay');
    });

    test('script contains renderDriftRibbon function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderDriftRibbon'), 'should have renderDriftRibbon');
    });

    test('script contains renderBurstHeaderHtml function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function renderBurstHeaderHtml'), 'should have renderBurstHeaderHtml');
    });

    test('script contains journal-note-area class reference', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('journal-note-area'), 'should reference journal-note-area class');
    });

    test('script contains filterByDay command', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('filterByDay'), 'should post filterByDay command for heatmap clicks');
    });

    test('script contains setSearchQuery command', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('setSearchQuery'), 'should post setSearchQuery command');
    });

    test('script contains saveNote command', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('saveNote'), 'should post saveNote command');
    });

    test('script handles searchResult message type', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('searchResult'), 'should handle searchResult message');
    });

    test('script handles noteUpdate message type', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('noteUpdate'), 'should handle noteUpdate message');
    });

    test('hm-cell class is referenced in CSS and script', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('hm-cell'), 'should have hm-cell class');
    });

    test('burst-header class is referenced in CSS', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('burst-header'), 'should have burst-header CSS class');
    });

    test('tool-switch-highlight class is referenced in CSS', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('tool-switch-highlight'), 'should have tool-switch-highlight CSS class');
    });

    test('tl-first-match class is referenced in CSS', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('tl-first-match'), 'should have tl-first-match CSS class for search highlight');
    });
});

