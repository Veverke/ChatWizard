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
import { tokenizeQuery } from '../search/fullTextEngine';

interface SessionRef { id: string; title: string; source: string; date: string; passage?: string; }

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
    let passageLines: string[] = [];
    let inPassage = false;
    for (const line of promptText.split('\n')) {
        const headerMatch = line.match(/^\[Session:\s*(.+?)\]\s*\|\s*Source:\s*(.+?)\s*\|\s*Date:\s*(.+)$/);
        if (headerMatch) {
            pending = { title: headerMatch[1], source: headerMatch[2], date: headerMatch[3] };
            passageLines = [];
            inPassage = false;
            continue;
        }
        if (pending && line.startsWith('Passage: ')) {
            passageLines = [line.slice('Passage: '.length)];
            inPassage = true;
            continue;
        }
        if (inPassage) {
            const idMatch = line.match(/^ID:\s*(.+)$/);
            if (idMatch) {
                refs.push({ ...pending!, id: idMatch[1].trim(), passage: passageLines.join('\n') });
                pending = null;
                passageLines = [];
                inPassage = false;
            } else {
                passageLines.push(line);
            }
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

/** Build a trusted MarkdownString with a medal-ranked GFM table of confirmed-relevant session refs. */
function buildSourcesMarkdown(refs: SessionRef[], queryTokens: string[] = []): vscode.MarkdownString {
    const sessionWord = refs.length === 1 ? 'session' : 'sessions';
    const lines = [
        `\n---\n📚 **Found in your history** — ${refs.length} relevant ${sessionWord}\n`,
        '| | Session | Source | Date | Excerpt |',
        '|---|---|---|---|---|',
    ];
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const marker = RANK_MEDALS[i] ?? `${i + 1}.`;
        const args = encodeURIComponent(JSON.stringify([{ id: ref.id }]));
        const uri = `command:chatwizard.openSession?${args}`;
        const dateStr = new Date(ref.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        // Escape pipe characters so they don't break the GFM table cell.
        const about = keywordAnchoredExcerpt(ref.passage ?? '', queryTokens, 200).replace(/\|/g, '\\|');
        lines.push(`| ${marker} | [${ref.title}](${uri}) | ${ref.source} | ${dateStr} | ${about} |`);
    }
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = { enabledCommands: ['chatwizard.openSession'] };
    return md;
}

/**
 * Return an excerpt from `passage` centred around the first occurrence of any
 * query keyword.  If keywords appear near the start (within 30 chars) the
 * excerpt starts from the beginning.  A leading ‘…’ is prepended when the
 * window starts mid-text so the reader knows context was skipped.
 */
function boldKeywords(text: string, keywordTokens: string[]): string {
    if (keywordTokens.length === 0) { return text; }
    const escaped = keywordTokens.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const kwRegex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
    const result: string[] = [];
    const protectedRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = protectedRegex.exec(text)) !== null) {
        if (m.index > lastIndex) {
            result.push(text.slice(lastIndex, m.index).replace(kwRegex, '**`$1`**'));
        }
        const span = m[0];
        if (span.startsWith('**')) {
            // Inside an existing bold span — apply `code` only to avoid breaking ** markers
            const inner = span.slice(2, -2);
            result.push('**' + inner.replace(kwRegex, '`$1`') + '**');
        } else {
            // Inside a code span — pass through untouched
            result.push(span);
        }
        lastIndex = protectedRegex.lastIndex;
    }
    if (lastIndex < text.length) {
        result.push(text.slice(lastIndex).replace(kwRegex, '**`$1`**'));
    }
    return result.join('');
}

/**
 * Sort `tokens` by ascending corpus frequency (rarest first) using the live
 * session index as the IDF source.  Rarer tokens are more semantically specific
 * and should be preferred when anchoring excerpts.
 */
function sortTokensByRarity(tokens: string[], sessionIndex: SessionIndex): string[] {
    if (tokens.length <= 1) { return tokens; }
    const summaries = sessionIndex.getAllSummaries();
    const freq = new Map<string, number>();
    for (const kw of tokens) {
        let count = 0;
        for (const s of summaries) {
            const session = sessionIndex.get(s.id);
            if (!session) { continue; }
            const words = new Set(
                session.messages.map(m => m.content.toLowerCase()).join(' ').split(/\W+/)
            );
            if (words.has(kw)) { count++; }
        }
        freq.set(kw, count);
    }
    return [...tokens].sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0));
}

