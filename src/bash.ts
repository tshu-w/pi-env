import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { exec, run, shellQuote } from "./exec.ts";
import { formatTarget, type Target } from "./target.ts";

const TERMINATION_GRACE_SECONDS = 0.25;
const PID_WAIT_MS = 5000;

/** Process groups of commands started in each environment. */
export class ProcessGroups {
	private groups = new Map<string, { target: Target; pids: Set<number> }>();

	add(target: Target, pid: number) {
		const key = formatTarget(target);
		const entry = this.groups.get(key) ?? { target, pids: new Set() };
		entry.pids.add(pid);
		this.groups.set(key, entry);
	}

	/** Stops the commands started in `target`, or in every environment. */
	async stop(target?: Target) {
		const entries = [...this.groups.values()].filter((entry) => !target || formatTarget(entry.target) === formatTarget(target));
		await Promise.allSettled(entries.map(async (entry) => {
			this.groups.delete(formatTarget(entry.target));
			await killGroups(entry.target, [...entry.pids]);
		}));
	}
}

function killGroups(target: Target, pids: number[]): Promise<unknown> {
	const groups = pids.map((pid) => `-${pid}`).join(" ");
	const script = `kill -TERM ${groups} 2>/dev/null; sleep ${TERMINATION_GRACE_SECONDS}; kill -KILL ${groups} 2>/dev/null; true`;
	return run(target, script, { timeoutMs: 10_000 }).catch(() => {});
}

/**
 * Bash operations in the environment. The command runs in its own process group, which a timeout
 * or abort kills. The call ends when the command's shell exits, even if background processes keep
 * its output open.
 */
export function createBashOperations(getTarget: () => Target, groups: ProcessGroups): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			const target = getTarget();
			const token = `__pi_env_exit_${randomBytes(8).toString("hex")}__`;
			const exports = Object.entries(env ?? {})
				.filter(([name, value]) => name.startsWith("PI_") && value !== undefined)
				.map(([name, value]) => `export ${name}=${shellQuote(value!)}\n`)
				.join("");
			const script =
				`cd ${shellQuote(cwd)} 2>/dev/null || { printf 'nocwd\\n' >&2; exit 1; }\n` +
				exports +
				`if command -v bash >/dev/null 2>&1; then shell=bash; else shell=sh; fi\n` +
				// macOS has no setsid; perl starts the process group there.
				`if command -v setsid >/dev/null 2>&1; then group=setsid; else group='perl -e setpgrp;exec@ARGV'; fi\n` +
				`$group "$shell" -c ${shellQuote(command)} </dev/null 2>&1 &\n` +
				`pid=$!\nprintf 'pid %s\\n' "$pid" >&2\nwait "$pid"\nprintf '%s %s\\n' ${token} "$?"\n`;

			return new Promise((resolve, reject) => {
				const client = new AbortController();
				let pending = Buffer.alloc(0);
				let stderr = "";
				let pid: number | undefined;
				let onPid: (() => void) | undefined;
				let settled = false;
				let timer: NodeJS.Timeout | undefined;

				const finish = (error: Error | undefined, exitCode?: number) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve({ exitCode: exitCode ?? null });
				};
				const stop = (error: Error) => {
					if (settled) return;
					finish(error);
					void (async () => {
						if (pid === undefined) {
							await new Promise<void>((done) => {
								onPid = done;
								setTimeout(done, PID_WAIT_MS);
							});
						}
						if (pid !== undefined) await killGroups(target, [pid]);
						client.abort();
					})();
				};
				const onAbort = () => stop(new Error("aborted"));

				const onStdout = (data: Buffer) => {
					if (settled) return;
					pending = Buffer.concat([pending, data]);
					const index = pending.indexOf(token);
					if (index === -1) {
						const keep = Math.min(pending.length, token.length + 1);
						if (pending.length > keep) onData(pending.subarray(0, pending.length - keep));
						pending = pending.subarray(pending.length - keep);
						return;
					}
					const status = pending.subarray(index + token.length).toString().match(/^ (\d+)\n/);
					if (!status) return;
					if (index > 0) onData(pending.subarray(0, index));
					finish(undefined, Number(status[1]));
					client.abort();
				};
				const onStderr = (data: Buffer) => {
					stderr += data.toString();
					const match = stderr.match(/^pid (\d+)\n/m);
					if (pid === undefined && match) {
						pid = Number(match[1]);
						groups.add(target, pid);
						onPid?.();
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) return onAbort();
				if (timeout !== undefined) timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);

				run(target, script, { signal: client.signal, onStdout, onStderr }).then(
					(code) => {
						if (settled) return;
						if (stderr.startsWith("nocwd\n")) return finish(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
						if (pending.length > 0) onData(pending);
						const message = stderr.replace(/^pid \d+\n/m, "").trim();
						finish(new Error(message || `${target.backend} exited with code ${code}`));
					},
					(error) => finish(error),
				);
			});
		},
	};
}

type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: any;
	structuredContent?: any;
};

/** Moves a full output file that Pi saved locally into the environment. */
async function upload(target: Target, localPath: string): Promise<string> {
	const content = await readFile(localPath);
	const script = `f=$(mktemp "\${TMPDIR:-/tmp}/pi-bash-XXXXXX") && cat > "$f" && printf %s "$f"`;
	const remotePath = (await exec(target, script, { input: content })).toString();
	await rm(localPath, { force: true });
	return remotePath;
}

/** Saves a bash result's full output in the environment and points the result at it. */
export async function relocateResult<T extends ToolResult>(target: Target, result: T): Promise<T> {
	const localPath: string | undefined = result.details?.fullOutputPath;
	if (!localPath) return result;
	const remotePath = await upload(target, localPath);
	for (const block of result.content) {
		if (block.type === "text" && block.text) block.text = block.text.replaceAll(localPath, remotePath);
	}
	result.details.fullOutputPath = remotePath;
	if (result.structuredContent?.full_output_path) result.structuredContent.full_output_path = remotePath;
	return result;
}

/** Same as relocateResult, for a failed command whose error names the full output. */
export async function relocateError(target: Target, error: unknown): Promise<unknown> {
	if (!(error instanceof Error)) return error;
	const localPath = error.message.match(/Full output: (.+?)\]/)?.[1];
	if (!localPath) return error;
	const remotePath = await upload(target, localPath);
	return new Error(error.message.replaceAll(localPath, remotePath));
}
