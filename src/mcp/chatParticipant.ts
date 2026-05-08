// src/mcp/chatParticipant.ts
//
// Registers a VS Code chat participant (@chatwizard) that surfaces the same
// three slash commands as the MCP prompts so they appear in the Copilot Chat
// `/` menu without requiring an MCP server connection.
//
// Logic is delegated entirely to the live IMcpPrompt.render() implementations,
// keeping behaviour identical to what MCP clients receive.
//
// IMPORTANT — keeping package.json in sync:
//   The static `contributes.chatParticipants.commands` array in package.json
//   must match the PROMPT_DEFS export in src/mcp/prompts/contextPrompts.ts.
//   When you add / rename / remove a prompt there, update package.json too.

import * as vscode from 'vscode';
import type { IMcpPrompt } from './mcpContracts';
import { PROMPT_DEFS } from './prompts/contextPrompts';

/** Participant ID — must match contributes.chatParticipants[].id in package.json */
const PARTICIPANT_ID = 'Veverke.chatwizard';

/**
 * Registers the @chatwizard VS Code chat participant.
 *
 * @param context  Extension context (participant is pushed onto subscriptions).
 * @param prompts  The live IMcpPrompt instances built in extension.ts — same
 *                 objects registered with the MCP server.
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    prompts: IMcpPrompt[],
): void {
    // Guard: chat participants require VS Code ≥ 1.90.
    if (typeof vscode.chat?.createChatParticipant !== 'function') {
        return;
    }

    const promptMap = new Map(prompts.map(p => [p.name, p]));

    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        async (request, _chatContext, stream, _token) => {
            const command = request.command; // e.g. 'answerFromHistory'
            const userText = request.prompt.trim();

            if (!command) {
                // Bare @chatwizard mention — list available slash commands.
                stream.markdown(
                    '**Chat Wizard** — available commands:\n\n' +
                    PROMPT_DEFS.map(d => `- \`/${d.command}\` — ${d.description}`).join('\n')
                );
                return;
            }

            const fullName = `chatwizard.${command}`;
            const prompt = promptMap.get(fullName);
            if (!prompt) {
                stream.markdown(`Chat Wizard: unknown command \`/${command}\`.`);
                return;
            }

            // Map the user's free-form text to the first declared argument.
            const def = PROMPT_DEFS.find(d => d.command === command);
            const argName = def?.argName ?? 'input';
            const args: Record<string, string> = userText ? { [argName]: userText } : {};

            try {
                const result = await prompt.render(args);
                const text = result.content
                    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                    .map(c => c.text)
                    .join('\n\n');
                stream.markdown(text);
            } catch (err) {
                stream.markdown(
                    `Chat Wizard: error running \`/${command}\` — ${String(err)}`
                );
            }
        }
    );

    participant.iconPath = new vscode.ThemeIcon('comment-discussion');
    context.subscriptions.push(participant);
}
