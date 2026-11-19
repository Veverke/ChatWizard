// src/views/sessionEntities.ts
// Pure helpers backing the two entity dropdowns in the session reader:
//   1st dropdown — entity type (Files, Tools, Languages, …), sorted alphabetically
//   2nd dropdown — entity values of the selected type, sorted alphabetically
//
// The grouping happens in the extension host (not the webview) so it is unit-testable
// and the webview only has to build <option> elements from an already-sorted payload.
//
// Semantic entities produced by the LLM pass are stored as `[type] value`
// (e.g. `[tool] Docker`, `[language] TypeScript`). They are split into one group
// per sub-type and the `[type]` marker is stripped from the values, so neither the
// dropdown nor the search it triggers ever sees the marker.

import type { ExtractedEntities } from '../types/index';

/** Field name of a regex-extracted entity type in `ExtractedEntities`. */
export type EntityTypeKey = 'filePaths' | 'functionNames' | 'errors' | 'decisions' | 'uris';

/** One entry of the first (entity type) dropdown plus its (sorted) second-dropdown values. */
export interface EntityTypeGroup {
    /** Stable identifier — `ExtractedEntities` field, or `semantic:<type>` for LLM sub-types. */
    key: string;
    /** Human-readable type label shown in the first dropdown (e.g. `Files`, `Tools`). */
    label: string;
    /** Entity values of this type — de-duplicated, alphabetical, never empty. */
    items: string[];
}

/** Regex-extracted entity types, in declaration order (the final list is sorted by label). */
export const ENTITY_TYPE_DEFS: ReadonlyArray<{ key: EntityTypeKey; label: string }> = [
    { key: 'filePaths',     label: 'Files' },
    { key: 'functionNames', label: 'Functions' },
    { key: 'errors',        label: 'Errors' },
    { key: 'decisions',     label: 'Decisions' },
    { key: 'uris',          label: 'Uris' },
];

/**
 * Display labels for the `[type] value` prefixes written by `entityLlmExtractor`
 * (`[framework] React`, `[api] GraphQL`, `[concept] …`, `[tool] …`, `[language] …`).
 * Plural forms are accepted too, so values written by other extractors or by
 * older versions group correctly instead of producing a duplicate type.
 */
const SEMANTIC_TYPE_LABELS: Readonly<Record<string, string>> = {
    api:        'APIs',
    apis:       'APIs',
    framework:  'Frameworks',
    frameworks: 'Frameworks',
    library:    'Libraries',
    libraries:  'Libraries',
    concept:    'Concepts',
    concepts:   'Concepts',
    tool:       'Tools',
    tools:      'Tools',
    language:   'Languages',
    languages:  'Languages',
    protocol:   'Protocols',
    protocols:  'Protocols',
};

/** Group label used for semantic values that carry no `[type]` prefix. */
export const DEFAULT_SEMANTIC_LABEL = 'Concepts';

/** Matches a leading `[type]` marker — e.g. `[tool] Docker` → type `tool`, value `Docker`. */
const SEMANTIC_PREFIX_RE = /^\s*\[([A-Za-z][\w .+-]{0,29})\]\s*/;

/** A semantic entity split into its optional `[type]` marker and its bare value. */
export interface SemanticValue {
    /** Lower-cased `[type]` marker, or `null` when the value had no prefix. */
    type: string | null;
    /** The entity itself, with the marker (and surrounding whitespace) removed. */
    value: string;
}

/**
 * Splits a semantic entity into its `[type]` marker and its bare value —
 * e.g. `[tool] Docker` → `{ type: 'tool', value: 'Docker' }`.
 *
 * Values without a marker (or with malformed brackets) are returned untouched
 * under the default `Concepts` type, so nothing is dropped.
 */
export function parseSemanticValue(raw: string): SemanticValue {
    if (typeof raw !== 'string') { return { type: null, value: '' }; }

    const match = SEMANTIC_PREFIX_RE.exec(raw);
    if (!match) { return { type: null, value: raw.trim() }; }

    const type = match[1].trim().toLowerCase();
    return {
        type: type === '' ? null : type,
        value: raw.slice(match[0].length).trim(),
    };
}

/** `library` → `Libraries`, `protocol` → `Protocols`, `concepts` → `Concepts`. */
function pluralize(word: string): string {
    if (word.endsWith('s')) { return word; }             // already plural (or "status" — good enough)
    if (/[^aeiou]y$/i.test(word)) { return word.slice(0, -1) + 'ies'; }
    return word + 's';
}

