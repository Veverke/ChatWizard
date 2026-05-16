// src/search/semanticContracts.ts

import { SemanticSearchResult, SemanticMessageResult } from './types';
import { Session } from '../types/index';

/** Embedding dimension for Xenova/all-MiniLM-L6-v2 */
export const SEMANTIC_DIMS = 384;

/**
 * Minimum cosine similarity score (0–1) for a result to be included.
 * For all-MiniLM-L6-v2 with fine-grained (message/paragraph) embeddings,
 * <0.35 is effectively noise/unrelated.
 */
export const SEMANTIC_MIN_SCORE = 0.35;

/**
 * Which turn types to include when searching the vector index.
 * Scope is a search-time filter only — indexing always covers both turn types.
 */
export type SemanticScope = 'both' | 'user' | 'assistant';

/** Wraps @xenova/transformers — loads the ONNX model and produces normalized embeddings */
export interface IEmbeddingEngine {
    readonly isReady: boolean;
    load(onProgress?: (message: string) => void): Promise<void>;
    embed(text: string): Promise<Float32Array>;
}

/** In-memory vector store with binary file persistence */
export interface ISemanticIndex {
    readonly size: number;
    add(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number, embedding: Float32Array): void;
    remove(sessionId: string): void;
    has(sessionId: string): boolean;
    search(queryEmbedding: Float32Array, topK: number, minScore?: number, scope?: SemanticScope): SemanticMessageResult[];
    save(filePath: string): Promise<void>;
    load(filePath: string): Promise<void>;
}

/** Orchestrates background embedding of sessions and exposes search */
export interface ISemanticIndexer {
    readonly isReady: boolean;
    readonly isIndexing: boolean;
    readonly indexedCount: number;
    initialize(): Promise<void>;
    scheduleSession(session: Session): void;
    removeSession(sessionId: string): void;
    search(query: string, topK: number, minScore?: number, scope?: SemanticScope): Promise<SemanticSearchResult[]>;
    dispose(): void;
}

/**
 * Stand-in for ISemanticIndexer used when semantic search is disabled.
 * All methods are no-ops; isReady is always false so tool callers
 * return the expected "not enabled" error message.
 */
export class NullSemanticIndexer implements ISemanticIndexer {
    readonly isReady = false;
    readonly isIndexing = false;
    readonly indexedCount = 0;
    async initialize(): Promise<void> { /* no-op */ }
    scheduleSession(_session: Session): void { /* no-op */ }
    removeSession(_sessionId: string): void { /* no-op */ }
    async search(_query: string, _topK: number, _minScore?: number, _scope?: SemanticScope): Promise<SemanticSearchResult[]> { return []; }
    dispose(): void { /* no-op */ }
}
