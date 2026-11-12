/**
 * test/unit/logFilters.test.ts
 *
 * Phase 4 — filters + search for the watch-logs Commands view.
 *
 * The predicates are pure, so these tests run without a VS Code host. They
 * cover the search facets per event kind (including multi-word AND and
 * case-insensitivity), the failure definition (failed commands +
 * non-warning errors) and the combined `matchesLogFilters` intersection.
 */

import * as assert from 'assert';
import {
    LogViewFilters,
    describeLogFilters,
    emptyLogFilters,
    eventSearchText,
    filterEvents,
    hasActiveFilters,
    isFailedCommand,
    isFailureEvent,
    matchesLogFilters,
    matchesSearch,
    normalizeSearchQuery,
    searchTokens,
} from '../../src/logs/logFilters';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    PlannerStepEvent,
    ToolCallEvent,
} from '../../src/logs/types';

function cmd(overrides: Partial<CommandEvent> & { id: string }): CommandEvent {
    return {
        type: 'command',
        timestamp: '2026-01-01T10:00:00.000Z',
        tool: 'copilot',
        commandText: 'npm test',
        ...overrides,
    } as CommandEvent;
}

suite('logFilters — query normalisation', () => {
    test('blank queries mean "no search"', () => {
        assert.strictEqual(normalizeSearchQuery(undefined), undefined);
        assert.strictEqual(normalizeSearchQuery(''), undefined);
        assert.strictEqual(normalizeSearchQuery('   '), undefined);
        assert.strictEqual(normalizeSearchQuery('  npm test '), 'npm test');
    });

    test('searchTokens splits on whitespace and lower-cases', () => {
        assert.deepStrictEqual(searchTokens(undefined), []);
        assert.deepStrictEqual(searchTokens('  '), []);
        assert.deepStrictEqual(searchTokens('NPM   Test'), ['npm', 'test']);
    });
});

suite('logFilters — searchable text per event kind', () => {
    test('command text, cwd, shell and output summaries are searchable', () => {
        const text = eventSearchText(cmd({
            id: 'c1',
            commandText: 'npm run build',
            cwd: '/repo/app',
            shell: 'pwsh',
            stdoutSummary: 'built in 4s',
            stderrSummary: 'warning: deprecated',
        }));
        for (const needle of ['npm run build', '/repo/app', 'pwsh', 'built in 4s', 'deprecated']) {
            assert.ok(text.includes(needle), `expected "${needle}" in search text`);
        }
    });

    test('file operations expose operation type, path, old path and detail', () => {
        const event = {
            type: 'fileOperation',
            id: 'f1',
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'cline',
            operationType: 'move',
            filePath: '/repo/src/new.ts',
            oldPath: '/repo/src/old.ts',
            detail: 'renamed by agent',
        } as FileOperationEvent;
        const text = eventSearchText(event);
        assert.ok(text.includes('move'));
        assert.ok(text.includes('/repo/src/new.ts'));
        assert.ok(text.includes('/repo/src/old.ts'));
        assert.ok(text.includes('renamed by agent'));
    });

    test('diffs search file path and patch text', () => {
        const event = {
            type: 'diff',
            id: 'd1',
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'copilot',
            filePath: '/repo/src/app.ts',
            diffText: '+const retry = 3;',
        } as DiffEvent;
        const text = eventSearchText(event);
        assert.ok(text.includes('/repo/src/app.ts'));
        assert.ok(text.includes('retry = 3'));
    });

    test('tool calls search name, result summary and JSON arguments', () => {
        const event = {
            type: 'toolCall',
            id: 't1',
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'copilot',
            toolName: 'run_in_terminal',
            resultSummary: 'exit 0',
            arguments: { command: 'git status' },
        } as ToolCallEvent;
        const text = eventSearchText(event);
        assert.ok(text.includes('run_in_terminal'));
        assert.ok(text.includes('exit 0'));
        assert.ok(text.includes('git status'));
    });

    test('errors search message and stack trace', () => {
        const event = {
            type: 'error',
            id: 'e1',
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'cline',
            message: 'TS2307 Cannot find module',
            stackTrace: 'at foo (/repo/src/foo.ts:1:1)',
        } as ErrorEvent;
        const text = eventSearchText(event);
        assert.ok(text.includes('TS2307'));
        assert.ok(text.includes('/repo/src/foo.ts'));
    });

    test('planner steps search description, status and step type', () => {
        const event = {
            type: 'plannerStep',
            id: 'p1',
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'antigravity',
            description: 'Run the test suite',
            status: 'completed',
            stepType: 'verify',
        } as PlannerStepEvent;
        const text = eventSearchText(event);
        assert.ok(text.includes('Run the test suite'));
        assert.ok(text.includes('completed'));
        assert.ok(text.includes('verify'));
    });
});

