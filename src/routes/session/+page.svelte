<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		createScrapbook,
		deleteScrapbook,
		deleteTake,
		getScrapbook,
		getScribble,
		getSession,
		getTakeResult,
		getTakeUsage,
		listScrapbooks,
		listScribbles,
		patchSessionName,
		processScribble,
		processTake,
		renderScrapbook,
		renameTake,
		resetLyrics,
		scrapbookAudioUrl,
		scribbleAudioUrl,
		SCRIBBLES_SESSION_ID,
		setBookmark,
		takeAudioUrl,
		updateLineText,
		updateLyrics,
		updateScrapbook,
		uploadTake,
		type LineRef,
		type LyricLine,
		type ScrapEntry,
		type Scrapbook,
		type ScrapbookSummary,
		type TakeMeta
	} from '#lib/connection.svelte.ts';
	import { carve, lyricsPayload, mergeSelected } from '#lib/lyrics.ts';
	import { newEntryName } from '#lib/session.ts';
	import { markSessionOpened } from '#lib/recent.ts';
	import { extensionForMime, Recorder } from '#lib/recorder.svelte.ts';
	import { SharedMic } from '#lib/micShare.svelte.ts';
	import EntryPlayer from '#lib/components/EntryPlayer.svelte';

	type EntryStatus = 'recorded' | 'processing' | 'done' | 'error';

	type Entry = {
		localId: string;
		serverId: string | null;
		index: number;
		name: string;
		bookmarked: boolean;
		status: EntryStatus;
		/** True once the lyrics were edited away from the pipeline's detection. */
		edited: boolean;
		lyrics: LyricLine[];
		error?: string | null;
	};

	/** A scribble: a journal take shared across every session. */
	type Scribble = {
		id: string;
		index: number;
		name: string;
		kind: 'audio' | 'text';
		status: EntryStatus;
		lyrics: LyricLine[];
		error?: string | null;
	};

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let sessionId = $state('');
	let sessionName = $state('');
	let error = $state<string | null>(null);

	/** Inline rename of the session name in the header. */
	let renamingSession = $state(false);
	let sessionNameDraft = $state('');

	function beginSessionRename() {
		renamingSession = true;
		sessionNameDraft = sessionName;
	}

	async function commitSessionRename(event: SubmitEvent) {
		event.preventDefault();
		const name = sessionNameDraft.trim();
		renamingSession = false;
		const url = api.url;
		if (!name || name === sessionName || !url || !sessionId) return;
		const previous = sessionName;
		sessionName = name;
		try {
			await patchSessionName(url, sessionId, name);
		} catch {
			sessionName = previous;
			error = 'Could not rename the session.';
		}
	}

	/** The journal: one entry per take, newest first. */
	let entries = $state<Entry[]>([]);
	let nextIndex = $state(1);
	let tab = $state<'all' | 'bookmarked' | 'scribbles'>('all');

	/** Scribbles: journal takes shared across every session. */
	let scribbles = $state<Scribble[]>([]);
	let scribbleError = $state<string | null>(null);
	let scribblesLoading = $state(false);

	/** Inline rename state. */
	let editingId = $state<string | null>(null);
	let nameDraft = $state('');

	/** Which journal entries show their lyrics player (default: collapsed). */
	let expandedEntries = $state<Record<string, boolean>>({});

	function toggleEntry(localId: string) {
		expandedEntries[localId] = !expandedEntries[localId];
	}

	/** Which scribbles show their player (default: collapsed). */
	let expandedScribbles = $state<Record<string, boolean>>({});

	function toggleScribble(scribbleId: string) {
		expandedScribbles[scribbleId] = !expandedScribbles[scribbleId];
	}

	/** Scrapbooks. */
	let scrapbooks = $state<ScrapbookSummary[]>([]);
	let activeScrapbookId = $state('');
	let scrapbook = $state<Scrapbook | null>(null);
	let scrapbookBusy = $state(false);
	let scrapbookError = $state<string | null>(null);
	let dragOverScrapbook = $state(false);
	/** True while an edited scrapbook's mix is (re)rendering. */
	let renderPending = $state(false);
	/** The open scrapbook's name, edited in place in the selector field. */
	let scrapbookNameDraft = $state('');
	/** Whether the scrapbook picker list is showing. */
	let scrapbookMenuOpen = $state(false);
	/** Guards against creating two "default" scrapbooks at once. */
	let autoCreateInFlight = false;
	/** Which mix is playing: the isolated vocals, or with the source backgrounds. */
	let scrapbookMode = $state<'vocals' | 'backgrounds'>('vocals');
	/** True while the other mix variant is being rendered (playback keeps going). */
	let backgroundsPending = $state(false);

	/** Split-pane: how much of the row the scrapbook gets, in percent. */
	let splitPercent = $state(50);
	let splitEl = $state<HTMLDivElement | null>(null);
	let resizing = $state(false);

	const recorder = new Recorder();
	/** The phone-shared microphone, if one is available. */
	const sharedMic = new SharedMic();
	let micSource = $state<'computer' | 'shared'>('computer');
	let segmentStartedAt = $state(0);
	let elapsed = $state(0);
	let loadedFor = '';

	let recording = $derived(micSource === 'shared' ? sharedMic.recording : recorder.recording);
	let recorderError = $derived(micSource === 'shared' ? sharedMic.error : recorder.error);
	let recorderFailed = $derived(
		micSource === 'shared' ? Boolean(sharedMic.error) : recorder.state === 'error'
	);

	// Listen for a shared microphone whenever we're connected.
	$effect(() => {
		const url = api.url;
		if (!url) return;
		sharedMic.connect(url);
		return () => sharedMic.disconnect();
	});

	$effect(() => {
		bootstrap(page.url.searchParams);
		const id = page.url.searchParams.get('id') ?? '';
		sessionId = id;
		if (id) markSessionOpened(id);
		ready = true;
	});

	$effect(() => {
		const url = api.url;
		const id = sessionId;
		if (!url || !id || loadedFor === id) return;
		loadedFor = id;
		// Scrapbooks belong to the session, so drop the previous session's.
		activeScrapbookId = '';
		scrapbook = null;
		scrapbooks = [];
		void loadSession(url, id);
		void refreshScrapbooks(url);
	});

	// Scribbles are global, so they load once per server (not per session).
	let scribblesLoadedFor = '';
	$effect(() => {
		const url = api.url;
		if (!url || scribblesLoadedFor === url) return;
		scribblesLoadedFor = url;
		void loadScribbles(url);
	});

	$effect(() => {
		if (!recording || segmentStartedAt <= 0) {
			elapsed = 0;
			return;
		}
		const started = segmentStartedAt;
		const timer = setInterval(() => {
			elapsed = (performance.now() - started) / 1000;
		}, 100);
		return () => clearInterval(timer);
	});

	$effect(() => {
		const onUnload = () => recorder.stop();
		window.addEventListener('keydown', onKeydown);
		window.addEventListener('beforeunload', onUnload);
		return () => {
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('beforeunload', onUnload);
			recorder.stop();
			sharedMic.stop();
		};
	});

	let visibleEntries = $derived(
		tab === 'bookmarked' ? entries.filter((entry) => entry.bookmarked) : entries
	);
	let pageTitle = $derived(sessionName ? `${sessionName} — Catchy Catcher` : 'Catchy Catcher');

	// --- Scribbles (a global journal) --------------------------------------

	async function loadScribbles(url: string) {
		scribblesLoading = true;
		scribbleError = null;
		try {
			const list = await listScribbles(url);
			const loaded: Scribble[] = list.map((item) => ({
				id: item.take_id,
				index: item.index ?? 0,
				name: item.name?.trim() || item.take_id,
				kind: item.kind === 'text' ? 'text' : 'audio',
				status: normalizeStatus(item.status),
				lyrics: [],
				error: item.error ?? null
			}));
			scribbles = loaded;
			for (const scribble of loaded) {
				if (scribble.status !== 'done') continue;
				const result = await getScribble(url, scribble.id);
				if (result) {
					scribbles = scribbles.map((candidate) =>
						candidate.id === scribble.id ? { ...candidate, lyrics: result.lyrics } : candidate
					);
				}
			}
		} catch (loadError) {
			scribbleError = loadError instanceof Error ? loadError.message : 'Could not load scribbles.';
		} finally {
			scribblesLoading = false;
		}
	}

	function scribbleAudio(scribble: Scribble): string {
		const url = api.url;
		if (!url) return '';
		// Raw recording, so scribbles are audible before (and after) processing.
		return scribbleAudioUrl(url, scribble.id, 'original');
	}

	function scribbleLineRef(scribble: Scribble, lineIndex: number): LineRef | null {
		if (scribble.status !== 'done') return null;
		return { session_id: SCRIBBLES_SESSION_ID, take_id: scribble.id, line_index: lineIndex };
	}

	async function processScribbleEntry(scribble: Scribble) {
		const url = api.url;
		if (!url) return;
		scribbles = scribbles.map((candidate) =>
			candidate.id === scribble.id ? { ...candidate, status: 'processing', error: null } : candidate
		);
		try {
			const result = await processScribble(url, scribble.id);
			scribbles = scribbles.map((candidate) =>
				candidate.id === scribble.id
					? { ...candidate, status: 'done', lyrics: result.lyrics }
					: candidate
			);
		} catch (processError) {
			scribbles = scribbles.map((candidate) =>
				candidate.id === scribble.id
					? {
							...candidate,
							status: 'error',
							error:
								processError instanceof Error
									? processError.message
									: 'Could not process the scribble.'
						}
					: candidate
			);
		}
	}

	// Keep the editable name field in step with the open scrapbook (including
	// after a rename or switching to another one). Leave it alone while the
	// scrapbook is mid-load so the user's typing isn't clobbered.
	$effect(() => {
		if (scrapbook) scrapbookNameDraft = scrapbook.name;
	});

	/** Drag the divider to repartition the scrapbook and journal columns. */
	function startResize(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		resizing = true;
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			/* pointer capture is best-effort */
		}
	}

	function moveResize(event: PointerEvent) {
		if (!resizing || !splitEl) return;
		const rect = splitEl.getBoundingClientRect();
		if (rect.width === 0) return;
		const percent = ((event.clientX - rect.left) / rect.width) * 100;
		splitPercent = Math.min(80, Math.max(20, percent));
	}

	function endResize(event: PointerEvent) {
		if (!resizing) return;
		resizing = false;
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		} catch {
			/* already released */
		}
	}

	function nudgeResize(delta: number) {
		splitPercent = Math.min(80, Math.max(20, splitPercent + delta));
	}

	function normalizeStatus(status: string | undefined): EntryStatus {
		if (status === 'done' || status === 'processing' || status === 'error') return status;
		return 'recorded';
	}

	function updateEntry(localId: string, patch: Partial<Entry>) {
		entries = entries.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry));
	}

	async function loadSession(url: string, id: string) {
		try {
			const session = await getSession(url, id);
			sessionName = session.name;
			const loaded: Entry[] = session.takes.map((take: TakeMeta) => ({
				localId: take.take_id,
				serverId: take.take_id,
				index: take.index,
				name: take.name?.trim() || take.take_id,
				bookmarked: Boolean(take.bookmarked),
				status: normalizeStatus(take.status),
				edited: false,
				lyrics: []
			}));
			loaded.sort((a, b) => b.index - a.index);
			entries = loaded;
			nextIndex = loaded.reduce((max, entry) => Math.max(max, entry.index), 0) + 1;
			error = null;

			for (const entry of loaded) {
				if (entry.status === 'done' && entry.serverId) {
					const result = await getTakeResult(url, id, entry.serverId);
					if (result)
						updateEntry(entry.localId, {
							lyrics: result.lyrics,
							edited: Boolean(result.edited)
						});
				}
			}
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Could not load the session.';
		}
	}

	// --- Recording ---------------------------------------------------------

	async function startRecording(source: 'computer' | 'shared' = 'computer') {
		if (source === 'shared') {
			micSource = 'shared';
			sharedMic.start();
			if (sharedMic.recording) segmentStartedAt = performance.now();
			return;
		}
		micSource = 'computer';
		await recorder.start();
		if (recorder.recording) segmentStartedAt = performance.now();
	}

	async function commit(process: boolean) {
		const url = api.url;
		if (!url || !sessionId || !recording) return;

		const blob =
			micSource === 'shared' ? await sharedMic.takeSegment() : await recorder.takeSegment();
		segmentStartedAt = performance.now();
		if (!blob) return;

		const index = nextIndex++;
		const localId = `local-${index}-${Math.random().toString(36).slice(2, 7)}`;
		const name = newEntryName();
		entries = [
			{
				localId,
				serverId: null,
				index,
				name,
				bookmarked: false,
				status: 'recorded',
				edited: false,
				lyrics: [],
				error: null
			},
			...entries
		];

		const file = new File([blob], `entry-${index}.${extensionForMime(blob.type)}`, {
			type: blob.type || 'audio/webm'
		});

		try {
			// Store first (fast) so the entry is playable right away — you don't
			// wait for processing to listen. Processing then runs in the background.
			const upload = await uploadTake(url, sessionId, file, { process: false, index, name });
			updateEntry(localId, { serverId: upload.takeId, status: 'recorded' });
			if (process) void processEntryById(localId);
		} catch (uploadError) {
			updateEntry(localId, {
				status: 'error',
				error: uploadError instanceof Error ? uploadError.message : 'Could not save the take.'
			});
		}
	}

	async function scrapCurrent() {
		if (!recording) return;
		if (micSource === 'shared') sharedMic.discardSegment();
		else await recorder.discardSegment();
		segmentStartedAt = performance.now();
	}

	function stopRecording() {
		if (micSource === 'shared') sharedMic.stop();
		else recorder.stop();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
		) {
			return;
		}
		if (event.key === ' ' || event.key === 'Spacebar') {
			event.preventDefault();
			if (recording) void commit(true);
			else void startRecording();
			return;
		}
		if (event.key === 'Enter' && recording) {
			event.preventDefault();
			void commit(false);
			return;
		}
		if ((event.key === 'Backspace' || event.key === 'Delete') && recording) {
			event.preventDefault();
			void scrapCurrent();
			return;
		}
		if (event.key === 'Escape' && recording) {
			event.preventDefault();
			stopRecording();
		}
	}

	function formatElapsed(seconds: number): string {
		const whole = Math.floor(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	// --- Journal entries ---------------------------------------------------

	async function processEntry(entry: Entry) {
		await processEntryById(entry.localId);
	}

	async function processEntryById(localId: string) {
		const url = api.url;
		const entry = entries.find((candidate) => candidate.localId === localId);
		if (!url || !entry?.serverId) return;
		updateEntry(localId, { status: 'processing', error: null });
		try {
			const result = await processTake(url, sessionId, entry.serverId);
			updateEntry(localId, { status: 'done', lyrics: result.lyrics });
		} catch (processError) {
			updateEntry(localId, {
				status: 'error',
				error: processError instanceof Error ? processError.message : 'Could not process the take.'
			});
		}
	}

	async function removeEntry(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		let usage: { bookmarked: boolean; scrapbooks: { name?: string }[] } = {
			bookmarked: entry.bookmarked,
			scrapbooks: []
		};
		try {
			usage = await getTakeUsage(url, sessionId, entry.serverId);
		} catch {
			/* if the check fails, fall back to the local bookmark flag */
		}
		if (usage.bookmarked || usage.scrapbooks.length) {
			const reasons: string[] = [];
			if (usage.bookmarked) reasons.push('bookmarked');
			if (usage.scrapbooks.length) {
				const names = usage.scrapbooks.map((item) => item.name || 'a scrapbook');
				reasons.push(`used in ${names.join(', ')}`);
			}
			const ok = window.confirm(
				`Delete this entry? It is ${reasons.join(' and ')}. Its lines will be removed from the scrapbook too.`
			);
			if (!ok) return;
		}
		try {
			await deleteTake(url, sessionId, entry.serverId);
			entries = entries.filter((candidate) => candidate.localId !== entry.localId);
			// The open scrapbook may just have lost lines; reload it.
			if (activeScrapbookId) await selectScrapbook(activeScrapbookId);
		} catch (deleteError) {
			error = deleteError instanceof Error ? deleteError.message : 'Could not delete the entry.';
		}
	}

	/** Restore an edited entry's lyrics to what the pipeline detected. */
	async function resetEntryLyrics(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		try {
			const lyrics = await resetLyrics(url, sessionId, entry.serverId);
			updateEntry(entry.localId, { lyrics, edited: false });
		} catch (resetError) {
			error = resetError instanceof Error ? resetError.message : 'Could not reset the lines.';
		}
	}

	async function toggleBookmark(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		const next = !entry.bookmarked;
		updateEntry(entry.localId, { bookmarked: next });
		try {
			await setBookmark(url, sessionId, entry.serverId, next);
		} catch (bookmarkError) {
			updateEntry(entry.localId, { bookmarked: !next });
			error =
				bookmarkError instanceof Error ? bookmarkError.message : 'Could not save the bookmark.';
		}
	}

	function beginRename(entry: Entry) {
		editingId = entry.localId;
		nameDraft = entry.name;
	}

	function cancelRename() {
		editingId = null;
		nameDraft = '';
	}

	async function handleRename(event: SubmitEvent) {
		event.preventDefault();
		const id = editingId;
		const name = nameDraft.trim();
		if (!id || !name) return;
		const entry = entries.find((candidate) => candidate.localId === id);
		cancelRename();
		if (!entry) return;
		if (!entry.serverId) {
			updateEntry(id, { name });
			return;
		}
		if (entry.name !== name) updateEntry(id, { name });
		try {
			await renameTake(api.url as string, sessionId, entry.serverId, name);
		} catch (renameError) {
			error = renameError instanceof Error ? renameError.message : 'Could not rename.';
		}
	}

	function entryAudio(entry: Entry): string {
		const url = api.url;
		if (!url || !sessionId || !entry.serverId) return '';
		// Always play the raw recording: you can hear it without processing, and
		// it keeps the performance rather than the isolated vocal stem.
		return takeAudioUrl(url, sessionId, entry.serverId, 'original');
	}

	function journalLineRef(entry: Entry, lineIndex: number): LineRef | null {
		if (!entry.serverId || entry.status !== 'done') return null;
		return { session_id: sessionId, take_id: entry.serverId, line_index: lineIndex };
	}

	// --- Scrapbooks --------------------------------------------------------

	async function refreshScrapbooks(url: string) {
		try {
			scrapbooks = await listScrapbooks(url, sessionId);
			if (scrapbooks.length === 0) {
				// There is always an open scrapbook: make an empty one to start.
				await ensureScrapbook(url);
				return;
			}
			const open = scrapbooks.some((item) => item.scrapbook_id === activeScrapbookId);
			if (!open) await selectScrapbook(scrapbooks[0].scrapbook_id);
		} catch (listError) {
			scrapbookError =
				listError instanceof Error ? listError.message : 'Could not load scrapbooks.';
		}
	}

	/** Create the default empty scrapbook when the server has none. */
	async function ensureScrapbook(url: string) {
		if (autoCreateInFlight) return;
		autoCreateInFlight = true;
		try {
			const created = await createScrapbook(url, sessionId, { name: newEntryName(), lines: [] });
			scrapbooks = [created, ...scrapbooks];
			await selectScrapbook(created.scrapbook_id);
		} catch (createError) {
			scrapbookError =
				createError instanceof Error ? createError.message : 'Could not create a scrapbook.';
		} finally {
			autoCreateInFlight = false;
		}
	}

	/** Commit the name field: pick an existing scrapbook, else rename the open one. */
	function commitScrapbookName() {
		scrapbookMenuOpen = false;
		const value = scrapbookNameDraft.trim();
		if (!scrapbook) {
			scrapbookNameDraft = '';
			return;
		}
		if (!value) {
			scrapbookNameDraft = scrapbook.name;
			return;
		}
		const match = scrapbooks.find((item) => item.name.trim() === value);
		if (match && match.scrapbook_id !== activeScrapbookId) {
			void selectScrapbook(match.scrapbook_id);
			return;
		}
		if (value !== scrapbook.name) void saveScrapbook({ name: value });
	}

	function onScrapbookNameKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			(event.currentTarget as HTMLInputElement).blur();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			scrapbookNameDraft = scrapbook?.name ?? '';
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

	function chooseScrapbook(item: ScrapbookSummary) {
		scrapbookMenuOpen = false;
		scrapbookNameDraft = item.name;
		if (item.scrapbook_id !== activeScrapbookId) void selectScrapbook(item.scrapbook_id);
	}

	async function selectScrapbook(id: string) {
		const url = api.url;
		activeScrapbookId = id;
		scrapbook = null;
		scrapbookError = null;
		scrapbookMode = 'vocals';
		backgroundsPending = false;
		if (!url || !id) return;
		try {
			scrapbook = await getScrapbook(url, sessionId, id);
			if (scrapbook.lines.length) await renderActive();
		} catch (loadError) {
			scrapbookError =
				loadError instanceof Error ? loadError.message : 'Could not load the scrapbook.';
		}
	}

	/** Append a take's (or scribble's) lines to the open scrapbook. */
	async function copyLinesToScrapbook(
		name: string,
		sourceSessionId: string,
		takeId: string,
		lyrics: LyricLine[]
	) {
		const url = api.url;
		if (!url) return;
		const lines: LineRef[] = lyrics.map((_line, lineIndex) => ({
			session_id: sourceSessionId,
			take_id: takeId,
			line_index: lineIndex
		}));
		if (!lines.length) return;

		if (scrapbook && activeScrapbookId) {
			await saveScrapbook({ lines: [...scrapbook.lines, ...lines] });
			return;
		}

		scrapbookBusy = true;
		scrapbookError = null;
		try {
			const created = await createScrapbook(url, sessionId, { name, lines });
			await refreshScrapbooks(url);
			await selectScrapbook(created.scrapbook_id);
		} catch (createError) {
			scrapbookError =
				createError instanceof Error ? createError.message : 'Could not create the scrapbook.';
		} finally {
			scrapbookBusy = false;
		}
	}

	async function copyEntryToScrapbook(entry: Entry) {
		if (!entry.serverId || entry.status !== 'done') return;
		await copyLinesToScrapbook(entry.name, sessionId, entry.serverId, entry.lyrics);
	}

	async function copyScribbleToScrapbook(scribble: Scribble) {
		if (scribble.status !== 'done') return;
		await copyLinesToScrapbook(scribble.name, SCRIBBLES_SESSION_ID, scribble.id, scribble.lyrics);
	}

	async function newScrapbook() {
		const url = api.url;
		if (!url) return;
		scrapbookBusy = true;
		try {
			const created = await createScrapbook(url, sessionId, { name: newEntryName(), lines: [] });
			await refreshScrapbooks(url);
			await selectScrapbook(created.scrapbook_id);
		} catch (createError) {
			scrapbookError =
				createError instanceof Error ? createError.message : 'Could not create the scrapbook.';
		} finally {
			scrapbookBusy = false;
		}
	}

	async function removeScrapbook() {
		const url = api.url;
		if (!url || !activeScrapbookId) return;
		try {
			await deleteScrapbook(url, sessionId, activeScrapbookId);
			activeScrapbookId = '';
			scrapbook = null;
			await refreshScrapbooks(url);
		} catch (deleteError) {
			scrapbookError = deleteError instanceof Error ? deleteError.message : 'Could not delete.';
		}
	}

	async function saveScrapbook(body: { name?: string; lines?: ScrapEntry[] }) {
		const url = api.url;
		if (!url || !activeScrapbookId) return;
		scrapbookBusy = true;
		renderPending = true;
		scrapbookError = null;

		// Show the change immediately; the mix catches up once it re-renders.
		if (scrapbook) {
			scrapbook = {
				...scrapbook,
				name: body.name ?? scrapbook.name,
				lines: body.lines ?? scrapbook.lines
			};
		}

		try {
			scrapbook = await updateScrapbook(url, sessionId, activeScrapbookId, body);
			await refreshScrapbooks(url);
			await renderActive();
		} catch (saveError) {
			scrapbookError = saveError instanceof Error ? saveError.message : 'Could not save.';
			renderPending = false;
		} finally {
			scrapbookBusy = false;
		}
	}

	/** True once the server has a mix for the current lines in this mode. */
	function variantRendered(mode: 'vocals' | 'backgrounds'): boolean {
		return Boolean(scrapbook?.render?.variants?.[mode]);
	}

	/**
	 * Flip the scrapbook between the isolated-vocal mix and one that keeps each
	 * line's background. The other variant renders on demand (cached afterwards);
	 * playback keeps going on the current mix until the new one is ready.
	 */
	async function toggleBackgrounds() {
		const url = api.url;
		if (!url || !activeScrapbookId || !scrapbook || backgroundsPending) return;
		const target: 'vocals' | 'backgrounds' =
			scrapbookMode === 'backgrounds' ? 'vocals' : 'backgrounds';
		if (variantRendered(target)) {
			scrapbookMode = target;
			return;
		}
		backgroundsPending = true;
		scrapbookError = null;
		try {
			const render = await renderScrapbook(
				url,
				sessionId,
				activeScrapbookId,
				target === 'backgrounds'
			);
			scrapbook = { ...scrapbook, render };
		} catch (renderError) {
			scrapbookError =
				renderError instanceof Error ? renderError.message : 'Could not render the mix.';
		} finally {
			backgroundsPending = false;
		}
		if (variantRendered(target)) scrapbookMode = target;
	}

	async function renderActive() {
		const url = api.url;
		if (!url || !activeScrapbookId || !scrapbook?.lines.length) {
			renderPending = false;
			return;
		}
		scrapbookBusy = true;
		renderPending = true;
		try {
			const render = await renderScrapbook(
				url,
				sessionId,
				activeScrapbookId,
				scrapbookMode === 'backgrounds'
			);
			if (scrapbook) scrapbook = { ...scrapbook, render, rendered: true };
		} catch (renderError) {
			scrapbookError = renderError instanceof Error ? renderError.message : 'Could not render.';
		} finally {
			renderPending = false;
			scrapbookBusy = false;
		}
	}

	/**
	 * Keep every instance of a section identical: the instance you just edited
	 * defines the lines and order, and the other instances are rebuilt from it
	 * (each keeping its own instance id, so adjacent ones stay separate).
	 */
	function syncLinkedGroups(
		lines: LineRef[],
		sourceGroupId?: string,
		sourceIndex?: number,
		sources?: Record<string, string[]>
	): LineRef[] {
		const keyOf = (ref: LineRef): string | undefined => ref.group?.instance ?? ref.group?.id;
		const runs: {
			id: string;
			instance: string;
			start: number;
			end: number;
			lines: LineRef[];
		}[] = [];
		let index = 0;
		while (index < lines.length) {
			const group = lines[index].group;
			if (!group) {
				index++;
				continue;
			}
			const key = keyOf(lines[index]);
			const start = index;
			while (index < lines.length && keyOf(lines[index]) === key) index++;
			runs.push({
				id: group.id,
				instance: key ?? group.id,
				start,
				end: index,
				lines: lines.slice(start, index)
			});
		}
		const ids: string[] = [];
		for (const run of runs) {
			if (!ids.includes(run.id)) ids.push(run.id);
		}
		if (!ids.length) return lines;

		const canonical: Record<string, LineRef[]> = {};
		for (const id of ids) {
			const list = runs.filter((run) => run.id === id);
			let chosen: LineRef[] = list[0]?.lines ?? [];
			const edited = sources?.[id];
			if (edited?.length) {
				// The copy that was just edited defines the section. If that copy
				// is gone entirely, the section is gone from every copy too.
				chosen = list.find((run) => edited.includes(run.instance))?.lines ?? [];
			} else if (sourceGroupId === id && sourceIndex !== undefined) {
				chosen =
					list.find((run) => sourceIndex >= run.start && sourceIndex < run.end)?.lines ?? chosen;
			}
			canonical[id] = chosen;
		}

		const out: LineRef[] = [];
		index = 0;
		while (index < lines.length) {
			const group = lines[index].group;
			if (!group) {
				out.push(lines[index]);
				index++;
				continue;
			}
			const key = keyOf(lines[index]);
			while (index < lines.length && keyOf(lines[index]) === key) index++;
			const source = canonical[group.id] ?? [];
			out.push(
				...source.map((ref) => ({
					...ref,
					group: { ...group, instance: key },
					data: ref.data ? { ...ref.data } : undefined
				}))
			);
		}
		return out;
	}

	function saveLines(
		lines: LineRef[],
		sourceGroupId?: string,
		sourceIndex?: number,
		sources?: Record<string, string[]>
	) {
		const synced = syncLinkedGroups(lines, sourceGroupId, sourceIndex, sources);
		void saveScrapbook({ lines: nestEntries(synced) });
	}

	/**
	 * Snap an insertion index out of a section's run, so dropping one whole
	 * section on top of another lands beside it instead of splitting it in two.
	 */
	function snapOutsideRun(
		lines: LineRef[],
		index: number,
		group: LineRef['group'] | null | undefined
	): number {
		if (!group) return index;
		const key = group.instance ?? group.id;
		const keyOf = (ref: LineRef): string | undefined => ref.group?.instance ?? ref.group?.id;
		let start = index;
		while (start > 0 && keyOf(lines[start - 1]) === key) start--;
		let end = index;
		while (end < lines.length && keyOf(lines[end]) === key) end++;
		if (end <= start) return index;
		return index - start <= end - index ? start : end;
	}

	/**
	 * The section a drop joins, if any. Drops that should not join a section pass
	 * ``null`` (the EntryPlayer decides from where the pointer landed).
	 */
	function addLinesAt(refs: LineRef[], index?: number, group?: LineRef['group'] | null) {
		const current = scrapbook ? [...scrapbookFlat] : [];
		let at = index ?? current.length;
		let target = group ?? undefined;
		const refsHaveSection = refs.some((ref) => ref.group);
		// A section dropped on another lands beside it, never splitting it.
		if (target && refsHaveSection) {
			at = snapOutsideRun(current, at, target);
			target = undefined;
		}
		// A dragged section keeps its shared id but becomes its own instance.
		const instances: Record<string, string> = {};
		const incoming = refs.map((ref) => {
			if (ref.group) {
				if (!instances[ref.group.id]) instances[ref.group.id] = newInstanceId();
				return { ...ref, group: { ...ref.group, instance: instances[ref.group.id] } };
			}
			if (target) return { ...ref, group: target };
			return ref;
		});
		current.splice(at, 0, ...incoming);
		saveLines(current, incoming[0]?.group?.id, at);
	}

	function removeLineAt(index: number) {
		const current = scrapbook ? [...scrapbookFlat] : [];
		const sources = changedGroups(current, [index]);
		current.splice(index, 1);
		saveLines(current, undefined, undefined, sources);
	}

	/** Delete every selected line (Backspace/Delete on a selection). */
	function removeLinesAt(indices: number[]) {
		if (!scrapbook || !indices.length) return;
		const current = [...scrapbookFlat];
		const drop = indices
			.filter((index) => index >= 0 && index < current.length)
			.sort((a, b) => a - b);
		if (!drop.length) return;
		const dropSet = new Set(drop);
		const sources = changedGroups(current, drop);
		let lines = current.filter((_ref, index) => !dropSet.has(index));
		// Deleting a whole section renumbers the ones of that type that remain.
		const types = new Set(
			drop
				.map((index) => current[index]?.group?.type)
				.filter((type): type is string => Boolean(type))
		);
		for (const type of types) lines = renumberSections(lines, type);
		saveLines(lines, undefined, undefined, sources);
	}

	/** Delete a whole section (every line of the instance that was clicked). */
	function removeGroupAt(indices: number[]) {
		if (!scrapbook || !indices.length) return;
		const type = scrapbookFlat[indices[0]]?.group?.type;
		const drop: Record<number, boolean> = {};
		for (const index of indices) drop[index] = true;
		let lines = scrapbookFlat.filter((_ref, index) => !drop[index]);
		if (type) lines = renumberSections(lines, type);
		saveLines(lines);
	}

	/** True when the given indices include the whole of at least one section instance. */
	function wholeRunMoved(current: LineRef[], moving: number[], groupId: string): boolean {
		const keyOf = (ref: LineRef): string | undefined => ref.group?.instance ?? ref.group?.id;
		const set: Record<number, boolean> = {};
		for (const index of moving) set[index] = true;
		let index = 0;
		while (index < current.length) {
			if (current[index].group?.id !== groupId) {
				index++;
				continue;
			}
			const key = keyOf(current[index]);
			const start = index;
			while (index < current.length && keyOf(current[index]) === key) index++;
			let complete = true;
			for (let step = start; step < index; step++) {
				if (!set[step]) {
					complete = false;
					break;
				}
			}
			if (complete) return true;
		}
		return false;
	}

	/**
	 * Sections whose definition changed because one of ``indices`` left them (or
	 * moved within them) rather than the whole run relocating. Those copies
	 * become the canonical content for every linked twin.
	 */
	function changedGroups(current: LineRef[], indices: number[]): Record<string, string[]> {
		const sources: Record<string, string[]> = {};
		for (const index of indices) {
			const group = current[index]?.group;
			if (!group?.id) continue;
			if (wholeRunMoved(current, indices, group.id)) continue;
			const instance = group.instance ?? group.id;
			(sources[group.id] ??= []).push(instance);
		}
		return sources;
	}

	/**
	 * Move (or, with ``copy``, duplicate) the selected indices so they land before
	 * ``to``. A copied section becomes its own linked instance.
	 */
	function moveLines(from: number[], to: number, group?: LineRef['group'] | null, copy = false) {
		const current = scrapbook ? [...scrapbookFlat] : [];
		const valid = from
			.filter((index) => index >= 0 && index < current.length)
			.sort((a, b) => a - b);
		if (!valid.length) return;

		const moving = valid.map((index) => current[index]);
		const removedBefore = copy ? 0 : valid.filter((index) => index < to).length;
		const remaining = copy
			? [...current]
			: current.filter((_line, index) => !valid.includes(index));
		let target = Math.max(0, Math.min(remaining.length, to - removedBefore));

		const movingIds: string[] = [];
		for (const ref of moving) {
			if (ref.group?.id && !movingIds.includes(ref.group.id)) movingIds.push(ref.group.id);
		}
		// Moving a whole section (dragging its label/body) relocates it beside any
		// section it is dropped on, keeping its own identity. Moving individual
		// lines joins the section they are dropped in (or leaves one they left).
		const wholeSections =
			movingIds.length > 0 && movingIds.every((id) => wholeRunMoved(current, valid, id));
		let destination = group ?? undefined;
		if (destination && wholeSections) {
			target = snapOutsideRun(remaining, target, destination);
			destination = undefined;
		}
		// A copied section gets a fresh instance id (same group id), so it stays a
		// linked twin of the original and edits to either update both.
		const copyInstances: Record<string, string> = {};
		const placed = moving.map((ref) => {
			if (copy) {
				if (destination) return { ...ref, group: destination };
				if (ref.group && wholeRunMoved(current, valid, ref.group.id)) {
					if (!copyInstances[ref.group.id]) copyInstances[ref.group.id] = newInstanceId();
					return { ...ref, group: { ...ref.group, instance: copyInstances[ref.group.id] } };
				}
				return {
					session_id: ref.session_id,
					take_id: ref.take_id,
					line_index: ref.line_index,
					data: ref.data
				};
			}
			if (destination) return { ...ref, group: destination };
			const id = ref.group?.id;
			if (id && !wholeRunMoved(current, valid, id)) {
				return {
					session_id: ref.session_id,
					take_id: ref.take_id,
					line_index: ref.line_index,
					data: ref.data
				};
			}
			return ref;
		});
		remaining.splice(target, 0, ...placed);
		const sources = copy ? undefined : changedGroups(current, valid);
		saveLines(remaining, destination?.id ?? placed[0]?.group?.id, target, sources);
	}

	function onScrapbookDrop(event: DragEvent) {
		event.preventDefault();
		dragOverScrapbook = false;
		const payload = event.dataTransfer?.getData('application/x-catchy-lines');
		if (!payload) return;
		try {
			const refs: unknown = JSON.parse(payload);
			if (Array.isArray(refs)) addLinesAt(refs as LineRef[]);
		} catch {
			/* ignore malformed drag data */
		}
	}

	/** Double-clicked a line's text in the journal; persist the display override. */
	async function editLine(entry: Entry, index: number, text: string) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		const trimmed = text.trim();
		updateEntry(entry.localId, {
			edited: true,
			lyrics: entry.lyrics.map((line, lineIndex) =>
				lineIndex === index ? { ...line, text: trimmed } : line
			)
		});
		try {
			const updated = await updateLineText(url, sessionId, entry.serverId, index, trimmed);
			updateEntry(entry.localId, {
				lyrics: entry.lyrics.map((line, lineIndex) => (lineIndex === index ? updated : line))
			});
		} catch (editError) {
			error = editError instanceof Error ? editError.message : 'Could not save the line.';
		}
	}

	/**
	 * Ctrl-clicked a scrapbook line: reveal the recording it came from. Switch to
	 * the tab that holds it (Bookmarked, Scribbles, or All entries), expand the
	 * entry, then scroll to and flash the line.
	 */
	async function locateScrapbookLine(index: number) {
		const ref = scrapbookFlat[index];
		if (!ref) return;

		if (ref.session_id === SCRIBBLES_SESSION_ID) {
			tab = 'scribbles';
			expandedScribbles[ref.take_id] = true;
		} else {
			const entry = entries.find((candidate) => candidate.serverId === ref.take_id);
			if (!entry) return; // the line came from another session; not shown here
			tab = entry.bookmarked ? 'bookmarked' : 'all';
			expandedEntries[entry.localId] = true;
		}

		// Let Svelte swap tabs/expand the entry before we look for the bubble.
		await tick();
		requestAnimationFrame(() => flashLine(ref.take_id, ref.line_index));
	}

	/** Scroll a rendered line into view and briefly ring it. */
	function flashLine(takeId: string, lineIndex: number) {
		const host = document.querySelector<HTMLElement>(`[data-take-id="${takeId}"]`);
		const bubble = host?.querySelector<HTMLElement>(`[data-line-index="${lineIndex}"]`);
		if (!bubble) return;
		bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
		bubble.classList.add('ring-2', 'ring-amber-500');
		window.setTimeout(() => bubble.classList.remove('ring-2', 'ring-amber-500'), 1200);
	}

	/** Per-entry request counter, so a slow older response can't clobber a newer edit. */
	const lyricEditSeq: Record<string, number> = {};

	/**
	 * Apply a new segmentation to a take. The UI updates immediately; the server
	 * is told in the background (it recomputes BPM) and only the newest edit wins.
	 */
	function applyLyrics(entry: Entry, lines: LyricLine[]) {
		const previous = entry.lyrics;
		updateEntry(entry.localId, { lyrics: lines, edited: true });

		const url = api.url;
		const takeId = entry.serverId;
		if (!url || !takeId) return;

		const seq = (lyricEditSeq[entry.localId] ?? 0) + 1;
		lyricEditSeq[entry.localId] = seq;
		void (async () => {
			try {
				const updated = await updateLyrics(url, sessionId, takeId, lyricsPayload(lines));
				if (lyricEditSeq[entry.localId] === seq) {
					updateEntry(entry.localId, { lyrics: updated });
				}
			} catch (editError) {
				if (lyricEditSeq[entry.localId] === seq) {
					updateEntry(entry.localId, { lyrics: previous });
				}
				error = editError instanceof Error ? editError.message : 'Could not save the lines.';
			}
		})();
	}

	/** Ctrl-clicked: merge the selection into one raw (bubble-less) line, then carve. */
	function mergeSelectedLines(entry: Entry, indices: number[]) {
		const next = mergeSelected(entry.lyrics, indices);
		if (next) applyLyrics(entry, next);
	}

	/** Dragged across words of a raw line: those words become a bubble, the rest
	 *  stays raw so you can keep carving. */
	function carveLine(entry: Entry, index: number, from: number, to: number) {
		const next = carve(entry.lyrics, index, from, to);
		if (next) applyLyrics(entry, next);
	}

	/** Flatten section groups into the flat list the editor works on. */
	function flattenEntries(entries: ScrapEntry[]): LineRef[] {
		const out: LineRef[] = [];
		const seen: Record<string, boolean> = {};
		entries.forEach((entry, entryIndex) => {
			if ('lines' in entry) {
				let instance = entry.group.instance;
				if (!instance || seen[instance]) instance = `e${entryIndex}-${instance ?? ''}`;
				seen[instance] = true;
				const group = { ...entry.group, instance };
				for (const line of entry.lines) out.push({ ...line, group });
			} else {
				out.push(entry);
			}
		});
		return out;
	}

	/** Fold consecutive lines of one section *instance* back into group entries. */
	function nestEntries(flat: LineRef[]): ScrapEntry[] {
		const out: ScrapEntry[] = [];
		const keyOf = (ref: LineRef): string | undefined => ref.group?.instance ?? ref.group?.id;
		let index = 0;
		while (index < flat.length) {
			const group = flat[index].group;
			if (!group) {
				out.push(flat[index]);
				index++;
				continue;
			}
			const key = keyOf(flat[index]);
			const lines: LineRef[] = [];
			while (index < flat.length && keyOf(flat[index]) === key) {
				const ref = flat[index];
				lines.push({
					session_id: ref.session_id,
					take_id: ref.take_id,
					line_index: ref.line_index,
					data: ref.data
				});
				index++;
			}
			out.push({ group: { ...group }, lines });
		}
		return out;
	}

	function newInstanceId(): string {
		return `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	}

	let scrapbookFlat = $derived(scrapbook ? flattenEntries(scrapbook.lines) : []);

	/** True when the stored render's lines match the scrapbook's current lines. */
	function renderMatchesLines(book: Scrapbook | null): boolean {
		const timeline = book?.render?.timeline;
		const flat = book ? flattenEntries(book.lines) : [];
		if (!book || !timeline?.length || timeline.length !== flat.length) return false;
		return flat.every((ref, index) => {
			const source = timeline[index].source;
			return (
				source &&
				source.session_id === ref.session_id &&
				source.take_id === ref.take_id &&
				source.line_index === ref.line_index
			);
		});
	}

	let renderInSync = $derived(!renderPending && renderMatchesLines(scrapbook));
	let scrapbookLoading = $derived(Boolean(scrapbookFlat.length) && !renderInSync);

	function sourceKey(ref: { session_id: string; take_id: string; line_index: number }): string {
		return `${ref.session_id}|${ref.take_id}|${ref.line_index}`;
	}

	/**
	 * The bubbles to show, always in the scrapbook's line order. Each line reuses
	 * its rendered words when the render has one, so a reorder only moves bubbles
	 * around — it never restyles them. Lines with no render yet (e.g. freshly
	 * added) fall back to a plain text bubble until the mix catches up.
	 */
	function scrapbookLinesFor(): LyricLine[] {
		const book = scrapbook;
		if (!book) return [];
		const timeline = book.render?.timeline ?? [];
		// When the render is in sync it is one timeline entry per line occurrence,
		// so index it directly — repeated copies of the same clip then each get
		// their own time instead of collapsing onto one.
		const byIndex = timeline.length === scrapbookFlat.length && renderMatchesLines(book);
		const rendered: Record<string, LyricLine> = {};
		if (!byIndex) {
			for (const line of timeline) {
				if (line.source) rendered[sourceKey(line.source)] = line;
			}
		}
		return withDuplicateTags(
			scrapbookFlat.map((ref, index) => {
				const base = byIndex ? timeline[index] : rendered[sourceKey(ref)];
				const dataWords = ref.data?.words ?? [];
				const label =
					(ref.data?.text && ref.data.text.trim()) ||
					dataWords
						.map((word) => word.word)
						.join(' ')
						.trim();
				return {
					bpm: base?.bpm ?? ref.data?.bpm ?? 0,
					'start time': base?.['start time'] ?? 0,
					'end time': base?.['end time'] ?? 0,
					words: base?.words ?? dataWords,
					// The text comes from the line's snapshot, so re-splitting the
					// journal never changes a scrapbook that already holds it.
					text: label || `Line ${ref.line_index + 1}`,
					group: ref.group
				};
			})
		);
	}

	/** Compare lyric text ignoring case and punctuation (so "Hello!" == "hello"). */
	function normalizeLyricText(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	/**
	 * Tag lines that share the same words but come from a different recording, so
	 * the two are told apart. Copies of the *same* clip all share a number; a
	 * word sung once (however many times it is copied) stays unnumbered.
	 */
	function withDuplicateTags(lines: LyricLine[]): LyricLine[] {
		const sourcesByText: Record<string, string[]> = {};
		lines.forEach((line, index) => {
			const text = normalizeLyricText(line.text ?? '');
			if (!text) return;
			const source = sourceKey(scrapbookFlat[index]);
			const sources = sourcesByText[text] ?? [];
			if (!sources.includes(source)) sources.push(source);
			sourcesByText[text] = sources;
		});
		return lines.map((line, index) => {
			const sources = sourcesByText[normalizeLyricText(line.text ?? '')];
			if (!sources || sources.length < 2) return line;
			return { ...line, tag: sources.indexOf(sourceKey(scrapbookFlat[index])) + 1 };
		});
	}

	let scrapbookLines = $derived(scrapbookLinesFor());

	/** Pretty names for section types. */
	const SECTION_LABELS: Record<string, string> = {
		chorus: 'Chorus',
		verse: 'Verse',
		bridge: 'Bridge',
		'pre-chorus': 'Pre-chorus',
		tag: 'Tag',
		intro: 'Intro',
		outro: 'Outro',
		other: 'Other'
	};

	/**
	 * Rename every section of ``type`` so the first is ``Type`` (when alone) or
	 * ``Type 1``, ``Type 2``… as soon as there is more than one. ``other`` is
	 * excluded: it is named by hand.
	 */
	function renumberSections(lines: LineRef[], type: string): LineRef[] {
		if (type === 'other') return lines;
		const ids: string[] = [];
		for (const ref of lines) {
			if (ref.group?.type === type && !ids.includes(ref.group.id)) ids.push(ref.group.id);
		}
		const label = SECTION_LABELS[type] ?? 'Section';
		const names: Record<string, string> = {};
		ids.forEach((id, index) => {
			names[id] = ids.length > 1 ? `${label} ${index + 1}` : label;
		});
		return lines.map((ref) =>
			ref.group && names[ref.group.id]
				? { ...ref, group: { ...ref.group, name: names[ref.group.id] } }
				: ref
		);
	}

	/** Group a contiguous run of scrapbook lines under a section type. */
	function groupScrapbookLines(indices: number[], type: string, name?: string) {
		if (!scrapbook || !indices.length) return;
		const low = Math.min(...indices);
		const high = Math.max(...indices);
		const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		let lines = scrapbookFlat.map((ref, index) =>
			index >= low && index <= high
				? { ...ref, group: { id, type, instance: id, ...(name ? { name } : {}) } }
				: ref
		);
		lines = renumberSections(lines, type);
		saveLines(lines);
	}

	/** Break one section instance back into plain lines (others stay grouped). */
	function ungroupScrapbookLines(indices: number[]) {
		if (!scrapbook || !indices.length) return;
		const type = scrapbookFlat[indices[0]]?.group?.type;
		const drop: Record<number, boolean> = {};
		for (const index of indices) drop[index] = true;
		let lines = scrapbookFlat.map((ref, index) => {
			if (!drop[index]) return ref;
			return {
				session_id: ref.session_id,
				take_id: ref.take_id,
				line_index: ref.line_index,
				data: ref.data
			};
		});
		if (type) lines = renumberSections(lines, type);
		saveLines(lines);
	}

	/** Rename one section (every instance of it). */
	function renameScrapbookGroup(groupId: string, name: string) {
		if (!scrapbook) return;
		const trimmed = name.trim();
		if (!trimmed) return;
		const lines = scrapbookFlat.map((ref) =>
			ref.group?.id === groupId ? { ...ref, group: { ...ref.group, name: trimmed } } : ref
		);
		saveLines(lines);
	}

	let scrapbookSrc = $derived.by(() => {
		const render = scrapbook?.render;
		if (!api.url || !sessionId || !activeScrapbookId || !render || !renderInSync) return '';
		const info = render.variants?.[scrapbookMode];
		if (!info) return '';
		const version = encodeURIComponent(info.rendered_at ?? '');
		const backgrounds = scrapbookMode === 'backgrounds' ? '&backgrounds=true' : '';
		return `${scrapbookAudioUrl(api.url, sessionId, activeScrapbookId)}?v=${version}${backgrounds}`;
	});
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

<main class="flex min-h-dvh flex-col bg-white text-neutral-900 lg:h-dvh lg:overflow-hidden">
	<header class="flex items-start justify-between gap-4 border-b border-neutral-100 px-6 py-3">
		<div class="min-w-0">
			<a
				href={resolve('/')}
				class="text-[11px] font-medium tracking-wide text-neutral-400 uppercase hover:text-neutral-700"
			>
				Catchy Catcher
			</a>
			{#if renamingSession}
				<form onsubmit={commitSessionRename} class="mt-0.5 flex items-center gap-1">
					<input
						bind:value={sessionNameDraft}
						aria-label="Session name"
						class="min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-lg font-semibold focus:border-neutral-500 focus:outline-none"
					/>
					<button
						type="submit"
						class="shrink-0 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-800"
					>
						Save
					</button>
					<button
						type="button"
						onclick={() => (renamingSession = false)}
						class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
					>
						Cancel
					</button>
				</form>
			{:else}
				<button
					type="button"
					onclick={beginSessionRename}
					title="Rename session"
					class="block max-w-full truncate text-left text-xl font-semibold tracking-tight hover:text-neutral-600"
				>
					{sessionName || 'Session'}
				</button>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-3">
			<a href={resolve('/')} class="text-xs text-neutral-500 hover:text-neutral-900">
				All sessions
			</a>
		</div>
	</header>

	<div class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-5 sm:px-6 lg:min-h-0">
		{#if !ready}
			<p class="text-sm text-neutral-400">Loading…</p>
		{:else if connection.status === 'checking'}
			<p class="text-sm text-neutral-500">Connecting…</p>
		{:else if !api.url}
			<div class="space-y-2 text-center">
				<p class="text-sm text-neutral-500">Not connected to a processing server.</p>
				<a href={resolve('/')} class="text-sm font-medium text-neutral-900 underline">
					Connect with a share code
				</a>
			</div>
		{:else if !sessionId}
			<p class="text-sm text-neutral-500">No session selected.</p>
		{:else}
			<!-- Recorder bar (kept last so it sits below the panels) -->
			<section
				class="order-last flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5"
			>
				{#if recorderFailed}
					<p class="text-sm text-red-600">{recorderError}</p>
					<button
						onclick={() => startRecording()}
						class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
					>
						Try again
					</button>
				{:else if recording}
					<span class="size-2.5 animate-pulse rounded-full bg-red-600"></span>
					<span class="text-sm font-medium">
						Recording{micSource === 'shared' ? ' · shared mic' : ''}
					</span>
					<span class="font-mono text-sm text-neutral-500">{formatElapsed(elapsed)}</span>
					<span class="ml-auto text-xs text-neutral-500">
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Space</kbd> keep
						&amp; process ·
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Enter</kbd> keep raw
						·
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Delete</kbd> scrap
					</span>
					<button
						onclick={stopRecording}
						class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
					>
						Stop
					</button>
				{:else if sharedMic.present}
					<button
						onclick={() => startRecording('computer')}
						class="rounded-full border border-neutral-300 bg-white px-4 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100"
					>
						Use computer mic
					</button>
					<button
						onclick={() => startRecording('shared')}
						class="rounded-full bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
					>
						Use shared mic
					</button>
					<span class="text-xs text-neutral-500">A phone is sharing its microphone.</span>
				{:else}
					<button
						onclick={() => startRecording()}
						class="rounded-full bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
					>
						Start recording
					</button>
					<span class="text-xs text-neutral-500">
						Sing, then <kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5"
							>Space</kbd
						>
						keeps &amp; processes a phrase,
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Enter</kbd>
						keeps it raw,
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Delete</kbd> scraps it.
					</span>
				{/if}
			</section>

			{#if error}
				<p class="text-center text-xs text-red-600">{error}</p>
			{/if}

			<div bind:this={splitEl} class="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row lg:gap-0">
				<!-- Scrapbook (left) -->
				<section
					class="order-2 flex flex-col gap-3 lg:order-1 lg:min-h-0 lg:w-[var(--split)] lg:min-w-0 lg:shrink-0 lg:overflow-y-auto lg:pr-4"
					style="--split:{splitPercent}%"
				>
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-xs font-medium tracking-wide text-neutral-500 uppercase">Scrapbook</h2>
						<div class="flex items-center gap-1">
							<button
								onclick={newScrapbook}
								disabled={scrapbookBusy}
								class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
							>
								New
							</button>
							<button
								onclick={removeScrapbook}
								disabled={scrapbookBusy || !activeScrapbookId}
								class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
							>
								Delete
							</button>
						</div>
					</div>

					<!-- One field: type to rename the open scrapbook, or open the list to switch. -->
					<div class="relative">
						<input
							bind:value={scrapbookNameDraft}
							oninput={() => (scrapbookMenuOpen = true)}
							onfocus={() => (scrapbookMenuOpen = true)}
							onkeydown={onScrapbookNameKeydown}
							onblur={commitScrapbookName}
							placeholder="Scrapbook name"
							aria-label="Scrapbook name"
							class="w-full rounded-lg border border-neutral-300 bg-white py-2 pr-9 pl-3 text-sm focus:border-neutral-500 focus:outline-none"
						/>
						<button
							type="button"
							tabindex="-1"
							aria-label="Show scrapbooks"
							onmousedown={(event) => event.preventDefault()}
							onclick={() => (scrapbookMenuOpen = !scrapbookMenuOpen)}
							class="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-lg text-neutral-400 hover:text-neutral-700"
						>
							<svg viewBox="0 0 24 24" class="size-4 fill-current" aria-hidden="true">
								<path d="m7 10 5 5 5-5z" />
							</svg>
						</button>
						{#if scrapbookMenuOpen && scrapbooks.length > 1}
							<ul
								class="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
							>
								{#each scrapbooks as item (item.scrapbook_id)}
									<li>
										<button
											type="button"
											onmousedown={(event) => event.preventDefault()}
											onclick={() => chooseScrapbook(item)}
											class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm {item.scrapbook_id ===
											activeScrapbookId
												? 'bg-neutral-100 font-medium'
												: 'hover:bg-neutral-50'}"
										>
											<span class="truncate">{item.name}</span>
											<span class="shrink-0 text-xs text-neutral-400">{item.line_count}</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					{#if scrapbookError}
						<p class="text-xs text-red-600">{scrapbookError}</p>
					{/if}

					{#if scrapbook}
						<!-- Lines live in the player: drag to add/reorder, × to remove -->
						{#if scrapbookFlat.length === 0}
							<div
								role="list"
								aria-label="Scrapbook lines"
								class="min-h-40 rounded-xl border-2 border-dashed px-3 py-3 transition-colors {dragOverScrapbook
									? 'border-neutral-900 bg-neutral-50'
									: 'border-neutral-200 bg-neutral-50/50'}"
								ondragover={(event) => {
									event.preventDefault();
									dragOverScrapbook = true;
								}}
								ondragleave={() => (dragOverScrapbook = false)}
								ondrop={onScrapbookDrop}
							>
								<p class="py-6 text-center text-xs text-neutral-400">
									Drag lines here from a journal entry, or use that entry's “To scrapbook”.
								</p>
							</div>
						{:else}
							<button
								type="button"
								role="switch"
								aria-checked={scrapbookMode === 'backgrounds'}
								onclick={toggleBackgrounds}
								disabled={backgroundsPending || scrapbookBusy}
								title="Play the mix with the background music behind each line"
								class="flex items-center gap-2 self-start rounded-full border px-3 py-1 text-xs font-medium transition-colors {scrapbookMode ===
								'backgrounds'
									? 'border-neutral-900 bg-neutral-900 text-white'
									: 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-100'} disabled:cursor-not-allowed disabled:opacity-60"
							>
								<span
									class="size-2 rounded-full {scrapbookMode === 'backgrounds'
										? 'bg-white'
										: 'bg-neutral-300'}"
									aria-hidden="true"
								></span>
								{#if backgroundsPending}
									Rendering backgrounds…
								{:else if scrapbookMode === 'backgrounds'}
									Backgrounds on
								{:else}
									Backgrounds off
								{/if}
							</button>
							<EntryPlayer
								src={scrapbookSrc}
								lyrics={scrapbookLines}
								loading={scrapbookLoading}
								downloadName={scrapbook.name}
								allowReorder
								onDropLines={(refs, index, group) => addLinesAt(refs as LineRef[], index, group)}
								onMoveLines={moveLines}
								onRemove={removeLineAt}
								onRemoveSelected={removeLinesAt}
								onRemoveGroup={removeGroupAt}
								onLocateLine={locateScrapbookLine}
								onGroupLines={groupScrapbookLines}
								onUngroup={ungroupScrapbookLines}
								lineRef={(index) => scrapbookFlat[index] ?? null}
								onRenameGroup={renameScrapbookGroup}
							/>
							{#if !scrapbook.render?.timeline?.length && !scrapbookBusy}
								<button
									onclick={renderActive}
									class="self-start rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800"
								>
									Render mix
								</button>
							{:else if scrapbookBusy}
								<p class="text-xs text-neutral-400">Rendering…</p>
							{/if}
						{/if}
					{/if}
				</section>

				<!-- Draggable divider: give either side more room. -->
				<button
					type="button"
					aria-label="Resize scrapbook and journal"
					title="Drag to resize"
					class="group relative hidden w-3 shrink-0 cursor-col-resize touch-none select-none lg:order-2 lg:block"
					onpointerdown={startResize}
					onpointermove={moveResize}
					onpointerup={endResize}
					onpointercancel={endResize}
					onkeydown={(event) => {
						if (event.key === 'ArrowLeft') {
							event.preventDefault();
							nudgeResize(-2);
						} else if (event.key === 'ArrowRight') {
							event.preventDefault();
							nudgeResize(2);
						}
					}}
				>
					<span
						class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors {resizing
							? 'bg-neutral-900'
							: 'bg-neutral-200 group-hover:bg-neutral-400'}"
					></span>
				</button>

				<!-- Journal (right) -->
				<section
					class="order-1 flex flex-col gap-3 lg:order-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pl-4"
				>
					<div class="flex items-center justify-between gap-2">
						<div class="flex items-center gap-1">
							<button
								onclick={() => (tab = 'all')}
								class="rounded-md px-2.5 py-1 text-xs font-medium {tab === 'all'
									? 'bg-neutral-900 text-white'
									: 'text-neutral-500 hover:bg-neutral-100'}"
							>
								All entries
							</button>
							<button
								onclick={() => (tab = 'bookmarked')}
								class="rounded-md px-2.5 py-1 text-xs font-medium {tab === 'bookmarked'
									? 'bg-neutral-900 text-white'
									: 'text-neutral-500 hover:bg-neutral-100'}"
							>
								Bookmarked
							</button>
							<button
								onclick={() => (tab = 'scribbles')}
								class="rounded-md px-2.5 py-1 text-xs font-medium {tab === 'scribbles'
									? 'bg-neutral-900 text-white'
									: 'text-neutral-500 hover:bg-neutral-100'}"
							>
								Scribbles
							</button>
						</div>
						<span class="text-xs text-neutral-400">
							{tab === 'scribbles'
								? `${scribbles.length} scribbles`
								: `${visibleEntries.length} entries`}
						</span>
					</div>

					{#if tab === 'scribbles'}
						<!-- Scribbles: a journal shared across every session. Made on the homepage. -->
						{#if scribbleError}
							<p class="text-xs text-red-600">{scribbleError}</p>
						{/if}
						{#if scribbles.length === 0}
							<p
								class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400"
							>
								{scribblesLoading
									? 'Loading scribbles…'
									: 'No scribbles yet — make them from the homepage.'}
							</p>
						{:else}
							<ul class="space-y-3">
								{#each scribbles as scribble (scribble.id)}
									<li
										data-take-id={scribble.id}
										class="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3"
									>
										<div class="flex items-center justify-between gap-3">
											<div class="flex min-w-0 flex-1 items-center gap-2">
												<button
													type="button"
													onclick={() => toggleScribble(scribble.id)}
													aria-expanded={Boolean(expandedScribbles[scribble.id])}
													aria-label={expandedScribbles[scribble.id]
														? 'Collapse scribble'
														: 'Expand scribble'}
													title={expandedScribbles[scribble.id] ? 'Collapse' : 'Expand'}
													class="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
												>
													<svg
														viewBox="0 0 24 24"
														class="size-4 transition-transform {expandedScribbles[scribble.id]
															? 'rotate-90'
															: ''}"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														stroke-linecap="round"
														stroke-linejoin="round"
														aria-hidden="true"
													>
														<path d="m9 6 6 6-6 6" />
													</svg>
												</button>
												<span class="font-mono text-xs text-neutral-400"
													>{String(scribble.index).padStart(2, '0')}</span
												>
												<span class="truncate text-sm font-medium text-neutral-800"
													>{scribble.name}</span
												>
												{#if scribble.status === 'processing'}
													<span class="shrink-0 text-xs text-neutral-400">Processing…</span>
												{:else if scribble.status === 'recorded'}
													<span class="shrink-0 text-xs text-neutral-400">Unprocessed</span>
												{:else if scribble.status === 'error'}
													<span class="shrink-0 text-xs text-red-600">Failed</span>
												{/if}
											</div>
											<div class="flex shrink-0 items-center gap-1">
												{#if scribble.status === 'recorded'}
													<button
														onclick={() => processScribbleEntry(scribble)}
														class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
													>
														Process
													</button>
												{:else if scribble.kind === 'audio' && scribble.status === 'done'}
													<button
														onclick={() => copyScribbleToScrapbook(scribble)}
														disabled={scrapbookBusy}
														title="Copy this scribble's lines to the open scrapbook"
														class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"
													>
														To scrapbook
													</button>
												{/if}
											</div>
										</div>

										{#if scribble.error}
											<p class="text-xs text-red-600">{scribble.error}</p>
										{/if}

										{#if expandedScribbles[scribble.id]}
											{#if scribble.kind === 'text'}
												<div class="space-y-1.5">
													{#each scribble.lyrics as line, lineIndex (lineIndex)}
														<div
															class="rounded-lg border border-dashed border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800"
														>
															{line.text ?? ''}
														</div>
													{/each}
												</div>
											{:else if scribble.status === 'done' && scribbleAudio(scribble)}
												<EntryPlayer
													src={scribbleAudio(scribble)}
													lyrics={scribble.lyrics}
													framed={false}
													downloadName={scribble.name}
													dragLine={(lineIndex) => scribbleLineRef(scribble, lineIndex)}
												/>
											{:else if scribbleAudio(scribble)}
												<EntryPlayer
													src={scribbleAudio(scribble)}
													lyrics={[]}
													emptyLabel={null}
													framed={false}
													downloadName={scribble.name}
												/>
											{/if}
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{:else if visibleEntries.length === 0}
						<p
							class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400"
						>
							{tab === 'bookmarked'
								? 'No bookmarked entries yet. Star an entry to keep it here.'
								: 'Nothing yet — start recording and keep a phrase.'}
						</p>
					{:else}
						<ul class="space-y-3">
							{#each visibleEntries as entry (entry.localId)}
								<li
									data-take-id={entry.serverId ?? undefined}
									class="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3"
								>
									<div class="flex items-center justify-between gap-3">
										<div class="flex min-w-0 flex-1 items-center gap-2">
											<button
												type="button"
												onclick={() => toggleEntry(entry.localId)}
												aria-expanded={Boolean(expandedEntries[entry.localId])}
												aria-label={expandedEntries[entry.localId]
													? 'Collapse entry'
													: 'Expand entry'}
												title={expandedEntries[entry.localId] ? 'Collapse' : 'Expand'}
												class="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
											>
												<svg
													viewBox="0 0 24 24"
													class="size-4 transition-transform {expandedEntries[entry.localId]
														? 'rotate-90'
														: ''}"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													aria-hidden="true"
												>
													<path d="m9 6 6 6-6 6" />
												</svg>
											</button>
											<span class="font-mono text-xs text-neutral-400"
												>{String(entry.index).padStart(2, '0')}</span
											>
											{#if editingId === entry.localId}
												<form
													onsubmit={handleRename}
													class="flex min-w-0 flex-1 items-center gap-1"
												>
													<input
														bind:value={nameDraft}
														aria-label="Entry name"
														class="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
													/>
													<button
														type="submit"
														class="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white"
													>
														Save
													</button>
													<button
														type="button"
														onclick={cancelRename}
														class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
													>
														Cancel
													</button>
												</form>
											{:else}
												<button
													onclick={() => entry.serverId && beginRename(entry)}
													disabled={!entry.serverId}
													title={entry.serverId ? 'Rename entry' : entry.name}
													class="truncate text-sm font-medium text-neutral-800 hover:text-neutral-950 disabled:cursor-default"
												>
													{entry.name}
												</button>
												{#if entry.status === 'processing'}
													<span class="shrink-0 text-xs text-neutral-400">Processing…</span>
												{:else if entry.status === 'recorded'}
													<span class="shrink-0 text-xs text-neutral-400">Unprocessed</span>
												{:else if entry.status === 'error'}
													<span class="shrink-0 text-xs text-red-600">Failed</span>
												{/if}
											{/if}
										</div>
										<div class="flex shrink-0 items-center gap-1">
											<button
												onclick={() => toggleBookmark(entry)}
												title={entry.bookmarked ? 'Remove bookmark' : 'Bookmark entry'}
												aria-label={entry.bookmarked ? 'Remove bookmark' : 'Bookmark entry'}
												class="rounded-md px-1.5 py-1 text-sm {entry.bookmarked
													? 'text-amber-500'
													: 'text-neutral-300 hover:text-neutral-500'}"
											>
												{entry.bookmarked ? '★' : '☆'}
											</button>
											{#if entry.status === 'recorded'}
												<button
													onclick={() => processEntry(entry)}
													class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
												>
													Process
												</button>
											{:else if entry.status === 'done'}
												<button
													onclick={() => copyEntryToScrapbook(entry)}
													disabled={scrapbookBusy}
													title="Copy this entry's lines to a scrapbook"
													class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
												>
													To scrapbook
												</button>
											{/if}
											{#if entry.status === 'done' && entry.edited}
												<button
													onclick={() => resetEntryLyrics(entry)}
													title="Restore the lines the computer detected"
													class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
												>
													Reset
												</button>
											{/if}
											<button
												onclick={() => removeEntry(entry)}
												class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600"
											>
												Delete
											</button>
										</div>
									</div>

									{#if entry.error}
										<p class="text-xs text-red-600">{entry.error}</p>
									{/if}

									{#if expandedEntries[entry.localId]}
										{#if entry.status === 'done' && entryAudio(entry)}
											<EntryPlayer
												src={entryAudio(entry)}
												lyrics={entry.lyrics}
												framed={false}
												downloadName={entry.name}
												dragLine={(lineIndex) => journalLineRef(entry, lineIndex)}
												onEditLine={(lineIndex, text) => editLine(entry, lineIndex, text)}
												onMergeSelected={(indices) => mergeSelectedLines(entry, indices)}
												onCarve={(lineIndex, from, to) => carveLine(entry, lineIndex, from, to)}
											/>
										{:else if entryAudio(entry)}
											<EntryPlayer
												src={entryAudio(entry)}
												lyrics={[]}
												emptyLabel={null}
												framed={false}
												downloadName={entry.name}
											/>
										{/if}
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>
		{/if}
	</div>
</main>
