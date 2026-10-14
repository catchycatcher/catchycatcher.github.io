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
import { newSessionId, newSessionName, newTakeId, type Session } from './session.ts';
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

/** One word in a lyric line, as the pipeline returns it. */
export type LyricWord = {
	word: string;
	length: number;
	/** Exact word bounds in seconds (present on freshly processed results). */
	start?: number;
	end?: number;
};

/** One lyric line; keys mirror the spec schema (hence the spaced "start time"). */
export type LyricLine = {
	bpm: number;
	'start time': number;
	'end time': number;
	words: LyricWord[];
	/** Optional display-text override (the pipeline timings are unchanged). */
	text?: string;
	/** Mid-re-split line: shown as plain text (no bubble) until carved. */
	raw?: boolean;
	/** Scrapbook renders tag each line with the take it came from. */
	source?: { session_id: string; take_id: string; line_index: number };
	/** Scrapbook section grouping (UI only; audio is unaffected). */
	group?: { id: string; type: string; name?: string };
	/** Small badge to tell apart same-lyric lines from different recordings. */
	tag?: number;
};

/** The payload returned once a take has been processed. */
export type TakeResult = {
	vocals: string;
	background: string;
	lyrics: LyricLine[];
	/** True when the lyrics have been edited away from the pipeline's detection. */
	edited?: boolean;
};

/** A take as the session manifest describes it. */
export type TakeMeta = {
	take_id: string;
	index: number;
	name?: string;
	bookmarked?: boolean;
	status: string;
	/** ``text`` for text-only scribbles; absent/``audio`` for recordings. */
	kind?: string;
	processed?: boolean;
	input_filename?: string;
	error?: string | null;
	filename?: string;
	created_at?: string;
	finished_at?: string;
};

/** A session's name plus the takes stored inside it. */
export type SessionDetail = { id: string; name: string; takes: TakeMeta[] };

/** The outcome of storing/processing one upload. */
export type TakeUpload = {
	takeId: string;
	/** The pipeline payload, when the upload was processed. */
	result: TakeResult | null;
	/** The stored metadata, when the upload was kept unprocessed. */
	meta: TakeMeta | null;
};

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
	sessions: [] as Session[],
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

/** Every session stored on the server, with its display name and last change. */
export async function listSessions(url: string): Promise<Session[]> {
	const response = await fetch(`${base(url)}/sessions`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when listing sessions.`);
	}

	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.sessions)) return [];

	const sessions: Session[] = [];
	for (const entry of body.sessions) {
		// Legacy servers returned bare id strings; newer ones return objects.
		if (typeof entry === 'string') {
			sessions.push({ id: entry, name: entry, updatedAt: null });
		} else if (isRecord(entry) && typeof entry.id === 'string') {
			const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id;
			const updatedAt =
				typeof entry.updated_at === 'string' && entry.updated_at ? entry.updated_at : null;
			sessions.push({ id: entry.id, name, updatedAt });
		}
	}
	return sessions;
}

/** Create an empty session folder, ready for the first take. */
export async function createSession(url: string, sessionId: string, name: string): Promise<void> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}?name=${encodeURIComponent(name)}`,
		{
			method: 'POST',
			headers: { accept: 'application/json' }
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when creating the session.`);
	}
}

/** Change a session's display name (its takes are untouched). */
export async function patchSessionName(
	url: string,
	sessionId: string,
	name: string
): Promise<void> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}?name=${encodeURIComponent(name)}`,
		{
			method: 'PATCH',
			headers: { accept: 'application/json' }
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when renaming the session.`);
	}
}

/** Delete a session and every take inside it. */
export async function removeSession(url: string, sessionId: string): Promise<void> {
	const response = await fetch(`${base(url)}/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'DELETE',
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when deleting the session.`);
	}
}

// ---------------------------------------------------------------------------
// Takes (one processed recording inside a session)
// ---------------------------------------------------------------------------

/** A session's name and its takes, from the manifest endpoint. */
export async function getSession(url: string, sessionId: string): Promise<SessionDetail> {
	const response = await fetch(`${base(url)}/sessions/${encodeURIComponent(sessionId)}`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when loading the session.`);
	}

	const body: unknown = await response.json();
	if (!isRecord(body)) return { id: sessionId, name: sessionId, takes: [] };

	const id = typeof body.session_id === 'string' ? body.session_id : sessionId;
	const name = typeof body.name === 'string' && body.name.trim() ? body.name : id;
	const takes = Array.isArray(body.takes) ? (body.takes as TakeMeta[]) : [];
	return { id, name, takes };
}

/**
 * Upload one recording. By default the server processes it before answering
 * (which can take minutes on the GPU); pass ``process: false`` to just store the
 * audio and process it later with {@link processTake}.
 */
export async function uploadTake(
	url: string,
	sessionId: string,
	file: File,
	{
		process = true,
		index,
		name,
		takeId = newTakeId()
	}: { process?: boolean; index?: number; name?: string; takeId?: string } = {}
): Promise<TakeUpload> {
	const query = [`process=${process ? 'true' : 'false'}`];
	if (index !== undefined) query.push(`index=${index}`);
	if (name) query.push(`name=${encodeURIComponent(name)}`);

	const form = new FormData();
	form.append('file', file);

	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}?${query.join('&')}`,
		{ method: 'POST', body: form, headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the recording.`);
	}

	const body: unknown = await response.json();
	if (process) return { takeId, result: body as TakeResult, meta: null };
	return { takeId, result: null, meta: body as TakeMeta };
}

