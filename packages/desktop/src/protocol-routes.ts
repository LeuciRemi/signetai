export function isDaemonRouteUrl(url: string): boolean {
	const path = new URL(url).pathname;
	return path === "/health" || path.startsWith("/api/") || path.startsWith("/memory/");
}

export function daemonRouteTarget(baseUrl: string, url: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const parsed = new URL(url);
	return `${base}${parsed.pathname}${parsed.search}`;
}
