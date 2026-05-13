// src/utils/semver.ts

/**
 * Returns true when `candidate` is a strictly higher semver than `current`.
 * Handles `major.minor.patch` strings (extra pre-release segments are ignored).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
    const parse = (v: string): [number, number, number] => {
        const parts = v.split('.').map(p => parseInt(p, 10));
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
    };
    const [caMaj, caMin, caPatch] = parse(candidate);
    const [cuMaj, cuMin, cuPatch] = parse(current);
    if (caMaj !== cuMaj) { return caMaj > cuMaj; }
    if (caMin !== cuMin) { return caMin > cuMin; }
    return caPatch > cuPatch;
}
