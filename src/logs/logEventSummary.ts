/**
 * src/logs/logEventSummary.ts
 *
 * UX pass — human-readable digests of normalized agent-log events.
 *
 * The Commands view renders one row per event, so a list of N identical
 * `Tool Call` rows is useless: the user cannot tell a file read from a shell
 * command without opening each one. This module answers three questions with
 * pure, unit-testable helpers:
 *
 *   - **What is it?**  `describeLogEvent()` → one sentence explaining what the
 *     command / tool call does (`Runs a Git command: git status`,
 *     `Reads a file from the workspace: src/extension.ts`). The detail webview
 *     shows it as the event's *Description*, and the tree tooltips reuse it.
 *   - **Which one is it?**  `toolCallTarget()` → the identifying argument of a
 *     tool call (file path, command text, search query, URL), derived from the
 *     arguments the adapters stored. `toolCallLabel()` renders it in square
 *     brackets (`view [src/extension.ts]`) so identical tool names stay
 *     distinguishable in the tree.
 *   - **What went in / came out?**  `toolCallInputText()` /
 *     `toolCallOutputText()` feed the detail webview's **Input** / **Output**
 *     sections.
 *
 * The catalogue is intentionally a small, ordered table rather than an
 * exhaustive tool dictionary: unknown tools still render (`<tool>` + whatever
 * identifying argument they carry), they just get a generic description.
 */