function keywordAnchoredExcerpt(passage: string, keywordTokens: string[], maxChars: number): string {
    const flat = passage.replace(/[\n\r]+/g, ' ').trim();
    if (!flat) { return ''; }
    if (keywordTokens.length === 0) {
        return flat.slice(0, maxChars) + (flat.length > maxChars ? '…' : '');
    }
    const lower = flat.toLowerCase();
    // Priority anchoring: tokens are pre-sorted rarest-first, so the first one
    // found in the passage is automatically the most specific match.
    let anchorPos = -1;
    for (const kw of keywordTokens) {
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const match = re.exec(lower);
        if (match) { anchorPos = match.index; break; }
    }
    let excerpt: string;
    let prefix = '';
    let suffix = '';
    if (anchorPos <= 30 || anchorPos === -1) {
        excerpt = flat.slice(0, maxChars);
        if (flat.length > maxChars) { suffix = '…'; }
    } else {
        const start = anchorPos - 30;
        excerpt = flat.slice(start, start + maxChars);
        prefix = '…';
        if (start + maxChars < flat.length) { suffix = '…'; }
    }
    return prefix + boldKeywords(excerpt, keywordTokens) + suffix;
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
        const command = request.command; // e.g. 'queryHistory'
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
            const sessionCount = sessionIndex.getAllSummaries().length;

            // Emit first progress message before the expensive render() call
            if (command === 'queryHistory' && !userText.startsWith('--continued ') && !userText.startsWith('--general ')) {
                stream.progress(`Searching ${sessionCount} sessions…`);
            } else if (command === 'continueFromHistory') {
                stream.progress('Retrieving your most recent session…');
            } else if (command === 'getPrompts') {
                stream.progress('Loading prompt library…');
            }

            const result = await prompt.render(args);
            const text = result.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map(c => c.text)
                .join('\n\n');

            // Parse session refs and filter to sessions that exist in the current index.
            const sessionRefs = parseSessionRefs(text);
            const existingRefs = sessionRefs
                .filter(ref => sessionIndex.get(ref.id) !== undefined)
                .slice(0, 3);

            // Strip the prompt down to only the sessions we'll show, so Phase 2 LLM
            // cannot reference sessions the user never saw.
            const allowedIds = new Set(existingRefs.map(r => r.id));
            const filteredText = filterPromptToAllowedSessions(text, allowedIds);

            const isQuery  = command === 'queryHistory';
            const isPhase2 = userText.startsWith('--continued ') || userText.startsWith('--general ');

            if (isQuery && !isPhase2) {
                stream.progress(`Found ${sessionRefs.length} candidate sessions — evaluating relevance…`);
                // Phase 1 — display pre-filtered sessions directly.
                // The keyword filter in getContextTool already removed irrelevant sessions.
                // No LLM gating: LLM filtering was unreliable (too selective) and
                // caused relevant sessions to be incorrectly excluded from the table.
                const queryTokens = sortTokensByRarity(tokenizeQuery(userText), sessionIndex);
                // Enrich passages: if the top-priority (rarest) token is absent from
                // the tool-returned passage, find it in the full session content instead.
                const topToken = queryTokens[0];
                const enrichedRefs = topToken ? existingRefs.map(ref => {
                    const re = new RegExp(`\\b${topToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    if (re.test(ref.passage ?? '')) { return ref; }
                    const session = sessionIndex.get(ref.id);
                    if (!session) { return ref; }
                    const fullText = session.messages.map(m => m.content).join('\n');
                    const match = re.exec(fullText);
                    if (!match) { return ref; }
                    const start = Math.max(0, match.index - 100);
                    return { ...ref, passage: fullText.slice(start, start + 400) };
                }) : existingRefs;
                stream.progress(`Assembling answer from ${enrichedRefs.length} confirmed match${enrichedRefs.length === 1 ? '' : 'es'}…`);
                if (enrichedRefs.length > 0) {
                    stream.markdown(buildSourcesMarkdown(enrichedRefs, queryTokens));
                    const refIds = enrichedRefs.map(r => r.id).join(',');
                    stream.button({ title: '✅ Yes — use history', command: 'chatwizard.query.continued', arguments: [userText, refIds] });
                    stream.button({ title: '❌ No — get general guidance', command: 'chatwizard.query.general', arguments: [userText] });
                } else {
                    stream.markdown('No relevant sessions found in your chat history for this question.');
                    stream.button({ title: 'Get general guidance', command: 'chatwizard.query.general', arguments: [userText] });
                }
                return;
            }

            // Phase 2 (--continued / --general) or other prompts — call LLM and stream.
            if (command === 'continueFromHistory') {
                stream.progress('Building continuation summary…');
            } else if (command === 'getPrompts') {
                stream.progress('Ranking prompts by relevance…');
            }

            const messages = [makeUserMessage(filteredText)] as vscode.LanguageModelChatMessage[];
            const modelResponse = await request.model.sendRequest(messages, {}, token);

            if (command === 'continueFromHistory') {
                stream.progress('Ready — here is where you left off…');
            } else if (command === 'getPrompts') {
                stream.progress('Found matching prompts — assembling response…');
            }

            for await (const chunk of modelResponse.text) {
                stream.markdown(chunk);
            }

            // Inline action buttons (requires VS Code ≥ 1.90)
            if (typeof stream.button === 'function') {
                if (command === 'continueFromHistory') {
                    const lastSessionId = existingRefs[0]?.id;
                    if (lastSessionId) {
                        stream.button({
                            command: 'chatwizard.openSession',
                            title: '$(arrow-right) Pick up where I left off',
                            tooltip: 'Open the last session in the reader',
                            arguments: [{ id: lastSessionId }],
                        });
                    }
                    stream.button({
                        command: 'chatwizard.focusSessionTree',
                        title: '$(history) Open last session in tree',
                        tooltip: 'Reveal this session in the ChatWizard tree',
                        arguments: [],
                    });
                } else if (command === 'queryHistory' && isPhase2) {
                    stream.button({
                        command: 'chatwizard.focusSessionTree',
                        title: '$(list-tree) Open in ChatWizard',
                        tooltip: 'Focus the ChatWizard session tree',
                        arguments: [],
                    });
                    if (existingRefs[0]?.id) {
                        stream.button({
                            command: 'chatwizard.exportSession',
                            title: '$(export) Export answer',
                            tooltip: 'Export this answer to Markdown',
                            arguments: [{ id: existingRefs[0].id }],
                        });
                    }
                }
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
        vscode.commands.registerCommand('chatwizard.query.continued', async (query: string, refIds?: string) => {
            const refsPart = refIds ? ` --refs ${refIds}` : '';
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /queryHistory --continued ${query}${refsPart}`,
                isPartialQuery: false,
            });
        }),
        vscode.commands.registerCommand('chatwizard.query.general', async (query: string) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@chatwizard /queryHistory --general ${query}`,
                isPartialQuery: false,
            });
        }),
    );

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('comment-discussion');

    context.subscriptions.push(participant);
}
