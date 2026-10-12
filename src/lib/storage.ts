/**
 * Remember the API url the user last connected with, so a refresh — or a visit
 * tomorrow — can skip the share-code form.
 *
 * Every `localStorage` access is guarded: private browsing, a disabled store or
 * a corrupt entry must never break the app, they just mean "nothing saved".
 */

/** Which query parameter the saved value maps back to. */
export type ConnectionKind = 'share_code' | 'url';

export type SavedConnection = {
	kind: ConnectionKind;
	value: string;
	/** Epoch milliseconds, so the UI can show how stale the connection is. */
	savedAt: number;
};

const STORAGE_KEY = 'catchycatcher.connection';

function store(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		// Access itself can throw when storage is blocked by the browser.
		return null;
	}
}

/** Read the saved connection, or `null` when there isn't a usable one. */
export function loadSavedConnection(): SavedConnection | null {
	const raw = readRaw();
	if (!raw) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSavedConnection(parsed)) return parsed;
	} catch {
		// Fall through and clear the corrupt entry.
	}

	clearSavedConnection();
	return null;
}

function readRaw(): string | null {
	try {
		return store()?.getItem(STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
}

/** Persist a connection and return the record that was stored. */
export function saveConnection(kind: ConnectionKind, value: string): SavedConnection {
	const saved: SavedConnection = { kind, value, savedAt: Date.now() };
	try {
		store()?.setItem(STORAGE_KEY, JSON.stringify(saved));
	} catch {
		// Storage full or unavailable — the connection still works for this session.
	}
	return saved;
}

/** Forget the saved connection (the "Disconnect" action). */
export function clearSavedConnection(): void {
	try {
		store()?.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to do.
	}
}

function isSavedConnection(value: unknown): value is SavedConnection {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.kind === 'share_code' || record.kind === 'url') &&
		typeof record.value === 'string' &&
		record.value.trim().length > 0
	);
}
