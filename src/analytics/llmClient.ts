// src/analytics/llmClient.ts
// Central LLM completion client.
// Tries providers in priority order: VS Code Copilot LM API → Cursor agent CLI.
// Each consumer (kbLlmClassifier, entityLlmExtractor, etc.) calls promptLlm()
// instead of duplicating model selection and sendRequest() logic.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { createLogger } from '../utils/logger';
import { openReadonlyDb } from '../utils/sqliteDb';

const log = createLogger().withContext('LLM');

// ── Cached agent path ──────────────────────────────────────────────────────
let _cachedAgentPath: string | null | undefined; // undefined = not yet checked

/**
 * Detect whether the extension host is Cursor (not VS Code).
 * Cursor sets vscode.env.appName to "Cursor" — we check for that via the
 * vscode API, but since that may not be available at module-load time we
 * also check for known Cursor-specific environment markers.
 */
export function isRunningInCursor(): boolean {
    try {
        const appName = vscode.env.appName;
        if (appName && /cursor/i.test(appName)) { return true; }
    } catch { /* vscode not ready */ }
    // Fallback: check process environment for Cursor-specific paths/markers
    const exePath = process.execPath?.toLowerCase() || '';
    if (exePath.includes('cursor')) { return true; }
    return false;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface LlmCompletionOptions {
    /** Optional system prompt. If the selected provider does not support separate
     *  system prompts (e.g. Cursor CLI), it will be inlined into the user message. */
    systemPrompt?: string;
    /** Timeout in milliseconds for the completion request. Default: 30_000 */
    timeoutMs?: number;
}

// ── VS Code LM API provider ────────────────────────────────────────────────

/**
 * Pool of free Copilot models to try, in priority order.
 */
const VSCODE_MODEL_CHAIN = [
    { vendor: 'copilot', family: 'o4-mini' },
    { vendor: 'copilot', family: 'gpt-4o-mini' },
    { vendor: 'copilot', family: 'gpt-4.1-mini' },
    { vendor: 'copilot', family: 'gpt-4o' },
    { vendor: 'copilot', family: 'gpt-4.1' },
    { vendor: 'copilot', family: 'gpt-3.5-turbo' },
];

const MODEL_TIMEOUT_MS = 2_000;

/**
 * Try the VS Code LM API (works in VS Code with Copilot free tier, and in
 * Cursor when a compatible LM provider is registered).
 */
async function tryVsCodeLm(
    systemPrompt: string | undefined,
    userContent: string,
    timeoutMs: number,
): Promise<string | null> {
    // 1) Try the explicit free Copilot model chain
    for (const filter of VSCODE_MODEL_CHAIN) {
        log.info(`VS Code LM: trying ${filter.vendor}/${filter.family}`);
        try {
            const model = await Promise.race([
                vscode.lm.selectChatModels(filter),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), MODEL_TIMEOUT_MS),
                ),
            ]);
            if (model?.[0]) {
                const name = model[0].name || model[0].family || filter.family;
                log.info(`VS Code LM: selected ${name}`);
                const raw = await doSendRequest(model[0], systemPrompt, userContent, timeoutMs);
                if (raw === null) {
                    log.warn(`VS Code LM: selected ${name} but sendRequest failed`);
                } else {
                    return raw;
                }
            }
            log.info(`VS Code LM: ${filter.family} not available`);
        } catch {
            log.info(`VS Code LM: ${filter.family} timed out or errored`);
        }
    }

    // 2) Fallback — any Copilot model at all
    try {
        log.info('VS Code LM: trying any Copilot model as fallback');
        const any = await Promise.race([
            vscode.lm.selectChatModels({ vendor: 'copilot' }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), MODEL_TIMEOUT_MS),
            ),
        ]);
        if (any?.[0]) {
            const name = any[0].name || any[0].family || 'unknown';
            log.info(`VS Code LM: any-Copilot-model fallback selected ${name}`);
            const raw = await doSendRequest(any[0], systemPrompt, userContent, timeoutMs);
            if (raw === null) {
                log.warn(`VS Code LM: any-Copilot-model fallback ${name} sendRequest failed`);
            } else {
                return raw;
            }
        }
    } catch {
        // no model available at all
    }

    log.warn('VS Code LM: no model available after trying all options');
    return null;
}

