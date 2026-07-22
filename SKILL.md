---
name: vrt
description: Visual regression test a visual change, before vs after. PREFERS capturing the real running app (localdev) with Playwright — navigating to the affected page and, where needed, simulating API responses to trigger the UI condition (as in pr-playwright-verify) — and falls back to Storybook for pure component / design-system changes or when no app is running. Under Claude, presents results as an Artifact with side-by-side before/after columns; emits a single baked composite image only as a fallback for agents without an artifact system. Defaults to comparing against origin/main; pass --against <ref> or pick interactively. Vision-based, per-invocation.
---

# /vrt — Visual Regression Test

Show what a change looks like **before vs after**, grounded in the real rendered output, and explain each visible difference from the in-context diff.

Two independent axes:

- **Capture** — where the pixels come from. **Prefer the real running app** (localdev) via Playwright; fall back to **Storybook** for pure component/design-system work or when no app is running.
- **Presentation** — how the user sees the result. **Under Claude Code, build an Artifact with before/after columns** (richer: real side-by-side, per-callsite rows, scrollable, zoomable). A single baked **composite** image is only for environments without the artifact system (Cursor, headless, other agents).

Decide capture first (real-app vs Storybook), then presentation (artifact vs composite).

## Choosing the capture mode

Prefer **real-app** when the change manifests on a page you can reach in the locally running app (localdev) — feature UI, list/detail pages, dialogs, headers, state-dependent rendering. The real app exercises the actual routing, data, theme, and layout the user sees, so the VRT reflects reality, not a story's approximation.

Fall back to **Storybook** when:
- there's no locally running app (or it's mid-use for something else and a ref switch would disrupt it — see the ref-switch note),
- the change is in a component that isn't wired into a reachable route (a pure design-system atom/molecule), or
- the component is new and has no production callsite yet (use the migration-story pattern).

When unsure, ask which mode the user wants, or state your choice and proceed.

---

## Real-app capture (preferred)

Drive the actual running app with Playwright, screenshot the region where the change shows, for both the **after** (working branch) and the **before** (comparison ref).

Reuse the **pr-playwright-verify** machinery — it already solves auth and state:
- **Auth:** the saved `storageState` at `~/.localdev/pw-auth.json` (run its `ensure-auth.mjs` if missing). One login covers the localdev apps via SSO.
- **Hosts:** plain HTTP, e.g. `http://console.localdev.keycard.sh`.
- **State via request interception:** when the change only shows under data/permission/flag/empty/error conditions you don't have, **`page.route` the read response and reshape it** so the UI renders that branch — exactly the pr-playwright-verify technique (fetch the real response, mutate, `route.fulfill`). Scope the route tightly; discover the real wire shape first. This is read-only to the backend and deterministic. Register routes **before** `page.goto`. Never `route.abort()` a mutation the flow depends on.

### Capturing both states

The app serves one checkout at a time, so before/after needs two passes over the **same** navigation + interception script:

1. **After** — on the working branch (already checked out): run the Playwright script, screenshot the affected region(s) to `after-<label>.png`.
2. **Before** — get the app onto the comparison ref, then re-run the identical script → `before-<label>.png`. Options, cheapest first:
   - **Interception-only toggle** — if "before/after" is a data/props condition you can express purely by reshaping the intercepted response (not a code change), capture both from the same running branch by varying the `page.route` body. No ref switch. Best case.
   - **Ref switch on the served checkout** — `git stash` (or `git checkout <ref>`), let localdev live-sync/rebuild (`localdev tilt wait <resource>`), re-run, then restore the branch. **This moves the working tree** — only do it if the checkout is yours to move and the user isn't mid-test on it. Confirm first if unsure.
   - **Dedicated worktree** the local app is pointed at (advanced) — avoids touching the primary checkout; use when the served checkout must stay put.
   - If none is safe/feasible, **fall back to the Storybook cross-ref path**, which does two refs cleanly via a base worktree + two ports (below).

