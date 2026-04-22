# DESIGN.md + API.md Extractor (Violentmonkey)

A single-file userscript that does two things on any site you visit:

1. **DESIGN.md** — extracts the site's design tokens (typography, color palette, spacing scale, radius/shadow/motion, CSS custom properties, font faces) and emits a TypeUI-compatible `DESIGN.md` you can feed to Claude Code, Codex, Cursor, Stitch, etc.
2. **API.md** — passively observes every `fetch`/`XMLHttpRequest` the page makes and emits an `API.md` documenting the site's internal API contract: endpoints (templated), required headers, auth mechanism, query params, request/response schemas inferred from live samples, and GraphQL operations.

Clean-room reimplementation of the core logic from the open-source **"DESIGN.md Style Extractor – TypeUI"** Chrome extension ([MIT, bergside/design-md-chrome](https://github.com/bergside/design-md-chrome)), stripped to one file and with the API-contract sniffer added on.

## What's stripped vs. the Chrome extension

| Removed | Why |
|---|---|
| Service worker + popup HTML/CSS/JS (~20 KB) | Not needed — userscript runs directly in page |
| `chrome.downloads` / `chrome.scripting` / `chrome.storage` | Replaced by `GM_download` + blob fallback |
| SKILL.md generation branch | Not requested — DESIGN.md only |
| `lib/validate.mjs` harness | Inline validation via diagnostics |
| Typeui.sh promotional footer links | No external references |
| Node test harness in `tests/` | Replaced with smoke test alongside script |
| Audience/surface scoring with evidence bookkeeping (6×6 matrix, ~170 LOC) | Compacted to a single-pass scorer that produces the same labels |

## What's added

- **Network sniffer** installed at `document-start` (hooks `fetch` and `XMLHttpRequest`) that collects request/response headers, bodies, status codes, timings.
- **URL templating** — numeric IDs → `:id`, UUIDs → `:uuid`, Mongo ObjectIds → `:objectId`, long random tokens → `:token`.
- **Header frequency analysis** — a header present in 100% of observed calls to an endpoint is flagged as "likely required"; known auth headers are flagged explicitly.
- **JSON schema inference** with type merging across samples, plus recognition of `string(uuid)`, `string(datetime)`, `string(email)`, `string(url)`.
- **GraphQL detection** — flags endpoints whose bodies look like `{query, variables}`, extracts operation names.
- **Redaction** — JWT patterns, long mixed-case tokens, and auth header values (`Authorization`, `Cookie`, `X-Api-Key`, …) are redacted before anything is written to disk or clipboard.
- **Opt-in documentation probe** — fires one-off requests to `/openapi.json`, `/swagger.json`, `/api-docs`, `/.well-known/openapi.json`, etc., and runs a GraphQL introspection query against detected GraphQL endpoints. Not automatic.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. Open `design-api-extractor.user.js` — Violentmonkey will detect it and offer to install.
3. Done — it's active on all sites (`@match *://*/*`).

Tampermonkey should also work (uses only `GM_registerMenuCommand`, `GM_setClipboard`, `GM_download`, `GM_notification`), but it's tested against Violentmonkey.

## Usage

Open any site. While you browse, the sniffer is silently building up API observations.

Via the Violentmonkey menu (click the extension icon):

- **Generate DESIGN.md (Ctrl+Shift+D)** — sample the DOM right now and download `DESIGN.{host}.md`
- **Generate API.md (Ctrl+Shift+A)** — dump currently-observed endpoints to `API.{host}.md`
- **Generate API.md + probe OpenAPI/GraphQL** — same as above but also fires discovery requests to common spec paths on the current origin
- **🔎 Deep probe (safe — GET only) (Ctrl+Shift+P)** — harvest HTML + inline JS + external scripts + sourcemaps + robots.txt + sitemap.xml, extract endpoint candidates, then probe only with GET. Safe for production sites.
- **🔎 Deep probe (read methods — GET + HEAD + OPTIONS)** — adds HEAD (for size/content-type inspection) and OPTIONS (for CORS preflight info). Still read-only but chattier. Useful for APIs that expose different responses per method.
- **⚠️ Deep probe (ALL METHODS from source — may modify data!)** — probes POST/PUT/PATCH/DELETE **only** for URLs where that method was explicitly observed in source. Fires empty `{}` JSON bodies (servers often respond with schema-rich 400s naming required fields). **Can create, modify, or delete data.** Use only on staging, localhost, or systems you own/have permission to test.
- **Copy DESIGN.md / Copy API.md to clipboard** — same content, no download
- **Show observation count** — toast with current `endpoints, total calls` numbers
- **Clear API observations** — reset counters (useful between page loads of different sites in the same tab)

### Safety rails built into the destructive tier

- Even with ALL METHODS selected, mutating methods (POST/PUT/PATCH/DELETE) are **only** fired against URLs where that exact method was explicitly extracted from source. The script never invents a POST against a GET-only string literal.
- Paths containing `logout`, `signout`, `delete`, `destroy`, `remove`, `purge`, `revoke`, `cancel`, `unsubscribe`, `deactivate`, `disable`, `reset-password`, `reset_password`, `forgot-password` are blocked regardless of tier.
- Cross-origin URLs are never probed — only same-origin. (They're still documented in the `Static Analysis` section of API.md.)
- URL templates containing placeholders (`/users/:id`, `/users/${id}`) are documented but not probed.
- A red-tinted progress panel with a cancel button stays on-screen the whole time. `Esc` via the panel cancels mid-run.
- An explicit confirmation dialog appears before any probe fires, showing the method breakdown (e.g. "47 GET, 3 POST, 2 DELETE") and estimated duration.
- The keyboard shortcut `Ctrl+Shift+P` maps to the **safe** tier only; the destructive tier requires a deliberate click in the Violentmonkey menu.

### What the deep probe harvests

Before any probing, the harvester pulls source from:

| Source | What it looks for |
|---|---|
| Current document `outerHTML` | Links, form actions, `data-*` attributes with URLs |
| Inline `<script>` tags | All the regex patterns below |
| External scripts (same-origin, max 40, max 2 MB each) | All the regex patterns below |
| Sourcemaps (`//# sourceMappingURL=`) referenced by those scripts | Pre-minification source code — usually far richer in endpoint literals |
| `script#__NEXT_DATA__` and `<script type="application/json">` | Route tables, page data blobs, API base URLs |
| `/robots.txt` | `Sitemap:`, `Allow:`, `Disallow:` paths |
| `/sitemap.xml` | `<loc>` entries |
| `/manifest.json`, `/sw.js`, `/service-worker.js` | PWA/manifest endpoints, precache URLs |

### Regex patterns matched

| Pattern | Captures |
|---|---|
| `fetch("URL", { method: "METHOD" })` | Method + URL |
| `axios.METHOD(...)` / `this.http.METHOD(...)` / `$http.METHOD(...)` / `api.METHOD(...)` / `client.METHOD(...)` | Method + URL |
| `$.ajax({ url, type/method })` | Method + URL |
| `new Request(url, { method })` | Method + URL |
| `xhr.open("METHOD", "URL")` | Method + URL |
| `{ path: "/api/...", method: "GET" }` | URL (route-config objects — Next.js, Remix, etc.) |
| String literals starting with `/api/`, `/v1/`, `/v2/`, `/_next/data/`, `/rest/`, `/graphql`, `/wp-json`, `/hasura` | URL only (method defaults to GET) |
| Full URLs to same origin or `api.*` / `admin.*` / `backend.*` / `gql.*` subdomains | URL only |

## Tips

- For the best API.md, **browse the site first** (log in, click around, trigger the workflows you want documented), then run the command. The sniffer only sees what the page actually calls.
- Clear observations when you navigate to a different host — otherwise you'll mix endpoints in the output.
- Run the OpenAPI/GraphQL probe only on sites you trust; it will send requests with cookies. Some WAFs may flag the introspection attempt.
- Body samples in `API.md` are not redacted — only header values are. If you plan to share the file, eyeball it first.

