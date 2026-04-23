// src/search/semanticContracts.ts

import { SemanticSearchResult } from './types';

/** Embedding dimension for Xenova/all-MiniLM-L6-v2 */
export const SEMANTIC_DIMS = 384;

/** Maximum characters of session text passed to the embedding model */
export const SEMANTIC_MAX_CHARS = 2048;

/**
 * Minimum cosine similarity score (0–1) for a result to be included.
 * For all-MiniLM-L6-v2: <0.25 is effectively noise/unrelated.
 */
export const SEMANTIC_MIN_SCORE = 0.25;

/** Wraps @xenova/transformers — loads the ONNX model and produces normalized embeddings */
export interface IEmbeddingEngine {
    readonly isReady: boolean;
    load(onProgress?: (message: string) => void): Promise<void>;
    embed(text: string): Promise<Float32Array>;
}

/** In-memory vector store with binary file persistence */
export interface ISemanticIndex {
    readonly size: number;
    add(sessionId: string, embedding: Float32Array): void;
    remove(sessionId: string): void;
    has(sessionId: string): boolean;
    search(queryEmbedding: Float32Array, topK: number, minScore?: number): SemanticSearchResult[];
    save(filePath: string): Promise<void>;
    load(filePath: string): Promise<void>;
}

/** Orchestrates background embedding of sessions and exposes search */
export interface ISemanticIndexer {
    readonly isReady: boolean;
    readonly isIndexing: boolean;
    readonly indexedCount: number;
    initialize(): Promise<void>;
    scheduleSession(sessionId: string, text: string): void;
    removeSession(sessionId: string): void;
    search(query: string, topK: number, minScore?: number): Promise<SemanticSearchResult[]>;
    dispose(): void;
}
