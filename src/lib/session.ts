/**
 * Session id helpers. Pure string maths, so they live in a plain `.ts` module —
 * `new Date()` is not reactive state and has no business in a `.svelte.ts` file.
 */

/**
 * A readable, collision-resistant id for a new session, e.g.
 * `session-20261012-143207-x4f`. Sorting ids lexically sorts them by creation
 * time, which is what the session list relies on.
 */
export function newSessionId(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = Math.random().toString(36).slice(2, 5);
	return `session-${stamp}-${suffix}`;
}
