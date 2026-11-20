# Sanitized GitLab DOM validation

Validation date: 2026-09-09. The source was one authenticated private self-hosted GitLab MR. No raw HTML, screenshots, source text, private host, project name, user data, or real URL is stored here.

## Confirmed facts

- The observed route was `/group/project/merge_requests/<iid>/diffs`. The alternate `/-/merge_requests/<iid>/diffs` form is supported by the URL parser from the requirement but was not present in this sample.
- The diff root was `.diffs`; each file was `.diff-file.file-holder` with `data-view="inline"` or `data-view="parallel"`.
- The exact displayed new path for ordinary and added files was `.file-title-name[data-title]`. A separate `data-blob-diff-path` was a blob URL and is deliberately not used as a repository-path parser.
- The page did not expose `data-new-path` or `data-old-path`. No renamed file appeared in the sample, so rename path structure remains unverified. A title containing rename notation is rejected unless a future adapter has an explicit structured new path.
- Inline mode used `tr.line_holder.new` for additions, `.old` for deletions, an unqualified `.line_holder` for context, and `.match` for hunk/unfold rows. The trustworthy new changed-line cell was `td.new_line.new[data-linenumber]`.
- Side-by-side mode used `tr.line_holder.parallel`. Pure additions had an empty old-side cell and `td.new_line.new`; paired replacements had old-side `.old` and new-side `.new`; context cells lacked the `.new` marker. The same `td.new_line.new[data-linenumber]` selector therefore identifies only new changed lines in both modes.
- One collapsed file used a visible `a.click-to-expand` inside `.nothing-here-block.diff-collapsed`. Activating it changed the content to `.diff-content.loading`; rows were inserted asynchronously. Hidden alternate-view placeholders also existed, so visibility cannot be inferred from the mere presence of `click-to-expand`.
- Switching inline/side-by-side added or changed a `view` query and temporarily emptied the diff before asynchronous rows returned. MR tab navigation changed the pathname while retaining dynamically managed diff content. The exact navigation framework could not be proven, so the implementation uses both URL checks and a debounced `MutationObserver` rather than assuming a named SPA library.
- The active diff version was exposed by `.mr-version-dropdown a.is-active`. Historical and latest selections both can produce a `diff_id` query, so `diff_id` alone is not a history signal. The active label is required; unknown labels fail closed.
- The sample contained added and modified files. No renamed or deleted file sample was available, so their exact header structure remains unknown. Deleted rows themselves were confirmed and are excluded because they lack a new-side changed cell.

## Diff identity for MR presentation schema 2

The active `.mr-version-dropdown a.is-active` latest-version link exposes a numeric `diff_id`. The adapter requires one unambiguous active latest link whose origin/path match the page and whose ID agrees with any explicit URL `diff_id`. Short commit labels and blob links alone remain insufficient.

New-side diff rows expose a comment button with JSON `data-position`: `position_type`, `base_sha`, `start_sha`, `head_sha`, `new_path`, and `new_line`. The server binds the selected diff ID through registered-project latest version metadata; the extension validates each row's complete three refs, exact path and line against that result before annotation. Missing/malformed/mismatched row metadata never authorizes a marker. This also handles the interval where version controls have updated but old rows remain during asynchronous replacement. These structured fields supersede the earlier observation that no complete row identity had been located.

Server mapping and state decisions are never inferred from DOM source text. Historical diff selections remain unsupported. An unknown version while GitLab is loading is shown as loading and retried. `data-position` and active-link `href` changes participate in invalidation; no global class observer is added.

## Incremental rendering boundary

File containers and exact new paths are discovered before viewport observation; new-side line cells are scanned only for nearby files. An `IntersectionObserver` watches `.diff-file.file-holder` with a 600-pixel root margin. A collapsed file is never expanded by the extension; GitLab's later row insertion invalidates that file's scan, and an offscreen dirty file waits until it approaches the viewport.

The document observer tracks child-list changes and the `data-new-path`, `data-title`, `data-view`, and `data-linenumber` attributes. Class changes are observed separately within `.mr-version-dropdown` and nearby file containers; file class observers are disconnected on viewport exit, and those row snapshots are invalidated on re-entry. This avoids observing unrelated global spinners, icons and syntax-highlight classes. SVG class values must be read via `getAttribute("class")`, not the SVGAnimatedString-valued `className` property.

Mutations inside a file invalidate only that file's row snapshot; newly inserted outer containers are searched only within their own subtree, and detached files are unobserved. Extension-owned summary/marker changes and the extension's file-dimming class do not schedule scans. Page-version checks remain in the content controller; the scheduler uses the adapter only to verify actual row three-ref identity against the server-issued target before applying its decisions.
