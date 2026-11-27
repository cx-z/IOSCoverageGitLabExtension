# iOS Coverage for GitLab

A read-only Manifest V3 Chrome extension that displays iOS changed-line coverage directly on supported GitLab merge request diff pages.

The Coverage service remains the only source of coverage truth. The extension displays server decisions; it never calculates, inherits, or guesses coverage and never writes to GitLab.

## Features

- Shows changed-line coverage summary and report metadata on GitLab MR diff pages.
- Marks new-side changed lines with four distinct, accessible states.
- Supports GitLab inline and side-by-side diff layouts.
- Handles lazy-loaded files, collapsed files, SPA-style navigation, and report generation changes.
- Loads file coverage near the viewport, with at most four file requests in flight and progressive per-file annotations.
- Coalesces diff mutations by file and skips unchanged markers and summaries.
- Polls the resolver while analysis is queued or running.
- Removes line annotations when the server or actual row identity cannot prove applicability to the displayed diff.
- Uses no framework, bundler, remote executable code, or third-party runtime dependency.

## Coverage states

| State | Marker | Meaning |
| --- | --- | --- |
| `covered` | Green `✓` | The line is measurable and covered. |
| `uncovered` | Red `×` | No applicable complete hit exists, including definite new/modified code. |
| `not_measurable` | Gray `·` | The line has no measurable coverage region. |
| `unknown` | Orange `?` | The service cannot determine the state reliably. |

Markers also expose an accessible label and the evidence source: `current_build`, `historical_inheritance`, `mixed`, or `none`. `not_measurable` and `unknown` are never treated as `uncovered`.

## Requirements

