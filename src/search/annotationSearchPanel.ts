// src/search/annotationSearchPanel.ts
// Feature 30 — Search Annotations: search only within annotation text across all sessions.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { SessionSummary } from '../types/index';
import { friendlySourceName, sourceCodiconId } from '../ui/sourceUi';

interface AnnotationResultItem extends vscode.QuickPickItem {
    sessionId: string;
    messageIndex: number;
}

/**
 * QuickPick-based panel for searching annotation text.
 * Loads all sidecar metadata, filters sessions whose annotations contain the query,
 * and lets the user open the session at the annotated message.
 */
export class AnnotationSearchPanel {
    static async show(
        context: vscode.ExtensionContext,
        index: SessionIndex,
        sidecarStore: SidecarMetadataStore,
    ): Promise<void> {
        // Build summary lookup map once
        const summaryMap = new Map<string, SessionSummary>();
        for (const summary of index.getAllSummaries()) {
            summaryMap.set(summary.id, summary);
        }

        // Pre-load all metadata
        const metaMap = await sidecarStore.load();

        const quickPick = vscode.window.createQuickPick<AnnotationResultItem>();
        quickPick.placeholder = 'Search annotation text…';
        quickPick.matchOnDescription = false;
        quickPick.matchOnDetail = true;

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        function runSearch(value: string): void {
            const text = value.trim().toLowerCase();
            if (!text) {
                quickPick.items = [];
                return;
            }

            const items: AnnotationResultItem[] = [];

            for (const [sessionId, meta] of metaMap.entries()) {
                const annotations = meta.annotations;
                if (!annotations || annotations.length === 0) { continue; }

                const summary = summaryMap.get(sessionId);
                if (!summary) { continue; }

                for (const ann of annotations) {
                    if (!ann.text.toLowerCase().includes(text)) { continue; }

                    const srcIcon = `$(${sourceCodiconId(summary.source)})`;
                    const label = `${srcIcon}  ${summary.title}`;
                    const dateStr = ann.createdAt.slice(0, 10);
                    const msgDate = summary.updatedAt.slice(0, 10);
                    const description = `${msgDate}  ·  msg #${ann.messageIndex + 1}`;
                    const detail = `Annotation (${dateStr}):  ${ann.text.slice(0, 200)}`;

                    items.push({
                        label,
                        description,
                        detail,
                        sessionId,
                        messageIndex: ann.messageIndex,
                    });
                }
            }

            // Sort: most recent sessions first
            items.sort((a, b) => {
                const sa = summaryMap.get(a.sessionId);
                const sb = summaryMap.get(b.sessionId);
                return (sb?.updatedAt ?? '').localeCompare(sa?.updatedAt ?? '');
            });

            quickPick.items = items;
        }

        quickPick.onDidChangeValue((value) => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                runSearch(value);
            }, 300);
        });

        quickPick.onDidAccept(() => {
            const active = quickPick.activeItems[0];
            if (active) {
                const summary = summaryMap.get(active.sessionId);
                if (summary) {
                    vscode.commands.executeCommand('chatwizard.openSession', summary, '', false);
                }
            }
        });

        quickPick.onDidHide(() => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            quickPick.dispose();
        });

        quickPick.show();
    }
}