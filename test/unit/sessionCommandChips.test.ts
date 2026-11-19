/**
 * test/unit/sessionCommandChips.test.ts
 *
 * The reader's per-response **Commands** chip is built by a pure module, so
 * these tests run without a VS Code host. They cover the correlation rules
 * (timestamps, turn indexes, dropped events), the chip aggregation (Git vs
 * terminal commands, tool calls, file changes, errors, paired patch/diff
 * suppression) and the rendered HTML (collapsed by default, escaped, slots
 * appended by `renderChunk`).
 */

import * as assert from 'assert';
import {
    MAX_ROWS_PER_SECTION,
    buildCommandChipHtml,
    buildCommandChips,
    formatCommandChipSummary,
    isGitCommand,
    renderCommandChip,
} from '../../src/views/sessionCommandChips';
import { renderChunk } from '../../src/views/sessionRenderer';
import type { Message } from '../../src/types/index';
import type {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    ToolCallEvent,
} from '../../src/logs/types';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:10:00.000Z';

function msg(role: 'user' | 'assistant', content: string, timestamp?: string): Message {
    return {
        id: `m-${Math.random()}`,
        role,
        content,
        codeBlocks: [],
        ...(timestamp ? { timestamp } : {}),
    };
}

function command(
    id: string,
    text: string,
    timestamp = T0,
    exitCode?: number
): CommandEvent {
    return {
        id,
        type: 'command',
        timestamp,
        tool: 'cline',
        sessionId: 's1',
        commandText: text,
        exitCode,
    };
}

function toolCall(id: string, toolName: string, timestamp = T0, success?: boolean): ToolCallEvent {
    return {
        id,
        type: 'toolCall',
        timestamp,
        tool: 'cline',
        sessionId: 's1',
        toolName,
        success,
    };
}

function diff(id: string, filePath: string, timestamp = T0): DiffEvent {
    return {
        id,
        type: 'diff',
        timestamp,
        tool: 'cline',
        sessionId: 's1',
        filePath,
        diffText: '--- a\n+++ b\n',
        addedLines: 2,
        removedLines: 1,
    };
}

function fileOp(id: string, filePath: string, operationType: FileOperationEvent['operationType'] = 'patch'): FileOperationEvent {
    return {
        id,
        type: 'fileOperation',
        timestamp: T0,
        tool: 'cline',
        sessionId: 's1',
        operationType,
        filePath,
    };
}

function errorEvent(id: string, message: string, severity: ErrorEvent['severity'] = 'error'): ErrorEvent {
    return {
        id,
        type: 'error',
        timestamp: T0,
        tool: 'cline',
        sessionId: 's1',
        message,
        severity,
    };
}

suite('sessionCommandChips — classification helpers', () => {
    test('isGitCommand recognises plain and chained Git invocations', () => {
        assert.strictEqual(isGitCommand('git status'), true);
        assert.strictEqual(isGitCommand('  git commit -m "wip"'), true);
        assert.strictEqual(isGitCommand('cd repo && git diff'), true);
        assert.strictEqual(isGitCommand('npm test; git log'), true);
        assert.strictEqual(isGitCommand('npm run git-status'), false);
        assert.strictEqual(isGitCommand('github-cli auth'), false);
    });

    test('formatCommandChipSummary pluralises and joins the counts', () => {
        assert.strictEqual(
            formatCommandChipSummary({ git: 2, terminal: 4, toolCalls: 3, fileChanges: 0, errors: 1 }),
            '2 git cmds \u00b7 4 terminal cmds \u00b7 3 tool calls \u00b7 1 error'
        );
        assert.strictEqual(
            formatCommandChipSummary({ git: 1, terminal: 0, toolCalls: 0, fileChanges: 1, errors: 0 }),
            '1 git cmd \u00b7 1 file change'
        );
    });
});

