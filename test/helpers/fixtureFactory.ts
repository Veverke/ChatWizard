// test/helpers/fixtureFactory.ts
//
// Shared factory utilities for integration and E2E test suites.
//
// Functions:
//   writeCopilotSessions(dir, n)  — write N minimal Copilot JSONL files (one session each).
//                                   One code block per session so 201 sessions also produce
//                                   201 code blocks for code-block pagination tests (#17, #30, #36).
//   createCursorDb(dbPath, data?) — seed a Cursor state.vscdb SQLite database.
//   createWindsurfDb(dbPath, data?) — seed a Windsurf state.vscdb SQLite database.
//
// Path convention:  compiled output lives at  out/test/helpers/fixtureFactory.js
//                   fixtures live under       test/fixtures/<source>/
//                   so __dirname → ../../.. → workspace root → test/fixtures/...

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

// ---------------------------------------------------------------------------
// Language cycle for variety in generated code blocks
// ---------------------------------------------------------------------------

const LANGUAGES = [
    'typescript', 'javascript', 'python', 'rust', 'go',
    'java', 'csharp', 'cpp', 'bash', 'sql',
] as const;

// ---------------------------------------------------------------------------
// Copilot JSONL factory
// ---------------------------------------------------------------------------

/**
 * Writes `n` minimal Copilot JSONL session files to `targetDir`.
 *
 * Each file is two lines:
 *   Line 1 — kind:0 snapshot (session metadata)
 *   Line 2 — kind:2 patch   (requests array with one user/assistant turn)
 *
 * The assistant response includes a fenced code block whose language cycles
 * through LANGUAGES so that 201+ sessions also yield 201+ distinct code blocks
 * for code-block / timeline pagination tests (tests #17, #30, #36).
 *
 * @param targetDir  Directory in which to write the session files (created if needed).
 * @param n          Number of session files to write.
 */
export function writeCopilotSessions(targetDir: string, n: number): void {
    fs.mkdirSync(targetDir, { recursive: true });

    for (let i = 0; i < n; i++) {
        const sessionId = `copilot-paginated-${String(i).padStart(4, '0')}`;
        const lang      = LANGUAGES[i % LANGUAGES.length];
        const ts        = 1700000000000 + i * 60_000; // 1-minute gaps

        const snapshot = JSON.stringify({
            kind: 0,
            v: {
                version: 3,
                sessionId,
                creationDate: ts,
                requests: [],
                inputState: {},
            },
        });

        const requests = JSON.stringify({
            kind: 2,
            k: ['requests'],
            v: [{
                requestId: `req-${sessionId}`,
                timestamp: ts + 1_000,
                message: {
                    text: `[Paginated session ${i}] Write a hello-world snippet in ${lang}.`,
                    parts: [],
                },
                response: [{
                    value: (
                        `Here is a hello-world in ${lang}:\n\n` +
                        `\`\`\`${lang}\n` +
                        `// hello world — session index ${i}\n` +
                        `console.log("Hello, world! (${i})");\n` +
                        `\`\`\``
                    ),
                    supportThemeIcons: true,
                }],
            }],
        });

        fs.writeFileSync(
            path.join(targetDir, `${sessionId}.jsonl`),
            `${snapshot}\n${requests}`,
            'utf8'
        );
    }
}

// ---------------------------------------------------------------------------
// SQLite factory helpers
// ---------------------------------------------------------------------------

/** Shape of `test/fixtures/cursor/fixture-data.json` */
export interface CursorFixtureData {
    allComposers: unknown[];
}

/** Shape of `test/fixtures/windsurf/fixture-data.json` */
export interface WindsurfFixtureData {
    sessions: unknown[];
}

/** Resolve a path relative to the workspace root regardless of CWD. */
function fixturesPath(...parts: string[]): string {
    // __dirname (compiled) = <workspace>/out/test/helpers
    // ../../.. lands on <workspace>/
    return path.resolve(__dirname, '../../..', 'test', 'fixtures', ...parts);
}

/**
 * Creates a minimal Cursor `state.vscdb` SQLite database at `dbPath`.
 *
 * Inserts `composer.composerData` into an `ItemTable` (key/value schema).
 * Uses the bundled fixture data from `test/fixtures/cursor/fixture-data.json`
 * unless overridden by the `data` argument.
 *
 * @param dbPath  Absolute path where the SQLite file should be created.
 * @param data    Optional override; defaults to the JSON fixture file.
 */
export function createCursorDb(dbPath: string, data?: CursorFixtureData): void {
    const payload: CursorFixtureData = data ?? JSON.parse(
        fs.readFileSync(fixturesPath('cursor', 'fixture-data.json'), 'utf8')
    ) as CursorFixtureData;

    const db = new Database(dbPath);
    try {
        db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
            .run('composer.composerData', JSON.stringify(payload));
    } finally {
        db.close();
    }
}

/**
 * Creates a minimal Windsurf `state.vscdb` SQLite database at `dbPath`.
 *
 * Inserts `cascade.sessionData` into an `ItemTable` (key/value schema).
 * Uses the bundled fixture data from `test/fixtures/windsurf/fixture-data.json`
 * unless overridden by the `data` argument.
 *
 * @param dbPath  Absolute path where the SQLite file should be created.
 * @param data    Optional override; defaults to the JSON fixture file.
 */
export function createWindsurfDb(dbPath: string, data?: WindsurfFixtureData): void {
    const payload: WindsurfFixtureData = data ?? JSON.parse(
        fs.readFileSync(fixturesPath('windsurf', 'fixture-data.json'), 'utf8')
    ) as WindsurfFixtureData;

    const db = new Database(dbPath);
    try {
        db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
            .run('cascade.sessionData', JSON.stringify(payload));
    } finally {
        db.close();
    }
}
