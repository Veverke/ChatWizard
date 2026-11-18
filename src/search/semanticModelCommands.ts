// src/search/semanticModelCommands.ts

/**
 * Commands that let a user unblock semantic search without editing JSON settings
 * or reading logs: pick a mirror host, point at a pre-downloaded model folder,
 * retry, or clear a corrupt cache.
 *
 * All three are safe to run at any time — they only touch settings/files and ask
 * the extension to restart the semantic indexer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { describeMissingFiles, resolveLocalModel } from './localModelPath';
import { SEMANTIC_MODEL_FAILURE_MARKER, SEMANTIC_MODEL_READY_MARKER } from './semanticIndexer';

/** Where the troubleshooting docs live (kept in sync with docs/troubleshooting/). */
export const MODEL_TROUBLESHOOTING_URL =
    'https://github.com/Veverke/ChatWizard/blob/master/docs/troubleshooting/semantic-model-download.md';

/** Folder created by `SemanticModelInstaller` inside the model cache dir. */
const DOWNLOAD_SUBDIR = 'downloaded';

export interface SemanticModelCommandHost {
    /** `<globalStorage>/models` — holds the download, the markers and the sentinel. */
    modelsDir: string;
    /** Dispose + recreate the semantic indexer so new settings take effect. */
    restart(): void;
    /** True when `chatwizard.enableSemanticSearch` is on. */
    isEnabled(): boolean;
    /**
     * Forget the one-time download consent (used after a cache reset so the user
     * is asked again — and sees the download progress — instead of silently
     * pulling 23 MB in the background).
     */
    clearConsent(): Promise<void>;
}

export function registerSemanticModelCommands(
    context: vscode.ExtensionContext,
    host: SemanticModelCommandHost,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.configureSemanticModel', () => configureModelSource()),
        vscode.commands.registerCommand('chatwizard.retrySemanticModel', () => retryModelLoad(host)),
        vscode.commands.registerCommand('chatwizard.resetSemanticModelCache', () => resetModelCache(host)),
    );
}

type SourceQuickPickItem = vscode.QuickPickItem & { id: string };

/** `Chat Wizard: Configure AI Model Source…` */
async function configureModelSource(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('chatwizard');
    const currentMirror = (cfg.get<string>('semanticModelMirror') ?? '').trim();
    const currentPath = (cfg.get<string>('semanticModelPath') ?? '').trim();
    const isAutomatic = !currentMirror && !currentPath;

    const items: SourceQuickPickItem[] = [
        {
            id: 'auto',
            label: '$(cloud-download) Automatic',
            description: isAutomatic ? 'current' : '',
            detail: 'Official Hugging Face host, then the ChatWizard GitHub release asset.',
        },
        {
            id: 'mirror',
            label: '$(globe) Mirror host…',
            description: currentMirror,
            detail: 'e.g. https://hf-mirror.com — for networks that block huggingface.co.',
        },
        {
            id: 'local',
            label: '$(folder) Local model folder…',
            description: currentPath,
            detail: 'Use files downloaded on another machine — no network access needed.',
        },
        { id: 'guide', label: '$(book) Open troubleshooting guide' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Chat Wizard: AI model source',
        ignoreFocusOut: true,
    });
    if (!picked) {
        return;
    }

    if (picked.id === 'guide') {
        void vscode.env.openExternal(vscode.Uri.parse(MODEL_TROUBLESHOOTING_URL));
        return;
    }

    if (picked.id === 'auto') {
        await cfg.update('semanticModelMirror', '', vscode.ConfigurationTarget.Global);
        await cfg.update('semanticModelPath', '', vscode.ConfigurationTarget.Global);
        announce('Chat Wizard: using the automatic AI model source.');
        return;
    }

    if (picked.id === 'mirror') {
        await configureMirror(cfg, currentMirror);
        return;
    }

    await configureLocalFolder(cfg);
}


