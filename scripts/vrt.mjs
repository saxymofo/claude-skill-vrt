#!/usr/bin/env node
/**
 * VRT orchestrator.
 *
 * Workflow:
 *  1. From the user's repo (cwd), find the merge-base with origin/main.
 *  2. Ensure a sibling worktree at ../<repo>-vrt-main pointing at origin/main.
 *  3. npm install in both the working tree and the worktree if needed.
 *  4. Spawn two storybook instances on different ports.
 *  5. Wait for both /index.json endpoints to come up.
 *  6. Enumerate stories. Filter by changed files (default) or run all.
 *  7. For each story, screenshot from both ports. Build a side-by-side
 *     composite and a pixelmatch diff overlay.
 *  8. Write a manifest.json describing every story's image paths.
 *  9. Emit a single JSON status line on stdout, then exit. Storybooks
 *     are killed on exit; the worktree stays warm.
 */

import { spawn, execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import pixelmatch from "pixelmatch";
import pngjs from "pngjs";
import { chromium } from "playwright";
import sharp from "sharp";

import { renderIndexHtml } from "./render-index.mjs";

const { PNG } = pngjs;

// ----- arg parsing -----
const args = process.argv.slice(2);
function flag(name) {
	return args.includes(`--${name}`);
}
function valued(name, fallback) {
	const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (i === -1) return fallback;
	const a = args[i];
	if (a.includes("=")) return a.split("=", 2)[1];
	return args[i + 1];
}

if (flag("help")) {
	console.log(`vrt — visual regression test against a git ref

Usage:
  node vrt.mjs [--against <ref>] [--all] [--limit N] [--base-port 6006] [--branch-port 6007]

Flags:
  --against REF      ref to compare HEAD against (default: origin/main).
                     Accepts anything git rev-parse understands:
                       origin/main           PR-review baseline (default)
                       HEAD~1                previous commit on this branch
                       4f30214               a specific sha
                       my-other-branch       another local branch
                       v1.2.0                a tag
  --all              compare every story (default: only stories whose source dir contains changed files)
  --limit N          cap the number of stories
  --base-port N      port for the comparison-base storybook (default 6006)
  --branch-port N    port for the working-branch storybook (default 6007)
`);
	process.exit(0);
}

const AGAINST = valued("against", "origin/main");
const ALL = flag("all");
const CHANGED_ONLY = !ALL;
const LIMIT = Number(valued("limit", "0")) || 0;
const BASE_PORT = Number(valued("base-port", "6006"));
const BRANCH_PORT = Number(valued("branch-port", "6007"));

// ----- discover repo -----
function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: "utf8", ...opts }).trim();
}

const repoRoot = sh("git rev-parse --show-toplevel");
const repoName = basename(repoRoot);

// ----- guard: storybook script -----
const pkgPath = join(repoRoot, "package.json");
if (!existsSync(pkgPath)) {
	console.error("No package.json in repo root. Aborting.");
	process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!pkg.scripts?.storybook) {
	console.error(
		'No "storybook" script in package.json. /vrt only supports repos with `npm run storybook`. Aborting.',
	);
	process.exit(1);
}

// ----- resolve --against -----
// Only fetch when the ref points at a remote-tracking branch — otherwise
// we'd be hitting the network for local refs (HEAD~1, shas, tags). Match
// `origin/<branch>` shape; anything else is assumed local-resolvable.
const remoteMatch = AGAINST.match(/^origin\/(.+)$/);
if (remoteMatch) {
	console.error(`Fetching ${AGAINST}…`);
	sh(`git fetch origin "${remoteMatch[1]}" --quiet`, { cwd: repoRoot });
}

let baseRef;
try {
	baseRef = sh(`git rev-parse --verify "${AGAINST}^{commit}"`, {
		cwd: repoRoot,
	});
} catch {
	console.error(
		`Could not resolve --against "${AGAINST}". Pass a ref that \`git rev-parse\` understands (e.g. origin/main, HEAD~1, a sha, a branch name, a tag).`,
	);
	process.exit(1);
}

