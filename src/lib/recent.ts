/**
 * Which sessions were opened last, kept in ``localStorage`` so the homepage can
 * list them by "last opened" instead of "last created".
 */

const KEY = 'catchycatcher.recent-sessions';

function read(): Record<string, number> {
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as Record<string, number>) : {};
	} catch {
		return {};
	}
}

/** Record that a session was just opened. */
export function markSessionOpened(id: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		const map = read();
		map[id] = Date.now();
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* storage unavailable; ordering just falls back to id */
	}
}

/** A map of session id → when it was last opened (ms). */
export function recentSessions(): Record<string, number> {
	return read();
}
