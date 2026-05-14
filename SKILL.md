---
name: vrt
description: Visual regression test storybook stories on the working branch against any git ref. Defaults to origin/main; pass --against <ref> (or pick interactively) to compare against a previous commit, branch, or tag. Uses vision-based comparison (not pixel-diff thresholds). Default scope is stories whose source directory contains files changed since the comparison ref; pass --all for full coverage. Works in any repo with `npm run storybook`.
---

# /vrt — Visual Regression Test against a git ref

Compare the visual output of Storybook stories on the working branch against another git ref using vision-based comparison.

The orchestrator script (`scripts/vrt.mjs`) creates a sibling worktree at the chosen ref, spawns two storybook instances on different ports, screenshots each story from both, and emits side-by-side composite images plus pixel-diff highlights. **You** then read each composite via the Read tool (vision) and produce a written summary, using the in-context git diff to explain *why* each visible change happened.

## Workflow

1. **Sanity check.** `pwd` should be a git repo with `npm run storybook` defined. If not, abort with a clear error.

2. **Decide the comparison ref.** Parse the user's invocation:
   - If they passed `--against <ref>`, use it. Skip to step 4.
   - If they didn't, prompt the user with `AskUserQuestion` before running anything. Gather a curated list:
     - `origin/main` — default; for PR review
     - `HEAD~1` — previous commit on this branch (use this with the "add a story commit first, then make the visual change" workflow described in *Comparing against a commit on the working branch* below)
     - `merge-base with origin/main` — every change on this branch
     - **Recent commits**: `git log --format='%h %s (%cr)' -7 HEAD` — show 4–5 of them with subjects + relative dates inline
     - **Enter a different ref…** — escape hatch for arbitrary refs
   - Resolve the user's choice into a concrete ref string. Use the exact symbolic form they picked (e.g. `HEAD~1`, `4f30214`, `origin/main`) — the script handles all of them.

3. **Install skill dependencies on first run** (once per machine):
   ```bash
   if [ ! -d ~/.claude/skills/vrt/node_modules ]; then
     (cd ~/.claude/skills/vrt && npm install --no-audit --no-fund && npx playwright install chromium)
   fi
   ```

4. **Run the orchestrator** from the user's repo:
   ```bash
   node ~/.claude/skills/vrt/scripts/vrt.mjs --against <ref> <flags>
   ```
   Flags:
   - `--against REF` — ref to compare HEAD against (default `origin/main`; accepts anything `git rev-parse` understands).
   - default: `--changed-only` (story is included if its source file's directory contains a file changed since the merge-base with `--against`).
   - `--all` — opt out of the changed-files filter.
   - `--limit N` — cap the number of stories (useful for debugging).
   - `--base-port N` / `--branch-port N` — override the default ports if 6006/6007 conflict.

   The script prints a single JSON line on stdout at the end:
   ```json
   {"manifestPath": "<repo>/.vrt/<run>/manifest.json", "indexUrl": "file://<repo>/.vrt/<run>/index.html", "outDir": "<repo>/.vrt/<run>", "storyCount": 7, "erroredCount": 0}
   ```
   Capture that. It's the handoff to you.

   The output lives under `<repo>/.vrt/<run-id>/` rather than `/tmp/` so
   the agent's later Read calls hit cwd-relative paths and don't trigger
   per-image permission prompts. The script auto-appends `.vrt/` to the
   repo's `.gitignore` on first run.

5. **Read the manifest.** Each story entry has `files.composite` (side-by-side: **left half = the comparison ref, right half = working branch**, separated by a 4px black gutter) and `files.diff` (pixelmatch overlay — useful when a vision summary calls out subtle changes, but not required reading).

6. **For each story in the manifest:**
   - Read `files.composite` via the Read tool.
   - Decide if the two halves *materially* differ. Vision is generous; ignore sub-pixel rendering noise. The accompanying `pixelDiffPercent` is a hint, not a gate (a tiny number can still be a meaningful change if it's a deliberate color shift).
   - If they differ, write a 1-2 sentence note: what changed visually + what code change caused it. You have `git diff <against>...HEAD` available — use it to ground the explanation.

7. **Produce the final report**, grouped by component (use story `title` to group). Skip stories that look identical. Top-level: count of changed stories across N components, with a one-sentence theme if the changes form one. Always surface the `indexUrl` so the user can browse the composites + pixel-diffs in a browser:
   ```
   ## VRT report — <N> stories changed across <M> components (vs <against>)

   <theme summary>

   ### Components/Button
   - **Primary**: <what changed> — <why>
   - **Outline**: <what changed> — <why>

   ### …

   _Browse all composites: <indexUrl>_
   ```

8. **Cleanup is automatic** — the script kills its storybooks on exit. The worktree is left warm at `../<repo>-vrt-base` for the next run. Don't manually delete it.

## Comparing against a commit on the working branch

Useful when you want to verify a visual change to a component that doesn't already have a story on `origin/main` — a Storybook-only comparison can't render a story that doesn't exist in the comparison ref.

The workflow:

1. Commit A: add the Storybook story for the component. No code changes to the component itself.
2. Commit B: make the visual change you want to verify.
3. Run `/vrt --against HEAD~1` (or pick "HEAD~1" from the interactive picker).

Both commits have the story, so both Storybook instances can render it. The diff captures only the visual effect of commit B.

If the user has lumped story + change into a single commit, the script will report `0 stories matched` (the story exists only on the working ref). Suggest they split the commits and re-run.

## Edge cases

- `Could not resolve --against "<ref>"` → script exits 1 with that message. The user passed something `git rev-parse` doesn't understand; suggest they double-check the ref or pick from the interactive list.
- `0 stories matched the changed-only filter` → the script prints that message and exits 0. Tell the user, suggest `/vrt --all` if they want full coverage.
- `HEAD is already at <ref>` → script exits 0 with that message. Nothing to compare.
- A story with `error` in the manifest entry (instead of `files`) → screenshot failed in one branch. Surface it under a "Stories that errored" section; don't try to vision-read the missing image.
- First run will be slow: skill deps install (~30s), playwright chromium download (~50MB), worktree creation, two storybook builds in parallel, then dependency install in the worktree if not already there. Subsequent runs reuse all of that.

## Why side-by-side composites instead of two separate images

One Read call per story instead of two. The vision model compares both halves in a single frame, which is much better at "padding shifted by 2px on the right" type observations than reading two unrelated images and trying to remember the first.

## Out of scope

- App-level VRT against running localdev pages. Storybook only — no backend dependency.
- Cross-viewport comparisons. Single 1280×720 viewport. (Easy to extend if needed.)
- Persistent baselines / Chromatic-style approval workflow. This skill is per-invocation; the agent's report is the artifact.
