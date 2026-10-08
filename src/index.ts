import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createBashOperations, ProcessGroups, relocateError, relocateResult } from "./bash.ts";
import { loadContextFiles } from "./context.ts";
import { exec, shellQuote } from "./exec.ts";
import { createEditOperations, createFindOperations, createLsOperations, createReadOperations, createWriteOperations } from "./files.ts";
import { grep } from "./grep.ts";
import {
	type Environment,
	expandHome,
	formatAddress,
	formatEnvironment,
	formatTarget,
	parseEnvironment,
	sameTarget,
	USAGE,
} from "./target.ts";

const ENTRY_TYPE = "env-state";
const ENV_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

type PersistedState = { environment: string; home: string } | { environment: null };

type SessionEntry = { type: string; customType?: string; data?: unknown };

/** Starts an environment from its spec: the path must exist; without one, the user's home. */
async function resolveEnvironment(spec: string): Promise<Environment> {
	const { target, path: cwd } = parseEnvironment(spec);
	const script = `${cwd ? `cd ${shellQuote(cwd)}` : "cd"} && printf '%s\\n%s' "$HOME" "$(pwd)"`;
	// Bounded probe: an unreachable environment must not hang /env or session start.
	const [home, resolved] = (await exec(target, script, { timeoutMs: 15_000 })).toString().split("\n");
	return { target, cwd: resolved, home };
}

function serialize(env: Environment | null): PersistedState {
	return env ? { environment: formatEnvironment(env), home: env.home } : { environment: null };
}

function deserialize(data: unknown): Environment | null {
	const record = data as Partial<{ environment: string | null; home: string }> | undefined;
	if (!record?.environment || typeof record.home !== "string") return null;
	try {
		const { target, path: cwd } = parseEnvironment(record.environment);
		return cwd ? { target, cwd, home: record.home } : null;
	} catch {
		return null;
	}
}

function findPersisted(entries: SessionEntry[]): { found: boolean; env: Environment | null } {
	const entry = entries.filter((item) => item.type === "custom" && item.customType === ENTRY_TYPE).pop();
	return entry ? { found: true, env: deserialize(entry.data) } : { found: false, env: null };
}

function sshHosts(): string[] {
	try {
		const content = fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf-8");
		const hosts = new Set<string>();
		for (const line of content.split(/\r?\n/)) {
			const match = line.trim().match(/^Host\s+(.+)$/i);
			if (!match) continue;
			for (const host of match[1].split(/\s+/)) if (host && !/[*?!]/.test(host)) hosts.add(host);
		}
		return [...hosts].sort();
	} catch {
		return [];
	}
}

function runningContainers(): string[] {
	try {
		return execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
			.split("\n")
			.filter(Boolean)
			.sort();
	} catch {
		return [];
	}
}