const branchRef = sh("git rev-parse HEAD", { cwd: repoRoot });
const mergeBase = sh(`git merge-base "${AGAINST}" HEAD`, { cwd: repoRoot });

if (branchRef === baseRef) {
	console.error(
		`HEAD is already at ${AGAINST} (${baseRef.slice(0, 8)}); nothing to compare.`,
	);
	process.exit(0);
}

// ----- worktree -----
// One shared worktree per repo, reset to the requested ref each run.
// The directory name is intentionally ref-agnostic (`-vrt-base`) so a
// user switching between `--against origin/main` and `--against HEAD~1`
// doesn't accumulate multiple worktrees on disk.
const worktreePath = resolve(repoRoot, "..", `${repoName}-vrt-base`);
if (!existsSync(worktreePath)) {
	console.error(`Creating worktree at ${worktreePath}…`);
	sh(`git worktree add --detach "${worktreePath}" "${AGAINST}"`, {
		cwd: repoRoot,
	});
} else {
	console.error(`Updating existing worktree at ${worktreePath} → ${AGAINST}…`);
	sh(`git -C "${worktreePath}" reset --hard "${baseRef}"`, { cwd: repoRoot });
}

// ----- install deps if needed -----
function ensureDeps(dir) {
	if (existsSync(join(dir, "node_modules"))) return;
	console.error(`Installing dependencies in ${dir} (one-time, may take ~1 minute)…`);
	// Prefer `npm ci` — uses the lockfile exactly, sidesteps peer-dep
	// resolution. If the project lacks a lockfile or has a peer-dep
	// conflict that even ci can't paper over, fall back to `npm install
	// --legacy-peer-deps` which mirrors what npm does when peers don't
	// quite align (a real-world thing in larger projects).
	const ciCmd = "npm ci --prefer-offline --no-audit --no-fund";
	const fallbackCmd =
		"npm install --legacy-peer-deps --prefer-offline --no-audit --no-fund";
	try {
		execSync(ciCmd, { cwd: dir, stdio: "inherit" });
	} catch {
		console.error(
			"`npm ci` failed; retrying with `npm install --legacy-peer-deps`…",
		);
		execSync(fallbackCmd, { cwd: dir, stdio: "inherit" });
	}
}
ensureDeps(repoRoot);
ensureDeps(worktreePath);

// ----- storybook spawn -----
function storybookBin(cwd) {
	const local = join(cwd, "node_modules", ".bin", "storybook");
	if (!existsSync(local)) {
		throw new Error(`storybook binary not found at ${local}; run npm install in ${cwd}`);
	}
	return local;
}

function spawnStorybook(cwd, port, label) {
	const bin = storybookBin(cwd);
	const proc = spawn(bin, ["dev", "-p", String(port), "--ci", "--no-open"], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NODE_ENV: "development", BROWSER: "none" },
	});
	const tag = `[sb:${label}]`;
	proc.stdout.on("data", (b) => process.stderr.write(`${tag} ${b}`));
	proc.stderr.on("data", (b) => process.stderr.write(`${tag} ${b}`));
	proc.on("exit", (code) => {
		if (code !== 0 && code !== null) {
			process.stderr.write(`${tag} exited with code ${code}\n`);
		}
	});
	return proc;
}

