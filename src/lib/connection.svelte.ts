/**
 * The app's connection to the processing server.
 *
 * Holds the reactive dashboard state (health, sessions, the session being
 * prepared) and the actions that talk to the API: probe `/health`, list
 * `/sessions`, and create a session folder with `POST /sessions/{id}`.
 *
 * The persisted share code lives in `#lib/storage`; `bootstrap()` is what ties
 * "what the url says" and "what we saved" together on load.
 */
import { api, clearApiUrl, setApiUrl } from './api.svelte.ts';
import { newSessionId } from './session.ts';
import { inputFromParams, toApiUrl, type SearchParamsLike, type ShareInput } from './share.ts';
import {
	clearSavedConnection,
	loadSavedConnection,
	saveConnection,
	type SavedConnection
} from './storage.ts';

/** How long to wait for `/health` before calling the server unreachable. */
const HEALTH_TIMEOUT_MS = 6000;

export type ConnectionStatus = 'idle' | 'checking' | 'online' | 'offline';
export type SessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

export const connection = $state({
	status: 'idle' as ConnectionStatus,
	/** Why an automatic restore failed, shown on the connect screen. */
	notice: null as string | null,
	/** Error from a session action (list/create), shown on the dashboard. */
	error: null as string | null,
	/** Human description of where the current url came from. */
	source: '',
	/** The persisted connection, mirrored here so the UI can offer "try again". */
	saved: null as SavedConnection | null,
	sessions: [] as string[],
	sessionsStatus: 'idle' as SessionsStatus,
	/** The session most recently created, highlighted in the list. */
	activeSession: null as string | null,
	busy: false
});

/**
 * The last url we started connecting to. Not reactive on purpose: it lets
 * `bootstrap()` bail out when a `pushState` re-runs it for a url already in
 * flight, without reading `api.url` inside an effect (which would loop).
 */
let attempted: string | null = null;

// ---------------------------------------------------------------------------
// Low-level API calls
// ---------------------------------------------------------------------------

function base(url: string): string {
	return url.replace(/\/+$/, '');
}

/** True when the server at `url` answers `/health` successfully. */
export async function ping(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${base(url)}/health`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
		});
		return response.ok;
	} catch {
		// Unreachable, offline, CORS-blocked or timed out — all "not reachable".
		return false;
	}
}

/** Every session id stored on the server. */
export async function listSessions(url: string): Promise<string[]> {
	const response = await fetch(`${base(url)}/sessions`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when listing sessions.`);
	}

	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.sessions)) return [];
	return body.sessions.filter((id): id is string => typeof id === 'string');
}

/** Create an empty session folder, ready for the first take. */
export async function createSession(url: string, sessionId: string): Promise<void> {
	const response = await fetch(`${base(url)}/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'POST',
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when creating the session.`);
	}
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export type EstablishResult = { ok: true } | { ok: false; message: string };

type EstablishOptions = { source?: string; persist?: boolean };

/**
 * Point the app at a parsed input and check it is reachable. Only a reachable
 * server becomes the current one; on success the input is saved for next time.
 */
export async function establish(
	input: ShareInput,
	{ source = 'your share code', persist = true }: EstablishOptions = {}
): Promise<EstablishResult> {
	const url = toApiUrl(input);
	attempted = url;
	clearApiUrl();
	connection.status = 'checking';
	connection.error = null;
	connection.notice = null;

	if (!(await ping(url))) {
		connection.status = 'offline';
		return { ok: false, message: `Couldn't reach the server at ${url}.` };
	}

	setApiUrl(url);
	connection.source = source;
	connection.status = 'online';

	if (persist) {
		const isUrl = input.kind === 'url';
		connection.saved = saveConnection(isUrl ? 'url' : 'share_code', isUrl ? input.url : input.code);
	}

	void refreshSessions();
	return { ok: true };
}

/**
 * Decide what to do on load (and on back/forward). Reads no reactive state, so
 * it is safe to call from an `$effect` that depends only on `page.url`.
 */
export function bootstrap(params: SearchParamsLike): void {
	const fromParams = inputFromParams(params);

	if (fromParams.kind === 'error') {
		connection.notice = fromParams.message;
		return;
	}

	if (fromParams.kind === 'input') {
		run(fromParams.input, fromParams.source);
		return;
	}

	// No query string: fall back to the connection saved last time.
	const saved = loadSavedConnection();
	connection.saved = saved;
	if (saved) {
		run(savedToInput(saved), 'your saved connection');
		return;
	}

	connection.notice = null;
}

/** Re-check the saved connection after an automatic restore failed. */
export function retry(): void {
	if (connection.saved) {
		void runEstablish(savedToInput(connection.saved), 'your saved connection');
	}
}

function run(input: ShareInput, source: string): void {
	if (toApiUrl(input) === attempted) return;
	void runEstablish(input, source);
}

async function runEstablish(input: ShareInput, source: string): Promise<EstablishResult> {
	const result = await establish(input, { source });
	connection.notice = result.ok
		? null
		: `${result.message} It may have expired — enter a new share code to reconnect.`;
	return result;
}

function savedToInput(saved: SavedConnection): ShareInput {
	return saved.kind === 'url'
		? { kind: 'url', url: saved.value }
		: { kind: 'share-code', code: saved.value };
}

// ---------------------------------------------------------------------------
// Dashboard actions
// ---------------------------------------------------------------------------

/** Refresh the list of sessions on the connected server. */
export async function refreshSessions(): Promise<void> {
	const url = api.url;
	if (!url) return;

	connection.sessionsStatus = 'loading';
	connection.error = null;
	try {
		connection.sessions = await listSessions(url);
		connection.sessionsStatus = 'ready';
	} catch (error) {
		connection.sessionsStatus = 'error';
		connection.error = error instanceof Error ? error.message : 'Could not load sessions.';
	}
}

/** Create a fresh session folder on the server and reveal it in the list. */
export async function startNewSession(): Promise<void> {
	const url = api.url;
	if (!url || connection.busy) return;

	const sessionId = newSessionId();
	connection.busy = true;
	connection.error = null;
	try {
		await createSession(url, sessionId);
		connection.activeSession = sessionId;
		await refreshSessions();
	} catch (error) {
		connection.error = error instanceof Error ? error.message : 'Could not create the session.';
	} finally {
		connection.busy = false;
	}
}

/** Forget the saved code and drop the connection (back to the connect screen). */
export function disconnect(): void {
	clearSavedConnection();
	clearApiUrl();
	attempted = null;
	connection.status = 'idle';
	connection.notice = null;
	connection.error = null;
	connection.source = '';
	connection.saved = null;
	connection.sessions = [];
	connection.sessionsStatus = 'idle';
	connection.activeSession = null;
	connection.busy = false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