Keep both passes byte-identical except the code under test: same viewport, `deviceScaleFactor` (use 2), `colorScheme` (default to the OS theme; Console resolves dark via `localStorage['ui-theme']`), navigation, waits, and interception. Any incidental difference reads as a false regression.

Screenshot the **element/region** that changed (`locator.screenshot()`), not always the full page — a tighter frame makes the before/after columns legible. Read each shot via vision to confirm it captured the intended state and isn't clipped/loading.

---

## Storybook capture (fallback)

### Cross-ref orchestrator — before/after across two git refs

`scripts/vrt.mjs` creates a sibling worktree at the comparison ref, spawns two Storybook instances, screenshots each matching story from both refs, and writes per-side frames + a composite + a pixel-diff overlay. Use it for component/design-system changes that live in stories.

1. **Sanity check.** `pwd` is a git repo with `npm run storybook`. Else abort.
2. **Decide the ref.** If `--against <ref>` given, use it. Else `AskUserQuestion` with: `origin/main` (default, PR review), `HEAD~1`, `merge-base with origin/main`, recent commits (`git log --format='%h %s (%cr)' -7 HEAD`), and an "enter a ref" escape hatch.
3. **Install deps on first run:**
   ```bash
   if [ ! -d ~/.claude/skills/vrt/node_modules ]; then
     (cd ~/.claude/skills/vrt && npm install --no-audit --no-fund && npx playwright install chromium)
   fi
   ```
4. **Run** from the repo:
   ```bash
   node ~/.claude/skills/vrt/scripts/vrt.mjs --against <ref> <flags>
   ```
   Flags: `--against REF` (default `origin/main`); default `--changed-only` (story included if its source dir has a file changed since the merge-base); `--all` for full coverage; `--limit N`; `--base-port`/`--branch-port` (default 6006/6007); `--theme dark|light` (default OS theme; both refs shot in the same scheme). It prints one JSON line: `{manifestPath, indexUrl, outDir, storyCount, erroredCount}`. Output lives under `<repo>/.vrt/<run>/` (auto-gitignored) so later Reads are cwd-relative.
5. **Read the manifest.** Each entry has the per-side frames, `files.composite` (left = comparison ref, right = working branch, 4px gutter), and `files.diff` (pixelmatch overlay — a hint, not a gate).
6. For each story, decide if the two states *materially* differ (vision is generous; ignore sub-pixel noise). For changed ones, note what changed + why, grounded in `git diff <against>...HEAD`.
7. Present per the **Presentation** section — under Claude, feed the per-side frames into an artifact's before/after columns; don't just dump the composite.
8. Cleanup is automatic; the base worktree is left warm at `../<repo>-vrt-base`.

**New story not on the base ref?** Split into two commits — Commit A adds the story (no component change), Commit B makes the visual change — then `/vrt --against HEAD~1`. Both refs have the story, so the diff isolates B. (Single lumped commit → `0 stories matched`; suggest the split.)

### Migration story — self-contained (no base ref)