suite('sessionCommandChips — correlation', () => {
    test('events follow the latest timestamped response', () => {
        const messages = [
            msg('user', 'Fix the build', T0),
            msg('assistant', 'Running the tests now.', T0),
            msg('user', 'Also commit it', T1),
            msg('assistant', 'Committing.', T1),
        ];
        const events: LogEvent[] = [
            command('c1', 'npm test', '2026-01-01T10:01:00.000Z', 0),
            command('c2', 'git commit -m "fix"', '2026-01-01T10:11:00.000Z', 0),
        ];

        const chips = buildCommandChips(events, messages);
        assert.deepStrictEqual([...chips.keys()], [1, 3], 'one chip after each response');
        assert.deepStrictEqual(chips.get(1)?.counts.terminal, 1);
        assert.deepStrictEqual(chips.get(3)?.counts.git, 1);
    });

    test('turn indexes attach to the last response of the turn', () => {
        const messages = [
            msg('user', 'first'),
            msg('assistant', 'answer one'),
            msg('user', 'second'),
            msg('assistant', 'answer two'),
            msg('assistant', 'more of answer two'),
        ];
        const events: CommandEvent[] = [command('c1', 'npm ci', T0, 0)];
        events[0].messageIndex = 1;

        const chips = buildCommandChips(events, messages);
        assert.deepStrictEqual([...chips.keys()], [4]);
        assert.strictEqual(chips.get(4)?.turnIndex, 1);
    });

    test('a raw transcript index pointing at an assistant message is honoured', () => {
        const messages = [
            msg('user', 'first'),
            msg('assistant', 'answer one'),
            msg('user', 'second'),
            msg('assistant', 'answer two'),
        ];
        const event = command('c1', 'ls', T0, 0);
        event.messageIndex = 3;

        const chips = buildCommandChips([event], messages);
        assert.deepStrictEqual([...chips.keys()], [3]);
    });

    test('Windsurf raw indexes are not mistaken for turn numbers', () => {
        const messages = [
            msg('user', 'first'),
            msg('assistant', 'answer one'),
            msg('user', 'second'),
            msg('assistant', 'answer two'),
        ];
        // Windsurf stamps the transcript position (the assistant message that
        // ran the tool), which numerically collides with turn 1 above.
        const event: LogEvent = { ...command('w1', 'ls', T0, 0), tool: 'windsurf', messageIndex: 1 };

        const chips = buildCommandChips([event], messages);
        assert.deepStrictEqual([...chips.keys()], [1], 'chip follows the message that ran the tool');
        assert.strictEqual(chips.get(1)?.turnIndex, 0);
    });

    test('uncorrelated events are dropped rather than guessed', () => {
        const messages = [msg('user', 'q'), msg('assistant', 'a')];
        const chips = buildCommandChips([command('c1', 'npm test')], messages);
        assert.strictEqual(chips.size, 0);
    });

    test('no events or no messages yields no chips', () => {
        assert.strictEqual(buildCommandChips([], [msg('user', 'q')]).size, 0);
        assert.strictEqual(buildCommandChips([command('c1', 'ls')], []).size, 0);
    });
});

