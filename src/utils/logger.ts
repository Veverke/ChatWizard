/**
 * src/utils/logger.ts
 *
 * Centralised diagnostic logger for Chat Wizard.
 * Provides structured logging with levels, timestamps, and context tagging
 * to make startup / embedding / watcher issues straightforward to troubleshoot.
 */

import * as vscode from 'vscode';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_ICONS: Record<LogLevel, string> = {
    DEBUG: '🔍',
    INFO: 'ℹ️',
    WARN: '⚠️',
    ERROR: '🚫',
};

const LOG_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

export interface Logger {
    debug(ctx: string, msg: string, ...args: unknown[]): void;
    info(ctx: string, msg: string, ...args: unknown[]): void;
    warn(ctx: string, msg: string, ...args: unknown[]): void;
    error(ctx: string, msg: string, ...args: unknown[]): void;
    /** Create a child logger that prefixes every message with a fixed context. */
    withContext(ctx: string): BoundLogger;
    /** Get the underlying VS Code output channel (for passing to legacy code). */
    getChannel(): vscode.OutputChannel;
    /** Set the minimum log level shown. */
    setLevel(level: LogLevel): void;
}

/**
 * A logger that already has a fixed context baked in.
 * Methods only need the message (and optional format args).
 */
export interface BoundLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    /** Create a further-nested logger. */
    withContext(ctx: string): BoundLogger;
    /** Get the underlying VS Code output channel. */
    getChannel(): vscode.OutputChannel;
    /** Set the minimum log level shown. */
    setLevel(level: LogLevel): void;
}

/**
 * A logger that already has a fixed context baked in.
 * Methods only need the message (and optional format args).
 */
export interface BoundLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    /** Create a further-nested logger. */
    withContext(ctx: string): BoundLogger;
    /** Get the underlying VS Code output channel. */
    getChannel(): vscode.OutputChannel;
    /** Set the minimum log level shown. */
    setLevel(level: LogLevel): void;
}

/**
 * Default minimum level shown to the output channel.
 * Can be overridden via the `chatwizard.logLevel` setting.
 */
function defaultMinLevel(): LogLevel {
    const cfg = vscode.workspace.getConfiguration('chatwizard');
    return cfg.get<LogLevel>('logLevel', 'INFO');
}

/**
 * Create a Logger that writes structured messages to a VS Code OutputChannel.
 * If `channel` is provided, it will be reused instead of creating a new one.
 * When called without arguments, a single shared "Chat Wizard" channel is used
 * so all Chat Wizard logs appear in the same Output entry.
 *
 * Usage:
 *   const log = createLogger();              // uses shared channel
 *   const log = createLogger(channel);       // reuses an existing channel
 *   log.info('Startup', 'Activation began');
 *   log.withContext('Semantic').debug('Queue started');
 */

// Shared channel reused by all createLogger() calls without explicit channel
let _sharedChannel: vscode.OutputChannel | undefined;

/**
 * Get the shared "Chat Wizard" output channel used by `createLogger()`.
 * Creates it on first use. Lets legacy code (e.g. watcher fallbacks) reuse
 * the same channel so all Chat Wizard logs land in one Output entry.
 */
export function getSharedChannel(): vscode.OutputChannel {
    return _sharedChannel ?? (_sharedChannel = vscode.window.createOutputChannel('Chat Wizard'));
}

export function createLogger(
    channelOrName?: vscode.OutputChannel | string,
): Logger {
    const channel = typeof channelOrName === 'object' && channelOrName !== null
        ? channelOrName
        : typeof channelOrName === 'string'
            ? vscode.window.createOutputChannel(channelOrName)
            : getSharedChannel();
    let minLevel = defaultMinLevel();

    function fmt(level: LogLevel, ctx: string, msg: string): string {
        const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
        const icon = LOG_ICONS[level];
        return `[${ts}] ${icon} [${level}] [${ctx}] ${msg}`;
    }

    function setMinLevel(level: LogLevel): void {
        minLevel = level;
    }

    function write(level: LogLevel, ctx: string, msg: string, ...args: unknown[]): void {
        if (LOG_PRIORITY[level] < LOG_PRIORITY[minLevel]) { return; }
        channel.appendLine(fmt(level, ctx, args.length > 0 ? sprintf(msg, ...args) : msg));
    }

    const logger: Logger = {
        debug(ctx, msg, ...args) { write('DEBUG', ctx, msg, ...args); },
        info(ctx, msg, ...args) { write('INFO', ctx, msg, ...args); },
        warn(ctx, msg, ...args) { write('WARN', ctx, msg, ...args); },
        error(ctx, msg, ...args) { write('ERROR', ctx, msg, ...args); },

        withContext(fixedCtx: string): BoundLogger {
            return {
                debug(msg, ...args) { write('DEBUG', fixedCtx, msg, ...args); },
                info(msg, ...args) { write('INFO', fixedCtx, msg, ...args); },
                warn(msg, ...args) { write('WARN', fixedCtx, msg, ...args); },
                error(msg, ...args) { write('ERROR', fixedCtx, msg, ...args); },
                getChannel: () => channel,
                withContext: (nested: string) => logger.withContext(`${fixedCtx} > ${nested}`),
                setLevel: setMinLevel,
            };
        },

        getChannel: () => channel,
        setLevel: setMinLevel,
    };

    return logger;
}

/**
 * Minimal sprintf — replaces %s, %d, %f, %j, %% in a format string.
 * If the msg contains no format specifiers, returns it unchanged.
 */
function sprintf(msg: string, ...args: unknown[]): string {
    if (args.length === 0) { return msg; }
    let i = 0;
    return msg.replace(/%[sdfj%]/g, (match) => {
        if (match === '%%') { return '%'; }
        if (i >= args.length) { return match; }
        const val = args[i++];
        switch (match) {
            case '%s': return String(val);
            case '%d': return String(Math.trunc(Number(val)));
            case '%f': return String(Number(val));
            case '%j': return JSON.stringify(val);
            default: return match;
        }
    });
}

/**
 * Decorates a Promise with a timeout that rejects after `ms` milliseconds.
 * The timer is unref'd so it doesn't keep the Node.js process alive —
 * preventing hidden process leaks in extension hosts.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out after ${ms}ms: ${label}`));
        }, ms);
        timer.unref();
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}
