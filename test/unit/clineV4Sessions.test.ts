/**
 * test/unit/clineV4Sessions.test.ts
 *
 * Cline 4.x layout (`~/.cline/data/sessions/<id>/`):
 *   - `discoverClineV4SessionsAsync` finds session directories and skips
 *     everything else (files, dirs without `<id>.json`, missing root).
 *   - `parseClineV4Session` maps the metadata + transcript into the shared
 *     `Session` shape: title, workspace, model, timestamps, messages.
 *
 * Both run against temp directories so real user storage is never touched.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    discoverClineV4SessionsAsync,
    getClineDataRoot,
    getClineV4SessionsRoot,
} from '../../src/readers/clineWorkspace';
import { parseClineV4Session } from '../../src/parsers/cline';

const SESSION_ID = '1794419386202_jotez';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-cline-v4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Creates `<root>/<id>/<id>.json` (+ optional transcript) and returns the session dir. */
function writeSession(
    root: string,
    id: string,
    meta: Record<string, unknown> | string,
    messages?: Record<string, unknown> | string
): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, `${id}.json`),
        typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2),
        'utf8'
    );
    if (messages !== undefined) {
        fs.writeFileSync(
            path.join(dir, `${id}.messages.json`),
            typeof messages === 'string' ? messages : JSON.stringify(messages, null, 2),
            'utf8'
        );
    }
    return dir;
}

const FULL_META = {
    version: 1,
    session_id: SESSION_ID,
    source: 'vscode',
    started_at: '2026-11-11T17:49:46.484Z',
    ended_at: '2026-11-11T18:48:21.384Z',
    status: 'completed',
    provider: 'cline',
    model: 'cline-pass/deepseek-v4.1-flash-1017',
    cwd: 'c:\\Repos\\Mine\\ChatWizard',
    workspace_root: 'c:\\Repos\\Mine\\ChatWizard',
    prompt: 'Debugging extension (F5) shows logs-parsing left side panels empty',
    metadata: {
        title: 'Debugging extension (F5) shows logs-parsing left side panels empty',
        modelId: 'cline-pass/deepseek-v4.1-flash-1017',
    },
};

const FULL_TRANSCRIPT = {
    version: 1,
    updated_at: '2026-11-11T18:38:17.749Z',
    sessionId: SESSION_ID,
    messages: [
        {
            id: 'm1',
            role: 'user',
            ts: 1794419388263,
            content: [{ type: 'text', text: '<user_input mode="act">Fix the panels</user_input>' }],
        },
        {
            id: 'm2',
            role: 'assistant',
            ts: 1794419389559,
            modelInfo: { id: 'deepseek/deepseek-v4-flash', provider: 'cline' },
            content: [
                { type: 'thinking', thinking: 'internal chain of thought' },
                { type: 'text', text: 'Here is a fix:\n\n```ts\nconst x = 1;\n```' },
                { type: 'tool_use', id: 'call-1', name: 'read_files', input: { filePaths: ['src/extension.ts'] } },
            ],
        },
        {
            // thinking-only / tool-only turn → must not become a message
            id: 'm3',
            role: 'assistant',
            ts: 1794419390000,
            content: [{ type: 'tool_use', id: 'call-2', name: 'run_commands', input: { commands: ['npm test'] } }],
        },
        {
            id: 'm4',
            role: 'user',
            ts: 1794419391000,
            content: [{ type: 'text', text: '<user_input mode="plan">And also check the docs</user_input>' }],
        },
    ],
};