suite('sessionCommandChips — chip content', () => {
    test('groups events into Commands-view sections and counts them', () => {
        const messages = [msg('user', 'go', T0), msg('assistant', 'done', T0)];
        const events = [
            command('g1', 'git status', '2026-01-01T10:00:30.000Z', 0),
            command('t1', 'npm test', '2026-01-01T10:00:31.000Z', 1),
            toolCall('tc1', 'read_file', '2026-01-01T10:00:32.000Z', false),
            diff('d1', 'src/a.ts', '2026-01-01T10:00:33.000Z'),
            fileOp('f1', 'src/a.ts'),
            errorEvent('e1', 'boom'),
        ];

        const chip = buildCommandChips(events, messages).get(1);
        assert.ok(chip, 'chip expected after the response');
        assert.deepStrictEqual(chip!.counts, {
            git: 1,
            terminal: 1,
            toolCalls: 1,
            fileChanges: 1,
            errors: 1,
        });
        // The paired patch file-op is folded into the diff row.
        assert.strictEqual(chip!.total, 5);
        assert.strictEqual(chip!.failedCount, 3, 'failed command + tool call + error');
        assert.deepStrictEqual(chip!.sections.map((section) => section.id), [
            'git', 'terminal', 'toolCalls', 'fileChanges', 'errors',
        ]);
        assert.strictEqual(chip!.sections[0].rows[0].description, 'exit 0');
        assert.strictEqual(chip!.sections[1].rows[0].description, 'exit 1');
        assert.strictEqual(chip!.sections[3].rows[0].label, 'src/a.ts');
        assert.match(chip!.summary, /1 git cmd/);
    });

    test('caps rows per section but keeps the exact count', () => {
        const messages = [msg('user', 'go', T0), msg('assistant', 'done', T0)];
        const events = Array.from({ length: MAX_ROWS_PER_SECTION + 5 }, (_, i) =>
            toolCall(`tc${i}`, 'read_file', '2026-01-01T10:00:30.000Z', true)
        );

        const chip = buildCommandChips(events, messages).get(1);
        assert.ok(chip);
        assert.strictEqual(chip!.counts.toolCalls, MAX_ROWS_PER_SECTION + 5);
        assert.strictEqual(chip!.sections[0].rows.length, MAX_ROWS_PER_SECTION);
        assert.strictEqual(chip!.sections[0].truncated, 5);
    });
});


suite('sessionCommandChips — HTML', () => {
    const messages = [msg('user', 'go', T0), msg('assistant', 'done', T0)];
    const events = [
        command('g1', 'git status', '2026-01-01T10:00:30.000Z', 0),
        command('t1', 'npm test', '2026-01-01T10:00:31.000Z', 1),
    ];

    test('the chip is collapsed by default but its sections are open', () => {
        const chip = buildCommandChips(events, messages).get(1);
        assert.ok(chip);
        const html = renderCommandChip(chip!);
        assert.ok(html.includes('<details class="cw-cmd-chip"'), 'outer details');
        assert.ok(!html.includes('<details class="cw-cmd-chip" open>'), 'outer chip is collapsed');
        assert.ok(html.includes('<details class="cw-cmd-section" open>'), 'sections are expanded');
        assert.ok(html.includes('>Commands<'), 'chip title');
        assert.ok(html.includes('1 failed'), 'failure badge');
    });

    test('command text is escaped and keeps its event id', () => {
        const hostile = [command('x1', '<script>alert(1)</script>', T0, 0)];
        const chip = buildCommandChips(hostile, messages).get(1);
        assert.ok(chip);
        const html = renderCommandChip(chip!);
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('data-event-id="x1"'));
    });

    test('buildCommandChipHtml keys the HTML by message index and lists sections', () => {
        const html = buildCommandChipHtml(events, messages);
        assert.deepStrictEqual([...html.keys()], [1]);
        assert.ok(html.get(1)!.includes('Git Commands'));
        assert.ok(html.get(1)!.includes('Terminal Commands'));
        assert.ok(html.get(1)!.includes('git status'));
    });
});

suite('sessionCommandChips — renderChunk integration', () => {
    test('appends one chip slot after the owning message only', () => {
        const messages = [
            msg('user', 'go', T0),
            msg('assistant', 'done', T0),
            msg('user', 'next', T1),
            msg('assistant', 'nothing ran', T1),
        ];
        const chips = buildCommandChipHtml(
            [command('c1', 'npm test', '2026-01-01T10:01:00.000Z', 0)],
            messages
        );
        const visible = messages.map((message, origIdx) => ({ msg: message, origIdx }));
        const cache = new Array<string | null>(messages.length).fill(null);

        const html = renderChunk(visible, cache, 0, messages.length, 'Cline', false, chips);
        assert.ok(html.includes('cw-cmd-chip-slot" data-for-msg="1"'), 'chip after the response');
        assert.ok(!html.includes('data-for-msg="0"'), 'no chip after the prompt');
        assert.ok(!html.includes('data-for-msg="3"'), 'no chip after a response without actions');
        // The cached message HTML itself never contains the chip.
        assert.ok(!cache[1]!.includes('cw-cmd-chip'));
    });
});