async function doSendRequest(
    model: vscode.LanguageModelChat,
    systemPrompt: string | undefined,
    userContent: string,
    timeoutMs: number,
): Promise<string | null> {
    try {
        // Build messages: some models don't honour systemPrompt option,
        // so we inline it when provided.
        const finalContent = systemPrompt
            ? `${systemPrompt}\n\n${userContent}`
            : userContent;

        const messages = [vscode.LanguageModelChatMessage.User(finalContent)];

        const response = await model.sendRequest(messages, undefined, new vscode.CancellationTokenSource().token);

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }

        return raw || null;
    } catch (err) {
        log.warn(`VS Code LM sendRequest failed: ${err}`);
        return null;
    }
}

// ── Cursor API key reader ──────────────────────────────────────────────────

/**
 * Read the Cursor access token from Cursor's global state.vscdb.
 * Returns the JWT token string, or null if it cannot be read.
 */
async function readCursorApiKey(): Promise<string | null> {
    try {
        const dbPath = path.join(
            process.env.USERPROFILE || '',
            'AppData',
            'Roaming',
            'Cursor',
            'User',
            'globalStorage',
            'state.vscdb',
        );
        if (!fs.existsSync(dbPath)) {
            log.debug('Cursor API key: state.vscdb not found');
            return null;
        }
        const db = await openReadonlyDb(dbPath);
        if (!db) {
            log.debug('Cursor API key: could not open state.vscdb');
            return null;
        }
        const row = db.get<{ value: string }>(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
        );
        db.close();
        if (row && typeof row.value === 'string' && row.value.trim()) {
            log.info('Cursor API key: read access token from state.vscdb');
            return row.value.trim();
        }
        log.debug('Cursor API key: accessToken not found in state.vscdb');
        return null;
    } catch (err) {
        log.warn(`Cursor API key: error reading state.vscdb: ${err}`);
        return null;
    }
}

// ── Cursor CLI provider ────────────────────────────────────────────────────

/**
 * Try the Cursor `agent` CLI as a fallback LLM provider.
 * Requires the Cursor CLI to be installed. Works on Cursor Free plan with
 * `--model auto`.
 */
async function tryCursorCli(
    systemPrompt: string | undefined,
    userContent: string,
    timeoutMs: number,
): Promise<string | null> {
    // Build the prompt
    const finalContent = systemPrompt
        ? `${systemPrompt}\n\n${userContent}`
        : userContent;

    // Find the agent binary
    const agentPath = findCursorAgent();
    if (!agentPath) {
        log.debug('Cursor CLI: agent not available (skipping)');
        return null;
    }
    log.info(`Cursor CLI: found agent at ${agentPath}`);

    // Determine workspace path for --workspace flag
    let workspacePath = '';
    try {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            workspacePath = folders[0].uri.fsPath;
        }
    } catch {
        // vscode not fully available
    }
    if (!workspacePath) {
        workspacePath = process.cwd();
    }

    log.info(`Cursor CLI: running agent with workspace=${workspacePath}`);

    // Read the Cursor API key from state.vscdb
    const apiKey = await readCursorApiKey();
    if (!apiKey) {
        log.warn('Cursor CLI: no API key available — agent will fail with "Authentication required"');
    }

    try {
        const result = await new Promise<string | null>((resolve, reject) => {
            const isWinCmd = process.platform === 'win32' && agentPath.endsWith('.cmd');

            // Build args: pass everything EXCEPT the prompt as CLI args.
            // The prompt is sent via stdin to avoid Windows command-line length limits.
            const args = isWinCmd
                ? ['/c', agentPath, '-p', '--trust', '--workspace', workspacePath, '--model', 'auto']
                : ['-p', '--trust', '--workspace', workspacePath, '--model', 'auto'];

            const command = isWinCmd ? process.env.COMSPEC || 'cmd.exe' : agentPath;

            const child = spawn(command, args, {
                timeout: timeoutMs,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}),
                },
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            // Write the prompt to stdin, then close it
            child.stdin?.write(finalContent);
            child.stdin?.end();

            child.on('error', (err) => {
                (err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
                reject(err);
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    const err = new Error(`Cursor CLI exited with code ${code}`);
                    (err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
                    reject(err);
                    return;
                }
                resolve(stdout || null);
            });
        });

        if (result !== null) {
            const trimmed = result.trim();
            if (trimmed) {
                log.info(`Cursor CLI: got response (${trimmed.length} chars)`);
                return trimmed;
            }
        }

        log.warn('Cursor CLI: response was empty');
        return null;
    } catch (err) {
        const nodeErr = err as { message?: string; stderr?: string; code?: string | number; signal?: string };
        const stderrStr = nodeErr.stderr ? `, stderr: ${nodeErr.stderr}` : '';
        const codeStr = nodeErr.code != null ? `, code: ${nodeErr.code}` : '';
        const signalStr = nodeErr.signal ? `, signal: ${nodeErr.signal}` : '';
        log.warn(`Cursor CLI: execution failed${codeStr}${signalStr}${stderrStr}: ${nodeErr.message || nodeErr}`);
        return null;
    }
}