suite('Cline 4.x — storage paths', () => {
    test('getClineDataRoot honours CLINE_DATA_DIR, CLINE_DIR and defaults to ~/.cline/data', () => {
        const originalDataDir = process.env['CLINE_DATA_DIR'];
        const originalClineDir = process.env['CLINE_DIR'];
        try {
            process.env['CLINE_DATA_DIR'] = path.join('C:', 'custom', 'data');
            assert.strictEqual(getClineDataRoot(), path.join('C:', 'custom', 'data'));

            delete process.env['CLINE_DATA_DIR'];
            process.env['CLINE_DIR'] = path.join('C:', 'clinehome');
            assert.strictEqual(getClineDataRoot(), path.join('C:', 'clinehome', 'data'));

            delete process.env['CLINE_DIR'];
            assert.strictEqual(getClineDataRoot(), path.join(os.homedir(), '.cline', 'data'));
            assert.strictEqual(getClineV4SessionsRoot(), path.join(os.homedir(), '.cline', 'data', 'sessions'));
        } finally {
            if (originalDataDir === undefined) { delete process.env['CLINE_DATA_DIR']; }
            else { process.env['CLINE_DATA_DIR'] = originalDataDir; }
            if (originalClineDir === undefined) { delete process.env['CLINE_DIR']; }
            else { process.env['CLINE_DIR'] = originalClineDir; }
        }
    });
});

suite('Cline 4.x — discoverClineV4SessionsAsync', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('returns an empty list when the sessions root does not exist', async () => {
        const sessions = await discoverClineV4SessionsAsync(path.join(root, 'nope'));
        assert.deepStrictEqual(sessions, []);
    });

    test('finds session dirs that contain <id>.json and skips the rest', async () => {
        writeSession(root, SESSION_ID, FULL_META, FULL_TRANSCRIPT);
        const noMeta = writeSession(root, '1794419386203_nometa', {});
        // Remove the metadata file → the dir must be skipped.
        fs.rmSync(path.join(noMeta, '1794419386203_nometa.json'));
        // A stray file at the sessions root must be ignored.
        fs.writeFileSync(path.join(root, 'sessions.db'), 'not a session', 'utf8');

        const sessions = await discoverClineV4SessionsAsync(root);

        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].sessionId, SESSION_ID);
        assert.strictEqual(sessions[0].storageDir, path.join(root, SESSION_ID));
        assert.strictEqual(sessions[0].metaFile, path.join(root, SESSION_ID, `${SESSION_ID}.json`));
        assert.strictEqual(sessions[0].messagesFile, path.join(root, SESSION_ID, `${SESSION_ID}.messages.json`));
    });

    test('a session without a transcript is still discovered (freshly started session)', async () => {
        writeSession(root, SESSION_ID, FULL_META);
        const sessions = await discoverClineV4SessionsAsync(root);
        assert.strictEqual(sessions.length, 1);
    });

