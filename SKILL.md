---
name: vrt
description: Visual regression test storybook stories on the working branch against origin/main. Uses vision-based comparison (not pixel-diff thresholds). Default scope is stories whose source directory contains files changed since origin/main; pass --all for full coverage. Works in any repo with `npm run storybook`.
---

# /vrt — Visual Regression Test against origin/main

Compare the visual output of Storybook stories on the working branch against `origin/main` using vision-based comparison.

The orchestrator script (`scripts/vrt.mjs`) creates a sibling worktree at `origin/main`, spawns two storybook instances on different ports, screenshots each story from both, and emits side-by-side composite images plus pixel-diff highlights. **You** then read each composite via the Read tool (vision) and produce a written summary, using the in-context git diff to explain *why* each visible change happened.

## Workflow

1. **Sanity check.** `pwd` should be a git repo with `npm run storybook` defined. If not, abort with a clear error.

2. **Install skill dependencies on first run** (once per machine):
   ```bash
   if [ ! -d ~/.claude/skills/vrt/node_modules ]; then
     (cd ~/.claude/skills/vrt && npm install --no-audit --no-fund && npx playwright install chromium)
   fi
   ```

3. **Run the orchestrator** from the user's repo:
   ```bash
   node ~/.claude/skills/vrt/scripts/vrt.mjs <flags>
   ```
   Flags:
   - default: `--changed-only` (story is included if its source file's directory contains a file changed since the merge-base with origin/main)
   - `--all` — opt out of filtering
   - `--limit N` — cap the number of stories (useful for debugging)

   The script prints a single JSON line on stdout at the end:
   ```json
   {"manifestPath": "/tmp/vrt-<run>/manifest.json", "indexUrl": "file:///tmp/vrt-<run>/index.html", "outDir": "/tmp/vrt-<run>", "storyCount": 7, "erroredCount": 0}
   ```
   Capture that. It's the handoff to you.

4. **Read the manifest.** Each story entry has `files.composite` (side-by-side: **left half = origin/main, right half = working branch**, separated by a 4px black gutter) and `files.diff` (pixelmatch overlay — useful when a vision summary calls out subtle changes, but not required reading).

5. **For each story in the manifest:**
   - Read `files.composite` via the Read tool.
   - Decide if the two halves *materially* differ. Vision is generous; ignore sub-pixel rendering noise. The accompanying `pixelDiffPercent` is a hint, not a gate (a tiny number can still be a meaningful change if it's a deliberate color shift).
   - If they differ, write a 1-2 sentence note: what changed visually + what code change caused it. You have `git diff origin/main...HEAD` available — use it to ground the explanation.

6. **Produce the final report**, grouped by component (use story `title` to group). Skip stories that look identical. Top-level: count of changed stories across N components, with a one-sentence theme if the changes form one. Always surface the `indexUrl` so the user can browse the composites + pixel-diffs in a browser:
   ```
   ## VRT report — <N> stories changed across <M> components

   <theme summary>

   ### Components/Button
   - **Primary**: <what changed> — <why>
   - **Outline**: <what changed> — <why>

   ### …

   _Browse all composites: <indexUrl>_
   ```

7. **Cleanup is automatic** — the script kills its storybooks on exit. The worktree is left warm at `../<repo>-vrt-main` for the next run. Don't manually delete it.

## Edge cases

- `0 stories matched the changed-only filter` → the script prints that message and exits 0. Tell the user, suggest `/vrt --all` if they want full coverage.
- `HEAD is already at origin/main` → script exits 0 with that message. Nothing to compare.
- A story with `error` in the manifest entry (instead of `files`) → screenshot failed in one branch. Surface it under a "Stories that errored" section; don't try to vision-read the missing image.
- First run will be slow: skill deps install (~30s), playwright chromium download (~50MB), worktree creation, two storybook builds in parallel, then dependency install in the worktree if not already there. Subsequent runs reuse all of that.

## Why side-by-side composites instead of two separate images

One Read call per story instead of two. The vision model compares both halves in a single frame, which is much better at "padding shifted by 2px on the right" type observations than reading two unrelated images and trying to remember the first.

## Out of scope

- App-level VRT against running localdev pages. Storybook only — no backend dependency.
- Cross-viewport comparisons. Single 1280×720 viewport. (Easy to extend if needed.)
- Persistent baselines / Chromatic-style approval workflow. This skill is per-invocation; the agent's report is the artifact.
