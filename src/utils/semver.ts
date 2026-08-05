// src/utils/semver.ts

/**
 * Returns true when `candidate` is a strictly higher semver than `current`.
 * Handles `major.minor.patch` strings (extra pre-release segments are ignored).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
    const parse = (v: string): [number, number, number, boolean] => {
        const parts = v.split('.').map(p => parseInt(p.split('-')[0], 10));
        const hasPre = v.includes('-');
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, hasPre];
    };
    const [caMaj, caMin, caPatch, caPre] = parse(candidate);
    const [cuMaj, cuMin, cuPatch, cuPre] = parse(current);
    if (caMaj !== cuMaj) { return caMaj > cuMaj; }
    if (caMin !== cuMin) { return caMin > cuMin; }
    if (caPatch !== cuPatch) { return caPatch > cuPatch; }
    // Numeric parts equal — a release beats its pre-release
    if (!caPre && cuPre) { return true; }
    return false;
}
