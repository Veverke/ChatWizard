import * as vscode from 'vscode';
import * as path from 'path';
import { SessionIndex } from '../index/sessionIndex';
import { Session, SessionSummary } from '../types/index';
import { SessionTreeItem } from '../views/sessionTreeProvider';
import { serializeSession, serializeSessions } from '../export/markdownSerializer';
import { friendlySourceName, sourceCodiconId } from '../ui/sourceUi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a session title into a safe filename fragment (no extension). */
function safeFilename(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'session';
}

/** Return the best default directory URI for save/open dialogs. */
function defaultFolderUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) { return folders[0].uri; }
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '/';
    return vscode.Uri.file(home);
}

/**
 * Ask the user for export mode (separate files or combined), pick destination,
 * write files, and open the result. Shared by exportAll and exportSelected.
 */
export async function performExport(sessions: Session[]): Promise<void> {
    if (sessions.length === 0) {
        vscode.window.showInformationMessage('No sessions to export');
        return;
    }

    type ModeItem = vscode.QuickPickItem & { id: 'separate' | 'combined' };
    const modeItems: ModeItem[] = [
        { label: '$(file)  One file per session', description: 'Creates a .md file for each session in a chosen folder', id: 'separate' },
        { label: '$(files)  Single combined file', description: 'All sessions in one .md file with a table of contents', id: 'combined' },
    ];
    const modePick = await vscode.window.showQuickPick(modeItems, {
        title: 'Export Sessions',
        placeHolder: 'Choose export format',
    });
    if (!modePick) { return; }

    if (modePick.id === 'separate') {
        const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Choose export folder',
            openLabel: 'Export here',
        });
        if (!folderUris || folderUris.length === 0) { return; }
        const folder = folderUris[0];
        for (const session of sessions) {
            const fileUri = vscode.Uri.joinPath(folder, `${safeFilename(session.title)}.md`);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(serializeSession(session), 'utf8'));
        }
        vscode.window.showInformationMessage(`Exported ${sessions.length} session(s) to ${folder.fsPath}`);
        return;
    }

    // Combined file
    const saveUri = await vscode.window.showSaveDialog({
        filters: { 'Markdown': ['md'] },
        title: 'Save combined export',
        defaultUri: vscode.Uri.joinPath(defaultFolderUri(), 'chatwizard-export.md'),
    });
    if (!saveUri) { return; }
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(serializeSessions(sessions, 'combined'), 'utf8'));
    await vscode.window.showTextDocument(saveUri);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerExportCommands(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    getOrderedSummaries?: () => SessionSummary[],
): void {

    // -----------------------------------------------------------------------
    // chatwizard.exportSession — export a single session from the context menu
    // -----------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.exportSession', async (item: SessionTreeItem) => {
            const session = index.get(item.summary.id);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${item.summary.id}`);
                return;
            }
            const filename = `${safeFilename(session.title)}.md`;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(defaultFolderUri(), filename),
                filters: { 'Markdown': ['md'] },
                title: 'Export Session as Markdown',
            });
            if (!uri) { return; }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeSession(session), 'utf8'));
            await vscode.window.showTextDocument(uri);
        })
    );

    // -----------------------------------------------------------------------
    // chatwizard.exportAll — export every indexed session
    // -----------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.exportAll', async () => {
            const sessions = index.getAllSummaries()
                .map(s => index.get(s.id))
                .filter((s): s is Session => s !== null && s !== undefined);
            await performExport(sessions);
        })
    );

    // -----------------------------------------------------------------------
    // chatwizard.exportSelected — multi-pick sessions then export
    // -----------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.exportSelected', async () => {
            const allSummaries = getOrderedSummaries ? getOrderedSummaries() : index.getAllSummaries();
            if (allSummaries.length === 0) {
                vscode.window.showInformationMessage('No sessions to export');
                return;
            }

            type SummaryItem = vscode.QuickPickItem & { id: string };
            const items: SummaryItem[] = allSummaries.map((s: SessionSummary) => ({
                label: s.title || 'Untitled Session',
                description: `${path.basename(s.workspacePath ?? s.workspaceId)} · ${s.updatedAt.slice(0, 10)}`,
                detail: `${friendlySourceName(s.source)} · ${s.messageCount} messages`,
                id: s.id,
            }));

            // Use createQuickPick instead of showQuickPick to avoid scroll-dismissal
            // issues that occur with canPickMany on Windows.
            const qp = vscode.window.createQuickPick<SummaryItem>();
            qp.items = items;
            qp.canSelectMany = true;
            qp.title = 'Export Selected Sessions';
            qp.placeholder = 'Type to filter · Space or click to select · Enter to export';
            qp.matchOnDescription = true;
            qp.matchOnDetail = true;

            const picked = await new Promise<readonly SummaryItem[] | undefined>(resolve => {
                qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
                qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
                qp.show();
            });
            if (!picked || picked.length === 0) { return; }

            const sessions = picked
                .map(p => index.get(p.id))
                .filter((s): s is Session => s !== null && s !== undefined);
            await performExport(sessions);
        })
    );

    // -----------------------------------------------------------------------
    // chatwizard.exportExcerpt — export user-selected messages from a session
    // Invoked by the webview "Export Excerpt…" button via postMessage.
    // -----------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.exportExcerpt', async (sessionId: string) => {
            const session = index.get(sessionId);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
                return;
            }

            const visible = session.messages.filter(m => m.content.trim() !== '');
            const assistantLabel = friendlySourceName(session.source);
            const assistantIcon = sourceCodiconId(session.source);

            type MsgItem = vscode.QuickPickItem & { msgIndex: number };
            const items: MsgItem[] = visible.map((msg, i) => ({
                label: msg.role === 'user' ? '$(account) You' : `$(${assistantIcon}) ${assistantLabel}`,
                description: msg.content.split('\n')[0].slice(0, 90),
                msgIndex: i,
            }));

            const picked = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                title: `Export Excerpt — ${session.title}`,
                placeHolder: 'Select messages to include (Space to toggle, Enter to confirm)',
            });
            if (!picked || picked.length === 0) { return; }

            const excerptSession: Session = {
                ...session,
                title: `${session.title} (excerpt)`,
                messages: picked.map(p => visible[p.msgIndex]),
            };

            const filename = `${safeFilename(session.title)}-excerpt.md`;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(defaultFolderUri(), filename),
                filters: { 'Markdown': ['md'] },
                title: 'Export Excerpt as Markdown',
            });
            if (!uri) { return; }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeSession(excerptSession), 'utf8'));
            await vscode.window.showTextDocument(uri);
        })
    );
}
