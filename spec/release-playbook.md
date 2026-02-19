# Release / Rollback Playbook

This playbook defines the release and recovery path for `tsuba` monorepo packages.

Airplane-grade release rule:

- never publish from a dirty or unsynced tree,
- always run full verification gates,
- rollback by forward-fixing (never force-delete published artifacts).

---

## 1) Preflight (required)

From `main`, clean tree, synced with `origin/main`:

1. `npm run run-all`
2. proof verification (included by publish scripts unless `--no-proof`)
3. confirm version bumps are intentional and monotonic

Helpers:

- npm packages: `bash scripts/publish-npm.sh --dry-run`
- crates: `bash scripts/publish-crates.sh --dry-run`

Both scripts enforce:

- branch must be `main`
- no local modifications
- local `HEAD` must equal `origin/main`
- target version must not already exist in registry

---

## 2) Publish sequence

Recommended order:

1. publish npm packages (`publish-npm.sh`)
2. publish Rust crates (`publish-crates.sh`)

Reason: CLI/compiler/bindgen consumers typically resolve npm first; crate publish is consumed by generated Cargo flows.

---

## 3) Rollback model

Registry artifacts are immutable in practice for consumers; rollback uses **forward correction**:

1. stop rollout (do not publish remaining packages/crates)
2. fix on a new commit/PR
3. bump versions
4. rerun full gates (`npm run run-all`, proof verification)
5. publish corrected versions

Never:

- force-push release history
- delete remote branches/tags from automation
- republish same version with different contents

---

## 4) Partial-failure recovery

If npm publish succeeded but crate publish failed (or vice versa):

1. record the successfully published set
2. bump only the affected unpublished artifacts and dependents as needed
3. run full verification
4. publish remaining set

Do not attempt to overwrite already-published versions.

---

## 5) Operator checklist

- [ ] `main` checked out
- [ ] `git status` clean
- [ ] `git pull --ff-only` done
- [ ] `npm run run-all` green
- [ ] proof verification green
- [ ] dry-run publish plans reviewed
- [ ] actual publish completed
- [ ] post-publish smoke validation passed
