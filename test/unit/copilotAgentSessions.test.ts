/**
 * test/unit/copilotAgentSessions.test.ts
 *
 * GitHub Copilot agent-host sessions (VS Code 1.146+ / Copilot Chat 1.0+):
 *   <COPILOT_HOME || ~/.copilot>/session-state/<id>/{events.jsonl,workspace.yaml}
 *
 * Covers discovery, the workspace.yaml parser, and the transcript parser.
 * Everything runs against temp directories so real user data is never touched.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    discoverCopilotAgentSessionsAsync,
    getCopilotAgentHome,
    getCopilotAgentSessionStateRoot,
} from '../../src/readers/copilotWorkspace';
import {
    parseCopilotAgentSession,
    parseCopilotAgentWorkspaceYaml,
    stripCopilotAgentPreamble,
} from '../../src/parsers/copilotAgent';

const SESSION_ID = 'eafa37da-58b9-401e-94c0-15fdd56a42d1';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-copilot-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const WORKSPACE_YAML = [
    `id: ${SESSION_ID}`,
    'cwd: C:\\Repos\\Mine\\ChatWizard',
    'git_root: C:\\Repos\\Mine\\ChatWizard',
    'repository: Veverke/ChatWizard',
    'host_type: github',
    'branch: v1.7-fixes',
    'client_name: vscode-agent-host',
    'name: testing - today is  nov 13rd',
    'user_named: false',
    'created_at: 2026-11-12T23:23:17.872Z',
    'updated_at: 2026-11-12T23:23:47.027Z',
    '',
].join('\n');

const EVENTS = [
    {
        type: 'session.start',
        data: {
            sessionId: SESSION_ID,
            selectedModel: 'gpt-6-luna',
            context: { cwd: 'C:\\Repos\\Mine\\ChatWizard', branch: 'v1.7-fixes' },
        },
        id: 'ev-1',
        timestamp: '2026-11-12T23:23:18.820Z',
    },
    {
        type: 'user.message',
        data: {
            content: 'testing - today is  nov 13rd',
            transformedContent: '<current_datetime>2026-11-13T01:23:49.066+02:00</current_datetime>\n\ntesting - today is  nov 13rd',
        },
        id: 'ev-2',
        timestamp: '2026-11-12T23:23:49.070Z',
    },
    {
        type: 'assistant.message',
        data: {
            content: '',
            toolRequests: [{ toolCallId: 'call-1', name: 'view', arguments: { path: 'src/extension.ts' } }],
        },
        id: 'ev-3',
        timestamp: '2026-11-12T23:23:50.000Z',
    },
    {
        type: 'assistant.message',
        data: { content: 'Here you go:\n\n```ts\nconst x = 1;\n```' },
        id: 'ev-4',
        timestamp: '2026-11-12T23:23:55.000Z',
    },
    {
        type: 'tool.execution_complete',
        data: { toolCallId: 'call-1' },
        id: 'ev-5',
        timestamp: '2026-11-12T23:23:56.000Z',
    },
];

/** Creates `<root>/<id>/{events.jsonl,workspace.yaml}`. */
function writeSession(
    root: string,
    id: string,
    events: unknown[] | string,
    workspaceYaml: string | undefined = WORKSPACE_YAML
): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const body = typeof events === 'string'
        ? events
        : events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'events.jsonl'), body, 'utf8');
    if (workspaceYaml !== undefined) {
        fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspaceYaml, 'utf8');
    }
    return dir;

