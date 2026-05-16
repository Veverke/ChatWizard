// src/mcp/mcpAuthManager.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages the bearer token used to authenticate MCP server requests.
 *
 * The token is a 32-byte random hex string stored as plain text at `tokenPath`.
 * An optional logger callback may be supplied to the constructor; when present,
 * token write events are recorded with byte length and creation timestamp only
 * — the raw token value is never passed to the logger.
 */
export class McpAuthManager {
    constructor(private readonly _log?: (message: string) => void) {}

    /**
     * Return the existing token if the file exists; otherwise generate a fresh token,
     * write it to `tokenPath` (creating parent directories as needed), and return it.
     */
    async getOrCreateToken(tokenPath: string): Promise<string> {
        this._assertAbsolute(tokenPath);
        try {
            const raw = fs.readFileSync(tokenPath, 'utf8').trim();
            if (this._isValidToken(raw)) {
                return raw;
            }
            if (raw.length > 0) {
                // Non-empty but invalid/corrupt — regenerate
                return this._writeNewToken(tokenPath);
            }
        } catch (err: unknown) {
            // File does not exist yet — fall through to generate.
            if (!this._isNoEntError(err)) {
                throw err;
            }
        }
        return this._writeNewToken(tokenPath);
    }

    /**
     * Read and return an existing valid token from `tokenPath`, or `null` if the file
     * does not exist. Does NOT create a new token — use this from code paths where the
     * token file must already exist (e.g. copyMcpConfig), so consent gating is preserved.
     */
    async readToken(tokenPath: string): Promise<string | null> {
        this._assertAbsolute(tokenPath);
        try {
            const raw = fs.readFileSync(tokenPath, 'utf8').trim();
            return this._isValidToken(raw) ? raw : null;
        } catch (err: unknown) {
            if (this._isNoEntError(err)) { return null; }
            throw err;
        }
    }

    /**
     * Generate a fresh token, overwrite the existing file, and return the new token.
     * Called when the user explicitly requests token rotation.
     */
    async rotateToken(tokenPath: string): Promise<string> {
        this._assertAbsolute(tokenPath);
        return this._writeNewToken(tokenPath);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private _writeNewToken(tokenPath: string): string {
        const token = crypto.randomBytes(32).toString('hex');
        const dir = path.dirname(tokenPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(tokenPath, 0o600); } catch { /* non-POSIX filesystem */ }
        this._log?.(`[McpAuthManager] Token written — 32 bytes at ${new Date().toISOString()}`);
        return token;
    }

    private _isValidToken(raw: string): boolean {
        return /^[0-9a-f]{64}$/.test(raw);
    }

    private _assertAbsolute(tokenPath: string): void {
        if (!path.isAbsolute(tokenPath)) {
            throw new Error(
                `McpAuthManager: tokenPath must be an absolute path (got "${tokenPath}").`
            );
        }
    }

    private _isNoEntError(err: unknown): boolean {
        return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: string }).code === 'ENOENT'
        );
    }
}
