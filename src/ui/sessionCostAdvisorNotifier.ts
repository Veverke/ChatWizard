// src/ui/sessionCostAdvisorNotifier.ts
//
// Subscribes to LiveSessionTracker.onDidUpdate() and, after each new turn is
// recorded, computes cost advice and surfaces it as a VS Code information message.
//
// Architecture:
//   - Debounced 2 s so rapid streaming updates only trigger one computation
//   - Reads chatwizard.sessionCostAdvisor.enabled (default: true)
//   - Reads chatwizard.sessionCostAdvisor.useLlm  (default: true)
//   - Uses LLM consolidation (consolidateLlm) as primary path when useLlm=true,
//     heuristic consolidate() as fallback/alternative
//   - SessionCostAdvisor enforces minimum savings threshold ($0.001)

import * as vscode from 'vscode';
import type { LiveSessionTracker } from '../utils/liveSessionTracker';
import type { SessionIndex } from '../index/sessionIndex';
import { SessionCostAdvisor, AdviseTurn } from '../analytics/sessionCostAdvisor';
import { consolidate } from '../analytics/promptConsolidator';
import { consolidateLlm } from '../analytics/promptConsolidatorLlm';
import { resolveModelId } from '../utils/modelPriceTable';
import { formatCostUsd } from '../utils/tokenizer';
import { SessionCostAdvicePanel } from './sessionCostAdvicePanel';
import type { ModelId } from '../utils/modelPriceTable';

const DEBOUNCE_MS = 2_000;

/** Returns a ModelId from a raw session.model string, with a sensible default. */
function inferModelId(raw: string | undefined): ModelId {
    if (!raw) { return 'claude-3-5-sonnet'; }
    return resolveModelId(raw) ?? 'claude-3-5-sonnet';
}

export class SessionCostAdvisorNotifier implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly liveTracker: LiveSessionTracker,
        private readonly sessionIndex: SessionIndex,
    ) {
        const sub = liveTracker.onDidUpdate(() => this._onUpdate());
        this._disposables.push(sub);
    }

    private _onUpdate(): void {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            void this._compute();
        }, DEBOUNCE_MS);
    }

    private async _compute(): Promise<void> {
        const config = vscode.workspace.getConfiguration('chatwizard');
        if (!config.get<boolean>('sessionCostAdvisor.enabled', true)) { return; }
        const useLlm = config.get<boolean>('sessionCostAdvisor.useLlm', true);

        // Resolve the most recently active session
        const entry = this.liveTracker.getActive()[0] ?? this.liveTracker.getMostRecent();
        if (!entry) { return; }

        const session = this.sessionIndex.get(entry.sessionId);
        if (!session) { return; }

        // Build turn records from consecutive user/assistant pairs
        const turns: AdviseTurn[] = [];
        const modelId = inferModelId(session.model);
        let pendingUser: string | null = null;

        for (const msg of session.messages) {
            if (msg.skipped) { continue; }
            if (msg.role === 'user') {
                pendingUser = msg.content;
            } else if (msg.role === 'assistant' && pendingUser !== null) {
                turns.push({ userText: pendingUser, assistantText: msg.content, modelId });
                pendingUser = null;
            }
        }

        if (turns.length < 2) { return; }

        const consolidateFn = useLlm
            ? (msgs: string[]) => consolidateLlm(msgs)
            : (msgs: string[]) => Promise.resolve(consolidate(msgs));

        const advisor = new SessionCostAdvisor(consolidateFn);
        let advice;
        try {
            advice = await advisor.advise(turns);
        } catch {
            return;
        }
        if (!advice) { return; }

        // Truncate consolidated prompt for the notification message
        const promptPreview = advice.consolidatedPrompt.length > 120
            ? advice.consolidatedPrompt.slice(0, 117) + '…'
            : advice.consolidatedPrompt;

        const msg =
            `💰 Session spend: ${formatCostUsd(advice.cumulativeCostUsd)} · ${advice.turnCount} turns · ${advice.modelDisplayName}\n` +
            `💡 Had you started with: "${promptPreview}" → saving ${formatCostUsd(advice.savingsUsd)} (${advice.savingsPct}%)`;

        const selection = await vscode.window.showInformationMessage(msg, 'View Details');
        if (selection === 'View Details') {
            SessionCostAdvicePanel.show(advice);
        }
    }

    dispose(): void {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        for (const d of this._disposables) { d.dispose(); }
    }
}
