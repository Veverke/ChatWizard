// src/ui/userSurveyPrompt.ts
// Feature — User Survey notification that appears once per day, 30 minutes
// after extension activation, with "Take it", "Already taken", and "Later" options.

import * as vscode from 'vscode';

const SURVEY_URL = 'https://forms.gle/Mj4JtMsYLdxQds1R6';

/** Delay before the survey notification first fires after activation (ms). */
const INITIAL_DELAY_MS = 30 * 60 * 1000; // 30 minutes

/** Keys used in globalState. */
const KEY_PERM_DISMISSED = 'chatwizard.surveyPermanentlyDismissed';
const KEY_LAST_SHOWN_DATE = 'chatwizard.surveyLastShownDate';

function getTodayDate(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Starts the user survey prompt timer. Call once from activate().
 * Returns a disposable so it can be cleaned up on deactivation.
 */
export function startUserSurveyPrompt(context: vscode.ExtensionContext): vscode.Disposable {
    const timer = setTimeout(() => {
        showSurveyPrompt(context);
    }, INITIAL_DELAY_MS);

    return { dispose: () => clearTimeout(timer) };
}

async function showSurveyPrompt(context: vscode.ExtensionContext): Promise<void> {
    // Check permanent dismissal
    if (context.globalState.get<boolean>(KEY_PERM_DISMISSED, false)) {
        return;
    }

    // Check if already shown today
    const lastShown = context.globalState.get<string>(KEY_LAST_SHOWN_DATE, '');
    const today = getTodayDate();
    if (lastShown === today) {
        return;
    }

    // Record that we showed it today (prevents re-trigger if user picks "Later" or dismisses)
    await context.globalState.update(KEY_LAST_SHOWN_DATE, today);

    const selection = await vscode.window.showInformationMessage(
        '🐿️ Chat Wizard — Got a minute? Help shape the future by filling in our quick user survey!',
        { modal: false },
        'Take it',
        'Already taken',
        'Later',
    );

    if (selection === 'Take it') {
        await vscode.env.openExternal(vscode.Uri.parse(SURVEY_URL));
    } else if (selection === 'Already taken') {
        await context.globalState.update(KEY_PERM_DISMISSED, true);
    } else {
        // "Later" — already recorded as shown today; nothing more to do.
    }
}

/**
 * Resets survey state (for testing purposes).
 */
export function resetSurveyState(context: vscode.ExtensionContext): Promise<void> {
    return Promise.all([
        context.globalState.update(KEY_PERM_DISMISSED, undefined),
        context.globalState.update(KEY_LAST_SHOWN_DATE, undefined),
    ]).then(() => undefined);
}

/**
 * Manually triggers the survey prompt (for the chatwizard.showSurvey command).
 */
export function showSurveyPromptManually(context: vscode.ExtensionContext): void {
    // Bypass the daily check so the user can always trigger it manually
    if (context.globalState.get<boolean>(KEY_PERM_DISMISSED, false)) {
        void vscode.window.showInformationMessage(
            'You have already marked the survey as completed. Use "Chat Wizard: Reset Survey" if you want to reset this.',
        );
        return;
    }
    void showSurveyPrompt(context);
}