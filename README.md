# iOS Coverage for GitLab

A read-only Manifest V3 Chrome extension that displays iOS changed-line coverage directly on supported GitLab merge request diff pages.

The Coverage service remains the only source of coverage truth. The extension displays server decisions; it never calculates, inherits, or guesses coverage and never writes to GitLab.

## Features

- Shows changed-line coverage summary and report metadata on GitLab MR diff pages.
- Marks new-side changed lines with four distinct, accessible states.
- Supports GitLab inline and side-by-side diff layouts.
- Handles lazy-loaded files, collapsed files, SPA-style navigation, and report generation changes.
- Polls the resolver while analysis is queued or running.
- Removes line annotations whenever the server cannot prove that the report matches the current diff.
- Uses no framework, bundler, remote executable code, or third-party runtime dependency.

## Coverage states

| State | Marker | Meaning |
| --- | --- | --- |
| `covered` | Green `✓` | The line is measurable and covered. |
| `uncovered` | Red `×` | The line is measurable but is not fully covered. |
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

Load the generated `dist/company` directory as an unpacked extension. No settings or clicks are needed.

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

The summary explains the current state. When the resolver returns `can_annotate=true`, the extension loads the matching report and visible file details, then adds line markers using only this exact key:

```text
(repo_relative_path, new_line_number)
```

MR overview, commits, repository pages, historical diff versions, extra-suffix routes, and look-alike paths are not annotated. The extension does not automatically expand every collapsed large file.

## Why stale reports have no line markers

The server permits annotation only when all three immutable identities match:

```text
Build.merge_base_sha      == GitLab diff base_sha
Build.target_sha_at_build == GitLab diff start_sha
Build.git_sha             == GitLab diff head_sha
```

If any value is missing or different, the resolver returns a non-annotatable state such as `stale_diff`. The extension immediately removes existing markers and does not fall back to head-only comparison, basename or path-suffix matching, source-text matching, or nearby-line guessing. This prevents an old report from being presented as coverage for the current diff.

## Server dependency

The companion backend is [iOS Code Coverage Server](https://github.com/cx-z/iOSCodeCoverageServer). Real data requires a deployment compatible with API version 1 and MR Coverage resolver schema version 1, with anonymous read-only access enabled (`"anonymous_read": true` in `config/server.json`) so the extension works without any Token. The extension uses only these fixed read-only endpoints:

```text
GET  /health
POST /api/v1/integrations/gitlab/merge-request-coverage/resolve
GET  /api/v1/cycles/<cycle_id>/report
GET  /api/v1/cycles/<cycle_id>/report/files/<file_id>
```

The resolver request contains exactly `schema_version` and the current `mr_url`. The server must:

- serve these endpoints without a client credential when `anonymous_read` is enabled;
- map the exact registered GitLab host, full project path, and MR IID;
- obtain current MR diff refs using its own GitLab credential;
- compare all three SHAs with the latest-success Build;
- return the fixed resolver schema, including `can_annotate`, `should_poll`, and a fixed relative `summary_api` path;
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
| Coverage service | API version 1 with MR Coverage resolver schema version 1. |
| Extension data | Resolver/report/file-detail schema version 1. Unknown or malformed responses fail closed. |

GitLab compatibility is based on DOM structure rather than a claimed GitLab release range. GitLab UI changes can require an adapter update; when the structure cannot be recognized uniquely, the extension shows an unsupported state and adds no line markers. Firefox, Safari, and other Chromium browsers are not currently tested or supported.

## Development and testing

Run the test suite with Node.js's built-in test runner:

```bash
node --test tests/*.test.js
```

Tests use neutral fixtures under `https://git.example.com/group/project/...` and require no network access. They cover URL parsing, strict API contracts, the four coverage states and evidence sources, exact path/line matching, idempotent rendering, generation and route cleanup, stale-report behavior, polling, message authorization, and manifest restrictions.

The runtime module boundaries are deliberately small:

- `src/background/`: settings-backed network requests and tab-scoped file authorization;
- `src/content/gitlab-url.js`: supported MR URL parsing;
- `src/content/gitlab-dom-adapter.js`: exact path and new-side line extraction;
- `src/content/coverage-renderer.js`: extension-owned summary and line UI;
- `src/shared/contracts.js`: response validation;
- `src/options/`: settings and permission requests.

See [docs/dom-validation.md](docs/dom-validation.md) for sanitized DOM validation findings. Do not add private page HTML, screenshots, source code, credentials, or production runtime data to fixtures or issues.

## License

Licensed under the [Apache License 2.0](LICENSE).