async function configureMirror(
    cfg: vscode.WorkspaceConfiguration,
    currentMirror: string,
): Promise<void> {
    const value = await vscode.window.showInputBox({
        title: 'Chat Wizard: mirror host',
        prompt: 'Base URL of a Hugging Face-compatible mirror. Leave empty to use the official host.',
        placeHolder: 'https://hf-mirror.com',
        value: currentMirror,
        ignoreFocusOut: true,
        validateInput: (input) => {
            const candidate = input.trim();
            if (!candidate) {
                return undefined;
            }
            try {
                const parsed = new URL(candidate);
                return parsed.protocol === 'https:' || parsed.protocol === 'http:'
                    ? undefined
                    : 'Only http(s) URLs are supported.';
            } catch {
                return 'Enter a full URL, e.g. https://hf-mirror.com';
            }
        },
    });
    if (value === undefined) {
        return;
    }
    const mirror = value.trim().replace(/\/+$/, '');
    await cfg.update('semanticModelPath', '', vscode.ConfigurationTarget.Global);
    await cfg.update('semanticModelMirror', mirror, vscode.ConfigurationTarget.Global);
    announce(
        mirror
            ? `Chat Wizard: AI model mirror set to ${mirror}.`
            : 'Chat Wizard: using the official AI model host.',
    );
}

async function configureLocalFolder(
    cfg: vscode.WorkspaceConfiguration,
): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Use this folder',
        title: 'Select the folder holding config.json, tokenizer.json and onnx/',
    });
    const folder = selection?.[0]?.fsPath;
    if (!folder) {
        return;
    }
    const resolved = resolveLocalModel(folder);
    if (resolved.missing.length > 0) {
        void vscode.window.showErrorMessage(
            'Chat Wizard: that folder is not a usable AI model folder — missing '
            + `${describeMissingFiles(resolved.missing)}. `
            + 'Expected config.json, tokenizer.json and onnx/model_quantized.onnx.',
        );
        return;
    }
    await cfg.update('semanticModelMirror', '', vscode.ConfigurationTarget.Global);
    await cfg.update('semanticModelPath', resolved.modelFolder, vscode.ConfigurationTarget.Global);
    announce('Chat Wizard: using the local AI model folder.');
}

/** `Chat Wizard: Retry Loading the AI Model` */
function retryModelLoad(host: SemanticModelCommandHost): void {
    if (!host.isEnabled()) {
        void vscode.window.showInformationMessage(
            'Chat Wizard: semantic search is disabled. Enable "chatwizard.enableSemanticSearch" to use it.',
            'Open Settings',
        ).then(action => {
            if (action === 'Open Settings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard.enableSemanticSearch');
            }
        });
        return;
    }
    host.restart();
    void vscode.window.showInformationMessage('Chat Wizard: retrying the AI model download…');
}

/** `Chat Wizard: Reset AI Model Cache` — repairs partial/corrupt downloads. */
async function resetModelCache(host: SemanticModelCommandHost): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        'Delete the downloaded AI model files? They will be fetched again (or read from your '
        + 'configured local model folder). This does not affect your sessions or search index.',
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') {
        return;
    }

    const targets = [
        path.join(host.modelsDir, DOWNLOAD_SUBDIR),
        path.join(host.modelsDir, SEMANTIC_MODEL_FAILURE_MARKER),
        path.join(host.modelsDir, SEMANTIC_MODEL_READY_MARKER),
    ];
    for (const target of targets) {
        try {
            await fs.promises.rm(target, { recursive: true, force: true });
        } catch {
            // Non-critical — a retry will surface a clear error if it matters.
        }
    }

    // Ask again on the next start so the re-download is visible, not silent.
    await host.clearConsent();

    host.restart();
    void vscode.window.showInformationMessage('Chat Wizard: AI model cache cleared.');
}

/**
 * Settings changes are applied by the configuration listener in `extension.ts`
 * (debounced) — announcing here keeps the two from racing into a double load.
 */
function announce(message: string): void {
    void vscode.window.showInformationMessage(message);
}