suite('Copilot agent-host — paths', () => {
    test('getCopilotAgentHome honours COPILOT_HOME and defaults to ~/.copilot', () => {
        const original = process.env['COPILOT_HOME'];
        try {
            process.env['COPILOT_HOME'] = path.join('C:', 'copilot-home');
            assert.strictEqual(getCopilotAgentHome(), path.join('C:', 'copilot-home'));
            assert.strictEqual(
                getCopilotAgentSessionStateRoot(),
                path.join('C:', 'copilot-home', 'session-state')
            );

            delete process.env['COPILOT_HOME'];
            assert.strictEqual(getCopilotAgentHome(), path.join(os.homedir(), '.copilot'));
            assert.strictEqual(
                getCopilotAgentSessionStateRoot(),
                path.join(os.homedir(), '.copilot', 'session-state')
            );
        } finally {
            if (original === undefined) { delete process.env['COPILOT_HOME']; }
            else { process.env['COPILOT_HOME'] = original; }
        }
    });
});

suite('Copilot agent-host — discoverCopilotAgentSessionsAsync', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('returns an empty list when the session-state root is missing', async () => {
        assert.deepStrictEqual(await discoverCopilotAgentSessionsAsync(path.join(root, 'nope')), []);
    });

    test('finds session dirs with a non-empty events.jsonl and skips everything else', async () => {
        writeSession(root, SESSION_ID, EVENTS);
        // Hidden helper directory (`.session-operation-locks` etc.) — skipped.
        fs.mkdirSync(path.join(root, '.session-operation-locks'), { recursive: true });
        // Directory without a transcript — skipped.
        fs.mkdirSync(path.join(root, 'no-transcript'), { recursive: true });
        // Empty transcript — skipped.
        writeSession(root, 'empty-transcript', []);
        // Stray file — skipped.
        fs.writeFileSync(path.join(root, 'stray.json'), '{}', 'utf8');

        const sessions = await discoverCopilotAgentSessionsAsync(root);

        assert.deepStrictEqual(sessions.map(s => s.sessionId), [SESSION_ID]);
        assert.strictEqual(sessions[0].sessionDir, path.join(root, SESSION_ID));
        assert.strictEqual(sessions[0].eventsFile, path.join(root, SESSION_ID, 'events.jsonl'));
        assert.strictEqual(sessions[0].workspaceFile, path.join(root, SESSION_ID, 'workspace.yaml'));
    });
});

suite('Copilot agent-host — workspace.yaml + preamble helpers', () => {
    test('parseCopilotAgentWorkspaceYaml reads flat scalars and strips quotes', () => {
        const parsed = parseCopilotAgentWorkspaceYaml(
            [
                '# comment',
                `id: ${SESSION_ID}`,
                'cwd: C:\\Repos\\Mine\\ChatWizard',
                'name: "quoted title"',
                "branch: 'v1.7-fixes'",
                'empty:',
                'summary_count: 0',
            ].join('\n')
        );

        assert.strictEqual(parsed['id'], SESSION_ID);
        assert.strictEqual(parsed['cwd'], 'C:\\Repos\\Mine\\ChatWizard');
        assert.strictEqual(parsed['name'], 'quoted title');
        assert.strictEqual(parsed['branch'], 'v1.7-fixes');
        assert.strictEqual(parsed['empty'], '');
        assert.strictEqual(parsed['summary_count'], '0');
    });

    test('reads |- block scalars (auto-titled / child-chat names)', () => {
        const parsed = parseCopilotAgentWorkspaceYaml(
            [
                `id: ${SESSION_ID}`,
                'name: |-',
                '  Investigate the root cause of a recurring BDD failure.',
                '',
                '  ## The error',
                '  System.Net.Http.HttpRequestException',
                'user_named: false',
                'summary_count: 1',
                '',
            ].join('\n')
        );

        assert.strictEqual(
            parsed['name'],
            'Investigate the root cause of a recurring BDD failure.\n\n## The error\nSystem.Net.Http.HttpRequestException'
        );
        // Lines after the block must still parse as sibling keys.
        assert.strictEqual(parsed['user_named'], 'false');
        assert.strictEqual(parsed['summary_count'], '1');
    });

    test('folds > block scalars and keeps nested indentation in | scalars', () => {
        const folded = parseCopilotAgentWorkspaceYaml(
            ['name: >-', '  fix the', '  failing BDD', 'cwd: C:\\repo'].join('\n')
        );
        assert.strictEqual(folded['name'], 'fix the failing BDD');
        assert.strictEqual(folded['cwd'], 'C:\\repo');

        const literal = parseCopilotAgentWorkspaceYaml(
            ['name: |', '  first', '    indented deeper', '  last', 'user_named: false'].join('\n')
        );
        assert.strictEqual(literal['name'], 'first\n  indented deeper\nlast\n');
        assert.strictEqual(literal['user_named'], 'false');
    });

    test('an empty block scalar is an empty value, not the header marker', () => {
        const parsed = parseCopilotAgentWorkspaceYaml(['name: |-', 'user_named: false'].join('\n'));

        assert.strictEqual(parsed['name'], '');
        assert.strictEqual(parsed['user_named'], 'false');
    });

    test('unescapes double-quoted scalars (\\r\\n, \\\\ and \\")', () => {
        const parsed = parseCopilotAgentWorkspaceYaml(
            ['name: "line one\\r\\nline two\\\\tail \\"quoted\\""', "branch: 'it''s'"].join('\n')
        );

        assert.strictEqual(parsed['name'], 'line one\r\nline two\\tail "quoted"');
        assert.strictEqual(parsed['branch'], "it's");
    });

    test('stripCopilotAgentPreamble removes the injected <current_datetime> block', () => {
        assert.strictEqual(
            stripCopilotAgentPreamble('<current_datetime>2026-11-13T01:23:49.066+02:00</current_datetime>\n\nhello'),
            'hello'
        );
        assert.strictEqual(stripCopilotAgentPreamble('plain text'), 'plain text');
    });
});


