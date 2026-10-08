import { posix } from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import { run, shellQuote } from "./exec.ts";
import type { Target } from "./target.ts";

const DEFAULT_LIMIT = 100;
const NO_RG = 90;
const NOT_FOUND = 91;

export type GrepParams = {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

/** Runs rg in the environment and formats its matches like Pi's grep tool. */
export async function grep(target: Target, searchPath: string, params: GrepParams, signal?: AbortSignal) {
	const context = params.context && params.context > 0 ? params.context : 0;
	const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	if (context) args.push("--context", String(context));
	args.push("--", params.pattern, searchPath);

	const quoted = shellQuote(searchPath);
	const script =
		`command -v rg >/dev/null 2>&1 || exit ${NO_RG}; ` +
		`if [ -d ${quoted} ]; then echo d; elif [ -e ${quoted} ]; then echo f; else exit ${NOT_FOUND}; fi; ` +
		`exec rg ${args.map(shellQuote).join(" ")}`;

	let isDirectory = false;
	let header = true;
	let rest = "";
	let stderr = "";
	let matchCount = 0;
	let lastMatch: { path: string; line: number } | undefined;
	let limitReached = false;
	let linesTruncated = false;
	const lines: string[] = [];
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	const formatPath = (file: string) => {
		if (isDirectory) {
			const relative = posix.relative(searchPath, file);
			if (relative && !relative.startsWith("..")) return relative;
		}
		return posix.basename(file);
	};
	const push = (file: string, line: number, text: string, match: boolean) => {
		const { text: truncated, wasTruncated } = truncateLine(text.replace(/\r?\n$/, "").replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		lines.push(match ? `${formatPath(file)}:${line}: ${truncated}` : `${formatPath(file)}-${line}- ${truncated}`);
	};
	const onLine = (line: string) => {
		if (header) {
			header = false;
			isDirectory = line === "d";
			return;
		}
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const file = event.data?.path?.text;
		const number = event.data?.line_number;
		const text = event.data?.lines?.text;
		const isLine = (event.type === "match" || event.type === "context") && file && typeof number === "number" && typeof text === "string";
		if (limitReached) {
			// After the last match, keep its trailing context only.
			if (isLine && event.type === "context" && file === lastMatch!.path && number <= lastMatch!.line + context) push(file, number, text, false);
			else stop.abort();
			return;
		}
		if (!isLine) return;
		push(file, number, text, event.type === "match");
		if (event.type !== "match") return;
		matchCount++;
		lastMatch = { path: file, line: number };
		if (matchCount >= limit) {
			limitReached = true;
			if (!context) stop.abort();
		}
	};

	let code: number | null;
	try {
		code = await run(target, script, {
			signal: stop.signal,
			onStdout: (data) => {
				const items = (rest + data.toString()).split("\n");
				rest = items.pop()!;
				for (const item of items) if (!stop.signal.aborted) onLine(item);
			},
			onStderr: (data) => {
				stderr += data.toString();
			},
		});
		if (rest) onLine(rest);
	} catch (error) {
		if (signal?.aborted || !limitReached) throw signal?.aborted ? new Error("Operation aborted") : error;
		code = 0;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	if (code === NO_RG) throw new Error("rg is not available in the execution environment. Use bash to search.");
	if (code === NOT_FOUND) throw new Error(`Path not found: ${searchPath}`);
	if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
	if (matchCount === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

	const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (limitReached) {
		notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
		details.matchLimitReached = limit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push("Some lines truncated. Use read tool to see full lines");
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}