/** Process a previously stored (unprocessed) take. */
export async function processTake(
	url: string,
	sessionId: string,
	takeId: string
): Promise<TakeResult> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/process`,
		{ method: 'POST', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when processing the recording.`);
	}
	return (await response.json()) as TakeResult;
}

/** Delete a stored take (a journal entry) and its files. */
export async function deleteTake(url: string, sessionId: string, takeId: string): Promise<void> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}`,
		{ method: 'DELETE', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when deleting the entry.`);
	}
}

/** Rename a journal entry. */
export async function renameTake(
	url: string,
	sessionId: string,
	takeId: string,
	name: string
): Promise<void> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}?name=${encodeURIComponent(name)}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when renaming the entry.`);
	}
}

/** Rewrite a lyric line from edited text; the server re-guesses its word timings. */
export async function updateLineText(
	url: string,
	sessionId: string,
	takeId: string,
	lineIndex: number,
	text: string
): Promise<LyricLine> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/lines/${lineIndex}?text=${encodeURIComponent(text)}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the line.`);
	}
	const body = (await response.json()) as { line: LyricLine };
	return body.line;
}

/** Replace a take's lyric lines (re-splitting); the server recomputes each BPM. */
export async function updateLyrics(
	url: string,
	sessionId: string,
	takeId: string,
	lines: { words: LyricWord[]; raw?: boolean }[]
): Promise<LyricLine[]> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/lyrics`,
		{
			method: 'PUT',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ lines })
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the lines.`);
	}
	const body = (await response.json()) as { lyrics: LyricLine[] };
	return body.lyrics;
}

/** Restore a take's lyrics to the pipeline's original detection. */
export async function resetLyrics(
	url: string,
	sessionId: string,
	takeId: string
): Promise<LyricLine[]> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/lyrics/reset`,
		{ method: 'POST', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when resetting the lyrics.`);
	}
	const body = (await response.json()) as { lyrics: LyricLine[] };
	return body.lyrics;
}

/** Where a take is used: its bookmark and the scrapbooks holding its lines. */
export async function getTakeUsage(
	url: string,
	sessionId: string,
	takeId: string
): Promise<{
	bookmarked: boolean;
	scrapbooks: { scrapbook_id: string; name?: string; line_count: number }[];
}> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/usage`,
		{ headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when checking the entry.`);
	}
	return (await response.json()) as {
		bookmarked: boolean;
		scrapbooks: { scrapbook_id: string; name?: string; line_count: number }[];
	};
}

/** A playable url for a take's raw audio or a generated stem. */
export function takeAudioUrl(
	url: string,
	sessionId: string,
	takeId: string,
	source: 'original' | 'vocals' | 'background' = 'original'
): string {
	const tail = source === 'original' ? 'original' : `audio/${source}`;
	return `${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}/${tail}`;
}