import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    PlannerStepEvent,
    ToolCallEvent,
} from './types';

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** First non-empty line of a text, trimmed and length-capped for display. */
export function oneLine(text: string | undefined, max = 100): string {
    const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Fit `text` into `max` characters.
 *
 * `keepTail` is used for file paths: trimming the end of
 * `c:\repo\src\a\extension.ts` would hide the very part that identifies the
 * call, so those keep their tail (`…\src\a\extension.ts`) instead.
 */
function compactTarget(text: string, max: number, keepTail = false): string {
    const line = oneLine(text, Math.max(max * 4, max));
    if (line.length <= max) { return line; }
    if (keepTail) { return `…${line.slice(line.length - (max - 1))}`; }
    return `${line.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/** First non-empty string (or list of strings) among `keys`. */
function firstStringArg(
    args: Record<string, unknown>,
    keys: readonly string[]
): string | undefined {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.trim().length > 0) { return value.trim(); }
        if (Array.isArray(value)) {
            const strings = value
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                .map((entry) => entry.trim());
            if (strings.length > 0) { return strings.join(', '); }
        }
    }
    return undefined;
}

/**
 * Normalize a tool name for catalogue lookups.
 *
 * Lower-cases and unwraps MCP namespaces (`mcp__github__create_issue` →
 * `create_issue`) so a namespaced tool still matches its plain counterpart.
 */
export function toolLookupKey(toolName: string | undefined): string {
    const lower = (toolName ?? '').trim().toLowerCase();
    if (lower.length === 0) { return ''; }
    const parts = lower.split('__');
    return parts.length > 1 ? parts[parts.length - 1] : lower;
}

// ---------------------------------------------------------------------------
// Tool catalogue — what a tool call does
// ---------------------------------------------------------------------------

/** Which argument family identifies a tool call best. */
export type ToolTargetPreference = 'path' | 'command' | 'query' | 'url';

interface ToolCatalogEntry {
    pattern: RegExp;
    /** One-sentence description of what the tool does. */
    description: string;
    /** Argument family rendered in square brackets (default: `path`). */
    prefer?: ToolTargetPreference;
}

/**
 * Known agent tools, grouped by what they do.
 *
 * Order matters: the first matching entry wins, so command / search patterns
 * are listed before the broader file-system one.
 */
const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
    {
        pattern: /^(powershell|terminal|shell|bash|sh|zsh|fish|cmd|run_in_terminal|runinterminal|run_command|run_commands|execute_command|executecommand|run_terminal_cmd|runterminalcmd|send_to_terminal|get_terminal_output)$/,
        description: 'Runs a shell command in the terminal',
        prefer: 'command',
    },
    {
        pattern: /^(grep|rg|findstr|find|fd|ag|search|search_files|file_search|search_codebase|codebase_search|semantic_search|list_code_definition_names)$/,
        description: 'Searches the workspace for text or files',
        prefer: 'query',
    },
    {
        pattern: /^(web_search|search_web|fetch|fetch_webpage|web_fetch|open_url|browser|browser_navigate)$/,
        description: 'Fetches or searches the web',
        prefer: 'url',
    },
    {
        pattern: /^(view|open_file|read_file|read_files|readfile|cat|get_file_contents|read_document)$/,
        description: 'Reads a file from the workspace',
        prefer: 'path',
    },
    {
        pattern: /^(apply_patch|applypatch|apply_diff|applydiff|patch_tool|patchtool)$/,
        description: 'Applies a diff / patch to a file',
        prefer: 'path',
    },
    {
        pattern: /^(write_to_file|writefile|create_file|createfile|create_new_file|createnewfile|new_file|insert_edit_into_file|replace_string_in_file|edit_file|editfile|editor|str_replace_editor|replace_string)$/,
        description: 'Creates or edits a workspace file',
        prefer: 'path',
    },
    {
        pattern: /^(delete_file|deletefile|remove_file|move_file|movefile|rename_file|renamefile|mkdir|make_directory|create_directory|createdirectory)$/,
        description: 'Changes the workspace file system (delete / move / rename / mkdir)',
        prefer: 'path',
    },
    {
        pattern: /^(list_dir|list_files|ls|dir|get_dir|view_directory)$/,
        description: 'Lists the contents of a directory',
        prefer: 'path',
    },
    {
        pattern: /^(get_errors|problems|read_problems|diagnostics)$/,
        description: 'Reads the editor diagnostics (errors / warnings)',
        prefer: 'path',
    },
    {
        pattern: /^(todo|update_todo|todo_write|manage_todo_list|update_plan|plan|task_progress)$/,
        description: 'Updates the agent task list / plan',
    },
    {
        pattern: /^(run_task|get_task_output|create_and_run_task|run_vs_code_task)$/,
        description: 'Runs or inspects a VS Code task',
        prefer: 'command',
    },
    {
        pattern: /^(ask_question|ask_followup_question|ask|confirm|vscode_askquestions)$/,
        description: 'Asks the user a question',
    },
    {
        pattern: /^(attempt_completion|complete_task|finish|task_complete)$/,
        description: 'Reports the task as complete',
    },
    {
        pattern: /^(spawn_agent|run_subagent|task|delegate)$/,
        description: 'Delegates part of the work to a sub-agent',
    },
];

/** The catalogue entry for a tool name, when it is a known tool. */
function catalogEntryFor(toolName: string | undefined): ToolCatalogEntry | undefined {
    const key = toolLookupKey(toolName);
    if (key.length === 0) { return undefined; }
    return TOOL_CATALOG.find((entry) => entry.pattern.test(key));
}

/** One-sentence description of what a known tool does (undefined if unknown). */
export function describeToolName(toolName: string | undefined): string | undefined {
    return catalogEntryFor(toolName)?.description;
}


// ---------------------------------------------------------------------------
// Command catalogue — what an executed command does
// ---------------------------------------------------------------------------

/** Shell command families, matched on the first word of the command. */
const COMMAND_FAMILIES: readonly { pattern: RegExp; description: string }[] = [
    { pattern: /^(sudo\s+)?git\b/, description: 'Runs a Git command' },
    { pattern: /^(npm|npx|pnpm|yarn|bun)\b/, description: 'Runs a Node.js package-manager command' },
    { pattern: /^(node|deno|tsx|ts-node|tsc)\b/, description: 'Runs a Node.js / TypeScript tool' },
    { pattern: /^(jest|vitest|mocha|karma|playwright|cypress)\b/, description: 'Runs JavaScript tests' },
    { pattern: /^(eslint|prettier|stylelint)\b/, description: 'Runs a linter / formatter' },
    { pattern: /^(dotnet|msbuild|nuget)\b/, description: 'Runs the .NET toolchain' },
    { pattern: /^(python|python3|py|pip|pip3|poetry|uv|conda)\b/, description: 'Runs a Python command' },
    { pattern: /^(pytest|tox|nox)\b/, description: 'Runs Python tests' },
    { pattern: /^go\b/, description: 'Runs the Go toolchain' },
    { pattern: /^(cargo|rustc)\b/, description: 'Runs the Rust toolchain' },
    { pattern: /^(mvn|mvnw|gradle|gradlew|ant)\b/, description: 'Runs a JVM build' },
    { pattern: /^(java|javac|kotlin|kotlinc)\b/, description: 'Runs a JVM tool' },
    { pattern: /^(make|cmake|ninja)\b/, description: 'Runs a native build' },
    { pattern: /^(docker|docker-compose|podman)\b/, description: 'Runs a container command' },
    { pattern: /^(kubectl|helm|terraform|az|aws|gcloud)\b/, description: 'Runs a cloud / infrastructure command' },
    { pattern: /^gh\b/, description: 'Runs a GitHub CLI command' },
    { pattern: /^(curl|wget|invoke-webrequest|iwr)\b/, description: 'Fetches a URL' },
    { pattern: /^(rg|grep|findstr|find|fd|ag|select-string)\b/, description: 'Searches the file system' },
    {
        pattern: /^(mkdir|rm|rmdir|cp|mv|del|copy|move|ls|dir|cat|type|get-childitem|remove-item|new-item|copy-item|move-item|test-path)\b/,
        description: 'Runs a file-system command',
    },
    {
        pattern: /^(pwsh|powershell|bash|sh|zsh|fish|cmd|cmd\.exe|source)\b/,
        description: 'Runs a shell script',
    },
];

/** One-sentence description of what an executed command does. */
export function describeCommand(commandText: string | undefined): string {
    const line = oneLine(commandText, 120);
    if (line.length === 0) { return 'Executes a shell command'; }
    const lowered = line.toLowerCase();
    const family = COMMAND_FAMILIES.find((entry) => entry.pattern.test(lowered));
    return family ? `${family.description}: ${line}` : `Runs the shell command “${line}”`;
}

// ---------------------------------------------------------------------------
// Tool call target — the identifying argument
// ---------------------------------------------------------------------------

const PATH_ARG_KEYS = [
    'path', 'filePath', 'file_path', 'filepath', 'absolute_path', 'relativePath',
    'target_file', 'file', 'files', 'paths', 'uri',
] as const;
const COMMAND_ARG_KEYS = [
    'command', 'commandLine', 'command_line', 'commands', 'cmd', 'script', 'terminalCommand',
] as const;
const QUERY_ARG_KEYS = [
    'query', 'pattern', 'pattern_info', 'search', 'term', 'q', 'regex', 'glob',
] as const;
const URL_ARG_KEYS = ['url', 'urls', 'href'] as const;
/** Last-resort arguments some tools use to describe the request themselves. */
const DESCRIPTION_ARG_KEYS = [
    'description', 'explanation', 'purpose', 'reason', 'intent', 'summary',
    'title', 'prompt', 'message', 'text',
] as const;

/** All argument objects a tool call may carry (MCP tools nest theirs). */
function argumentSources(args: Record<string, unknown>): Record<string, unknown>[] {
    const sources = [args];
    for (const key of ['input', 'arguments', 'params', 'parameters', 'toolInput']) {
        const nested = asRecord(args[key]);
        if (nested) { sources.push(nested); }
    }
    return sources;
}

function pickArg(
    sources: readonly Record<string, unknown>[],
    keys: readonly string[]
): string | undefined {
    for (const source of sources) {
        const found = firstStringArg(source, keys);
        if (found) { return found; }
    }
    return undefined;
}


/**
 * The argument that identifies one specific tool call.
 *
 * Copilot's `view` carries `{ path }`, `powershell` carries `{ command }`, a
 * search tool carries `{ query }` — which one to show is decided by the tool
 * catalogue, then by a sensible fallback order for unknown tools.
 */
export function toolCallTarget(event: ToolCallEvent, max = 80): string | undefined {
    const args = asRecord(event.arguments);
    if (!args) { return undefined; }
    const sources = argumentSources(args);
    const prefer = catalogEntryFor(event.toolName)?.prefer ?? 'path';

    const byPreference: Record<ToolTargetPreference, () => string | undefined> = {
        command: () => pickArg(sources, COMMAND_ARG_KEYS),
        query: () => pickArg(sources, QUERY_ARG_KEYS),
        url: () => pickArg(sources, URL_ARG_KEYS),
        path: () => pickArg(sources, PATH_ARG_KEYS),
    };
    const fallbacks: readonly ToolTargetPreference[] = prefer === 'path'
        ? ['path', 'command', 'query', 'url']
        : prefer === 'command'
            ? ['command', 'path', 'query', 'url']
            : prefer === 'query'
                ? ['query', 'path', 'command', 'url']
                : ['url', 'path', 'query', 'command'];

    for (const kind of fallbacks) {
        const value = byPreference[kind]();
        if (!value) { continue; }
        // File paths keep their tail (the file name) when trimmed.
        return compactTarget(value, max, kind === 'path');
    }

    const described = pickArg(sources, DESCRIPTION_ARG_KEYS);
    return described ? compactTarget(described, max) : undefined;
}

/**
 * Tree label for a tool call: `toolName [target]`.
 *
 * Identical tool names stay distinguishable — `view [src/extension.ts]`,
 * `powershell [npm test]`, `grep [registerLogCommands]`.
 */
export function toolCallLabel(event: ToolCallEvent, max = 80): string {
    const name = (event.toolName ?? '').trim() || 'tool';
    const budget = Math.max(12, max - name.length - 3);
    const target = toolCallTarget(event, budget);
    return target ? `${name} [${target}]` : name;
}

/** An explicit description the model attached to the call, if any. */
function explicitToolDescription(event: ToolCallEvent): string | undefined {
    const args = asRecord(event.arguments);
    if (!args) { return undefined; }
    return pickArg(argumentSources(args), DESCRIPTION_ARG_KEYS);
}

/** One sentence explaining what a tool call does (and on what). */
export function describeToolCall(event: ToolCallEvent): string {
    const name = (event.toolName ?? '').trim() || 'tool';
    const base = describeToolName(name) ?? `Invokes the “${name}” tool`;
    const detail = explicitToolDescription(event) ?? toolCallTarget(event, 140);
    return detail ? `${base}: ${detail}` : base;
}

/** Pretty-printed JSON arguments — the webview's **Input** block. */
export function toolCallInputText(event: ToolCallEvent): string | undefined {
    const args = asRecord(event.arguments);
    if (!args) { return undefined; }
    try {
        const serialized = JSON.stringify(args, null, 2);
        return serialized && serialized !== '{}' ? serialized : undefined;
    } catch {
        return undefined;
    }
}

/** Captured result summary — the webview's **Output** block. */
export function toolCallOutputText(event: ToolCallEvent): string | undefined {
    const summary = (event.resultSummary ?? '').trim();
    return summary.length > 0 ? summary : undefined;
}

// ---------------------------------------------------------------------------
// Whole-event description
// ---------------------------------------------------------------------------

const FILE_OPERATION_VERBS: Readonly<Record<string, string>> = {
    create: 'Creates the file',
    delete: 'Deletes the file',
    move: 'Moves the file',
    rename: 'Renames the file',
    mkdir: 'Creates the directory',
    patch: 'Patches the file',
};

/**
 * One sentence explaining what an event represents — the *Description* the
 * detail webview shows for every row of the Commands view.
 */
export function describeLogEvent(event: LogEvent): string {
    switch (event.type) {
        case 'command':
            return describeCommand((event as CommandEvent).commandText);
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            const verb = FILE_OPERATION_VERBS[op.operationType] ?? 'Changes';
            const detail = op.detail ? ` — ${oneLine(op.detail, 120)}` : '';
            return `${verb} ${op.filePath}${detail}`;
        }
        case 'diff': {
            const d = event as DiffEvent;
            const stats = d.addedLines !== undefined || d.removedLines !== undefined
                ? ` (+${d.addedLines ?? 0} −${d.removedLines ?? 0} lines)`
                : '';
            return `Captures a change to ${d.filePath}${stats}`;
        }
        case 'toolCall':
            return describeToolCall(event as ToolCallEvent);
        case 'error': {
            const e = event as ErrorEvent;
            const severity = e.severity ?? 'error';
            return `Records a ${severity}: ${oneLine(e.message, 140)}`;
        }
        case 'plannerStep': {
            const p = event as PlannerStepEvent;
            const stepType = p.stepType ? ` (${p.stepType})` : '';
            return `Planner step${stepType}: ${oneLine(p.description, 140)}`;
        }
    }
}

