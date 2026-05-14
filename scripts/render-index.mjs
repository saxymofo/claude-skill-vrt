/**
 * Generate a self-contained HTML index for a VRT run.
 *
 * Imported by `vrt.mjs` at the end of a run. Also usable standalone
 * to regenerate `index.html` from an existing `manifest.json`:
 *
 *   node scripts/render-index.mjs /tmp/vrt-<run>/manifest.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function escape(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function rel(outDir, p) {
	return p ? p.replace(`${outDir}/`, "") : null;
}

export function renderIndexHtml(manifest, outDir) {
	// Sort by pixel-diff descending so the most-changed stories surface
	// first. Errored stories sink to the bottom.
	const sorted = [...manifest.stories].sort((a, b) => {
		if (a.error && !b.error) return 1;
		if (b.error && !a.error) return -1;
		return (b.pixelDiffPercent ?? 0) - (a.pixelDiffPercent ?? 0);
	});

	const groups = new Map();
	for (const s of sorted) {
		if (!groups.has(s.title)) groups.set(s.title, []);
		groups.get(s.title).push(s);
	}

	const toc = [...groups.keys()]
		.map((t) => {
			const anchor = t.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
			return `<li><a href="#group-${anchor}">${escape(t)}</a> <span class="muted">(${groups.get(t).length})</span></li>`;
		})
		.join("");

	const sections = [...groups.entries()]
		.map(([title, stories]) => {
			const anchor = title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
			const cards = stories
				.map((s) => {
					const storyAnchor = s.id.replace(/[^a-z0-9-]/gi, "_");
					if (s.error) {
						return `
		<section class="card error" id="story-${storyAnchor}">
			<header>
				<h3>${escape(s.name)}</h3>
				<span class="badge-error">errored</span>
			</header>
			<pre>${escape(s.error)}</pre>
		</section>`;
					}
					const pct = s.pixelDiffPercent;
					const pctLabel =
						pct === null ? "size mismatch" : `${pct.toFixed(2)}% px diff`;
					const pctClass =
						pct === null
							? "badge-warn"
							: pct >= 1
								? "badge-warn"
								: pct >= 0.1
									? "badge"
									: "badge-quiet";
					return `
		<section class="card" id="story-${storyAnchor}">
			<header>
				<h3>${escape(s.name)}</h3>
				<span class="${pctClass}">${pctLabel}</span>
			</header>
			<p class="meta">${escape(s.importPath)} · <code>${escape(s.id)}</code></p>
			<figure>
				<figcaption>composite (left = ${escape(manifest.against ?? "base")} · right = working branch)</figcaption>
				<img src="${rel(outDir, s.files.composite)}" loading="lazy" alt="${escape(s.name)} composite">
			</figure>
			${
				s.files.diff
					? `
			<details>
				<summary>pixel-diff overlay</summary>
				<img src="${rel(outDir, s.files.diff)}" loading="lazy" alt="${escape(s.name)} diff overlay">
			</details>`
					: ""
			}
		</section>`;
				})
				.join("");
			return `
	<section class="group" id="group-${anchor}">
		<h2>${escape(title)}</h2>
		${cards}
	</section>`;
		})
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VRT report — ${escape(manifest.repo)} @ ${escape(manifest.branchRef.slice(0, 8))}</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: #fafafa;
		--fg: #18181b;
		--muted: #71717a;
		--card: #fff;
		--border: #e4e4e7;
		--badge: #e4e4e7;
		--badge-warn: #fde68a;
		--badge-error: #fecaca;
		--badge-quiet: #f4f4f5;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #09090b;
			--fg: #fafafa;
			--muted: #a1a1aa;
			--card: #18181b;
			--border: #27272a;
			--badge: #27272a;
			--badge-warn: #78350f;
			--badge-error: #7f1d1d;
			--badge-quiet: #1c1c1f;
		}
	}
	* { box-sizing: border-box; }
	body {
		margin: 0 auto;
		padding: 2rem;
		background: var(--bg);
		color: var(--fg);
		font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
		max-width: 1400px;
	}
	h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
	h2 { font-size: 1.2rem; margin: 2.5rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
	h3 { font-size: 1rem; margin: 0; }
	.summary { color: var(--muted); margin-bottom: 1.5rem; }
	.summary code { font-size: 0.85em; }
	.muted { color: var(--muted); font-weight: normal; }
	.toc { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 1rem 1.5rem; margin-bottom: 2rem; }
	.toc ul { margin: 0; padding-left: 1.2rem; }
	.toc li { margin: 0.25rem 0; }
	.toc a { color: var(--fg); text-decoration: none; }
	.toc a:hover { text-decoration: underline; }
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 1rem;
		margin-bottom: 1rem;
	}
	.card header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
	.card .meta { color: var(--muted); margin: 0 0 0.75rem; font-size: 0.85em; }
	.card .meta code { font-size: 0.95em; }
	.badge, .badge-warn, .badge-error, .badge-quiet {
		display: inline-block;
		font-size: 0.75rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-weight: 500;
		background: var(--badge);
	}
	.badge-warn { background: var(--badge-warn); }
	.badge-error { background: var(--badge-error); }
	.badge-quiet { background: var(--badge-quiet); color: var(--muted); }
	figure { margin: 0; }
	figcaption { color: var(--muted); font-size: 0.8rem; margin-bottom: 0.4rem; }
	img { max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 4px; display: block; background: #fff; }
	details { margin-top: 0.75rem; }
	details summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; padding: 0.25rem 0; }
	details summary:hover { color: var(--fg); }
	details img { margin-top: 0.5rem; max-width: 600px; }
	.error pre { white-space: pre-wrap; color: var(--muted); font-size: 0.85rem; margin: 0; }
</style>
</head>
<body>
	<h1>VRT report</h1>
	<p class="summary">
		<strong>Repo:</strong> <code>${escape(manifest.repo)}</code><br>
		<strong>Working branch:</strong> <code>${escape(manifest.branchRef.slice(0, 12))}</code> ·
		<strong>Comparison base:</strong> <code>${escape((manifest.baseRef ?? manifest.mainRef ?? "").slice(0, 12))}</code> (${escape(manifest.against ?? "origin/main")}, merge-base <code>${escape(manifest.mergeBase.slice(0, 12))}</code>)<br>
		<strong>Stories:</strong> ${manifest.stories.length} ·
		<strong>Generated:</strong> ${escape(manifest.generatedAt)}
	</p>
	<nav class="toc">
		<strong>Components</strong>
		<ul>${toc}</ul>
	</nav>
	${sections}
</body>
</html>`;
}

// Standalone: regenerate from an existing manifest.json.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		console.error("Usage: node render-index.mjs <manifest.json>");
		process.exit(1);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const outDir = dirname(manifestPath);
	const html = renderIndexHtml(manifest, outDir);
	const indexPath = `${outDir}/index.html`;
	writeFileSync(indexPath, html);
	console.log(`file://${indexPath}`);
}
