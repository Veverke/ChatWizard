/**
 * src/logs/adapters/agentToolMapping.ts
 *
 * Shared classification for the *new* agent session formats:
 *   - Cline 4.x / Roo Code — `tool_use` / `tool_result` content parts;
 *   - Copilot agent host     — `tool.execution_start` / `tool.execution_complete`.
 *
 * Both formats describe tool calls with a `name` + `arguments` object, which is
 * a different vocabulary from the legacy Cline `ui_messages.json` /
 * Copilot `chatSessions/*.jsonl` trails (`say:'command'`, `toolInvocationSerialized`).
 * Keeping the vocabulary in one place means both adapters agree on what counts
 * as a command, a file operation, a diff or a plain tool call.
 */

/** What a tool invocation means for the watch-logs schema. */
export type AgentToolKind = 'command' | 'fileOp' | 'diff' | 'tool';

/** Normalize a tool name for lookups (`Run_Commands` → `run_commands`). */
export function normalizeToolName(name: string | undefined): string {
    return (name ?? '').trim().toLowerCase();
}

/** Tools that execute a shell command. */
const COMMAND_TOOLS = new Set([
    'run_commands',
    'run_command',
    'execute_command',
    'executecommand',
    'run_in_terminal',
    'runinterminal',
    'terminal',
    'shell',
    'bash',
    'run_terminal_cmd',
    'runterminalcmd',
]);

export type AgentFileOperation = 'create' | 'delete' | 'move' | 'rename' | 'mkdir' | 'patch';

/** Tools that mutate the file system without an explicit patch payload. */
const FILE_OP_TOOLS: Readonly<Record<string, AgentFileOperation>> = {
    write_to_file: 'patch',
    writefile: 'patch',
    create_new_file: 'create',
    createnewfile: 'create',
    new_file: 'create',
    create_file: 'create',
    createfile: 'create',
    insert_edit_into_file: 'patch',
    replace_string_in_file: 'patch',
    edit_file: 'patch',
    editfile: 'patch',
    editor: 'patch',
    delete_file: 'delete',
    deletefile: 'delete',
    remove_file: 'delete',
    move_file: 'move',
    movefile: 'move',
    rename_file: 'rename',
    renamefile: 'rename',
    mkdir: 'mkdir',
    make_directory: 'mkdir',
    create_directory: 'mkdir',
    createdirectory: 'mkdir',
};

/** Tools whose arguments carry an explicit unified diff / patch payload. */
const DIFF_TOOLS = new Set([
    'apply_patch',
    'applypatch',
    'apply_diff',
    'applydiff',
    'patch_tool',
    'patchtool',
]);

/** Classify a tool invocation. Unknown tools are plain tool calls. */
export function classifyAgentTool(name: string | undefined): AgentToolKind {
    const key = normalizeToolName(name);
    if (COMMAND_TOOLS.has(key)) { return 'command'; }
    if (DIFF_TOOLS.has(key)) { return 'diff'; }
    if (FILE_OP_TOOLS[key] !== undefined) { return 'fileOp'; }
    return 'tool';
}

/** File-operation kind for a tool name (`create`, `patch`, …). */
export function fileOperationOf(name: string | undefined): AgentFileOperation {
    return FILE_OP_TOOLS[normalizeToolName(name)] ?? 'patch';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) { return value; }
    }
    return undefined;
}

/**
 * Extract the shell command(s) from a tool invocation's arguments.
 * Handles `command`, `commandLine`, `commandString`, `commands: string[]`.
 */
export function extractCommands(input: unknown): string[] {
    const args = asRecord(input);
    if (!args) { return []; }

    const single = firstString(args['command'], args['commandLine'], args['commandString'], args['cmd']);
    if (single) { return [single]; }

    const list = args['commands'];
    if (Array.isArray(list)) {
        return list.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
    }
    return [];
}

/** Extract the affected file path from a tool invocation's arguments. */
export function extractFilePath(input: unknown): string | undefined {
    const args = asRecord(input);
    if (!args) { return undefined; }
    return firstString(
        args['path'],
        args['filePath'],
        args['file_path'],
        args['absolute_path'],
        args['target_file'],
        args['file'],
    );
}

/** Extract a unified diff / patch payload from a tool invocation's arguments. */
export function extractPatch(input: unknown): string | undefined {
    // Some tools (e.g. Copilot's `apply_patch`) pass the patch itself as the
    // raw argument string rather than as a `{ patch }` object.
    if (typeof input === 'string') { return firstString(input); }
    const args = asRecord(input);
    if (!args) { return undefined; }
    return firstString(args['diff'], args['patch'], args['input'], args['contents'], args['content']);
}

/** Extract a search/replace pair (Cline/Roo `editor` style edits). */
export function extractSearchReplace(input: unknown): { search: string; replace: string } | undefined {
    const args = asRecord(input);
    if (!args) { return undefined; }
    const search = firstString(args['old_text'], args['old_str'], args['oldString'], args['search'], args['find']);
    const replace = firstString(args['new_text'], args['new_str'], args['newString'], args['replace'], args['replacement']);
    if (search === undefined && replace === undefined) { return undefined; }
    return { search: search ?? '', replace: replace ?? '' };
}

/** Extract a whole-file `content` payload (create/write tools). */
export function extractContent(input: unknown): string | undefined {
    const args = asRecord(input);
    if (!args) { return undefined; }
    return firstString(args['content'], args['contents'], args['text'], args['new_text']);
}

/** Cap a captured output string (keeps stored payloads small). */
export function capOutput(text: string | undefined, max: number): string | undefined {
    if (typeof text !== 'string') { return undefined; }
    const trimmed = text.trim();
    if (trimmed.length === 0) { return undefined; }
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Coerce an arbitrary tool-result payload into a printable summary string. */
export function resultToText(result: unknown): string | undefined {
    if (result === undefined || result === null) { return undefined; }
    if (typeof result === 'string') { return result; }
    if (Array.isArray(result)) {
        const parts = result
            .map((entry) => {
                const rec = asRecord(entry);
                if (!rec) { return typeof entry === 'string' ? entry : ''; }
                return firstString(rec['result'], rec['output'], rec['content'], rec['text'], rec['stdout']) ?? '';
            })
            .filter((part) => part.trim().length > 0);
        return parts.length > 0 ? parts.join('\n') : undefined;
    }
    const rec = asRecord(result);
    if (!rec) { return undefined; }
    const direct = firstString(rec['result'], rec['output'], rec['content'], rec['text'], rec['stdout']);
    if (direct) { return direct; }
    try { return JSON.stringify(result); } catch { return undefined; }
}