/**
 * Find the Cursor `agent` CLI binary on Windows, macOS, or Linux.
 * Returns the full path or null if not found.
 */
function findCursorAgent(): string | null {
    // Return cached result if already checked
    if (_cachedAgentPath !== undefined) {
        return _cachedAgentPath;
    }

    // Environment variable override
    if (process.env.CURSOR_AGENT_PATH) {
        const custom = process.env.CURSOR_AGENT_PATH;
        try {
            if (fs.existsSync(custom)) {
                log.info(`Cursor CLI: found via CURSOR_AGENT_PATH: ${custom}`);
                _cachedAgentPath = custom;
                return custom;
            }
        } catch { /* ignore */ }
    }

    const isWin = process.platform === 'win32';

    // Common install paths by platform
    const candidates: string[] = isWin
        ? [
            // Cursor standard install (user-level)
            `${process.env.LOCALAPPDATA}\\Programs\\Cursor\\resources\\app\\bin\\agent.cmd`,
            // Alternative install paths
            `${process.env.USERPROFILE}\\.cursor\\bin\\agent.cmd`,
            `${process.env.USERPROFILE}\\AppData\\Local\\Programs\\Cursor\\resources\\app\\bin\\agent.cmd`,
        ]
        : [
            // macOS
            `${process.env.HOME}/Applications/Cursor.app/Contents/Resources/app/bin/agent`,
            // Linux
            `${process.env.HOME}/.cursor/bin/agent`,
            '/usr/local/bin/cursor-agent',
            '/snap/bin/cursor',
        ];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                log.info(`Cursor CLI: found at hardcoded path: ${candidate}`);
                _cachedAgentPath = candidate;
                return candidate;
            }
        } catch { /* ignore */ }
    }

    // Try PATH resolution (user ran "Install 'cursor' command in PATH")
    try {
        const cmd = isWin ? 'where agent' : 'which agent';
        // Use execSync since this runs during startup, not inside request handling
        const pathResult = execSync(cmd, { encoding: 'utf8', timeout: 2_000, windowsHide: true })
            .trim()
            .split(/\r?\n/)[0]; // take first match
        if (pathResult && fs.existsSync(pathResult)) {
            log.info(`Cursor CLI: found via PATH: ${pathResult}`);
            _cachedAgentPath = pathResult;
            return pathResult;
        }
    } catch {
        // not on PATH
    }

    _cachedAgentPath = null;
    return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a prompt to the best available LLM and return the raw text response.
 *
 * Tries providers in this order:
 *   1. VS Code LM API (Copilot free models, or Cursor LM providers)
 *   2. Cursor `agent` CLI (Free plan, `--model auto`)
 *
 * Returns `null` when ALL providers are unavailable.
 *
 * @param systemPrompt  Optional system-level instructions. Inlined into the user
 *                      message for providers that don't support system prompts.
 * @param userContent   The main prompt / conversation content.
 * @param options       Optional timeout and other settings.
 */
