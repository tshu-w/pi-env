export type Backend = "docker" | "ssh";

export type Target = {
	backend: Backend;
	user?: string;
	/** Container name or SSH host. */
	host: string;
};

export type Environment = {
	target: Target;
	/** Working directory in the environment. */
	cwd: string;
	/** Home directory of the environment user. */
	home: string;
};

export const USAGE = "docker:[user@]container[:/path] or ssh:[user@]host[:/path]";

export function parseEnvironment(spec: string): { target: Target; path?: string } {
	const match = spec.trim().match(/^(docker|ssh):(?:([^@:/]+)@)?([^:@/]+)(?::(.*))?$/);
	if (!match) throw new Error(`Invalid environment: ${spec}. Use ${USAGE}.`);
	const [, backend, user, host, path] = match;
	return { target: { backend: backend as Backend, user, host }, path: path || undefined };
}

export function formatTarget(target: Target): string {
	return `${target.backend}:${formatAddress(target)}`;
}

export function formatEnvironment(env: Environment): string {
	return `${formatTarget(env.target)}:${env.cwd}`;
}

/** `[user@]host`, as the status bar and ssh show it. */
export function formatAddress(target: Target): string {
	return target.user ? `${target.user}@${target.host}` : target.host;
}

export function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
	return !!a && !!b && formatTarget(a) === formatTarget(b);
}

/** Resolves a tool path in the environment: `~` is the environment user's home. */
export function expandHome(path: string, home: string): string {
	const stripped = path.startsWith("@") ? path.slice(1) : path;
	if (stripped === "~") return home;
	if (stripped.startsWith("~/")) return `${home}${stripped.slice(1)}`;
	return path;
}
