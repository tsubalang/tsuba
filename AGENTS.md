# Agent Notes (Tsuba)

This repo is **airplane‑grade**: correctness > speed.

## Remote safety

- Never delete remote branches/tags, and never force-push.
- Only push new commits/branches; maintainers handle remote cleanup.

## Testing workflow

Fast iteration (allowed while developing):

- Run a focused test subset (Mocha `--grep` works):
  - `npm run test:cli -- --grep <pattern>`
  - `npm run test:compiler -- --grep <pattern>`

Final verification (required before merge/publish):

- `npm test`

