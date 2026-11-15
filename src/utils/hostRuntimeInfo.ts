/**
 * src/utils/hostRuntimeInfo.ts
 *
 * The extension host's exact Electron/Node/ABI identity, recorded on disk.
 *
 * WHY: `better-sqlite3` is a native module compiled for ONE
 * `NODE_MODULE_VERSION` (the ABI). `npm install` compiles it for the host
 * Node.js ABI; VS Code's Electron ships a different ABI, so VS Code needs a
 * rebuild (`npm run rebuild:native`). When the ABI does not match, the module
 * simply fails to load and both SQLite stores (session cache + agent-log store)
 * silently degrade to memory — which showed up as "the Commands view lists 0
 * commands even though the database is full".
 *
 * `scripts/rebuild-native.js` cannot discover the Electron version of the
 * *installed* VS Code from `resources/app/package.json` (it no longer ships
 * `electronVersion`). So the running extension records it here, in the same
 * shared cache directory the databases live in, and the rebuild script targets
 * exactly the Electron the extension host is running on.
 *
 * The write is best-effort: a read-only cache directory must never break
 * activation.
 */

import * as fs from 'fs';
import * as path from 'path';

/** File name inside the shared cache directory. */
export const HOST_RUNTIME_FILENAME = 'vscode-host-runtime.json';

/** Runtime identity of the extension host that last loaded ChatWizard. */
export interface HostRuntimeInfo {
    /** VS Code version (`vscode.version`). */
    vscodeVersion: string;
    /** Electron version of the extension host (`process.versions.electron`). */
    electron?: string;
    /** Node version inside Electron (`process.versions.node`). */
    node?: string;
    /** `NODE_MODULE_VERSION` the native modules must be compiled for. */
    modules?: string;
    /** Chrome version (diagnostics only). */
    chrome?: string;
    /** When this record was written (ISO-8601). */
    recordedAt: string;
}

/** Path of the host-runtime record for a shared cache directory. */
export function hostRuntimeInfoPath(cacheDir: string): string {
    return path.join(cacheDir, HOST_RUNTIME_FILENAME);
}

/**
 * Record the current extension host's runtime identity.
 *
 * @returns the written record, or `undefined` when the write failed.
 */
export function recordHostRuntimeInfo(
    cacheDir: string,
    vscodeVersion: string,
    versions: NodeJS.ProcessVersions = process.versions
): HostRuntimeInfo | undefined {
    const info: HostRuntimeInfo = {
        vscodeVersion: vscodeVersion ?? '',
        electron: versions['electron'],
        node: versions['node'],
        modules: versions['modules'],
        chrome: versions['chrome'],
        recordedAt: new Date().toISOString(),
    };
    try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(hostRuntimeInfoPath(cacheDir), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
        return info;
    } catch {
        // Read-only cache dir / permission issues — never block activation.
        return undefined;
    }
}

/** Read the last recorded host runtime identity, if any. */
export function readHostRuntimeInfo(cacheDir: string): HostRuntimeInfo | undefined {
    try {
        const raw = fs.readFileSync(hostRuntimeInfoPath(cacheDir), 'utf8');
        const parsed = JSON.parse(raw) as HostRuntimeInfo;
        if (!parsed || typeof parsed !== 'object') { return undefined; }
        return parsed;
    } catch {
        return undefined;
    }
}