- Google Chrome 102 or later.
- A GitLab instance served from an HTTPS origin on the default port 443. Custom HTTPS ports are not supported.
- A reachable, compatible iOS Coverage service with anonymous read-only access enabled for the extension endpoints; see [Server dependency](#server-dependency).
- The GitLab project must be registered with the Coverage service.

No GitLab or Coverage credential is required on the user side. The GitLab host is derived from the current page; the Coverage server URL is the only setting.

## Installation

### From a GitHub release or source archive

1. Download and extract the repository archive.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the extracted directory that contains `manifest.json`.
6. Complete the settings page, grant access only to the entered origins, and reload any already-open MR tab.

### From a clone

1. Clone this repository to a local directory.
2. Follow steps 2–6 above and select the cloned repository root.
3. After pulling a new version, click **Reload** on the extension card in `chrome://extensions`.

No build or package-install step is required.

### Company-internal build (pre-authorized)

The open-source extension authorizes each GitLab origin on first use. A company-internal build can bake the GitLab host and Coverage server into the manifest so that anyone who installs it sees coverage immediately after opening an MR link:

```bash
IOSCOVERAGE_GITLAB_ORIGIN=https://git.example.com \
IOSCOVERAGE_SERVER_ORIGIN=http://coverage.intra.example.com:8765 \
./scripts/make-company-build.sh
```

Load the generated `dist/company` directory as an unpacked extension. The build uses the supplied Coverage origin for both the default URL and host access. If the extension already has a saved URL, use **Restore default** and save the setting to switch to the new origin.

## Configuration

Open the extension settings by clicking its toolbar icon or by selecting **Extension options** on its Chrome details page. The only setting is:

- **Coverage server URL** — defaults to `http://127.0.0.1:8765`; use the intranet address when the service runs on another machine.

**Test connection** checks the public health endpoint. The GitLab origin is never configured: the extension identifies it from an open GitLab MR page. **保存并授权** and **测试连接** request access to the Coverage server and to the GitLab origin of an open MR tab together in one Chrome prompt; when an MR tab is open, its GitLab origin is recorded and the content script is enabled automatically. The company-internal build pre-authorizes the GitLab host, so no authorization or settings are needed.

Upgrading from a version that stored a GitLab origin migrates that origin into the authorized list and re-enables the content script automatically; any previously stored operator Token is deleted during the migration.

## Using the extension

Open the latest diff page of a supported merge request:

```text
/group/project/merge_requests/42/diffs
/group/project/-/merge_requests/42/diffs
```

The summary explains the current state and appears independently of file-detail loading. When the resolver returns `can_annotate=true`, the extension loads the matching report and observes file containers with a 600-pixel viewport margin. Only nearby files have their new-side rows scanned and their coverage details requested, with at most four file jobs in flight. Each completed file is annotated immediately; large plans yield between batches of 200 markers. Scrolling to another file schedules its annotations without loading the entire MR.

Line markers use only this exact key:

```text
(repo_relative_path, new_line_number)
```

MR overview, commits, repository pages, historical diff versions, extra-suffix routes, and look-alike paths are not annotated. The extension does not automatically expand every collapsed large file.

Closed and merged MRs retain access to existing coverage on their latest diff page. The service still verifies the selected version and all three refs, and the extension checks each actual row before annotating; closing or merging an MR alone does not hide its coverage. Cycle submission and background branch synchronization continue to require an open MR.

The adapter still checks exact file paths across all discovered file headers, including offscreen files, so duplicate or unsupported paths fail closed for the affected files while other verified files continue. DOM mutations are coalesced in a fixed 180-ms window: only affected files are invalidated, and only newly inserted subtrees are searched for new file containers. File details are reused by exact Cycle/generation/presentation/file identity, including in-flight requests. Route/version changes, resolver refreshes, report changes, and teardown invalidate asynchronous commits; rejected or stale resolver results clear line markers.

Class-attribute observation is limited to the diff-version controls and nearby file containers, rather than the entire document. File observers are disconnected when their containers leave the viewport margin, and cached row snapshots are invalidated when those files return. SVG classes are read through `getAttribute("class")` because SVG's `className` is an animated-string object, not an HTML class string.

Unchanged markers and summary models perform no DOM updates. The uncovered filter uses each file's server-provided uncovered count, so an offscreen file is not dimmed merely because its line markers have not loaded. `尚未标注文件` counts report files without successfully applied line annotations; viewport loading does not alter the server's coverage totals or states.

## Current MR and historical Build evidence

Resolver schema 2 binds the active latest-version link's `diff_id` to the registered GitLab MR version and all three fixed refs. Before annotating each actual row, the adapter also checks the structured comment `data-position` (base/start/head, exact new path, new line). Missing or mismatched identity leaves that row unannotated. A stale browser “latest version” label cannot authorize the server's newer MR snapshot.

When Build refs exactly match and no additional independent evidence remains unincorporated, the existing formal report path is preserved. Independently analyzed old-package uploads can update applicable MR lines even while a missing or untested current Build prevents formal report publication. After MR changes, a separate server projection retains applicable unchanged-line hits, follows line movement, marks definite new/modified code red, and limits orange to ambiguity or unavailable data. It compares directly with valid Build snapshots, so further commits cannot accidentally restore green; a proven restoration of original code may recover its original hit. Copies never borrow green merely because their text matches.

The current-MR summary and uncovered filter use complete server projection counts. Mapped MR results show classification counts and a historical-evidence label. When the server supplies a current-MR percentage, the extension validates its `covered / (covered + uncovered)` ratio and displays it separately from Build metadata. Older category-only responses and zero denominators remain supported without inventing a percentage. Green tooltips identify source Build and commit; report metadata includes its published time. Both kinds of uncovered line share the same red label. The formal Cycle report remains unchanged.

Snapshot/file caches and tab authorization include the presentation ID, which binds target version and source evidence identity in addition to generation. Issued IDs also bind the complete result contents; transiently degraded results can recover under a new ID without changing the original ID's details. Late resolver and file responses cannot overwrite newer authorization. Metadata refreshes continue while the tab is visible, including after a successful result, because MR changes need not change report generation. File rendering remains viewport-driven and bounded.

Schema 1 remains supported by the server for older extensions: it still requires exact three-SHA equality and returns `stale_diff` otherwise. New content scripts request schema 2 and fail closed against an old server; they never reinterpret a schema-1 old report as mapped current-MR data.

## Server dependency

The companion backend is [iOS Code Coverage Server](https://github.com/cx-z/iOSCodeCoverageServer). Real data requires a deployment compatible with API version 1 and MR Coverage resolver schema version 2, with anonymous read-only access enabled (`"anonymous_read": true` in `config/server.json`) so the extension works without any Token. The extension uses only these fixed read-only endpoints:

```text
GET  /health
POST /api/v1/integrations/gitlab/merge-request-coverage/resolve
GET  /api/v1/cycles/<cycle_id>/report
GET  /api/v1/cycles/<cycle_id>/report/files/<file_id>
```

The schema-2 summary request contains exactly `schema_version`, current `mr_url`, and page-selected `page_version`; file requests additionally carry the issued `presentation_id` and `file_id`. The server must:

- serve these endpoints without a client credential when `anonymous_read` is enabled;
- map the exact registered GitLab host, full project path, and MR IID;
- obtain current MR diff refs using its own GitLab credential;
- verify the page version against the current MR three refs, then use the strict report or independent verified line mapping;
- return the versioned resolver schema with `can_annotate`, `should_poll`, an immutable `presentation_id`, and complete current-MR counts/file identities;
- remain read-only for this request.

The extension does not create Cycles, upload Builds or Runs, start analysis, or manage the server. Those operations remain part of the server and iOS coverage collection workflow. The server URL must be reachable from Chrome; GitLab credentials stay on the server. Plain HTTP should be used only for loopback or a trusted intranet.

## Privacy and permissions

The extension requests only:

| Permission | Purpose |
| --- | --- |
| `storage` | Stores the Coverage server URL and the list of GitLab origins the user authorized. |
| `scripting` | Registers the content script for an authorized GitLab origin. |
| `tabs` | Reads tab URLs to detect open GitLab MR pages for the authorization flow. |
| Optional HTTPS host access | Connects to a GitLab origin the user authorized from the settings page. |
| Optional HTTP/HTTPS host access | Connects to the exact Coverage server origin entered by the user. |

The company-internal build additionally declares static `host_permissions` for the baked GitLab and Coverage server origins. The extension has no Cookie, `webRequest`, browsing-history, or GitLab write permission.

The extension holds no credential. It does not store or send an operator Token; read-only server access is enforced by the Coverage service inside the trusted intranet. Content scripts cannot request arbitrary URLs. The Service Worker requests only the fixed read-only Coverage API paths above.

The extension has no analytics, telemetry, advertising, or third-party data service. It reads the MR route, repository-relative file paths, and new-side line numbers needed to display coverage; it does not collect or transmit GitLab source text. See [PRIVACY.md](PRIVACY.md) for the complete privacy statement.

## Version compatibility

| Component | Supported boundary |
| --- | --- |
| Chrome | Version 102 or later, Manifest V3. |
| GitLab | HTTPS MR diff routes shown above; latest diff only; inline and side-by-side layouts. |
| Coverage service | API version 1 with MR Coverage resolver schema version 2. |
| Extension data | MR resolver/presentation schema 2; formal report schema 1 remains separate. Unknown or malformed responses fail closed. |

GitLab compatibility is based on DOM structure rather than a claimed GitLab release range. GitLab UI changes can require an adapter update; when the structure cannot be recognized uniquely, the extension shows an unsupported state and adds no line markers. Firefox, Safari, and other Chromium browsers are not currently tested or supported.

## Development and testing

Run the test suite with Node.js's built-in test runner:

```bash
node --test tests/*.test.js
```

Tests use neutral fixtures under `https://git.example.com/group/project/...` and require no network access. They cover URL parsing, strict API contracts, the four coverage states and evidence sources, exact path/line matching, idempotent rendering, generation and route cleanup, stale-report behavior, polling, message authorization, and manifest restrictions. The large-diff scheduler tests also cover offscreen deferral, bounded concurrency across generation changes, progressive file rendering, local mutation scans, request reuse, marker batching, and cancellation during navigation/teardown.

The runtime module boundaries are deliberately small:

- `src/background/`: settings-backed network requests and tab-scoped file authorization;
- `src/content/gitlab-url.js`: supported MR URL parsing;
- `src/content/gitlab-dom-adapter.js`: exact path and new-side line extraction;
- `src/content/coverage-renderer.js`: extension-owned summary and line UI;
- `src/content/file-annotations.js`: controller-owned viewport tracking, incremental file scans, bounded detail loading, and annotation batches;
- `src/shared/contracts.js`: response validation;
- `src/options/`: settings and permission requests.

See [docs/dom-validation.md](docs/dom-validation.md) for sanitized DOM validation findings. Do not add private page HTML, screenshots, source code, credentials, or production runtime data to fixtures or issues.

## License

Licensed under the [Apache License 2.0](LICENSE).