async function waitForStorybook(port, timeoutMs = 240_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/index.json`);
			if (r.ok) return await r.json();
		} catch {
			// not yet
		}
		await sleep(500);
	}
	throw new Error(`storybook on port ${port} not ready within ${timeoutMs}ms`);
}

console.error(
	`Starting storybooks (base "${AGAINST}" on :${BASE_PORT}, branch on :${BRANCH_PORT})…`,
);
const sbBase = spawnStorybook(worktreePath, BASE_PORT, "base");
const sbBranch = spawnStorybook(repoRoot, BRANCH_PORT, "branch");

let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const p of [sbBase, sbBranch]) {
		try {
			p.kill("SIGTERM");
		} catch {
			// ignore
		}
	}
}
process.on("SIGINT", () => {
	cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
	cleanup().finally(() => process.exit(143));
});

try {
	console.error("Waiting for both storybooks to be ready…");
	const [, branchIndex] = await Promise.all([
		waitForStorybook(BASE_PORT),
		waitForStorybook(BRANCH_PORT),
	]);

	// ----- enumerate stories (use branch index as source of truth — new stories are
	// what the user wants to see; deleted ones can't be screenshotted on the branch
	// anyway). -----
	const allEntries = Object.values(branchIndex.entries).filter(
		(e) => e.type === "story",
	);
	console.error(`Total stories on working branch: ${allEntries.length}`);

	// ----- changed-files filter -----
	let stories;
	if (CHANGED_ONLY) {
		const changed = sh(`git diff --name-only ${mergeBase}...HEAD`, {
			cwd: repoRoot,
		})
			.split("\n")
			.filter(Boolean);
		console.error(`Changed files since merge-base: ${changed.length}`);

		stories = allEntries.filter((entry) => {
			const importPath = entry.importPath.replace(/^\.\//, "");
			const storyDir = dirname(importPath);
			return changed.some(
				(f) => f === importPath || f.startsWith(`${storyDir}/`),
			);
		});
		console.error(
			`Stories whose source dir contains changed files: ${stories.length}`,
		);
	} else {
		stories = allEntries;
	}

	if (LIMIT > 0 && stories.length > LIMIT) {
		stories = stories.slice(0, LIMIT);
		console.error(`Capped to --limit ${LIMIT}.`);
	}

	if (stories.length === 0) {
		console.error(
			"No stories matched. Use --all to compare every story regardless of file changes.",
		);
		await cleanup();
		console.log(JSON.stringify({ storyCount: 0, manifestPath: null, outDir: null }));
		process.exit(0);
	}

	// ----- output dir -----
	const runId = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace(/Z$/, "");
	// Write into the working repo (not /tmp) so the agent's later Read
	// calls land on cwd-relative paths — those are auto-allowed under
	// Claude Code's default permission model. /tmp paths trigger a
	// permission prompt for every Read and the report becomes painful
	// to use.
	const vrtDir = join(repoRoot, ".vrt");
	const outDir = join(vrtDir, runId);
	mkdirSync(join(outDir, "stories"), { recursive: true });
	console.error(`Output directory: ${outDir}`);

	// Add `.vrt/` to .gitignore on first run so the artifacts don't
	// accidentally land in commits. Idempotent — append only if absent.
	const gitignorePath = join(repoRoot, ".gitignore");
	const gitignoreEntry = ".vrt/";
	let gitignoreContents = "";
	try {
		gitignoreContents = readFileSync(gitignorePath, "utf8");
	} catch {
		// no .gitignore yet — we'll create one
	}
	const hasEntry = gitignoreContents
		.split(/\r?\n/)
		.some((line) => line.trim() === gitignoreEntry);
	if (!hasEntry) {
		const sep = gitignoreContents && !gitignoreContents.endsWith("\n") ? "\n" : "";
		writeFileSync(
			gitignorePath,
			`${gitignoreContents}${sep}${gitignoreEntry}\n`,
		);
		console.error(`Added \`${gitignoreEntry}\` to .gitignore.`);
	}

	// ----- screenshot loop -----
	const browser = await chromium.launch();
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		reducedMotion: "reduce",
		deviceScaleFactor: 1,
	});

	async function screenshotStory(port, storyId, outPath) {
		const page = await context.newPage();
		try {
			const url = `http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(
				storyId,
			)}&viewMode=story`;
			await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
			// Belt-and-suspenders: networkidle isn't always enough.
			await page.evaluate(() =>
				document.fonts ? document.fonts.ready : Promise.resolve(),
			);
			await sleep(300);
			await page.screenshot({ path: outPath, fullPage: false });
		} finally {
			await page.close();
		}
	}

	const manifest = {
		runId,
		repo: repoRoot,
		// Symbolic ref the user passed (display label).
		against: AGAINST,
		// Resolved sha for the comparison base.
		baseRef,
		branchRef,
		mergeBase,
		generatedAt: new Date().toISOString(),
		stories: [],
	};

	for (const [i, entry] of stories.entries()) {
		const safeId = entry.id.replace(/[^a-z0-9-]/gi, "_");
		const storyDir = join(outDir, "stories", safeId);
		mkdirSync(storyDir, { recursive: true });

		const basePath = join(storyDir, "base.png");
		const branchPath = join(storyDir, "branch.png");
		const compositePath = join(storyDir, "composite.png");
		const diffPath = join(storyDir, "diff.png");

		process.stderr.write(
			`[${i + 1}/${stories.length}] ${entry.title} :: ${entry.name}… `,
		);

		try {
			await screenshotStory(BASE_PORT, entry.id, basePath);
			await screenshotStory(BRANCH_PORT, entry.id, branchPath);

			// Composite: side-by-side, base left | branch right, 4px black gutter.
			const [baseMeta, branchMeta] = await Promise.all([
				sharp(basePath).metadata(),
				sharp(branchPath).metadata(),
			]);
			const w = Math.max(baseMeta.width || 0, branchMeta.width || 0);
			const h = Math.max(baseMeta.height || 0, branchMeta.height || 0);

			await sharp({
				create: {
					width: w * 2 + 4,
					height: h,
					channels: 3,
					background: { r: 0, g: 0, b: 0 },
				},
			})
				.composite([
					{ input: basePath, left: 0, top: 0 },
					{ input: branchPath, left: w + 4, top: 0 },
				])
				.png()
				.toFile(compositePath);

			// Pixel diff. Crop to common dimensions if they differ.
			const png1 = PNG.sync.read(readFileSync(basePath));
			const png2 = PNG.sync.read(readFileSync(branchPath));
			let pixelDiffPercent = null;
			if (png1.width === png2.width && png1.height === png2.height) {
				const diff = new PNG({ width: png1.width, height: png1.height });
				const numDiff = pixelmatch(
					png1.data,
					png2.data,
					diff.data,
					png1.width,
					png1.height,
					{ threshold: 0.1, includeAA: false, alpha: 0.3 },
				);
				writeFileSync(diffPath, PNG.sync.write(diff));
				pixelDiffPercent = (numDiff / (png1.width * png1.height)) * 100;
			} else {
				// Mismatched dimensions — meaningful change; record without diff overlay.
				pixelDiffPercent = null;
			}

			manifest.stories.push({
				id: entry.id,
				title: entry.title,
				name: entry.name,
				importPath: entry.importPath,
				files: {
					base: basePath,
					branch: branchPath,
					composite: compositePath,
					diff: pixelDiffPercent === null ? null : diffPath,
				},
				dimensions: {
					base: { w: baseMeta.width, h: baseMeta.height },
					branch: { w: branchMeta.width, h: branchMeta.height },
				},
				pixelDiffPercent,
			});
			process.stderr.write(
				`ok${pixelDiffPercent === null ? " (size mismatch)" : ` (${pixelDiffPercent.toFixed(2)}% px diff)`}\n`,
			);
		} catch (err) {
			manifest.stories.push({
				id: entry.id,
				title: entry.title,
				name: entry.name,
				importPath: entry.importPath,
				error: err instanceof Error ? err.message : String(err),
			});
			process.stderr.write(`error: ${err.message}\n`);
		}
	}

	await browser.close();

	const manifestPath = join(outDir, "manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

	// Self-contained HTML index so the user can browse composites in a
	// browser without spinning up a server. Single file, no external CSS
	// or JS, references the per-story PNGs via relative paths.
	const indexPath = join(outDir, "index.html");
	writeFileSync(indexPath, renderIndexHtml(manifest, outDir));

	// Final handoff line for the agent.
	console.log(
		JSON.stringify({
			manifestPath,
			indexPath,
			indexUrl: `file://${indexPath}`,
			outDir,
			storyCount: stories.length,
			erroredCount: manifest.stories.filter((s) => s.error).length,
		}),
	);
} finally {
	await cleanup();
}
