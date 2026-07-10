---
name: release-cicd
description: Prepare, verify, diagnose, and publish Optipass macOS releases through its GitHub Actions CI/CD flow. Use when Codex needs to assess release readiness, inspect the release workflow, validate feature-to-main merge history, cut or push a release tag, follow the GitHub Release build, or investigate a failed release. Treat main-branch ancestry as a hard release gate; do not use for generic deployment work.
---

# Optipass Release CI/CD

## Establish the live contract

Read these files and Git state before acting; do not rely on this skill as a copy of a workflow that may have changed:

- `.github/workflows/release-tauri.yml`
- `README.md` release and installation sections
- `justfile`
- `apps/tauri/tauri.conf.json` and `apps/tauri/package.json` when desktop packaging changed
- `git status --short`, `git remote -v`, `git log --graph --decorate --oneline --all`, and current tags

The current expected contract is: pushing any tag runs the `Release Tauri DMG` workflow on `macos-26`; it builds the core package, API, Angular UI, and Tauri app, uploads `Optipass-<sanitized-tag>-macos-arm64.dmg`, then creates a GitHub Release with generated notes. The workflow is the source of truth for runner, toolchain, artifact naming, and permissions.

Do not claim signing or notarization exists unless the workflow proves it. The current README states that releases are not Apple Developer ID signed or notarized.

## Separate preparation, publication, and recovery

- Treat readiness checks and local builds as safe preparation.
- Treat creating or pushing a tag, editing or deleting a GitHub Release, and re-running a workflow as external changes. Do them only when the user explicitly asks to publish or authorizes the named action.
- Treat a failed tagged release as an investigation first. Do not delete and recreate a tag by default: the tag may already have triggered a partial release. Prefer a new patch tag after the cause is fixed, unless the user explicitly authorizes retagging.

## Enforce the main-history release gate

Never release directly from a feature branch. A candidate may originate on a feature branch only after its exact commit is reachable from `origin/main`; normally tag the merge commit on `main`.

### Preserve feature merges deliberately

Keep the merge topology that the release report depends on. First synchronize the local main branch without creating a local merge, then integrate one reviewed feature branch with an explicit merge commit:

```bash
git switch main
git fetch origin main
git merge --ff-only origin/main
git merge --no-ff --no-edit <verified-feature-ref>
git push origin main
```

`--ff-only` is only for synchronizing local `main` with `origin/main`; it must not be used to integrate the feature. `--no-ff --no-edit` automatically creates the separate merge commit, preserves the feature boundary, and retains Git's standard merge subject without opening an editor. Do not replace this release path with squash, rebase, cherry-pick, or a fast-forward feature merge unless the user explicitly asks to change the release-history policy.

Resolve conflicts and run the agreed verification before merging or pushing `main`. If the feature is not ready to merge, use `git merge --abort` rather than tag its branch. After the push succeeds, refresh `origin/main`; a local-only merge is not a release candidate.

Before a publish, refresh refs and identify the intended tag and candidate commit:

```bash
git fetch origin main --tags
release_tag="vX.Y.Z"
release_ref="origin/main"
release_commit="$(git rev-parse "$release_ref^{commit}")"
git merge-base --is-ancestor "$release_commit" origin/main
```

Stop if the ancestry check fails, the worktree contains unrelated changes, the tag already exists locally or remotely, or `origin` is not the expected Optipass repository. Do not substitute the checked-out feature branch for `origin/main` merely because it is ahead. When the release contains a feature integration, select its `--no-ff` merge commit (or a later main commit containing it), not the feature tip.

Show the integration history instead of describing a release as a branch snapshot:

```bash
previous_tag="$(git describe --tags --abbrev=0 "$release_commit^" 2>/dev/null || true)"
git log --first-parent --oneline "${previous_tag:+$previous_tag..}$release_commit"
git log --merges --first-parent --oneline "${previous_tag:+$previous_tag..}$release_commit"
```

Report the chosen commit SHA, previous tag, and first-parent range. If the range contains no intended feature merge or includes unrelated merges, stop for the user to choose the correct release point.

## Verify proportionately

Run the smallest relevant checks first. For a normal desktop release, use the repository entry points:

```bash
just test
just typecheck
just smoke-mock
```

Run `just build-tauri` before publishing when Tauri configuration, bundled API/runtime resources, icon assets, build tooling, or packaging dependencies changed; also run it if no equivalent successful packaging build is available for the candidate commit. Report if a check was skipped and why. `smoke-mock` must remain mock-only and must not receive real 1Password credentials.

Use a `vX.Y.Z` tag by convention, but do not infer a required manifest-version bump: the current workflow releases the pushed tag and does not derive it from the Tauri manifest. Flag any version-policy mismatch rather than silently changing version files.

## Publish only after confirmation

After all gates pass and the user has authorized the exact tag and commit, create an annotated tag on the selected merge/main commit and push only that tag:

```bash
git tag -a "$release_tag" "$release_commit" -m "Release $release_tag"
git push origin "$release_tag"
```

Do not use `git push --tags`. Do not push a branch as an incidental part of publishing. Immediately report the immutable tag-to-commit mapping and that the push starts the workflow.

## Follow the CI/CD result

Inspect the run associated with the pushed tag and wait only when the user asked to follow it:

```bash
gh run list --workflow release-tauri.yml --event push --limit 20
gh run watch <run-id> --exit-status
gh release view "$release_tag"
```

On success, verify the GitHub Release exists and that its DMG asset follows the workflow's expected `Optipass-<sanitized-tag>-macos-arm64.dmg` naming. State the release URL, artifact name, tag, commit, and first-parent change range.

On failure, inspect the failed job and its logs before proposing a fix. Keep diagnosis scoped to the failed step: dependency installation, Tauri bundle build, missing DMG staging path, or `gh release create`. Do not modify release state while diagnosing.
