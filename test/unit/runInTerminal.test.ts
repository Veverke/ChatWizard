/**
 * test/unit/runInTerminal.test.ts
 *
 * Unit tests for the "▶ Run in Terminal" helper behind the log-event detail
 * webview and the `chatwizard.execCommands.runInTerminal` tree command.
 *
 * The terminal itself is stubbed: these tests assert *what* is sent to VS Code
 * (tab title, working directory, command text) without spawning a shell.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { runCommandInTerminal, terminalNameFor } from '../../src/logs/runInTerminal';
import { removeTempDir } from '../helpers/fsCleanup';

interface FakeTerminal {
    name: string;
    cwd?: string;
    shown: number;
    sent: Array<{ text: string; addNewLine: boolean | undefined }>;
}

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-run-in-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

suite('runInTerminal — terminalNameFor', () => {
    test('prefixes the first non-empty line with "Chat Wizard: "', () => {
        assert.strictEqual(terminalNameFor('npm test'), 'Chat Wizard: npm test');
        assert.strictEqual(terminalNameFor('\n   \nnpm run build\nsecond line'), 'Chat Wizard: npm run build');
    });

    test('truncates long commands to the terminal-title budget', () => {
        const long = `git commit -m "${'x'.repeat(120)}"`;
        const name = terminalNameFor(long);
        assert.ok(name.startsWith('Chat Wizard: '), name);
        assert.ok(name.length <= 'Chat Wizard: '.length + 40, name);
        assert.ok(name.endsWith('…'), name);
    });

    test('falls back to the bare extension name when there is no text', () => {
        assert.strictEqual(terminalNameFor(''), 'Chat Wizard');
        assert.strictEqual(terminalNameFor('   \n\t  '), 'Chat Wizard');
    });
});

suite('runInTerminal — runCommandInTerminal', () => {
    let sandbox: sinon.SinonSandbox;
    let created: FakeTerminal[];
    let warning: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        created = [];

        sandbox.stub(vscode.window, 'createTerminal').callsFake(((options: vscode.TerminalOptions) => {
            const terminal: FakeTerminal = {
                name: options.name ?? '',
                cwd: options.cwd as string | undefined,
                shown: 0,
                sent: [],
            };
            created.push(terminal);
            return {
                name: terminal.name,
                show: () => { terminal.shown++; },
                sendText: (text: string, addNewLine?: boolean) => { terminal.sent.push({ text, addNewLine }); },
            } as unknown as vscode.Terminal;
        }) as typeof vscode.window.createTerminal);

        warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined as never);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('warns and creates no terminal when there is nothing to run', async () => {
        assert.strictEqual(await runCommandInTerminal(undefined), undefined);
        assert.strictEqual(await runCommandInTerminal(''), undefined);
        assert.strictEqual(await runCommandInTerminal('   \n '), undefined);

        assert.strictEqual(created.length, 0);
        assert.strictEqual(warning.callCount, 3);
        assert.match(String(warning.firstCall.args[0]), /no command text/i);
    });

    test('runs the command in the captured cwd when the folder still exists', async () => {
        const cwd = makeTmpDir();
        try {
            const terminal = await runCommandInTerminal('  npm test  ', cwd);

            assert.ok(terminal, 'a terminal is returned');
            assert.strictEqual(created.length, 1);
            assert.strictEqual(created[0].name, 'Chat Wizard: npm test');
            assert.strictEqual(created[0].cwd, cwd, 'existing cwd is honoured');
            assert.deepStrictEqual(created[0].sent, [{ text: 'npm test', addNewLine: true }]);
            assert.strictEqual(created[0].shown, 1, 'the terminal is revealed');
            assert.strictEqual(warning.callCount, 0);
        } finally {
            removeTempDir(cwd);
        }
    });

    test('drops the cwd when the captured folder no longer exists', async () => {
        const gone = path.join(os.tmpdir(), `cw-run-in-terminal-missing-${Date.now()}`);

        await runCommandInTerminal('git status', gone);

        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].cwd, undefined);
    });

    test('drops the cwd when the path points at a file, not a directory', async () => {
        const dir = makeTmpDir();
        const file = path.join(dir, 'not-a-dir.txt');
        fs.writeFileSync(file, 'x', 'utf8');
        try {
            await runCommandInTerminal('ls', file);

            assert.strictEqual(created.length, 1);
            assert.strictEqual(created[0].cwd, undefined);
        } finally {
            removeTempDir(dir);
        }
    });

    test('omits the cwd when none was captured', async () => {
        await runCommandInTerminal('npm run lint');
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].cwd, undefined);
        assert.strictEqual(created[0].name, 'Chat Wizard: npm run lint');
    });
});
