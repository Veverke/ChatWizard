// src/ui/brandingStatusBar.ts
// Persistent branding status-bar item showing the ChatWizard squirrel mascot.
// Default tooltip shows the extension version.  When a notable event occurs,
// call notify() — the squirrel pulses and the tooltip describes what happened.
// Clicking always runs the most relevant command and resets the tooltip.
// The tooltip auto-resets after 60 s if the user doesn't click.

import * as vscode from 'vscode';

// Just the squirrel — no label text.
const ICON_NORMAL = '🐿️';

// Pulse animation: icon → icon+space, repeated twice (~320 ms total).
// Only trailing en-space (U+2002) is used so the icon's left edge stays fixed,
// preventing the status bar from shifting when the item resizes.
const SP = '\u2002';   // en-space — reliable fixed-width padding in the status bar
const TILT_FRAMES = [
    ICON_NORMAL,              // frame 0 – normal
    `${ICON_NORMAL}${SP}`,   // frame 1 – expand right
    ICON_NORMAL,              // frame 2 – normal
    `${ICON_NORMAL}${SP}`,   // frame 3 – expand right
] as const;

const FRAME_MS       = 80;       // ms per frame  (4 × 80 = 320 ms total)
const PERIODIC_MS    = 20_000;   // idle heartbeat: pulse every 20 s
const RESET_AFTER_MS = 60_000;   // auto-reset tooltip if user doesn't click

const DEFAULT_CMD  = 'workbench.view.extension.chatwizard';
const INTERNAL_CMD = 'chatwizard._brandingClick';

export class BrandingStatusBarItem implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly _version: string;
    private _pendingCommand = DEFAULT_CMD;
    private _frameTimers: ReturnType<typeof setTimeout>[] = [];
    private _resetTimer:   ReturnType<typeof setTimeout>  | undefined;
    private _periodicTimer: ReturnType<typeof setInterval> | undefined;
    private readonly _cmdDisposable: vscode.Disposable;

    constructor(version: string) {
        this._version = version;
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            5, // far-right, unobtrusive
        );
        this.item.text    = ICON_NORMAL;
        this.item.command = INTERNAL_CMD;
        // Single internal click handler: run the target command then reset the tooltip.
        this._cmdDisposable = vscode.commands.registerCommand(INTERNAL_CMD, () => {
            const cmd = this._pendingCommand;
            this._reset();
            void vscode.commands.executeCommand(cmd);
        });
        this._applyDefault();
        this.item.show();
        // Periodic idle heartbeat — pulses every 20 s so the user notices the icon.
        this._periodicTimer = setInterval(() => this._pulse(), PERIODIC_MS);
    }

    /**
     * Pulse the squirrel and update the tooltip to describe a notable event.
     * Clicking the icon will run `command` and immediately reset the tooltip.
     * The tooltip auto-resets after 60 s if the user doesn't click.
     */
    notify(message: string, command: string = DEFAULT_CMD): void {
        this._pendingCommand = command;
        this.item.tooltip = `${message} — click to open`;
        this._pulse();
        if (this._resetTimer) { clearTimeout(this._resetTimer); }
        this._resetTimer = setTimeout(() => this._reset(), RESET_AFTER_MS);
    }

    private _reset(): void {
        if (this._resetTimer) { clearTimeout(this._resetTimer); this._resetTimer = undefined; }
        this._pendingCommand = DEFAULT_CMD;
        this._applyDefault();
    }

    private _applyDefault(): void {
        this.item.tooltip = `ChatWizard v${this._version} — click to open`;
    }

    private _pulse(): void {
        for (const t of this._frameTimers) { clearTimeout(t); }
        this._frameTimers = [];
        TILT_FRAMES.forEach((frame, i) => {
            this._frameTimers.push(
                setTimeout(() => { this.item.text = frame; }, i * FRAME_MS),
            );
        });
        // Reset to normal after all frames so no trailing space lingers.
        this._frameTimers.push(
            setTimeout(() => { this.item.text = ICON_NORMAL; }, TILT_FRAMES.length * FRAME_MS),
        );
    }

    dispose(): void {
        if (this._periodicTimer) { clearInterval(this._periodicTimer); }
        if (this._resetTimer)    { clearTimeout(this._resetTimer); }
        for (const t of this._frameTimers) { clearTimeout(t); }
        this._cmdDisposable.dispose();
        this.item.dispose();
    }
}
