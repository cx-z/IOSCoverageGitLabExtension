# Privacy

Effective date: September 9, 2026

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
- GitLab origin;
- Coverage operator Token.

The settings are not stored in Chrome sync storage. Extension-local storage is restricted to trusted extension contexts, so the GitLab content script cannot read the operator Token. Use **Clear Token** on the settings page, or remove the extension, to delete the credential from extension storage.

## Network requests

The extension communicates only with origins explicitly configured and approved by the user:

- the selected GitLab origin, where the content script reads supported diff DOM;
- the selected Coverage server origin, where the Service Worker calls fixed read-only API paths.

The current MR URL is sent to the configured Coverage server's resolver. The Coverage server may contact its configured GitLab API using server-owned credentials. The extension never receives or stores a GitLab Personal Access Token.

The operator Token is sent only in the `Authorization` header of fixed Coverage API requests. It is not inserted into URLs, GitLab DOM, page storage, logs, or remote telemetry.

## Permissions

- `storage` stores local settings and the operator Token.
- `scripting` registers the content script for the configured GitLab origin.
- optional HTTP/HTTPS host access allows the user to approve the exact configured GitLab and Coverage server origins.

The extension does not request Cookie, `webRequest`, browsing-history, download, clipboard, notification, or GitLab write permissions.

## Retention and sharing

The extension retains settings until the user clears them or removes the extension. It does not maintain a separate history of MR pages, reports, or source files. Data is not sold or shared with advertisers or data brokers. Any retention performed by the configured GitLab or Coverage service is governed by those services.

## Security boundary

The extension validates fixed server response contracts and fails closed when the report cannot be proven to match the current MR diff. Users are responsible for trusting and securing the configured Coverage server. Plain HTTP should be limited to loopback or a trusted development network.

## Changes and questions

Material privacy changes should be documented in this file with an updated effective date. Questions or reports can be opened as an issue in this repository; never include Tokens, private source code, internal URLs, or production response bodies in an issue.
