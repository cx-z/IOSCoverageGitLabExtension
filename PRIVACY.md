# Privacy

Effective date: September 17, 2026

iOS Coverage for GitLab is a local, read-only Chrome extension. It has no analytics, telemetry, advertising, tracking pixels, or third-party data service.

## Data processed

On a supported GitLab merge request diff page, the extension processes:

- the current page origin, route, full repository path, and MR IID;
- repository-relative changed-file paths;
- new-side changed-line numbers;
- coverage summaries, line states, evidence sources, and report identity returned by the configured Coverage service.

The extension does not collect or transmit GitLab source text. It does not read GitLab cookies, browser history, unrelated tabs, comments, discussions, labels, pipeline status, or user profile data.

## Data stored locally

The extension stores these settings in `chrome.storage.local`:

- Coverage server origin;
- the list of GitLab origins the user authorized from the page.

The settings are not stored in Chrome sync storage. Extension-local storage is restricted to trusted extension contexts, so the GitLab content script cannot read the settings or request arbitrary URLs. The extension stores no credential. Removing the extension deletes everything from extension storage.

## Network requests

The extension communicates only with origins explicitly approved by the user or pre-authorized by a company-internal build:

- an authorized GitLab origin, where the content script reads supported diff DOM;
- the configured Coverage server origin, where the Service Worker calls fixed read-only API paths.

The current MR URL is sent to the configured Coverage server's resolver. The Coverage server may contact its configured GitLab API using server-owned credentials. The extension never receives or stores a GitLab Personal Access Token.

The extension sends no Authorization header. Its read-only Coverage requests are served anonymously inside the trusted intranet when the Coverage service enables anonymous read access.

## Permissions

- `storage` stores the Coverage server origin and the authorized GitLab origins list.
- `scripting` registers the content script for an authorized GitLab origin.
- `tabs` reads tab URLs so the settings page can detect open GitLab MR pages and offer to authorize that site. Only the MR route (origin, project path, IID) is used; other tab content is not read.
- optional HTTP/HTTPS host access allows the user to approve an exact GitLab origin from the settings page and the exact Coverage server origin.

A company-internal build declares static `host_permissions` for the baked GitLab and Coverage server origins; see the build script for details. The extension does not request Cookie, `webRequest`, browsing-history, download, clipboard, notification, or GitLab write permissions.

## Retention and sharing

The extension retains settings until the user clears them or removes the extension. It does not maintain a separate history of MR pages, reports, or source files. Data is not sold or shared with advertisers or data brokers. Any retention performed by the configured GitLab or Coverage service is governed by those services.

## Security boundary

The extension validates fixed server response contracts and fails closed when the report cannot be proven to match the current MR diff. Users are responsible for trusting and securing the configured Coverage server. Plain HTTP should be limited to loopback or a trusted development network.

## Changes and questions

Material privacy changes should be documented in this file with an updated effective date. Questions or reports can be opened as an issue in this repository; never include Tokens, private source code, internal URLs, or production response bodies in an issue.
