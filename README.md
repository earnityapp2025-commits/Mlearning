# MLearning

MLearning is an Express app that records learning and error events, looks up known fixes, and exposes a small control panel. File changes stay behind the existing guardrails: an allowlist, a panel token, and an explicit dry-run or apply mode.

OpenAI is used only by the panel analysis route. It does not run during event ingest.

## Run

```bash
npm install
node index.js
```

`npm start` does the same thing. The process listens on `PORT`, or port 3000 if `PORT` is unset.

The server boots without Supabase or OpenAI credentials. Routes that need those values return a JSON error. Importing the app does not require the keys to be present.

## Environment

Set these in the process environment. Do not commit them.

| Variable | When it is required |
| --- | --- |
| `SUPABASE_URL` | Database routes. Supabase project URL (`https://…supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Database routes. Service role key. The app does not use the anon key. |
| `PANEL_TOKEN` | Protected panel and apply routes. |
| `OPENAI_API_KEY` | `POST /panel/analyze-test` only. Sent as a bearer token to the OpenAI chat completions API. The model is `gpt-4o-mini`. |
| `PORT` | Optional. Defaults to `3000`. |

## Database

`schema.sql` creates the tables the routes already read and write:

- `learn_events` — every accepted `POST /learn-event`
- `error_events` — the same event when `level` is `error`
- `verified_solutions` — known fixes looked up by `signature_hash` (the app reads this table; it does not insert rows)
- `fix_attempts` — dry-run and apply attempts from `POST /apply-fix`
- `applied_patches` — rows written after a fix or proposal is applied; `patch_key` is unique so a proposal is not applied twice
- `code_proposals` — proposal previews and apply requests
- `file_snapshots` — hash and size of the target file at proposal time

Run `schema.sql` in the Supabase SQL editor before using the database routes.

A known fix is a row in `verified_solutions`. `signature_hash` is the SHA-256 of `tool|message` (both trimmed and lowercased), which is the same value returned as `signatureHash`.

## Routes

Each path is registered once.

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `GET` | `/` | none | Status page with a link to the panel |
| `GET` | `/panel` | none | Serves `panel.html` |
| `GET` | `/introspect-app` | none | Reports allowlisted files and whether insertion markers are present |
| `POST` | `/learn-event` | none | Inserts a learn event, mirrors errors, and returns a known fix when one exists |
| `GET` | `/known-fix` | none | Looks up a verified solution by `tool` and `message` query params |
| `POST` | `/suggest-action` | none | Returns a suggestion from a verified solution, or says none is known yet |
| `GET` | `/learn-feed` | none | Latest 50 `learn_events` |
| `POST` | `/auto-apply-decision` | none | Explains whether a fix would pass the auto-apply checks. It does not write files |
| `GET` | `/panel-history` | none | Recent proposals, patches, and learn events |
| `POST` | `/apply-fix` | `x-panel-token` | Runs the allowlisted fixer in `dry-run` (default) or `apply` mode |
| `POST` | `/apply-proposal` | `x-panel-token` | Previews or inserts code at a named zone marker |
| `POST` | `/panel/ping` | `Authorization: Bearer <PANEL_TOKEN>` | Panel API sanity check |
| `POST` | `/panel/analyze-test` | `Authorization: Bearer <PANEL_TOKEN>` | Sends `{ summary, context }` to OpenAI and returns the analysis |

`POST /learn-event` body: `{ source, tool, message, app, level, context }`. `source`, `tool`, and `message` are required. `level` defaults to `info`.

## Guardrails

These limits are unchanged:

- Only `index.js` is in the file allowlist. Other paths are rejected.
- The only fixer is `replace_single_with_maybeSingle`, which replaces `.single(` with `.maybeSingle(`.
- `mode` is `dry-run` or `apply`. Dry-run returns a diff and does not write the file.
- `POST /apply-fix` and `POST /apply-proposal` require the `x-panel-token` header to match `PANEL_TOKEN`. If `PANEL_TOKEN` is unset, those routes respond with an error and do not write.
- Proposals are inserted only after a known marker in `index.js` (`routes` or `helpers`). Apply mode refuses a `patch_key` that was already stored.
- Auto-apply is an explanation only. A yes requires `auto_applicable`, confidence of at least `0.85`, an allowlisted fix type, and an allowlisted file.

The control panel loads without a token. Its dry-run button calls `POST /apply-fix` and therefore needs `PANEL_TOKEN` plus the `x-panel-token` header; the static page does not send that header.
