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
import { SessionIndex } from '../index/sessionIndex';

interface SessionRef { id: string; title: string; source: string; date: string; }

const RANK_MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Parse session reference blocks from a rendered prompt string.
 * Each block looks like:
 *   [Session: <title>] | Source: <source> | Date: <date>
 *   Passage: ...
 *   ID: <id>
 */
function parseSessionRefs(promptText: string): SessionRef[] {
    const refs: SessionRef[] = [];
    let pending: Omit<SessionRef, 'id'> | null = null;
    for (const line of promptText.split('\n')) {
        const headerMatch = line.match(/^\[Session:\s*(.+?)\]\s*\|\s*Source:\s*(.+?)\s*\|\s*Date:\s*(.+)$/);
        if (headerMatch) {
            pending = { title: headerMatch[1], source: headerMatch[2], date: headerMatch[3] };
            continue;
        }
        const idMatch = line.match(/^ID:\s*(.+)$/);
        if (idMatch && pending) {
            refs.push({ ...pending, id: idMatch[1].trim() });
            pending = null;
        }
    }
    return refs;
}

/** Build a trusted MarkdownString with a medal-ranked GFM table of session refs. */
function buildSourcesMarkdown(refs: SessionRef[], sessionIndex: SessionIndex, phase1 = false): vscode.MarkdownString {
    const sessionWord = refs.length === 1 ? 'session' : 'sessions';
    const lines = [
        `\n---\n📚 **Potential matches** — ${refs.length} ${sessionWord} retrieved\n`,
        '| | Session | Source | Date | About |',
        '|---|---|---|---|---|',
    ];
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const marker = phase1 ? `${i + 1}.` : (RANK_MEDALS[i] ?? `${i + 1}.`);
        const args = encodeURIComponent(JSON.stringify([{ id: ref.id }]));
        const uri = `command:chatwizard.openSession?${args}`;
        const dateStr = new Date(ref.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const session = sessionIndex.get(ref.id);
        const firstMsg = session?.messages.find(m => m.role === 'user')?.content ?? '';
        const about = firstMsg.slice(0, 100).replace(/[\n\r]+/g, ' ').trim() + (firstMsg.length > 100 ? '…' : '');
        lines.push(`| ${marker} | [${ref.title}](${uri}) | ${ref.source} | ${dateStr} | ${about} |`);
    }
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = { enabledCommands: ['chatwizard.openSession'] };
    return md;
}

/**
 * Filters a rendered prompt string so that only session blocks whose IDs are
 * in `allowedIds` are retained.  All other `[Session: …]` blocks are stripped.
 * Non-session lines (preamble, footer) are preserved unchanged.
 *
 * A session block is the run of consecutive non-blank lines that begins with
 * a `[Session: …]` header and ends at the next blank line (inclusive).
 */
export function filterPromptToAllowedSessions(text: string, allowedIds: Set<string>): string {
    const lines = text.split('\n');
    const out: string[] = [];
    let inBlock = false;
    let blockLines: string[] = [];
    let blockId: string | null = null;

    const flushBlock = () => {
        if (blockId !== null && allowedIds.has(blockId)) {
            out.push(...blockLines);
        }
        inBlock = false;
        blockLines = [];
        blockId = null;
    };

    for (const line of lines) {
        const isSessionHeader = /^\[Session:\s*.+\]\s*\|/.test(line);
        if (isSessionHeader) {
            if (inBlock) { flushBlock(); }
            inBlock = true;
            blockLines = [line];
            blockId = null;
            continue;
        }
        if (inBlock) {
            const idMatch = line.match(/^ID:\s*(.+)$/);
            if (idMatch) { blockId = idMatch[1].trim(); }
            blockLines.push(line);
            // A blank line terminates the block
            if (line.trim() === '') { flushBlock(); }
            continue;
        }
        out.push(line);
    }
    // Flush any trailing block (no trailing blank line)
    if (inBlock) { flushBlock(); }

    return out.join('\n');
}

/** Factory for creating a user-role language model message. Injectable for testing. */
export type UserMessageFactory = (text: string) => unknown;

/**
 * Creates the chat participant request handler.
 * Exported separately from registerChatParticipant to allow unit testing
 * without requiring a running VS Code chat API.
 *
 * @param promptMap        Map of full prompt name → IMcpPrompt instance.
 * @param sessionIndex     Live session index used to validate source refs.
 * @param makeUserMessage  Factory for creating LLM user messages. Defaults to
 *                         vscode.LanguageModelChatMessage.User (requires VS Code ≥ 1.90).
 */
