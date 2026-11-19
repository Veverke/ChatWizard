/**
 * test/unit/commandPurpose.test.ts
 *
 * Commands view — the Description row of a command detail panel is upgraded to
 * the *purpose* of the executed statement sequence, derived with a free model
 * when one is available.
 *
 * These tests cover the pure prompt/sanitizer helpers plus the cached, injectable
 * `deriveCommandPurpose()` — the real LLM client is never loaded here (the
 * completion function is injected), so no VS Code host is required.
 */

import * as assert from 'assert';
import {
    COMMAND_PURPOSE_SYSTEM_PROMPT,
    buildCommandPurposePrompt,
    cleanCommandPurpose,
    clearCommandPurposeCache,
    deriveCommandPurpose,
    isCommandPurposeResolved,
    peekCommandPurpose,
} from '../../src/logs/commandPurpose';
import { CommandEvent } from '../../src/logs/types';

function makeCommand(overrides: Partial<CommandEvent> = {}): CommandEvent {
    return {
        type: 'command',
        id: 'cmd-1',
        timestamp: '2026-01-01T10:00:00.000Z',
        tool: 'cline',
        commandText: 'rg "TOKEN" --glob "*.json" src',
        ...overrides,
    } as CommandEvent;
}

suite('commandPurpose — prompt', () => {
    test('lists the statements one per line plus the context', () => {
        const prompt = buildCommandPurposePrompt(makeCommand({
            commandText: 'cd src && rg "TOKEN" --glob "*.json" .; cd ..',
            cwd: 'C:/repo',
            shell: 'powershell',
            exitCode: 0,
        }));
        assert.ok(prompt.includes('cd src\nrg "TOKEN" --glob "*.json" .\ncd ..'), prompt);
        assert.ok(prompt.includes('It consists of 3 separate statements.'), prompt);
        assert.ok(prompt.includes('Working directory: C:/repo'), prompt);
        assert.ok(prompt.includes('Shell: powershell'), prompt);
        assert.ok(prompt.includes('Exit code: 0'), prompt);
        assert.ok(prompt.endsWith('Describe its purpose in one sentence.'));
    });

    test('a single statement omits the statement count line', () => {
        const prompt = buildCommandPurposePrompt(makeCommand({ commandText: 'npm test' }));
        assert.ok(!prompt.includes('separate statements'), prompt);
        assert.ok(prompt.includes('npm test'), prompt);
    });

    test('the system prompt asks for a purpose, not a shell-command restatement', () => {
        assert.match(COMMAND_PURPOSE_SYSTEM_PROMPT, /PURPOSE \/ INTENT/);
        assert.match(COMMAND_PURPOSE_SYSTEM_PROMPT, /ONE sentence/);
        assert.match(COMMAND_PURPOSE_SYSTEM_PROMPT, /do not mention that it runs a shell command/i);
    });
});

suite('commandPurpose — answer sanitizing', () => {
    test('keeps the first line, strips markdown / labels / wrapping quotes', () => {
        assert.strictEqual(
            cleanCommandPurpose('Searches JSON files under src for the TOKEN string.'),
            'Searches JSON files under src for the TOKEN string.'
        );
        assert.strictEqual(
            cleanCommandPurpose('- Purpose: "Searches JSON files under src."\n\nHope this helps!'),
            'Searches JSON files under src.'
        );
        assert.strictEqual(
            cleanCommandPurpose('```\n`Searches` JSON files  under src.```'),
            'Searches JSON files under src.'
        );
    });

    test('caps long answers and rejects empty ones', () => {
        const long = cleanCommandPurpose('x'.repeat(400));
        assert.ok(long !== null);
        assert.strictEqual(long.length, 220);
        assert.ok(long.endsWith('…'), 'trimmed answers are marked with an ellipsis');

        assert.strictEqual(cleanCommandPurpose(''), null);
        assert.strictEqual(cleanCommandPurpose('   \n  '), null);
        assert.strictEqual(cleanCommandPurpose(undefined), null);
        assert.strictEqual(cleanCommandPurpose(null), null);
    });
});

suite('commandPurpose — derivation and cache', () => {
    setup(() => clearCommandPurposeCache());
    teardown(() => clearCommandPurposeCache());

    test('returns the cleaned purpose from the injected model', async () => {
        const calls: Array<[string | undefined, string]> = [];
        const purpose = await deriveCommandPurpose(makeCommand(), {
            complete: async (system, user) => {
                calls.push([system, user]);
                return 'Searches JSON files under src for the TOKEN string.';
            },
        });

        assert.strictEqual(purpose, 'Searches JSON files under src for the TOKEN string.');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0][0], COMMAND_PURPOSE_SYSTEM_PROMPT);
        assert.ok(calls[0][1].includes('rg "TOKEN"'), 'the command text reaches the model');
        assert.strictEqual(
            peekCommandPurpose(makeCommand()),
            'Searches JSON files under src for the TOKEN string.'
        );
    });

    test('a second request for the same command is served from the cache', async () => {
        let calls = 0;
        const deps = {
            complete: async () => {
                calls++;
                return 'Lists TypeScript files.';
            },
        };
        await deriveCommandPurpose(makeCommand({ commandText: 'Get-ChildItem *.ts' }), deps);
        await deriveCommandPurpose(makeCommand({ commandText: 'Get-ChildItem *.ts' }), deps);
        assert.strictEqual(calls, 1, 'cached purposes are not re-requested');
    });

    test('concurrent requests share a single model call', async () => {
        let calls = 0;
        let release: (value: string) => void = () => undefined;
        const gate = new Promise<string>((resolve) => { release = resolve; });
        const deps = { complete: async (): Promise<string | null> => { calls++; return gate; } };

        const first = deriveCommandPurpose(makeCommand({ commandText: 'npm ci' }), deps);
        const second = deriveCommandPurpose(makeCommand({ commandText: 'npm ci' }), deps);
        release('Installs the locked dependencies.');
        assert.deepStrictEqual(await Promise.all([first, second]), [
            'Installs the locked dependencies.',
            'Installs the locked dependencies.',
        ]);
        assert.strictEqual(calls, 1);
    });

    test('no model / no answer keeps the heuristic description (null)', async () => {
        assert.strictEqual(await deriveCommandPurpose(makeCommand(), { complete: async () => null }), null);
        assert.strictEqual(peekCommandPurpose(makeCommand()), undefined);

        assert.strictEqual(
            await deriveCommandPurpose(makeCommand({ commandText: 'npm run build' }), {
                complete: async () => '   ',
            }),
            null
        );
    });

    test('a failing provider never throws', async () => {
        assert.strictEqual(
            await deriveCommandPurpose(makeCommand({ commandText: 'dotnet build' }), {
                complete: async () => { throw new Error('model exploded'); },
            }),
            null
        );
    });

    test('an empty command is not sent to the model', async () => {
        let calls = 0;
        const result = await deriveCommandPurpose(makeCommand({ commandText: '   ' }), {
            complete: async () => { calls++; return 'should not happen'; },
        });
        assert.strictEqual(result, null);
        assert.strictEqual(calls, 0);
    });

    test('isCommandPurposeResolved tracks settled answers — including "no model"', async () => {
        const event = makeCommand({ commandText: 'go build ./...' });
        assert.strictEqual(isCommandPurposeResolved(event), false, 'not answered yet');

        assert.strictEqual(await deriveCommandPurpose(event, { complete: async () => null }), null);
        assert.strictEqual(isCommandPurposeResolved(event), true, 'a cached "no answer" is settled');
        assert.strictEqual(peekCommandPurpose(event), undefined, 'but there is no purpose to show');
    });
});
