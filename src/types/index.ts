// src/types/index.ts

/** Which AI chat extension produced the session */
export type SessionSource = 'copilot' | 'claude';

/** Role of a message participant */
export type MessageRole = 'user' | 'assistant';

/** A fenced code block extracted from a message */
export interface CodeBlock {
    /** Programming language label (e.g. 'typescript', 'python', '') */
    language: string;
    /** Raw code content */
    content: string;
    /** ID of the session this block belongs to */
    sessionId: string;
    /** Index of the message within the session */
    messageIndex: number;
    /** 0-based index of this block among all fenced code blocks in the same message */
    blockIndexInMessage?: number;
}

/** A single turn in a conversation */
export interface Message {
    /** Unique identifier for this message (UUID or derived) */
    id: string;
    /** Whether this is a user or assistant message */
    role: MessageRole;
    /** Full text content of the message */
    content: string;
    /** Code blocks extracted from this message */
    codeBlocks: CodeBlock[];
    /** ISO timestamp string, or undefined if not recorded */
    timestamp?: string;
}

/** A complete chat session (one conversation thread) */
export interface Session {
    /** Unique identifier (derived from file path or internal ID) */
    id: string;
    /** Human-readable title or first user prompt truncated */
    title: string;
    /** Which AI extension produced this session */
    source: SessionSource;
    /** Opaque workspace identifier (hash or path) */
    workspaceId: string;
    /** Resolved path to the workspace root, if known */
    workspacePath?: string;
    /** AI model used in this session (e.g. "claude-sonnet-4-6", "gpt-4o") */
    model?: string;
    /** Ordered list of messages */
    messages: Message[];
    /** Absolute path to the source file on disk */
    filePath: string;
    /** Size of the source file in bytes, if available */
    fileSizeBytes?: number;
    /** ISO timestamp of session creation */
    createdAt: string;
    /** ISO timestamp of last update */
    updatedAt: string;
}

/** A fenced code block with session metadata attached, for the Code Blocks panel */
export interface IndexedCodeBlock {
    /** Programming language label (e.g. 'typescript', 'python', '') */
    language: string;
    /** Raw code content */
    content: string;
    /** ID of the session this block belongs to */
    sessionId: string;
    /** Index of the message within the session */
    messageIndex: number;
    /** 0-based index of this block among all fenced code blocks in the same message */
    blockIndexInMessage?: number;
    /** Whether this block came from a user or assistant message */
    messageRole: MessageRole;
    /** Human-readable session title */
    sessionTitle: string;
    /** Which AI source produced the session */
    sessionSource: SessionSource;
    /** ISO timestamp of last session update */
    sessionUpdatedAt: string;
    /** Resolved workspace path, if known */
    sessionWorkspacePath?: string;
}

/** A user-turn prompt, extracted for the Prompt Library */
export interface Prompt {
    /** Full text of the prompt */
    content: string;
    /** Session the prompt came from */
    sessionId: string;
    /** Message index within the session */
    messageIndex: number;
    /** ISO timestamp of the prompt */
    timestamp?: string;
}

/** Lightweight summary used by the TreeView (avoids holding full message content) */
export interface SessionSummary {
    id: string;
    title: string;
    source: SessionSource;
    workspaceId: string;
    workspacePath?: string;
    model?: string;
    filePath: string;
    fileSizeBytes?: number;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    createdAt: string;
    updatedAt: string;
}

/** Result of parsing a raw JSONL file */
export interface ParseResult {
    session: Session;
    errors: string[];
}

/** Workspace mapping info from Copilot's workspace.json */
export interface CopilotWorkspaceInfo {
    workspaceId: string;
    workspacePath: string;
    storageDir: string;
}