/** Toggle a journal entry's bookmark. */
export async function setBookmark(
	url: string,
	sessionId: string,
	takeId: string,
	bookmarked: boolean
): Promise<void> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}?bookmarked=${bookmarked ? 'true' : 'false'}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when bookmarking the entry.`);
	}
}

// ---------------------------------------------------------------------------
// Scribbles (a journal shared across every session)
// ---------------------------------------------------------------------------
//
// A scribble is a take that lives in the reserved ``scribbles`` session, so the
// homepage records them there and every session can read them. Kept apart from
// the song sessions by the server (``/sessions`` never lists it).

/** The reserved session id the server stores global scribbles under. */
export const SCRIBBLES_SESSION_ID = 'scribbles';

/** Every scribble on the server, newest first. */
export async function listScribbles(url: string): Promise<TakeMeta[]> {
	const response = await fetch(`${base(url)}/scribbles`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when listing scribbles.`);
	}
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.scribbles)) return [];
	return body.scribbles as TakeMeta[];
}

/** Upload one scribble; processed by default (pass ``process: false`` to store). */
export async function uploadScribble(
	url: string,
	file: File,
	{
		process = true,
		index,
		name,
		scribbleId = newTakeId()
	}: { process?: boolean; index?: number; name?: string; scribbleId?: string } = {}
): Promise<TakeUpload> {
	const query = [`process=${process ? 'true' : 'false'}`];
	if (index !== undefined) query.push(`index=${index}`);
	if (name) query.push(`name=${encodeURIComponent(name)}`);

	const form = new FormData();
	form.append('file', file);

	const response = await fetch(
		`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}?${query.join('&')}`,
		{ method: 'POST', body: form, headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the scribble.`);
	}

	const body: unknown = await response.json();
	if (process) return { takeId: scribbleId, result: body as TakeResult, meta: null };
	return { takeId: scribbleId, result: null, meta: body as TakeMeta };
}

/** Process a previously stored (unprocessed) scribble. */
export async function processScribble(url: string, scribbleId: string): Promise<TakeResult> {
	const response = await fetch(`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}/process`, {
		method: 'POST',
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when processing the scribble.`);
	}
	return (await response.json()) as TakeResult;
}

/** A scribble's processed result, or null when it has none. */
export async function getScribble(url: string, scribbleId: string): Promise<TakeResult | null> {
	const response = await fetch(`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) return null;
	const body: unknown = await response.json();
	if (isRecord(body) && isRecord(body.result)) return body.result as TakeResult;
	return null;
}

/** Rename a scribble. */
export async function renameScribble(url: string, scribbleId: string, name: string): Promise<void> {
	const response = await fetch(
		`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}?name=${encodeURIComponent(name)}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when renaming the scribble.`);
	}
}

/** Pin (or unpin) a scribble so it sorts to the top. */
export async function pinScribble(url: string, scribbleId: string, pinned: boolean): Promise<void> {
	const response = await fetch(
		`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}?bookmarked=${pinned ? 'true' : 'false'}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when pinning the scribble.`);
	}
}

/** Delete a scribble and its files. */
export async function deleteScribble(url: string, scribbleId: string): Promise<void> {
	const response = await fetch(`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}`, {
		method: 'DELETE',
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when deleting the scribble.`);
	}
}

/** A playable url for a scribble's raw audio or a generated stem. */
export function scribbleAudioUrl(
	url: string,
	scribbleId: string,
	source: 'original' | 'vocals' | 'background' = 'original'
): string {
	const tail = source === 'original' ? 'original' : `audio/${source}`;
	return `${base(url)}/scribbles/${encodeURIComponent(scribbleId)}/${tail}`;
}