/** Upper-cases the first character, leaving the rest untouched. */
function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Maps a `[type]` marker to the label shown in the first dropdown:
 * known LLM types use their fixed label (`tool` → `Tools`), unknown types get a
 * title-cased plural label (`database` → `Databases`), and missing markers fall
 * back to `Concepts`.
 */
export function semanticTypeLabel(type?: string | null): string {
    const normalized = (type ?? '').trim().toLowerCase();
    if (normalized === '') { return DEFAULT_SEMANTIC_LABEL; }

    const known = SEMANTIC_TYPE_LABELS[normalized];
    if (known) { return known; }

    return capitalize(pluralize(normalized));
}


/**
 * Alphabetical comparison that is case-insensitive, with a deterministic
 * case-sensitive tie-breaker so equal words keep a stable order everywhere.
 */
export function compareAlphabetically(a: string, b: string): number {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la < lb) { return -1; }
    if (la > lb) { return 1; }
    if (a < b) { return -1; }
    if (a > b) { return 1; }
    return 0;
}

/**
 * Trims, drops empty entries and de-duplicates values case-insensitively
 * (keeping the first spelling seen), then sorts them alphabetically.
 */
export function normalizeEntityValues(values: readonly string[] | undefined | null): string[] {
    if (!values || values.length === 0) { return []; }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of values) {
        if (typeof raw !== 'string') { continue; }
        const value = raw.trim();
        if (value === '') { continue; }
        const key = value.toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        result.push(value);
    }
    return result.sort(compareAlphabetically);
}

/** Mutable accumulator used while grouping — normalized/sorted at the end. */
interface MutableEntityGroup {
    key: string;
    label: string;
    values: string[];
}

/** Adds values to the group with the same label, or creates it when missing. */
function addValues(
    groups: Map<string, MutableEntityGroup>,
    label: string,
    key: string,
    values: readonly string[],
): void {
    if (values.length === 0) { return; }

    const dedupeKey = label.toLowerCase();
    const existing = groups.get(dedupeKey);
    if (existing) {
        existing.values.push(...values);
        return;
    }
    groups.set(dedupeKey, { key, label, values: [...values] });
}

/**
 * Builds the dropdown model: only entity types that actually have values,
 * sorted alphabetically by label, each with alphabetically sorted values.
 *
 * Semantic entities (`[type] value`) are split into one group per sub-type —
 * `[tool] Docker` joins `Tools`, `[language] TypeScript` joins `Languages`, …
 * — and the `[type]` marker is stripped from the value, so the dropdown (and the
 * search it triggers) only ever contains the entity itself. Unprefixed semantic
 * values keep falling back to `Concepts`.
 *
 * Returns `[]` when there is nothing to show.
 */
export function buildEntityTypeGroups(entities?: ExtractedEntities | null): EntityTypeGroup[] {
    if (!entities) { return []; }

    const groups = new Map<string, MutableEntityGroup>();

    // 1. Regex-extracted entities (Files, Functions, Errors, Decisions, Uris)
    for (const def of ENTITY_TYPE_DEFS) {
        addValues(groups, def.label, def.key, normalizeEntityValues(entities[def.key]));
    }

    // 2. Semantic entities — one bucket per `[type]` sub-type, marker stripped
    const semanticBuckets = new Map<string, MutableEntityGroup>();
    for (const raw of entities.semantic ?? []) {
        if (typeof raw !== 'string') { continue; }

        const parsed = parseSemanticValue(raw);
        if (parsed.value === '') { continue; }

        const label = semanticTypeLabel(parsed.type);
        const bucketKey = label.toLowerCase();
        const bucket = semanticBuckets.get(bucketKey);
        if (bucket) {
            bucket.values.push(parsed.value);
        } else {
            semanticBuckets.set(bucketKey, {
                key: `semantic:${parsed.type ?? 'concept'}`,
                label,
                values: [parsed.value],
            });
        }
    }
    for (const bucket of semanticBuckets.values()) {
        addValues(groups, bucket.label, bucket.key, bucket.values);
    }

    return Array.from(groups.values())
        .map(group => ({
            key: group.key,
            label: group.label,
            items: normalizeEntityValues(group.values),
        }))
        .filter(group => group.items.length > 0)
        .sort((a, b) => compareAlphabetically(a.label, b.label));
}