export function createParticipantHandler(
    promptMap: Map<string, IMcpPrompt>,
    sessionIndex: SessionIndex,
    makeUserMessage: UserMessageFactory = (text) => vscode.LanguageModelChatMessage.User(text),
) {
    return async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult | void> => {
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

            // Parse session refs and filter to sessions that exist in the current index.
            // Done before the LLM call so refs are available for progress messages and buttons.
            const sessionRefs = parseSessionRefs(text);
            const existingRefs = sessionRefs
                .filter(ref => sessionIndex.get(ref.id) !== undefined)
                .slice(0, 3);

            // Strip the prompt down to only the sessions the table will show,
            // so the LLM cannot reference sessions the user never sees.
            const allowedIds = new Set(existingRefs.map(r => r.id));
            const filteredText = filterPromptToAllowedSessions(text, allowedIds);

            stream.progress('Searching chat history…');

            // --- Phase 1 logic for both answerFromHistory and troubleshootFromHistory ---
            const isTroubleshoot = command === 'troubleshootFromHistory';
            const isAnswer      = command === 'answerFromHistory';
            const isPhase2      = userText.startsWith('--continued ') || userText.startsWith('--generic ') || userText.startsWith('--general ');

            // The rendered text is a prompt — send it to the LLM and stream the response.
            // (MCP clients handle this step themselves; the chat participant must do it here.)
            const messages = [makeUserMessage(filteredText)] as vscode.LanguageModelChatMessage[];
            const modelResponse = await request.model.sendRequest(messages, {}, token);

            // llmFoundMatch: true if Phase 1 LLM confirmed at least one session is relevant.
            let llmFoundMatch = false;

            if ((isTroubleshoot || isAnswer) && !isPhase2 && existingRefs.length > 0) {
                // Accumulate Phase 1 response so we can inspect it before emitting sources.
                let llmResponse = '';
                for await (const chunk of modelResponse.text) {
                    llmResponse += chunk;
                }
                // Suppress table entirely when LLM found no relevant sessions.
                const noMatch = llmResponse.includes('No relevant history found');
                llmFoundMatch = !noMatch;
                if (llmFoundMatch) {
                    // Only show sessions whose title the LLM actually mentioned — drop the rest.
                    const mentionedRefs = existingRefs.filter(r => llmResponse.includes(r.title));
                    const refsToShow = mentionedRefs.length > 0 ? mentionedRefs : existingRefs;
                    // Sources table first, then the LLM assessment below it.
                    stream.markdown(buildSourcesMarkdown(refsToShow, sessionIndex, false));
                    stream.markdown(llmResponse);
                    if (isTroubleshoot) {
                        stream.button({ title: '✅ Yes — show solutions from history', command: 'chatwizard.troubleshoot.continued', arguments: [userText] });
                        stream.button({ title: '❌ No — show general troubleshooting tips', command: 'chatwizard.troubleshoot.generic', arguments: [userText] });
                    } else {
                        stream.button({ title: '✅ Yes — answer from history', command: 'chatwizard.answer.continued', arguments: [userText] });
                        stream.button({ title: '❌ No — get general guidance', command: 'chatwizard.answer.general', arguments: [userText] });
                    }
                } else {
                    stream.markdown('No relevant sessions found in your chat history for this question.');
                    if (isTroubleshoot) {
                        stream.button({ title: 'Show general troubleshooting tips', command: 'chatwizard.troubleshoot.generic', arguments: [userText] });
                    } else {
                        stream.button({ title: 'Get general guidance', command: 'chatwizard.answer.general', arguments: [userText] });
                    }
                }
            } else {
                for await (const chunk of modelResponse.text) {
                    stream.markdown(chunk);
                }
                // No sessions at all — offer the generic fallback for Phase 1 commands.
                if ((isTroubleshoot || isAnswer) && !isPhase2) {
                    if (isTroubleshoot) {
                        stream.button({ title: 'Show general troubleshooting tips', command: 'chatwizard.troubleshoot.generic', arguments: [userText] });
                    } else {
                        stream.button({ title: 'Get general guidance', command: 'chatwizard.answer.general', arguments: [userText] });
                    }
                }
            }

            // Phase 1 complete — buttons already emitted; Phase 2 answer was streamed above.
            if (isTroubleshoot || isAnswer) {
                return;
            }
        } catch (err) {
            stream.markdown(
                `Chat Wizard: error running \`/${command}\` — ${String(err)}`
            );
        }
    };
}

/** Participant ID — must match contributes.chatParticipants[].id in package.json */
const PARTICIPANT_ID = 'Veverke.chatwizard';

/**
 * Registers the @chatwizard VS Code chat participant.
 *
 * @param context       Extension context (participant is pushed onto subscriptions).
 * @param prompts       The live IMcpPrompt instances built in extension.ts.
 * @param sessionIndex  Live session index used to validate source refs.
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    prompts: IMcpPrompt[],
    sessionIndex: SessionIndex,
): void {
    // Guard: chat participants require VS Code ≥ 1.90.
    if (typeof vscode.chat?.createChatParticipant !== 'function') {
        return;
    }

    const promptMap = new Map(prompts.map(p => [p.name, p]));
    const handler = createParticipantHandler(promptMap, sessionIndex);

    // Commands used by Phase 1 stream.button() calls.
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.troubleshoot.continued', async (errorText: string) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /troubleshootFromHistory --continued ${errorText}`,
                isPartialQuery: false,
            });
        }),
        vscode.commands.registerCommand('chatwizard.troubleshoot.generic', async (errorText: string) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /troubleshootFromHistory --generic ${errorText}`,
                isPartialQuery: false,
            });
        }),
        vscode.commands.registerCommand('chatwizard.answer.continued', async (question: string) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /answerFromHistory --continued ${question}`,
                isPartialQuery: false,
            });
        }),
        vscode.commands.registerCommand('chatwizard.answer.general', async (question: string) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /answerFromHistory --general ${question}`,
                isPartialQuery: false,
            });
        }),
    );

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('comment-discussion');

    context.subscriptions.push(participant);
}