/** Rewrite one audio scribble's line from edited text (re-guesses timings). */
export async function updateScribbleLineText(
	url: string,
	scribbleId: string,
	lineIndex: number,
	text: string
): Promise<LyricLine> {
	const response = await fetch(
		`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}/lines/${lineIndex}?text=${encodeURIComponent(text)}`,
		{ method: 'PATCH', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the line.`);
	}
	const body = (await response.json()) as { line: LyricLine };
	return body.line;
}

/** Replace an audio scribble's lines (re-splitting); the server recomputes BPM. */
export async function updateScribbleLyrics(
	url: string,
	scribbleId: string,
	lines: { words: LyricWord[]; raw?: boolean }[]
): Promise<LyricLine[]> {
	const response = await fetch(`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}/lyrics`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ lines })
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the lines.`);
	}
	const body = (await response.json()) as { lyrics: LyricLine[] };
	return body.lyrics;
}

/** Create a text-only scribble (no audio) from a name and its lines. */
export async function createTextScribble(
	url: string,
	body: { name: string; lines: string[] }
): Promise<TakeMeta> {
	const response = await fetch(`${base(url)}/scribbles/text`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when creating the scribble.`);
	}
	return (await response.json()) as TakeMeta;
}

/** Replace a text scribble's lines. */
export async function updateTextScribble(
	url: string,
	scribbleId: string,
	lines: string[]
): Promise<LyricLine[]> {
	const response = await fetch(`${base(url)}/scribbles/${encodeURIComponent(scribbleId)}/text`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ lines })
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the scribble.`);
	}
	const body = (await response.json()) as { lyrics: LyricLine[] };
	return body.lyrics;
}

// ---------------------------------------------------------------------------
// Scrapbooks (tempo-matched mixes of isolated lines)
// ---------------------------------------------------------------------------

/** A line lifted from a processed journal entry (with a snapshot of its data). */
export type LineRef = {
	session_id: string;
	take_id: string;
	line_index: number;
	/** Snapshot taken when the line was added, so later journal edits don't affect it. */
	data?: {
		bpm?: number;
		take_bpm?: number | null;
		start?: number;
		end?: number;
		words?: LyricWord[];
		text?: string | null;
	};
	/** Optional section grouping within a scrapbook (chorus/verse/bridge/other). */
	group?: { id: string; type: string; name?: string; instance?: string };
};

export type ScrapbookSummary = {
	scrapbook_id: string;
	name: string;
	line_count: number;
	created_at?: string;
	updated_at?: string;
	rendered?: boolean;
};

/** The server's render of a scrapbook: one mix plus a word timeline. */
export type ScrapbookRender = {
	audio: string;
	timeline: LyricLine[];
	gaps: number[];
	rendered_at?: string;
	/** Which mixes exist for the current lines: ``vocals`` and/or ``backgrounds``. */
	variants?: Record<string, { signature: string; rendered_at?: string }>;
};

/** A named section: an ordered block of lines that plays together. */
export type ScrapGroup = {
	group: { id: string; type: string; name?: string; instance?: string };
	lines: LineRef[];
};

/** A scrapbook entry: a bare line, or a section group holding its own lines. */
export type ScrapEntry = LineRef | ScrapGroup;

export type Scrapbook = ScrapbookSummary & {
	lines: ScrapEntry[];
	render: ScrapbookRender | null;
};

function scrapbookBase(url: string, sessionId: string): string {
	return `${base(url)}/sessions/${encodeURIComponent(sessionId)}/scrapbooks`;
}

export async function listScrapbooks(url: string, sessionId: string): Promise<ScrapbookSummary[]> {
	const response = await fetch(scrapbookBase(url, sessionId), {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when listing scrapbooks.`);
	}
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.scrapbooks)) return [];
	return body.scrapbooks as ScrapbookSummary[];
}

export async function getScrapbook(
	url: string,
	sessionId: string,
	scrapbookId: string
): Promise<Scrapbook> {
	const response = await fetch(
		`${scrapbookBase(url, sessionId)}/${encodeURIComponent(scrapbookId)}`,
		{
			headers: { accept: 'application/json' }
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when loading the scrapbook.`);
	}
	return (await response.json()) as Scrapbook;
}