For migration PRs ("show every place this component changed, old vs new") where the new markup exists on neither ref. Write an **uncommitted** story titled `Migration/<Component>` rendering each callsite as a labeled cell with the pre-migration markup and the migrated markup, shoot it once on the current branch, verify via vision, deliver, then discard the story (don't commit it).

**Fitting one shot:** prefer `fullPage: true` over compressing cells (keeps production-faithful sizing so any disparity is real). A 2-column grid of cells halves height when content is narrow. Trim long prose only as a last resort and **only symmetrically** — trimming one side manufactures a false diff. Cardinal rule: never introduce a before/after difference that doesn't exist in production.

### One-shot shoot script

The cross-ref orchestrator always spawns a base worktree; for a single story on the current branch, a smaller script suffices. Write it to `~/.claude/skills/vrt/shoot-story.mjs` (inherits the installed playwright), run once, delete it:

```js
// shoot-story.mjs — one story on the current branch → PNG.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs/promises";

const REPO = "/absolute/path/to/repo";
const PORT = 6006;
const STORY_ID = "migration-...--...";
const OUT = "/absolute/out.png";

const sb = spawn("npm", ["run", "storybook", "--", "--ci", "--port", String(PORT)],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
sb.stdout.on("data", () => {}); sb.stderr.on("data", () => {});
for (let i = 0; i < 300; i++) {           // poll until it serves (stdout patterns unreliable under --ci)
  try { if ((await fetch(`http://localhost:${PORT}/iframe.html`)).ok) break; } catch {}
  if (i === 299) { sb.kill(); throw new Error("Storybook didn't bind in 300s"); }
  await sleep(1000);
}
await sleep(2000);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`http://localhost:${PORT}/iframe.html?id=${STORY_ID}&viewMode=story`, { waitUntil: "networkidle" });
await sleep(1500);
await fs.writeFile(OUT, await page.screenshot({ fullPage: true }));
console.log("Wrote", OUT);
await browser.close(); sb.kill("SIGTERM");
```

Run from `~/.claude/skills/vrt/`, Read the `OUT` path to verify, delete the script.

---

## Presentation

### Under Claude — Artifact with before/after columns (preferred)

Build an HTML **Artifact** that puts **before** and **after** side by side, one row per story/callsite. This beats a baked composite: the columns are real DOM (responsive, scrollable, zoomable), each screenshot keeps native resolution, and you can label each row and annotate the diff inline.

- Load the **artifact-design** skill first (as always) and give the page a real, calibrated treatment — a utilitarian comparison board, not a flashy hero. Ground the palette in the subject's own tokens where known (e.g. Keycard's dark slate/iris) so it reads as native.
- Layout: a status/summary header, then per comparison a two-column row (`Before` | `After`) with the two element screenshots and a one-line "what changed + why". Wide shots scroll inside their own `overflow-x:auto` container; images `max-width:100%`.
- **Inline every image as a `data:` URI** — the artifact CSP blocks external hosts. base64 the PNGs and embed (a generator script avoids pasting base64 by hand). Keep the `<title>` and favicon stable across redeploys; redeploy the same file path to update the same URL as more comparisons land.
- Hand the user the artifact URL. It's private to them unless they choose to share it.

This is a genuine visual diff surface, so capture **separate** before/after images (element screenshots), not a pre-joined composite — the columns do the joining.

### Fallback — single composite image (agents without artifacts)

When the artifact system isn't available (Cursor, headless, another agent, or a plain PR deliverable), emit one **composite** PNG (before-left | after-right, thin gutter) and Read it via vision — one Read call lets the model compare both halves in a single frame, better for "shifted 2px" observations than two unrelated images. Deliver it by the channel that fits: drag-drop into a PR description (GitHub auto-uploads on drop; `gh` can't attach it), or save to a path the user can open. Use the migration-story/`fullPage` guidance above to fit everything cleanly.

---

## Report

Group by component/page. Skip identical ones. Lead with a count of changed items and a one-line theme if there is one. For each change: what moved + the code cause (from `git diff <against>...HEAD`). Surface the artifact URL (Claude) or the composite path/`indexUrl` (fallback). Flag a "pixel-identical" result on a **spacing/token** swap as suspicious — it can mean an off-scale value was preserved instead of the canonical token being adopted; check the intent.

## Edge cases

- `Could not resolve --against "<ref>"` / `0 stories matched` / `HEAD is already at <ref>` — the orchestrator exits with the message; relay it (suggest `--all` for the 0-match case).
- Manifest entry with `error` instead of frames — a screenshot failed on one ref; surface under "errored", don't vision-read the missing image.
- Real-app "before" needs a ref switch you can't safely do (checkout in use) → fall back to the Storybook cross-ref path, or capture only "after" and say so.
- localdev not running / app resource not Ready → tell the user to bring it up; don't start it yourself unless asked.
- First orchestrator run is slow (deps install, chromium download, two Storybook builds); later runs reuse them.

## Out of scope

- Cross-viewport matrices — single viewport per run (extendable).
- Persistent baselines / Chromatic-style approval — this skill is per-invocation; the artifact (or composite) + report is the deliverable.
