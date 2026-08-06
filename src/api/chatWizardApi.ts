// src/api/chatWizardApi.ts
// Feature 44 — Programmatic / Extension API

/**
 * Public API surface exposed by ChatWizard to other VS Code extensions.
 *
 * Obtain an instance via:
 * ```typescript
 * const ext = vscode.extensions.getExtension('Veverke.chatwizard');
 * const api: ChatWizardApi = ext?.exports as ChatWizardApi;
 * ```
 *
 * All methods are safe to call even when ChatWizard is still initialising;
 * they return undefined/empty rather than throwing.
 */
export interface ChatWizardApi {
    /** Extension version string (e.g. "1.5.0") */
    readonly version: string;

    /** Total number of indexed sessions (0 if not yet loaded) */
    readonly sessionCount: number;

    /**
     * Returns the 10 most recently updated session summaries.
     * Useful for surfacing context in other AI extensions.
     */
    getRecentSessions(limit?: number): ApiSessionSummary[];

    /**
     * Search sessions by keyword, returning matching session summaries.
     * @param query   Case-insensitive substring match across message content.
     * @param limit   Maximum results (default 20).
     */
    searchSessions(query: string, limit?: number): ApiSessionSummary[];

    /**
     * Retrieve a specific session by ID.
     * Returns undefined when the session is not in the index.
     */
    getSession(sessionId: string): ApiSession | undefined;

    /**
     * Returns whether the MCP server is currently running.
     */
    isMcpServerRunning(): boolean;

    /**
     * Returns the port the MCP server is currently running on, or 0 if stopped.
     */
    getMcpServerPort(): number;
}

/** Lightweight session descriptor for API consumers */
export interface ApiSessionSummary {
    id: string;
    title: string;
    source: string;
    messageCount: number;
    updatedAt: string;
    workspacePath?: string;
}

/** Full session data for API consumers */
export interface ApiSession {
    id: string;
    title: string;
    source: string;
    messages: ApiMessage[];
    updatedAt: string;
    createdAt: string;
    workspacePath?: string;
    model?: string;
}

export interface ApiMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}