/** `a, b, and c` */
function formatList(items: string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("env", { description: `Execution environment: ${USAGE}`, type: "string" });

	const initialCwd = process.cwd();
	const groups = new ProcessGroups();
	let active: Environment | null = null;

	const requireActive = () => {
		if (!active) throw new Error("No execution environment is active");
		return active;
	};
	const toolList = () => formatList([...ENV_TOOLS.filter((name) => pi.getActiveTools().includes(name)), "user ! commands"]);

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!active) return ctx.ui.setStatus("env", undefined);
		const label = active.target.backend === "ssh" ? "SSH" : "Docker";
		ctx.ui.setStatus("env", ctx.ui.theme.fg("accent", `${label}: ${formatAddress(active.target)}:${active.cwd}`));
	};

	/** Switches the environment and stops the commands started in the one left. */
	const setActive = (next: Environment | null, ctx: ExtensionContext) => {
		const previous = active;
		active = next;
		if (previous && !sameTarget(previous.target, next?.target)) void groups.stop(previous.target);
		updateStatus(ctx);
	};

	const persist = (ctx: ExtensionContext) => {
		const current = findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]);
		const same = current.found && JSON.stringify(serialize(current.env)) === JSON.stringify(serialize(active));
		if (!same) pi.appendEntry(ENTRY_TYPE, serialize(active));
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	const announceEnabled = (ctx: ExtensionContext) => {
		const env = requireActive();
		notify(ctx, `Execution environment enabled: ${formatEnvironment(env)} (disable: /env off)`);
	};

	const restore = (ctx: ExtensionContext) => {
		setActive(findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]).env, ctx);
	};

	const base = {
		read: createReadToolDefinition(initialCwd),
		write: createWriteToolDefinition(initialCwd),
		edit: createEditToolDefinition(initialCwd),
		bash: createBashToolDefinition(initialCwd),
		grep: createGrepToolDefinition(initialCwd),
		find: createFindToolDefinition(initialCwd),
		ls: createLsToolDefinition(initialCwd),
	};

	const withPath = <T extends { path?: string }>(params: T, env: Environment): T =>
		params.path === undefined ? params : { ...params, path: expandHome(params.path, env.home) };

	pi.registerTool({
		...base.read,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createReadToolDefinition(env.cwd, { operations: createReadOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.write,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createWriteToolDefinition(env.cwd, { operations: createWriteOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.edit,
		renderShell: "self",
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createEditToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createEditToolDefinition(env.cwd, { operations: createEditOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.bash,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createBashToolDefinition(env.cwd, { operations: createBashOperations(() => env.target, groups) });
			try {
				return await relocateResult(env.target, await tool.execute(id, params, signal, onUpdate, { ...ctx, cwd: env.cwd }));
			} catch (error) {
				throw await relocateError(env.target, error);
			}
		},
	});

	pi.registerTool({
		...base.grep,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createGrepToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const searchPath = path.posix.resolve(env.cwd, expandHome(params.path || ".", env.home));
			return grep(env.target, searchPath, params, signal);
		},
	});

	pi.registerTool({
		...base.find,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createFindToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createFindToolDefinition(env.cwd, { operations: createFindOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.ls,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = active;
			if (!env) return createLsToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createLsToolDefinition(env.cwd, { operations: createLsOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerCommand("env", {
		description: "Show or switch the execution environment. Use `/env off` to return to local execution.",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [{ value: "off", label: "off", description: "Return to local execution" }];
			if (active) items.push({ value: formatEnvironment(active), label: formatTarget(active.target), description: `Current environment (${active.cwd})` });
			for (const name of runningContainers()) items.push({ value: `docker:${name}`, label: `docker:${name}`, description: "Running container" });
			for (const host of sshHosts()) items.push({ value: `ssh:${host}`, label: `ssh:${host}`, description: "Host from ~/.ssh/config" });
			const trimmed = prefix.trim();
			const unique = items.filter((item, index) => items.findIndex((other) => other.value === item.value) === index);
			const filtered = unique.filter((item) => !trimmed || item.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const spec = args?.trim() ?? "";
			if (!spec) {
				notify(ctx, active
					? `Execution environment: ${formatEnvironment(active)} (disable: /env off)`
					: "Execution environment: off. Enable with /env docker:container:/path or /env ssh:host:/path.");
				return;
			}
			if (spec === "off") {
				if (!active) return;
				const tools = toolList();
				setActive(null, ctx);
				persist(ctx);
				notify(ctx, "Execution environment disabled.");
				pi.sendMessage({
					customType: "env-state-change",
					content: `Execution environment disabled. ${tools} now execute locally.`,
					display: false,
				}, { triggerTurn: false });
				return;
			}
			try {
				setActive(await resolveEnvironment(spec), ctx);
			} catch (error) {
				notify(ctx, `Failed to enable execution environment: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			persist(ctx);
			announceEnabled(ctx);
			pi.sendMessage({
				customType: "env-state-change",
				content: `Execution environment enabled: ${formatEnvironment(requireActive())}\n${toolList()} now execute in this environment.\nTo return them to local execution, run /env off.`,
				display: false,
			}, { triggerTurn: false });
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const flag = pi.getFlag("env");
		const persisted = findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (typeof flag === "string" && flag.trim() && (event.reason === "startup" || event.reason === "new" || !persisted.found)) {
			try {
				setActive(await resolveEnvironment(flag), ctx);
				persist(ctx);
				if (event.reason === "startup") announceEnabled(ctx);
				return;
			} catch (error) {
				notify(ctx, `Failed to initialize execution environment from --env: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("session_shutdown", async () => {
		active = null;
		await groups.stop();
	});

	pi.on("user_bash", () => {
		const env = active;
		if (!env) return;
		const ops = createBashOperations(() => env.target, groups);
		return { operations: { exec: (command, _cwd, options) => ops.exec(command, env.cwd, options) } };
	});

	pi.on("before_agent_start", async (event) => {
		const env = active;
		if (!env) return;
		const options = event.systemPromptOptions;
		options.cwd = env.cwd;
		options.sections.env = `Execution environment: ${formatTarget(env.target)}. ${toolList()} execute there; other tools run locally.`;
		// Keep the global context file; project ones come from the environment.
		const agentDir = path.resolve(getAgentDir());
		const global = options.contextFiles.filter((file) => path.dirname(file.path) === agentDir);
		const project = await loadContextFiles(env.target, env.cwd).catch(() => []);
		options.contextFiles = [...global, ...project];
	});
}
