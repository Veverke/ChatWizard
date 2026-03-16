# ChatWizard Release Work Plan

Date: 2026-03-16
Target: VS Code Marketplace first public release

## 1. Release Goal

Publish ChatWizard to the VS Code Marketplace with correct metadata, a valid package, and a repeatable release process.

## 2. Current Status Snapshot

Already in place:
- `publisher`, `version`, `description`, `keywords`, `repository` in `package.json`
- `engines.vscode` set (`^1.85.0`)
- `vscode:prepublish` script (`npm run compile`)
- `.vscodeignore` exists
- `README.md` and `LICENSE` exist

Gaps to close:
- Missing extension `icon` metadata in `package.json`
- No `CHANGELOG.md`
- License field may fail strict SPDX checks (`MIT AND LicenseRef-CommonClause-1.0`)
- Native dependency packaging risk (`better-sqlite3`)
- `.vscodeignore` should exclude extra non-runtime folders
- Publisher + PAT + publish flow not yet executed

## 3. Priority Actions

### P0 (Must finish before publish)

1. Add Marketplace icon
- Create `images/icon.png` (128x128 or 256x256 PNG)
- Add to `package.json`:

```json
"icon": "images/icon.png"
```

2. Add changelog
- Create root `CHANGELOG.md`
- Add initial `1.0.0` entry with release date and features

3. Finalize `better-sqlite3` packaging approach
- Preferred for wide support: package per target platform with `vsce --target`
- Minimum acceptable: publish package built on host platform and explicitly document platform support

4. Prepare publisher credentials
- Ensure Marketplace publisher `Veverke` exists
- Generate Azure DevOps PAT with Marketplace `Manage` scope

5. Install release tooling

```bash
npm install --save-dev @vscode/vsce
```

### P1 (Strongly recommended)

6. Resolve license field compatibility
- If keeping Commons Clause text: use

```json
"license": "SEE LICENSE IN LICENSE"
```

- If fully open-source MIT: remove Commons Clause text from `LICENSE` and set `"license": "MIT"`

7. Improve listing quality
- Add `galleryBanner` to `package.json`
- Add 2-3 screenshots in `README.md`

8. Tighten package contents
- Update `.vscodeignore` to exclude:
  - `.claude/**`
  - `docs/**`

## 4. Implementation Checklist

## Metadata and Listing
- [ ] Add `images/icon.png`
- [ ] Add `"icon": "images/icon.png"` to `package.json`
- [ ] Add optional `galleryBanner` in `package.json`
- [ ] Add screenshots to `README.md`

## Documentation
- [ ] Create `CHANGELOG.md`
- [ ] Confirm `README.md` has install/use notes and requirements
- [ ] Confirm `LICENSE` aligns with `package.json` license field

## Packaging Hygiene
- [ ] Update `.vscodeignore` for docs/internal folders
- [ ] Run compile

```bash
npm run compile
```

- [ ] Package and inspect artifact

```bash
npx vsce package
```

## 5. Publish Procedure

1. Authenticate once:

```bash
npx vsce login Veverke
```

2. Publish current version:

```bash
npx vsce publish
```

Alternative one-liner with PAT:

```bash
npx vsce publish -p <PAT>
```

3. Verify listing:
- Confirm extension page renders icon, README, changelog, categories, keywords
- Install from Marketplace on a clean VS Code profile and smoke test

## 6. Multi-Platform Packaging (if needed)

If shipping native dependency builds per platform:

```bash
npx vsce package --target win32-x64
npx vsce package --target linux-x64
npx vsce package --target darwin-arm64
```

Then publish target packages according to VSCE support for your workflow/version.

## 7. Smoke Test Matrix Before Publish

- [ ] Extension activates on startup
- [ ] Sessions tree loads and opens session webview
- [ ] Full-text search returns results
- [ ] Code blocks panel works
- [ ] Prompt library works
- [ ] Analytics panel opens
- [ ] Timeline panel opens
- [ ] Export commands generate markdown

## 8. Release Day Sequence

1. Final code freeze and pull latest main
2. `npm run compile`
3. `npx vsce package`
4. Install local VSIX and smoke test
5. Bump `version` in `package.json` if needed
6. Update `CHANGELOG.md`
7. `npx vsce publish`
8. Tag release in git (`vX.Y.Z`) and push tags

## 9. Post-Release Tasks

- Monitor Marketplace listing for metadata/rendering issues
- Track first-user issues and crash reports
- Prepare patch release checklist for `1.0.1`

## 10. Suggested Immediate Next Commits

1. Commit A: metadata/docs
- `package.json` icon/license/galleryBanner
- `CHANGELOG.md`
- `README.md` screenshots section

2. Commit B: packaging hygiene
- `.vscodeignore` cleanup
- any packaging notes in docs

3. Commit C: first marketplace publish tag
- version + changelog finalization
- release tag creation
