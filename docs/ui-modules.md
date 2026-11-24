# Dashboard UI modules

The dashboard is `public/index.html` (shell markup and styles only) plus plain browser ES modules in
`public/js/`. There is no build step and no npm dependency. The server serves `GET /js/<name>.js` for
names matching `^[a-z0-9-]+$`. The CSP's `script-src 'self'` covers the modules, and the page has no
inline script.

## Ownership rule

**A feature task edits only its own view module.** `nav.js` and `core.js` are changed only by an
integration task. That includes `core.js`'s exports, hooks and setters and `nav.js`'s registry and
global wiring. `vizor.js` and `index.html`'s single script tag are integration-only too.

## Modules

| Module | Owns |
| --- | --- |
| `vizor.js` | **Entry point**, the only `<script type="module">` in `index.html`. It imports `nav.js`, which loads `core.js` and every view. Then it starts the app with `readHash(); refresh();`. |
| `core.js` | `$`, `h()`, `put()`, `keepSame()`, and shared UI primitives used by several views: `icon`, `lamp`, `emptyState`, `infoBtn`/`statusEl`, `copyBtn`, `toast`, `disclosure`, `segBar`. Also time and number formats, the state store (`state`, `events`, `activity`) and its selectors (`proj`, `tasksOf`, `plansOf`, `statusFromState`, …), `post()`, and the router (`go`, `readHash`, `writeHash`, last-view memory). It also holds desktop notifications, screen-reader announcements, `refresh()`, the server event stream (SSE), and a few small actions several views call (`retry`, `retryMany`, `cancelRun`, `togglePause`). It imports nothing. |
| `nav.js` | The **view registry**: `render()` chooses the visible `<section>` and calls each view's render function. It also owns the sidebar, the header and its status strip, the page-wide keyboard shortcuts, hash routing and the 30 s refresh. |
| `home.js` | Home (`#v-home`): across-projects figures, project cards, new-project form. |
| `overview.js` | Overview (`#v-overview`): progress, workers, estimated finish, setup checklist, Needs you. |
| `plan.js` | Plan (`#v-plan`): request thread and drafts, plan canvas and dependency graph, approve guard, roadmaps and the phase queue. |
| `board.js` | Board (`#v-board`): columns and lanes, filters, task cards, board keys (`BOARD_KEYS`), card popover. |
| `run.js` | Run (`#v-run`): task list and search, attempts table, event log, the Merge anyway and Cancel task panels. |
| `ship.js` | Ship (`#v-ship`): folder status, GitHub push and its confirm step, push guard, merge history, `pushAll`. |
| `projects.js` | Projects (`#v-projects`): project table, project settings, add project, global worker limit. |
| `palette.js` | Command palette (Ctrl+K / Cmd+K). |
| `update.js` | Update indicator, panel and settings card. |

`home.js` is not in the original module list. Home is a view of its own, so it follows the
one-module-per-view rule. There are no other shared modules.

## How they connect

- **Load order.** `vizor.js` → `core.js` → `nav.js`, and `nav.js` imports every view. Module bodies run
  after the modules they import, so `vizor.js` runs last. Its `readHash(); refresh();` therefore runs
  after every view has wired its listeners, as the last lines of the old inline script did.
- **Views import from `core.js`.** A view imports from another view only to open that view's panel or
  run its action, never to change its state. The current edges are:
  - board → run (Merge anyway, Cancel task), ship (`pushAll`), plan (`levels`)
  - overview → run (`SUPERSEDED_HOLD`), ship (`pushAll`), plan (`activePhases`)
  - palette → plan, board, run, ship (each action calls the same function as its button)
  - ship → run (`stampCell`)
  - update → palette (`palOpen`)

  None of these form a cycle, and none of them import `nav.js`.
- **Core API for state.** Other modules can read `current`, `view`, `selTask`, `selNode`, `state`
  and the other exported bindings, but cannot assign them, because imported bindings are read-only.
  They change state through:
  - `go(patch)`: route and render
  - `setRoute(patch)`: set `current` / `view` / `selTask` / `selNode` without rendering
  - `setShipConfirm(pid)`

  Each module keeps its own UI state, for example `approveGuard` in plan.js, `mergeAnyway` and
  `cancelTask` in run.js, and `palOpen` in palette.js. `nav.js` only reads that state.
- **Hooks.** `core.js` cannot import views, so it exposes `hooks`, which other modules fill at load time:
  - `hooks.render`: set by `nav.js`. `core.js`'s `render()` calls it, for example from `go()` and `refresh()`.
  - `hooks.key`: set by `nav.js`. This is the page-wide keydown handler. `core.js` registers the
    listener before any view registers its own, so it still runs first, as it did in the single
    script.
  - `hooks.lanes`: set by `plan.js` to `drawEdges`. It redraws the graph when a disclosure that
    holds the graph opens.
  - `hooks.events`: list of functions called with every SSE event after the refresh is scheduled.
    `ship.js` uses it to reload or drop its cached `/ship` data.
- **Untrusted text** goes through `textContent` or `h()` only. The only `innerHTML` writes are the
  two constant icon strings in `core.js`.

## Test markers and file order

Each module's first line is `// <script>` and its last line is `// </script>`. The static UI tests
read the page with `uiSource()`, which joins `index.html` and the modules in **filename order**. The
tests then pull code out from between script tags, so keep both marker lines. Some tests also slice
between two markers, for example from `let cancelTask = null` to `// ----- Run -----`, or from the
update block to `readHash();` in `vizor.js`. When you move code between modules, keep those pairs in
the same order in the joined source. `test/page-script-syntax.test.ts` runs `node --check` on every
module and checks that every relative import resolves.
