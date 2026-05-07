# vrt — Visual Regression Test against `origin/main`

A Claude Code skill that compares Storybook stories on the working branch against `origin/main` using **vision-based** (not pixel-threshold) comparison, and writes a browsable HTML report.

Works in any repo with `npm run storybook` defined. Tested on `@keycardlabs/ui-lanyard` and `svc-console`.

## What it does

1. Creates a sibling git worktree at `../<repo>-vrt-main` pointing at `origin/main`.
2. Spawns two Storybook instances in parallel — one in the worktree, one in your working tree.
3. Enumerates stories from `index.json`. Default: only stories whose source directory contains files changed since the merge-base with `origin/main`. `--all` for full coverage.
4. Screenshots each story from both ports at `1280×720` with animations disabled and fonts awaited.
5. Emits a side-by-side composite (`main | branch`) and a `pixelmatch` overlay per story.
6. Writes a self-contained `index.html` next to a `manifest.json` so you can browse the run in any browser.
7. The Claude Code agent reads each composite via vision, cross-references `git diff origin/main...HEAD`, and writes a per-story summary.

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
/vrt              # default: changed-only filter
/vrt --all        # every story
/vrt --limit 10   # cap (useful for debugging)
```

The agent reports back grouped by component with per-story summaries and an `indexUrl` you can `open` to browse the composites.

## Output layout

```
/tmp/vrt-<run-id>/
├── index.html            # browsable report
├── manifest.json         # machine-readable
└── stories/
    └── <story-id>/
        ├── main.png      # raw screenshot from origin/main
        ├── branch.png    # raw screenshot from working tree
        ├── composite.png # side-by-side (left=main, right=branch)
        └── diff.png      # pixelmatch overlay
```

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
