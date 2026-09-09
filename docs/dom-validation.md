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

## Diff identity conclusion

No trustworthy structured source for the current diff’s complete `base_commit_sha`, `start_commit_sha`, and `head_commit_sha` was found in the rendered DOM or page runtime. Short commit labels and blob links are insufficient. Some bundled page script text contained generic commit-related symbol names, but it was not a structured current-diff identity and is not consumed.

The adapter therefore does not expose a diff-identity API. The extension delegates identity resolution to the read-only server resolver, which holds the GitLab credential, fetches the current MR diff refs, compares all three SHAs with the latest-success Build, and returns an explicit `can_annotate` decision. GitLab DOM remains responsible only for exact repository-relative new paths and new-side line numbers.