suite('logFilters — matchesSearch', () => {
    const build = cmd({ id: 'c1', commandText: 'NPM Run Build', sessionId: 's1', workspacePath: 'C:\\Repos\\App' });

    test('matching is case-insensitive', () => {
        assert.strictEqual(matchesSearch(build, 'npm run'), true);
        assert.strictEqual(matchesSearch(build, 'NPM'), true);
    });

    test('multiple words are AND-ed', () => {
        assert.strictEqual(matchesSearch(build, 'npm build'), true);
        assert.strictEqual(matchesSearch(build, 'npm deploy'), false);
    });

    test('the agent name and workspace path are searchable', () => {
        assert.strictEqual(matchesSearch(build, 'copilot'), true);
        assert.strictEqual(matchesSearch(build, 'repos\\app'), true);
    });

    test('an empty query matches everything', () => {
        assert.strictEqual(matchesSearch(build, undefined), true);
        assert.strictEqual(matchesSearch(build, '   '), true);
    });
});

suite('logFilters — failure definition', () => {
    test('failed commands require a non-zero exit code', () => {
        assert.strictEqual(isFailedCommand(cmd({ id: 'c1', exitCode: 0 })), false);
        assert.strictEqual(isFailedCommand(cmd({ id: 'c2', exitCode: 1 })), true);
        assert.strictEqual(isFailedCommand(cmd({ id: 'c3', exitCode: undefined })), false);
        assert.strictEqual(
            isFailedCommand({ type: 'error', id: 'e1', timestamp: '', tool: 'cline', message: 'x' } as LogEvent),
            false
        );
    });

    test('error events are failures unless they are warnings', () => {
        const error = (severity?: ErrorEvent['severity']): ErrorEvent => ({
            type: 'error',
            id: `e-${severity ?? 'none'}`,
            timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'cline',
            message: 'boom',
            severity,
        } as ErrorEvent);
        assert.strictEqual(isFailureEvent(error(undefined)), true);
        assert.strictEqual(isFailureEvent(error('error')), true);
        assert.strictEqual(isFailureEvent(error('fatal')), true);
        assert.strictEqual(isFailureEvent(error('warning')), false);
    });
});

suite('logFilters — combined filters', () => {
    const failingCopilot = cmd({ id: 'c1', sessionId: 's1', exitCode: 2, commandText: 'npm test' });
    const passingCline = cmd({ id: 'c2', sessionId: 's2', tool: 'cline', exitCode: 0, commandText: 'git status' });
    const warning = {
        type: 'error',
        id: 'e1',
        timestamp: '2026-01-01T10:00:00.000Z',
        tool: 'copilot',
        message: 'deprecated flag',
        severity: 'warning',
    } as ErrorEvent;
    const events: LogEvent[] = [failingCopilot, passingCline, warning];

    test('types / tool / failures / search intersect', () => {
        assert.deepStrictEqual(
            filterEvents(events, { types: ['command'] }).map((e) => e.id),
            ['c1', 'c2']
        );
        assert.deepStrictEqual(
            filterEvents(events, { tool: 'cline' }).map((e) => e.id),
            ['c2']
        );
        assert.deepStrictEqual(
            filterEvents(events, { failuresOnly: true }).map((e) => e.id),
            ['c1']
        );
        assert.deepStrictEqual(
            filterEvents(events, { failuresOnly: true, tool: 'cline' }),
            []
        );
        assert.deepStrictEqual(
            filterEvents(events, { search: 'git', types: ['command'] }).map((e) => e.id),
            ['c2']
        );
    });

    test('matchesLogFilters is true for an empty filter set', () => {
        for (const event of events) {
            assert.strictEqual(matchesLogFilters(event, emptyLogFilters()), true);
        }
    });
});

suite('logFilters — filter descriptions', () => {
    test('hasActiveFilters detects every dimension', () => {
        assert.strictEqual(hasActiveFilters({}), false);
        assert.strictEqual(hasActiveFilters({ search: '  ' }), false);
        assert.strictEqual(hasActiveFilters({ search: 'npm' }), true);
        assert.strictEqual(hasActiveFilters({ tool: 'cline' }), true);
        assert.strictEqual(hasActiveFilters({ failuresOnly: true }), true);
        assert.strictEqual(hasActiveFilters({ types: [] }), false);
        assert.strictEqual(hasActiveFilters({ types: ['error'] }), true);
    });

    test('describeLogFilters summarises the active filters', () => {
        assert.strictEqual(describeLogFilters({}), '');
        const filters: LogViewFilters = {
            search: 'npm test',
            tool: 'copilot',
            failuresOnly: true,
            types: ['error'],
        };
        assert.strictEqual(
            describeLogFilters(filters, (tool) => (tool === 'copilot' ? 'GitHub Copilot' : tool)),
            '"npm test" · GitHub Copilot · failures only · kind: Error / Failure'
        );
    });
});


