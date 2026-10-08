import { exec, shellQuote } from "./exec.ts";
import type { Target } from "./target.ts";

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** Project context files in `cwd` and its parents, outermost first, as Pi loads them locally. */
export async function loadContextFiles(target: Target, cwd: string): Promise<Array<{ path: string; content: string }>> {
	const script =
		`d=${shellQuote(cwd)}; while :; do ` +
		`for n in ${CANDIDATES.join(" ")}; do f="\${d%/}/$n"; ` +
		`if [ -f "$f" ] && [ -r "$f" ]; then printf '%s\\0' "$f"; cat -- "$f"; printf '\\0'; break; fi; done; ` +
		`[ "$d" = / ] && break; d=$(dirname -- "$d"); done`;
	const parts = (await exec(target, script, { timeoutMs: 15_000 })).toString().split("\0");
	const files: Array<{ path: string; content: string }> = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		files.unshift({ path: parts[i], content: parts[i + 1].replace(/^\uFEFF/, "") });
	}
	return files;
}