suite('Cline 4.x — parseClineV4Session', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('maps metadata and transcript into a Session', async () => {
        const dir = writeSession(root, SESSION_ID, FULL_META, FULL_TRANSCRIPT);

        const { session, errors } = await parseClineV4Session(dir);

        assert.deepStrictEqual(errors, []);
        assert.strictEqual(session.id, SESSION_ID);
        assert.strictEqual(session.source, 'cline');
        assert.strictEqual(session.filePath, dir);
        assert.strictEqual(session.title, 'Debugging extension (F5) shows logs-parsing left side panels empty');
        assert.strictEqual(session.workspacePath, 'c:\\Repos\\Mine\\ChatWizard');
        assert.strictEqual(session.model, 'deepseek/deepseek-v4-flash', 'model comes from the first transcript message');
        assert.strictEqual(session.createdAt, '2026-11-11T17:49:46.484Z');
        assert.strictEqual(session.updatedAt, '2026-11-11T18:48:21.384Z');
    });

    test('keeps only visible text: strips the <user_input> wrapper, drops thinking/tool-only turns', async () => {
        const dir = writeSession(root, SESSION_ID, FULL_META, FULL_TRANSCRIPT);

        const { session } = await parseClineV4Session(dir);

        assert.deepStrictEqual(session.messages.map(m => m.role), ['user', 'assistant', 'user']);
        assert.strictEqual(session.messages[0].content, 'Fix the panels');
        assert.ok(session.messages[1].content.startsWith('Here is a fix:'));
        assert.ok(!session.messages[1].content.includes('internal chain of thought'),
            'thinking must not leak into the reader');
        assert.strictEqual(session.messages[2].content, 'And also check the docs');
        assert.strictEqual(session.messages[0].timestamp, new Date(1794419388263).toISOString());
        assert.deepStrictEqual(session.messages.map(m => m.id), [
            `${SESSION_ID}-0`, `${SESSION_ID}-1`, `${SESSION_ID}-2`,
        ]);
        assert.strictEqual(session.messages[1].codeBlocks.length, 1, 'fenced code blocks are extracted');
        assert.strictEqual(session.messages[1].codeBlocks[0].language, 'typescript');
    });

    test('falls back to the prompt for the title when metadata.title is missing', async () => {
        const meta = { ...FULL_META, metadata: {} };
        const dir = writeSession(root, SESSION_ID, meta, FULL_TRANSCRIPT);

        const { session } = await parseClineV4Session(dir);
        assert.strictEqual(session.title, 'Debugging extension (F5) shows logs-parsing left side panels empty');
    });

    test('a session with metadata only yields no messages but no errors', async () => {
        const dir = writeSession(root, SESSION_ID, FULL_META);

        const { session, errors } = await parseClineV4Session(dir);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(session.messages, []);
        assert.strictEqual(session.title, 'Debugging extension (F5) shows logs-parsing left side panels empty');
    });

    test('invalid metadata JSON degrades to an empty session plus a parse error', async () => {
        const dir = writeSession(root, SESSION_ID, '{ not json', FULL_TRANSCRIPT);

        const { session, errors } = await parseClineV4Session(dir);
        assert.strictEqual(session.id, SESSION_ID);
        assert.deepStrictEqual(session.messages, []);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('Failed to read/parse'), errors[0]);
    });

    test('falls back to the first user message for the title when no metadata title/prompt exists', async () => {
        const meta = { ...FULL_META, prompt: undefined, metadata: {} };
        const dir = writeSession(root, SESSION_ID, meta, FULL_TRANSCRIPT);

        const { session } = await parseClineV4Session(dir);
        assert.strictEqual(session.title, 'Fix the panels');
    });

    test('a session without any usable title keeps the placeholder', async () => {
        const dir = writeSession(root, SESSION_ID, { version: 1 }, { version: 1, messages: [] });

        const { session } = await parseClineV4Session(dir);
        assert.strictEqual(session.title, 'Untitled Task');
    });

    test('non-object JSON roots are reported as parse errors', async () => {
        const dir = writeSession(root, SESSION_ID, '[]', '[]');

        const { session, errors } = await parseClineV4Session(dir);
        assert.deepStrictEqual(session.messages, []);
        assert.strictEqual(errors.length, 2, `errors: ${errors.join(' | ')}`);
        assert.ok(errors[0].includes('root value is not an object'), errors[0]);
        assert.ok(errors[1].includes('root value is not an object'), errors[1]);
    });

    test('message timestamps and model fall back to the metadata file', async () => {
        const transcript = {
            version: 1,
            messages: [
                { id: 'm1', role: 'user', ts: 1794419388263, content: [{ type: 'text', text: 'hello' }] },
            ],
        };
        const meta = { ...FULL_META, started_at: undefined, ended_at: undefined, metadata: {} };
        const dir = writeSession(root, SESSION_ID, meta, transcript);

        const { session } = await parseClineV4Session(dir);
        assert.strictEqual(session.createdAt, new Date(1794419388263).toISOString());
        assert.strictEqual(session.updatedAt, new Date(1794419388263).toISOString());
        assert.strictEqual(session.model, 'cline-pass/deepseek-v4.1-flash-1017', 'metadata.model is the fallback');
    });

    test('missing metadata file degrades to an empty session plus a parse error', async () => {
        const dir = path.join(root, SESSION_ID);
        fs.mkdirSync(dir, { recursive: true });

        const { session, errors } = await parseClineV4Session(dir);
        assert.deepStrictEqual(session.messages, []);
        assert.strictEqual(errors.length, 1);
    });
});

});
