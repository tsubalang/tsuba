# Agent Notes (Tsuba)

This repo is **airplane‑grade**: correctness > speed.

## Remote safety

- Never delete remote branches/tags, and never force-push.
- Only push new commits/branches; maintainers handle remote cleanup.
- Do not push directly to `main`. Create a feature branch for all changes and open a PR.
- Treat PR submission as mandatory for every code or doc change while branch protection is active.

## Testing workflow

Fast iteration (allowed while developing):

- Run a focused test subset (Mocha `--grep` works):
  - `npm run test:cli -- --grep <pattern>`
  - `npm run test:compiler -- --grep <pattern>`

Final verification (required before merge/publish):

- `npm run run-all`
