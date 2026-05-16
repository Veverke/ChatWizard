// src/utils/queryClassifier.ts
// Classifies natural-language queries for intent-specific prompt hints.

const ARCHITECTURE_KEYWORDS = [
    'architecture',
    'design',
    'diagram',
    'flow',
    'structure',
    'system',
    'component',
    'service',
    'module',
    'layer',
    'pipeline',
    'schema',
    'data model',
    'relationship',
    'dependency',
    'topology',
    'sequence',
    'interaction',
] as const;

/**
 * Returns `true` when the query appears to be about architecture, system design,
 * or component/data-flow relationships.
 *
 * Criteria: the lowercased query contains two or more keywords from the
 * architecture keyword set.
 *
 * @example
 * isArchitectureQuery('explain the service architecture') // true
 * isArchitectureQuery('how do I fix the JWT bug')         // false
 */
export function isArchitectureQuery(query: string): boolean {
    const lower = query.toLowerCase();
    let matchCount = 0;
    for (const kw of ARCHITECTURE_KEYWORDS) {
        if (lower.includes(kw)) {
            matchCount++;
            if (matchCount >= 2) { return true; }
        }
    }
    return false;
}