export async function promptLlm(
    systemPrompt: string | undefined,
    userContent: string,
    options?: LlmCompletionOptions,
): Promise<string | null> {
    const timeoutMs = options?.timeoutMs ?? 30_000;

    // Respect the user's LLM provider setting
    const provider = vscode.workspace
        .getConfiguration('chatwizard')
        .get<'auto' | 'vscode' | 'cursor'>('llmProvider', 'auto');

    if (provider === 'vscode') {
        return await tryVsCodeLm(systemPrompt, userContent, timeoutMs);
    }

    if (provider === 'cursor') {
        return await tryCursorCli(systemPrompt, userContent, timeoutMs);
    }

    // 'auto' — when running in Cursor, skip VS Code LM (it's never available)
    if (isRunningInCursor()) {
        // Quick early-exit: if we already know agent is missing, don't log anything
        if (_cachedAgentPath === null) {
            return null;
        }
        log.info('Cursor detected in auto mode — trying Cursor CLI directly');
        return await tryCursorCli(systemPrompt, userContent, timeoutMs);
    }

    // In VS Code: try VS Code LM API first, then Cursor CLI as fallback
    const vscodeResult = await tryVsCodeLm(systemPrompt, userContent, timeoutMs);
    if (vscodeResult !== null) return vscodeResult;

    const cursorResult = await tryCursorCli(systemPrompt, userContent, timeoutMs);
    if (cursorResult !== null) return cursorResult;

    log.warn('All LLM providers failed — returning null');
    return null;
}

/**
 * Check whether any LLM provider is available. Useful for deciding whether to
 * show LLM-dependent UI or fall back to heuristics.
 */
export async function isLlmAvailable(timeoutMs = 2_000): Promise<boolean> {
    // Quick check: does VS Code LM have any model?
    try {
        const models = await Promise.race([
            vscode.lm.selectChatModels({}),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
            ),
        ]);
        if (models && models.length > 0) return true;
    } catch {
        // fall through
    }

    // Check: is Cursor CLI available?
    return findCursorAgent() !== null;
}

/**
 * Show a one-time notification if the user is running Cursor but the `agent`
 * CLI binary is not installed. Uses a globalState flag to avoid nagging on
 * every startup.
 *
 * Call once during extension activation (extension.ts).
 */
export function maybeNotifyCursorAgentMissing(
    globalState: vscode.Memento,
    appName: string,
    execPath: string,
): void {
    // Only trigger in Cursor
    const isCursor = /cursor/i.test(appName) || execPath.toLowerCase().includes('cursor');
    log.info(`maybeNotifyCursorAgentMissing: isCursor=${isCursor} appName="${appName}" execPath="${execPath}"`);
    if (!isCursor) { return; }

    // Already nagged once — don't repeat
    const FLAG = 'chatwizard.cursorAgentNagShown.v3';
    if (globalState.get<boolean>(FLAG)) {
        log.info('maybeNotifyCursorAgentMissing: nag already shown, skipping');
        return;
    }

    // Quick check: is agent already on PATH?
    if (findCursorAgent()) {
        log.info('maybeNotifyCursorAgentMissing: agent CLI found, skipping notification');
        return;
    }

    log.info('maybeNotifyCursorAgentMissing: showing notification');
    // Defer to next tick — showInformationMessage can be suppressed during
    // early extension activation. Set the flag AFTER the notification resolves
    // so a crash/close before the user sees it doesn't permanently suppress it.
    setTimeout(() => {
        void vscode.window.showInformationMessage(
            'Chat Wizard: The Cursor `agent` CLI is not installed. ' +
            'Install it via "irm \'https://cursor.com/install?win32=true\' | iex" ' +
            '(Windows PowerShell) or visit https://cursor.com for other platforms. ' +
            'This enables free LLM calls for KB classification.',
        ).then(() => {
            void globalState.update(FLAG, true);
        }, () => {
            void globalState.update(FLAG, true);
        });
    }, 1_000);
}