suite('Copilot agent-host — parseCopilotAgentSession', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('maps workspace.yaml + events.jsonl into a Session', () => {
        const dir = writeSession(root, SESSION_ID, EVENTS);

        const { session, errors } = parseCopilotAgentSession(dir);

        assert.deepStrictEqual(errors, []);
        assert.strictEqual(session.id, SESSION_ID);
        assert.strictEqual(session.source, 'copilot');
        assert.strictEqual(session.title, 'testing - today is  nov 13rd');
        assert.strictEqual(session.workspacePath, 'C:\\Repos\\Mine\\ChatWizard');
        assert.strictEqual(session.model, 'gpt-6-luna');
        assert.strictEqual(session.createdAt, '2026-11-12T23:23:17.872Z');
        assert.strictEqual(session.updatedAt, '2026-11-12T23:23:47.027Z');
        assert.strictEqual(session.filePath, path.join(dir, 'events.jsonl'));
        assert.ok((session.fileSizeBytes ?? 0) > 0);
    });

    test('renders user/assistant turns and skips tool-only assistant turns', () => {
        const dir = writeSession(root, SESSION_ID, EVENTS);

        const { session } = parseCopilotAgentSession(dir);

        assert.deepStrictEqual(session.messages.map(m => m.role), ['user', 'assistant']);
        assert.strictEqual(session.messages[0].content, 'testing - today is  nov 13rd');
        assert.ok(session.messages[1].content.startsWith('Here you go:'));
        assert.strictEqual(session.messages[1].codeBlocks.length, 1, 'fenced code blocks are extracted');
        assert.strictEqual(session.messages[1].codeBlocks[0].language, 'typescript');
        assert.strictEqual(session.messages[0].timestamp, '2026-11-12T23:23:49.070Z');
        assert.deepStrictEqual(session.messages.map(m => m.id), [`${SESSION_ID}-0`, `${SESSION_ID}-1`]);
    });

    test('falls back to the first user turn when workspace.yaml has no name', () => {
        const yaml = `id: ${SESSION_ID}\ncwd: C:\\repo\ncreated_at: 2026-11-01T10:00:00.000Z\nupdated_at: 2026-11-01T10:05:00.000Z\n`;
        const dir = writeSession(root, SESSION_ID, EVENTS, yaml);

        const { session } = parseCopilotAgentSession(dir);
        assert.strictEqual(session.title, 'testing - today is  nov 13rd');
        assert.strictEqual(session.workspacePath, 'C:\\repo');
    });

    test('derives the title from a block-scalar name instead of the |- marker', () => {
        const yaml = [
            `id: ${SESSION_ID}`,
            'cwd: C:\\repo',
            'name: |-',
            '  Investigate the root cause of a recurring BDD failure.',
            '',
            '  ## The error',
            '  System.Net.Http.HttpRequestException',
            'created_at: 2026-11-01T10:00:00.000Z',
            'updated_at: 2026-11-01T10:05:00.000Z',
            '',
        ].join('\n');
        const dir = writeSession(root, SESSION_ID, EVENTS, yaml);

        const { session } = parseCopilotAgentSession(dir);
        assert.strictEqual(session.title, 'Investigate the root cause of a recurring BDD failure.');
        assert.strictEqual(session.workspacePath, 'C:\\repo');
    });

    test('derives the title from the first line of a quoted multi-line name', () => {
        const yaml = [
            `id: ${SESSION_ID}`,
            'cwd: C:\\repo',
            'name: "line one\\r\\nline two"',
            '',
        ].join('\n');
        const dir = writeSession(root, SESSION_ID, EVENTS, yaml);

        const { session } = parseCopilotAgentSession(dir);
        assert.strictEqual(session.title, 'line one');
    });

    test('an empty block-scalar name falls back to the first user turn', () => {
        const yaml = `id: ${SESSION_ID}\ncwd: C:\\repo\nname: |-\n`;
        const dir = writeSession(root, SESSION_ID, EVENTS, yaml);

        const { session } = parseCopilotAgentSession(dir);
        assert.strictEqual(session.title, 'testing - today is  nov 13rd');
    });

    test('a session without workspace.yaml still parses (cwd from session.start)', () => {
        const dir = writeSession(root, SESSION_ID, EVENTS, undefined);

        const { session, errors } = parseCopilotAgentSession(dir);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(session.workspacePath, 'C:\\Repos\\Mine\\ChatWizard');
        assert.strictEqual(session.title, 'testing - today is  nov 13rd');
        assert.strictEqual(session.createdAt, EVENTS[0].timestamp);
    });

    test('invalid JSON lines are reported but the rest of the transcript still parses', () => {
        const dir = writeSession(
            root,
            SESSION_ID,
            `${JSON.stringify(EVENTS[0])}\n{ broken json\n${JSON.stringify(EVENTS[1])}\n`
        );

        const { session, errors } = parseCopilotAgentSession(dir);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('invalid JSON'), errors[0]);
        assert.deepStrictEqual(session.messages.map(m => m.role), ['user']);
    });

    test('multimodal (array) message content is flattened to text', () => {
        const events = [
            EVENTS[0],
            {
                type: 'user.message',
                data: { content: [{ type: 'text', text: 'hello from array' }] },
                id: 'ev-a',
                timestamp: '2026-11-12T23:24:00.000Z',
            },
        ];
        const dir = writeSession(root, SESSION_ID, events);

        const { session } = parseCopilotAgentSession(dir);
        assert.deepStrictEqual(session.messages.map(m => m.content), ['hello from array']);
    });

    test('a missing transcript degrades to an empty session plus a parse error', () => {
        const dir = path.join(root, SESSION_ID);
        fs.mkdirSync(dir, { recursive: true });

        const { session, errors } = parseCopilotAgentSession(dir);
        assert.deepStrictEqual(session.messages, []);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('Failed to read events.jsonl'), errors[0]);
    });

    test('an explicit workspaceId overrides the session cwd', () => {
        const dir = writeSession(root, SESSION_ID, EVENTS);
        const { session } = parseCopilotAgentSession(dir, 'workspace-hash-123');
        assert.strictEqual(session.workspaceId, 'workspace-hash-123');
    });
});

}
