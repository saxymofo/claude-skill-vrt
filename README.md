# vrt — Visual Regression Test against a git ref

A Claude Code skill that compares Storybook stories on the working branch against any git ref using **vision-based** (not pixel-threshold) comparison, and writes a browsable HTML report.

Works in any repo with `npm run storybook` defined. Tested on `@keycardlabs/ui-lanyard` and `svc-console`.

## What it does

1. Decides the comparison ref — `origin/main` by default, or anything `git rev-parse` understands via `--against` (HEAD~1, a sha, a branch, a tag). When invoked interactively without `--against`, the agent prompts the user to pick from a curated list (origin/main, HEAD~1, merge-base, a few recent commits).
2. Creates a sibling git worktree at `../<repo>-vrt-base` pointing at the chosen ref. The worktree is reused across runs and reset to the requested ref each time.
3. Spawns two Storybook instances in parallel — one in the worktree, one in your working tree.
4. Enumerates stories from `index.json`. Default: only stories whose source directory contains files changed since the merge-base with the comparison ref. `--all` for full coverage.
5. Screenshots each story from both ports at `1280×720` with animations disabled and fonts awaited.
6. Emits a side-by-side composite (`base | branch`) and a `pixelmatch` overlay per story.
7. Writes a self-contained `index.html` next to a `manifest.json` so you can browse the run in any browser.
8. The Claude Code agent reads each composite via vision, cross-references the in-context git diff, and writes a per-story summary.

## Install

```bash
git clone <this-repo-url> ~/.claude/skills/vrt
```

That's the only manual step. The skill auto-installs its dependencies (playwright, sharp, pixelmatch, pngjs) and downloads the chromium headless shell on first invocation.

### Prereqs

- Node ≥ 20
- ~150 MB disk for the chromium binary
- A repo with `npm run storybook` defined

## Use

Inside any repo with Storybook:

```
/vrt                          # prompts you to pick a comparison ref, then runs --changed-only against it
/vrt --against origin/main    # explicit (and the default if you skip the prompt)
/vrt --against HEAD~1         # compare against the previous commit on this branch
/vrt --against 4f30214        # compare against a specific sha
/vrt --against my-other-branch  # compare against another branch
/vrt --all                    # widen scope: every story, not just stories under changed dirs
/vrt --limit 10               # cap the number of stories (useful for debugging)
```

The agent reports back grouped by component with per-story summaries and an `indexUrl` you can `open` to browse the composites.

## Comparing against a commit on this branch

Useful when you want to verify a change to a component that doesn't have a Storybook story on `origin/main` yet. The skill needs the story to exist in both refs (it's a Storybook-driven comparison), so:

1. Commit A: add the story. No visual change.
2. Commit B: make the visual change.
3. `/vrt --against HEAD~1`.

Both commits have the story; the diff captures only commit B's effect.

## Output layout

```
<repo>/.vrt/<run-id>/
├── index.html            # browsable report
├── manifest.json         # machine-readable
└── stories/
    └── <story-id>/
        ├── base.png      # raw screenshot from the comparison ref
        ├── branch.png    # raw screenshot from working tree
        ├── composite.png # side-by-side (left=base, right=branch)
        └── diff.png      # pixelmatch overlay
```

The output lives under `<repo>/.vrt/` (not `/tmp/`) so Claude Code's
auto-allow-cwd permission model covers the agent's later Read calls
without per-image prompts. The skill appends `.vrt/` to `.gitignore`
automatically on first run.

## Out of scope

- App-level VRT against running localdev pages. Storybook only — no backend dependency.
- Multiple viewports. Single 1280×720. (Easy to extend.)
- Persistent baselines / Chromatic-style approval workflow. Per-invocation only.

## Caveats

- Default-border-color regressions across Tailwind v3 → v4 migrations: confirm the working branch's storybook builds before invoking.
- Lockfile peer-dep conflicts cause the worktree's `npm ci` to fail; the script falls back to `npm install --legacy-peer-deps` automatically.
- The "changed-only" filter is dir-based — a story is included if any changed file lives under the story file's directory. Misses cross-cutting changes (e.g., a global theme tweak); `--all` is the escape hatch.

## Why vision-based comparison

Pixel-threshold tools (pixelmatch alone, odiff) require alignment, threshold tuning, and produce "47 pixels differ" answers. With Claude Code's vision, the comparison reads both halves of one composite frame and explains *what* changed semantically, plus *why* via the in-context git diff. Padding shifts, color drift, layout reflow, and text changes all get described in plain English.

The pixel-diff overlay is still produced — useful when a vision summary calls out a subtle change and you want to see *where*.

## Breaking changes from prior versions

If you're upgrading from a version that hardcoded `origin/main`:

- The worktree path changed from `../<repo>-vrt-main` to `../<repo>-vrt-base`. The old directory is orphaned; remove it with `git worktree remove <repo>-vrt-main` (or just delete the directory).
- Screenshot files are now `base.png` instead of `main.png`.
- Manifest field `mainRef` → `baseRef`; new field `against` carries the symbolic ref the user requested.
- The `--main-port` flag is now `--base-port`.

If you have downstream tooling that reads the manifest, update field names accordingly.