export async function createScrapbook(
	url: string,
	sessionId: string,
	body: { name: string; lines: ScrapEntry[] }
): Promise<ScrapbookSummary> {
	const response = await fetch(scrapbookBase(url, sessionId), {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when creating the scrapbook.`);
	}
	return (await response.json()) as ScrapbookSummary;
}

export async function updateScrapbook(
	url: string,
	sessionId: string,
	scrapbookId: string,
	body: { name?: string; lines?: ScrapEntry[] }
): Promise<Scrapbook> {
	const response = await fetch(
		`${scrapbookBase(url, sessionId)}/${encodeURIComponent(scrapbookId)}`,
		{
			method: 'PATCH',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body)
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when saving the scrapbook.`);
	}
	return (await response.json()) as Scrapbook;
}

export async function deleteScrapbook(
	url: string,
	sessionId: string,
	scrapbookId: string
): Promise<void> {
	const response = await fetch(
		`${scrapbookBase(url, sessionId)}/${encodeURIComponent(scrapbookId)}`,
		{
			method: 'DELETE',
			headers: { accept: 'application/json' }
		}
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when deleting the scrapbook.`);
	}
}

/** Render (or fetch the cached) tempo-matched mix for a scrapbook. */
export async function renderScrapbook(
	url: string,
	sessionId: string,
	scrapbookId: string,
	backgrounds = false
): Promise<ScrapbookRender> {
	const response = await fetch(
		`${scrapbookBase(url, sessionId)}/${encodeURIComponent(scrapbookId)}/render${
			backgrounds ? '?backgrounds=true' : ''
		}`,
		{ method: 'POST', headers: { accept: 'application/json' } }
	);
	if (!response.ok) {
		throw new Error(`The server answered ${response.status} when rendering the scrapbook.`);
	}
	return (await response.json()) as ScrapbookRender;
}

/** A playable url for a scrapbook's rendered mix. */
export function scrapbookAudioUrl(url: string, sessionId: string, scrapbookId: string): string {
	return `${scrapbookBase(url, sessionId)}/${encodeURIComponent(scrapbookId)}/audio`;
}

/** A finished take's result, or null when it has not produced one. */
export async function getTakeResult(
	url: string,
	sessionId: string,
	takeId: string
): Promise<TakeResult | null> {
	const response = await fetch(
		`${base(url)}/sessions/${encodeURIComponent(sessionId)}/takes/${encodeURIComponent(takeId)}`,
		{ headers: { accept: 'application/json' } }
	);
	if (!response.ok) return null;

	const body: unknown = await response.json();
	if (isRecord(body) && isRecord(body.result)) return body.result as TakeResult;
	return null;
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
		return { ok: false, message: "Couldn't reach the server." };
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

/**
 * Create a fresh session folder on the server, reveal it in the list, and
 * return its id (or null when there was nothing to do / it failed) so the
 * caller can navigate into it.
 */
export async function startNewSession(): Promise<string | null> {
	const url = api.url;
	if (!url || connection.busy) return null;

	const sessionId = newSessionId();
	connection.busy = true;
	connection.error = null;
	try {
		await createSession(url, sessionId, newSessionName());
		connection.activeSession = sessionId;
		await refreshSessions();
		return sessionId;
	} catch (error) {
		connection.error = error instanceof Error ? error.message : 'Could not create the session.';
		return null;
	} finally {
		connection.busy = false;
	}
}

/** Rename a session. Returns whether it worked; failures land in `connection.error`. */
export async function renameSession(sessionId: string, name: string): Promise<boolean> {
	const url = api.url;
	if (!url) return false;

	connection.error = null;
	try {
		await patchSessionName(url, sessionId, name);
		await refreshSessions();
		return true;
	} catch (error) {
		connection.error = error instanceof Error ? error.message : 'Could not rename the session.';
		return false;
	}
}

/** Delete a session and every take inside it. Returns whether it worked. */
export async function deleteSession(sessionId: string): Promise<boolean> {
	const url = api.url;
	if (!url) return false;

	connection.error = null;
	try {
		await removeSession(url, sessionId);
		if (connection.activeSession === sessionId) connection.activeSession = null;
		await refreshSessions();
		return true;
	} catch (error) {
		connection.error = error instanceof Error ? error.message : 'Could not delete the session.';
		return false;
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
