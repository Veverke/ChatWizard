/**
 * src/logs/commandStatements.ts
 *
 * Pure helpers that turn a one-line shell command sequence into a multi-line,
 * one-statement-per-line rendering:
 *
 *   cd repo && npm install; npm test
 *   →
 *   cd repo &&
 *   npm install;
 *   npm test
 *
 * The Commands view's detail panel shows the executed command under **Input**.
 * A long `a && b; c || d` chain is unreadable as a single line, so it is
 * broken up — but the *separators are kept at the end of each line* so the
 * rendered text stays shell-equivalent (bash treats a newline as `;`, and both
 * PowerShell 7 and bash continue a line that ends with `&&` / `||`). The
 * **▶ Run in Terminal** button still uses the untouched `commandText`.
 *
 * The splitter is deliberately conservative:
 *   - quotes are respected, so `git commit -m "fix: a; b"` stays one statement;
 *   - brackets are respected, so `(Get-ChildItem; Get-Date)` stays together;
 *   - pipelines are respected, so `rg foo | Select-Object -First 5` is one
 *     statement (a pipeline is one statement, not a sequence);
 *   - compound lines (`for f in a b; do echo $f; done`) are kept as-is.
 */

/** A top-level statement plus the separator that followed it. */
export interface CommandStatement {
    /** Statement text, trimmed, without the trailing separator. */
    text: string;
    /** `;` / `&&` / `||` when the statement was followed by one; `''` otherwise. */
    separator: '' | ';' | '&&' | '||';
}

/**
 * Lines that open a compound statement are never split further — breaking
 * `for f in a b; do echo $f; done` apart would be noise, not clarity.
 */
const COMPOUND_OPENERS = /^(if|for|foreach|while|until|switch|try|function|begin|process|end)\s/i;

const OPEN_BRACKETS = new Set(['(', '{', '[']);
const CLOSE_BRACKETS = new Set([')', '}', ']']);

/** Split one physical line into top-level statements (quote / bracket aware). */
function splitTopLevel(line: string): CommandStatement[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) { return []; }
    if (COMPOUND_OPENERS.test(trimmed)) {
        return [{ text: trimmed, separator: '' }];
    }

    const statements: CommandStatement[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let depth = 0;

    const flush = (separator: CommandStatement['separator']): void => {
        const text = current.trim();
        current = '';
        if (text.length > 0) { statements.push({ text, separator }); }
    };

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (quote) {
            current += ch;
            if (ch === '\\' && quote === '"' && i + 1 < line.length) {
                // Escaped character inside double quotes (`\"`) — copy verbatim.
                current += line[++i];
                continue;
            }
            if (ch === quote) { quote = undefined; }
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }

        if (ch === '\\' && i + 1 < line.length) {
            current += ch + line[++i];
            continue;
        }

        if (OPEN_BRACKETS.has(ch)) {
            depth++;
            current += ch;
            continue;
        }
        if (CLOSE_BRACKETS.has(ch)) {
            depth = Math.max(0, depth - 1);
            current += ch;
            continue;
        }

        if (depth === 0) {
            const next = line[i + 1];
            if (ch === '&' && next === '&') {
                flush('&&');
                i++;
                continue;
            }
            if (ch === '|' && next === '|') {
                flush('||');
                i++;
                continue;
            }
            if (ch === ';') {
                flush(';');
                continue;
            }
        }

        current += ch;
    }

    flush('');
    return statements;
}

/**
 * Split a command sequence into its top-level statements.
 *
 * Physical newlines are treated as separators too, and CRLF / CR endings are
 * normalized first. Empty fragments are dropped.
 */
export function splitCommandStatementParts(commandText: string | undefined): CommandStatement[] {
    const raw = (commandText ?? '').replace(/\r\n?/g, '\n');
    const parts: CommandStatement[] = [];
    for (const line of raw.split('\n')) {
        parts.push(...splitTopLevel(line));
    }
    return parts;
}

/** Statement texts only — no separators (`['cd repo', 'npm test']`). */
export function splitCommandStatements(commandText: string | undefined): string[] {
    return splitCommandStatementParts(commandText).map((statement) => statement.text);
}

/**
 * Multi-line rendering of a command sequence: one statement per line with the
 * original separators kept, so the text remains copy-pasteable.
 *
 * A command that is already a single statement is returned unchanged (trimmed).
 */
export function formatCommandStatements(commandText: string | undefined): string {
    return splitCommandStatementParts(commandText)
        .map((statement) => {
            if (!statement.separator) { return statement.text; }
            // `cmd;` hugs the semicolon; `cmd &&` / `cmd ||` need the space.
            return statement.separator === ';'
                ? `${statement.text};`
                : `${statement.text} ${statement.separator}`;
        })
        .join('\n');
}
