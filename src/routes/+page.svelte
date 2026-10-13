<script lang="ts">
	import { tick } from 'svelte';
	import { goto, pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		createTextScribble,
		deleteScribble,
		deleteSession,
		disconnect,
		establish,
		getScribble,
		listScribbles,
		processScribble,
		refreshSessions,
		renameScribble as renameScribbleApi,
		renameSession,
		retry,
		scribbleAudioUrl,
		startNewSession,
		subscribeChanges,
		updateScribbleLineText,
		updateScribbleLyrics,
		updateTextScribble,
		uploadScribble,
		type LyricLine,
		type TakeMeta
	} from '#lib/connection.svelte.ts';
	import { carve, lyricsPayload, mergeSelected } from '#lib/lyrics.ts';
	import { parseShareInput, toHref } from '#lib/share.ts';
	import { formatSessionDate, newEntryName, newTakeId, type Session } from '#lib/session.ts';
	import { extensionForMime, Recorder } from '#lib/recorder.svelte.ts';
	import EntryPlayer from '#lib/components/EntryPlayer.svelte';

	type ScribbleStatus = 'recorded' | 'processing' | 'done' | 'error';

	/** A scribble: a journal take shared across every session. */
	type Scribble = {
		id: string;
		index: number;
		name: string;
		kind: 'audio' | 'text';
		status: ScribbleStatus;
		lyrics: LyricLine[];
		error?: string | null;
	};

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let input = $state('');
	let error = $state<string | null>(null);
	let submitting = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	/** The id of the session being renamed, or null when none is. */
	let editingId = $state<string | null>(null);
	let nameDraft = $state('');
	/** The id of the session awaiting delete confirmation, or null. */
	let confirmingId = $state<string | null>(null);

	/** Scribbles: a journal shared across every session, recorded here. */
	let scribbles = $state<Scribble[]>([]);
	let scribblesLoading = $state(false);
	let scribbleError = $state<string | null>(null);
	let nextScribbleIndex = $state(1);
	let scribbleBusy = $state(false);
	let editingScribbleId = $state<string | null>(null);
	let scribbleNameDraft = $state('');
	/** Whether the whole Scribbles section is shown. */
	let scribblesOpen = $state(true);
	/** Whether the Sessions list is shown (collapsed by default on phones). */
	let sessionsOpen = $state(true);
	let sessionsDefaulted = false;

	const recorder = new Recorder();
	let segmentStartedAt = $state(0);
	let elapsed = $state(0);
	let scribblesLoadedFor = '';

	// Effects never run on the server, so this is our "read the url on load" hook.
	// Reading page.url keeps it reactive: back/forward re-resolves for free, and
	// `bootstrap` also falls back to the connection saved from last time.
	$effect(() => {
		bootstrap(page.url.searchParams);
		ready = true;
	});

	// Our generated ids sort chronologically, so newest sessions come first.
	let sessions = $derived([...connection.sessions].sort((a, b) => (a.id < b.id ? 1 : -1)));

	$effect(() => {
		if (ready && !api.url && connection.status !== 'checking') inputEl?.focus();
	});

	// Sessions start collapsed on phones, open on bigger screens.
	$effect(() => {
		if (!ready || sessionsDefaulted) return;
		sessionsDefaulted = true;
		sessionsOpen = !window.matchMedia('(max-width: 767px)').matches;
	});

	// Scribbles are global: load them once per server.
	$effect(() => {
		const url = api.url;
		if (!url || scribblesLoadedFor === url) return;
		scribblesLoadedFor = url;
		void loadScribbles(url);
	});

	// Live updates: refetch sessions and scribbles when another client writes.
	$effect(() => {
		const url = api.url;
		if (!url) return;
		let timer: number | undefined;
		const stop = subscribeChanges(url, () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				void refreshSessions();
				void loadScribbles(url);
			}, 500);
		});
		return () => {
			window.clearTimeout(timer);
			stop();
		};
	});

	// Live timer while recording a scribble.
	$effect(() => {
		if (!recorder.recording || segmentStartedAt <= 0) {
			elapsed = 0;
			return;
		}
		const started = segmentStartedAt;
		const timer = setInterval(() => {
			elapsed = (performance.now() - started) / 1000;
		}, 100);
		return () => clearInterval(timer);
	});

	// Release the microphone when leaving the page.
	$effect(() => {
		const onUnload = () => recorder.stop();
		window.addEventListener('beforeunload', onUnload);
		return () => {
			window.removeEventListener('beforeunload', onUnload);
			recorder.stop();
		};
	});

	function normalizeScribbleStatus(status: string | undefined): ScribbleStatus {
		if (status === 'done' || status === 'processing' || status === 'error') return status;
		return 'recorded';
	}

	async function loadScribbles(url: string) {
		scribblesLoading = true;
		scribbleError = null;
		try {
			const list = await listScribbles(url);
			const loaded: Scribble[] = list.map((item: TakeMeta) => ({
				id: item.take_id,
				index: item.index ?? 0,
				name: item.name?.trim() || item.take_id,
				kind: item.kind === 'text' ? 'text' : 'audio',
				status: normalizeScribbleStatus(item.status),
				lyrics: [],
				error: item.error ?? null
			}));
			scribbles = loaded;
			nextScribbleIndex = loaded.reduce((max, scribble) => Math.max(max, scribble.index), 0) + 1;

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

	async function startRecording() {
		await recorder.start();
		if (recorder.recording) segmentStartedAt = performance.now();
	}

	/** Keep the current take and process it into a scribble. */
	async function saveScribble() {
		const url = api.url;
		if (!url || !recorder.recording || scribbleBusy) return;

		const blob = await recorder.takeSegment();
		recorder.stop();
		segmentStartedAt = 0;
		if (!blob) return;

		const index = nextScribbleIndex++;
		const id = newTakeId();
		const name = newEntryName();
		scribbles = [
			{ id, index, name, kind: 'audio', status: 'processing', lyrics: [], error: null },
			...scribbles
		];

		const file = new File([blob], `scribble-${index}.${extensionForMime(blob.type)}`, {
			type: blob.type || 'audio/webm'
		});

		scribbleBusy = true;
		try {
			const upload = await uploadScribble(url, file, {
				process: true,
				index,
				name,
				scribbleId: id
			});
			scribbles = scribbles.map((candidate) =>
				candidate.id === id
					? { ...candidate, status: 'done', lyrics: upload.result?.lyrics ?? [] }
					: candidate
			);
		} catch (saveError) {
			scribbles = scribbles.map((candidate) =>
				candidate.id === id
					? {
							...candidate,
							status: 'error',
							error: saveError instanceof Error ? saveError.message : 'Could not save the scribble.'
						}
					: candidate
			);
		} finally {
			scribbleBusy = false;
		}
	}

	function discardScribble() {
		recorder.stop();
		segmentStartedAt = 0;
	}

	/** Collapse/expand the whole section; stopping the mic if we hide it. */
	function toggleScribblesSection() {
		if (scribblesOpen) recorder.stop();
		scribblesOpen = !scribblesOpen;
	}

	function scribbleAudio(scribble: Scribble): string {
		const url = api.url;
		if (!url) return '';
		return scribbleAudioUrl(url, scribble.id, scribble.status === 'done' ? 'vocals' : 'original');
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

	// --- Audio scribble line editing (homepage only) -----------------------

	/** Per-scribble request counter, so a slow older response can't clobber a newer edit. */
	const scribbleEditSeq: Record<string, number> = {};

	function setScribbleLyrics(id: string, lyrics: LyricLine[]) {
		scribbles = scribbles.map((candidate) =>
			candidate.id === id ? { ...candidate, lyrics } : candidate
		);
	}

	/** Re-line a scribble instantly; the server (BPM) catches up in the background. */
	function applyScribbleLyrics(scribble: Scribble, lines: LyricLine[]) {
		const previous = scribble.lyrics;
		setScribbleLyrics(scribble.id, lines);

		const url = api.url;
		if (!url) return;
		const seq = (scribbleEditSeq[scribble.id] ?? 0) + 1;
		scribbleEditSeq[scribble.id] = seq;
		void (async () => {
			try {
				const updated = await updateScribbleLyrics(url, scribble.id, lyricsPayload(lines));
				if (scribbleEditSeq[scribble.id] === seq) setScribbleLyrics(scribble.id, updated);
			} catch (editError) {
				if (scribbleEditSeq[scribble.id] === seq) setScribbleLyrics(scribble.id, previous);
				scribbleError =
					editError instanceof Error ? editError.message : 'Could not save the lines.';
			}
		})();
	}

	function mergeScribbleLines(scribble: Scribble, indices: number[]) {
		const next = mergeSelected(scribble.lyrics, indices);
		if (next) applyScribbleLyrics(scribble, next);
	}

	function carveScribbleLine(scribble: Scribble, index: number, from: number, to: number) {
		const next = carve(scribble.lyrics, index, from, to);
		if (next) applyScribbleLyrics(scribble, next);
	}

	async function editScribbleLine(scribble: Scribble, index: number, text: string) {
		const url = api.url;
		if (!url) return;
		const trimmed = text.trim();
		setScribbleLyrics(
			scribble.id,
			scribble.lyrics.map((line, lineIndex) =>
				lineIndex === index ? { ...line, text: trimmed } : line
			)
		);
		try {
			const updated = await updateScribbleLineText(url, scribble.id, index, trimmed);
			setScribbleLyrics(
				scribble.id,
				scribble.lyrics.map((line, lineIndex) => (lineIndex === index ? updated : line))
			);
		} catch (editError) {
			scribbleError = editError instanceof Error ? editError.message : 'Could not save the line.';
		}
	}

	// --- Text scribbles ----------------------------------------------------

	function textLinesOf(scribble: Scribble): string[] {
		return scribble.lyrics.map((line) => line.text ?? '');
	}

	function textLinesToLyrics(lines: string[]): LyricLine[] {
		return lines.map((text) => ({ bpm: 0, 'start time': 0, 'end time': 0, words: [], text }));
	}

	async function newTextScribble() {
		const url = api.url;
		if (!url || scribbleBusy) return;
		scribbleBusy = true;
		try {
			const created = await createTextScribble(url, { name: newEntryName(), lines: [] });
			nextScribbleIndex = Math.max(nextScribbleIndex, (created.index ?? 0) + 1);
			scribbles = [
				{
					id: created.take_id,
					index: created.index ?? nextScribbleIndex - 1,
					name: created.name?.trim() || created.take_id,
					kind: 'text',
					status: 'done',
					lyrics: textLinesToLyrics(['']),
					error: null
				},
				...scribbles
			];
		} catch (createError) {
			scribbleError =
				createError instanceof Error ? createError.message : 'Could not create the scribble.';
		} finally {
			scribbleBusy = false;
		}
	}

	/** Debounced persistence for text scribbles (one timer per scribble id). */
	const textSaveTimers: Record<string, number> = {};

	function scheduleTextSave(scribble: Scribble) {
		window.clearTimeout(textSaveTimers[scribble.id]);
		textSaveTimers[scribble.id] = window.setTimeout(() => {
			void saveTextScribble(scribble.id);
		}, 600);
	}

	async function saveTextScribble(scribbleId: string) {
		const url = api.url;
		if (!url) return;
		const current = scribbles.find((candidate) => candidate.id === scribbleId);
		if (!current) return;
		try {
			await updateTextScribble(
				url,
				scribbleId,
				textLinesOf(current).map((line) => line.trim())
			);
		} catch (saveError) {
			scribbleError =
				saveError instanceof Error ? saveError.message : 'Could not save the scribble.';
		}
	}

	function updateTextLine(scribble: Scribble, index: number, value: string) {
		setScribbleLyrics(
			scribble.id,
			scribble.lyrics.map((line, lineIndex) =>
				lineIndex === index ? { ...line, text: value } : line
			)
		);
		scheduleTextSave(scribble);
	}

	function addTextLine(scribble: Scribble, index: number) {
		const lines = [...scribble.lyrics];
		lines.splice(index + 1, 0, { bpm: 0, 'start time': 0, 'end time': 0, words: [], text: '' });
		setScribbleLyrics(scribble.id, lines);
		scheduleTextSave(scribble);
		void focusTextLine(scribble.id, index + 1);
	}

	function removeTextLine(scribble: Scribble, index: number) {
		if (scribble.lyrics.length <= 1) return;
		setScribbleLyrics(
			scribble.id,
			scribble.lyrics.filter((_line, lineIndex) => lineIndex !== index)
		);
		scheduleTextSave(scribble);
		void focusTextLine(scribble.id, Math.max(0, index - 1));
	}

	async function focusTextLine(scribbleId: string, index: number) {
		await tick();
		document.querySelector<HTMLInputElement>(`[data-text-line="${scribbleId}-${index}"]`)?.focus();
	}

	function onTextLineKeydown(scribble: Scribble, index: number, event: KeyboardEvent) {
		const element = event.currentTarget as HTMLInputElement;
		if (event.key === 'Enter') {
			event.preventDefault();
			addTextLine(scribble, index);
		} else if (event.key === 'Backspace' && element.value === '' && scribble.lyrics.length > 1) {
			event.preventDefault();
			removeTextLine(scribble, index);
		}
	}

	async function removeScribble(scribble: Scribble) {
		const url = api.url;
		if (!url) return;
		try {
			await deleteScribble(url, scribble.id);
			scribbles = scribbles.filter((candidate) => candidate.id !== scribble.id);
		} catch (deleteError) {
			scribbleError = deleteError instanceof Error ? deleteError.message : 'Could not delete.';
		}
	}

	function beginScribbleRename(scribble: Scribble) {
		editingScribbleId = scribble.id;
		scribbleNameDraft = scribble.name;
	}

	function cancelScribbleRename() {
		editingScribbleId = null;
		scribbleNameDraft = '';
	}

	async function handleScribbleRename(event: SubmitEvent) {
		event.preventDefault();
		const id = editingScribbleId;
		const name = scribbleNameDraft.trim();
		if (!id || !name) return;
		const url = api.url;
		const scribble = scribbles.find((candidate) => candidate.id === id);
		cancelScribbleRename();
		if (!scribble || !url) return;
		if (scribble.name !== name) {
			scribbles = scribbles.map((candidate) =>
				candidate.id === id ? { ...candidate, name } : candidate
			);
		}
		try {
			await renameScribbleApi(url, id, name);
		} catch (renameError) {
			scribbleError = renameError instanceof Error ? renameError.message : 'Could not rename.';
		}
	}

	function formatElapsed(seconds: number): string {
		const whole = Math.floor(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	/** Create a session, then drop straight into its page. */
	async function handleNewSession() {
		const id = await startNewSession();
		if (id) await goto(resolve(`/session?id=${encodeURIComponent(id)}`));
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();

		const parsed = parseShareInput(input);
		if (parsed.kind === 'invalid') {
			error = parsed.message;
			return;
		}

		error = null;
		submitting = true;
		const result = await establish(parsed, { source: 'your share code' });
		submitting = false;

		if (!result.ok) {
			error = result.message;
			return;
		}

		// Keep the address bar shareable/refreshable.
		await pushState(resolve(toHref(parsed)), {});
	}

	async function handleDisconnect() {
		disconnect();
		await replaceState(resolve('/'), {});
	}

	function beginRename(session: Session) {
		editingId = session.id;
		nameDraft = session.name;
		confirmingId = null;
	}

	function cancelRename() {
		editingId = null;
		nameDraft = '';
	}

	async function handleRename(event: SubmitEvent) {
		event.preventDefault();
		const id = editingId;
		const name = nameDraft.trim();
		if (id === null || !name) return;

		if (await renameSession(id, name)) cancelRename();
	}

	function requestDelete(sessionId: string) {
		editingId = null;
		confirmingId = sessionId;
	}

	async function confirmDelete(sessionId: string) {
		if (await deleteSession(sessionId)) confirmingId = null;
	}
</script>

<svelte:head>
	<title>Catchy Catcher</title>
	<meta name="description" content="Catchy Catcher — connect to your audio API." />
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

<main class="grid min-h-dvh place-items-center bg-white px-6 text-neutral-900">
	<div class="w-full {api.url ? 'max-w-2xl' : 'max-w-md'}">
		{#if !ready}
			<p class="text-center text-sm text-neutral-400">Loading…</p>
		{:else if connection.status === 'checking'}
			<div class="space-y-3 text-center">
				<div
					class="mx-auto size-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
				></div>
				<p class="text-sm text-neutral-500">Connecting…</p>
			</div>
		{:else if api.url}
			<div class="space-y-6">
				<div class="space-y-1 text-center">
					<h1 class="text-2xl font-semibold tracking-tight">Connected</h1>
					<p class="text-sm text-neutral-500">You're connected to your processing server.</p>
				</div>

				<div class="flex gap-3">
					<button
						onclick={handleNewSession}
						disabled={connection.busy}
						class="flex-1 rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{connection.busy ? 'Creating…' : 'New session'}
					</button>
					<button
						onclick={handleDisconnect}
						class="flex-1 rounded-lg border border-neutral-300 px-4 py-3 text-sm text-neutral-700 hover:bg-neutral-100"
					>
						Disconnect
					</button>
				</div>

				{#if connection.error}
					<p class="text-center text-xs text-red-600">{connection.error}</p>
				{/if}

				<section class="space-y-3">
					<div class="flex items-center justify-between gap-2">
						<button
							type="button"
							onclick={() => (sessionsOpen = !sessionsOpen)}
							aria-expanded={sessionsOpen}
							class="flex items-center gap-1"
						>
							<svg
								viewBox="0 0 24 24"
								class="size-4 text-neutral-400 transition-transform {sessionsOpen
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
							<span class="text-xs font-medium tracking-wide text-neutral-500 uppercase"
								>Sessions</span
							>
						</button>
						<button
							onclick={refreshSessions}
							disabled={connection.sessionsStatus === 'loading'}
							class="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
						>
							Refresh
						</button>
					</div>

					{#if sessionsOpen}
						{#if sessions.length === 0}
							<p
								class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400"
							>
								{connection.sessionsStatus === 'loading'
									? 'Loading…'
									: 'No sessions yet. Create one to get started.'}
							</p>
						{:else}
							<ul class="space-y-2">
								{#each sessions as session (session.id)}
									<li class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
										{#if editingId === session.id}
											<form onsubmit={handleRename} class="flex items-center gap-2">
												<input
													bind:value={nameDraft}
													aria-label="Session name"
													class="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200 focus:outline-none"
												/>
												<button
													type="submit"
													class="shrink-0 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800"
												>
													Save
												</button>
												<button
													type="button"
													onclick={cancelRename}
													class="shrink-0 rounded-md px-3 py-2 text-xs text-neutral-600 hover:bg-neutral-100"
												>
													Cancel
												</button>
											</form>
										{:else if confirmingId === session.id}
											<div class="flex items-center justify-between gap-3">
												<span class="text-sm text-neutral-700">Delete this session?</span>
												<div class="flex shrink-0 items-center gap-2">
													<button
														onclick={() => confirmDelete(session.id)}
														class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
													>
														Delete
													</button>
													<button
														onclick={() => (confirmingId = null)}
														class="rounded-md px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100"
													>
														Cancel
													</button>
												</div>
											</div>
										{:else}
											<div class="flex items-center justify-between gap-3">
												<div class="flex min-w-0 items-center gap-2">
													<a
														href={resolve(`/session?id=${encodeURIComponent(session.id)}`)}
														class="truncate text-sm text-neutral-800 hover:text-neutral-950 hover:underline"
														title={session.name}
													>
														{session.name}
													</a>
													{#if formatSessionDate(session.updatedAt)}
														<span
															class="shrink-0 text-xs text-neutral-400"
															title="Last modified {formatSessionDate(session.updatedAt)}"
														>
															{formatSessionDate(session.updatedAt)}
														</span>
													{/if}
												</div>
												<div class="flex shrink-0 items-center gap-1">
													<button
														onclick={() => beginRename(session)}
														class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
													>
														Rename
													</button>
													<button
														onclick={() => requestDelete(session.id)}
														class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600"
													>
														Delete
													</button>
												</div>
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</section>

				<section class="space-y-3">
					<button
						type="button"
						onclick={toggleScribblesSection}
						aria-expanded={scribblesOpen}
						class="flex w-full items-center justify-between"
					>
						<span class="flex items-center gap-1">
							<svg
								viewBox="0 0 24 24"
								class="size-4 text-neutral-400 transition-transform {scribblesOpen
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
							<span class="text-xs font-medium tracking-wide text-neutral-500 uppercase"
								>Scribbles</span
							>
						</span>
						<span class="text-xs text-neutral-400">{scribbles.length}</span>
					</button>

					{#if scribblesOpen}
						<p class="text-xs text-neutral-500">
							A journal shared across every session. Record one here and use it anywhere.
						</p>

						<div
							class="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3"
						>
							{#if recorder.state === 'error'}
								<p class="text-sm text-red-600">{recorder.error}</p>
								<button
									onclick={startRecording}
									class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
								>
									Try again
								</button>
							{:else if recorder.recording}
								<span class="size-2.5 animate-pulse rounded-full bg-red-600"></span>
								<span class="text-sm font-medium">Recording</span>
								<span class="font-mono text-sm text-neutral-500">{formatElapsed(elapsed)}</span>
								<div class="ml-auto flex items-center gap-2">
									<button
										onclick={saveScribble}
										disabled={scribbleBusy}
										class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
									>
										Keep &amp; process
									</button>
									<button
										onclick={discardScribble}
										class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
									>
										Discard
									</button>
								</div>
							{:else}
								<button
									onclick={startRecording}
									class="rounded-full bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
								>
									Record scribble
								</button>
								<button
									onclick={newTextScribble}
									disabled={scribbleBusy}
									class="rounded-full border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
								>
									New text scribble
								</button>
								<span class="text-xs text-neutral-500"
									>Recordings become lyrics; text scribbles are just editable boxes.</span
								>
							{/if}
						</div>

						{#if scribbleError}
							<p class="text-xs text-red-600">{scribbleError}</p>
						{/if}

						{#if scribbles.length === 0}
							<p
								class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400"
							>
								{scribblesLoading ? 'Loading…' : 'No scribbles yet.'}
							</p>
						{:else}
							<ul class="space-y-2">
								{#each scribbles as scribble (scribble.id)}
									<li
										class="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3"
									>
										<div class="flex items-center justify-between gap-3">
											{#if editingScribbleId === scribble.id}
												<form
													onsubmit={handleScribbleRename}
													class="flex min-w-0 flex-1 items-center gap-2"
												>
													<input
														bind:value={scribbleNameDraft}
														aria-label="Scribble name"
														class="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
													/>
													<button
														type="submit"
														class="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800"
													>
														Save
													</button>
													<button
														type="button"
														onclick={cancelScribbleRename}
														class="shrink-0 rounded-md px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100"
													>
														Cancel
													</button>
												</form>
											{:else}
												<div class="flex min-w-0 flex-1 items-center gap-2">
													<span class="font-mono text-xs text-neutral-400"
														>{String(scribble.index).padStart(2, '0')}</span
													>
													<button
														onclick={() => beginScribbleRename(scribble)}
														title="Rename scribble"
														class="truncate text-sm font-medium text-neutral-800 hover:text-neutral-950"
													>
														{scribble.name}
													</button>
													{#if scribble.status === 'processing'}
														<span class="shrink-0 text-xs text-neutral-400">Processing…</span>
													{:else if scribble.status === 'recorded'}
														<span class="shrink-0 text-xs text-neutral-400">Unprocessed</span>
													{:else if scribble.status === 'error'}
														<span class="shrink-0 text-xs text-red-600">Failed</span>
													{/if}
												</div>
											{/if}
											<div class="flex shrink-0 items-center gap-1">
												{#if scribble.status === 'recorded'}
													<button
														onclick={() => processScribbleEntry(scribble)}
														class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
													>
														Process
													</button>
												{/if}
												<button
													onclick={() => removeScribble(scribble)}
													class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600"
												>
													Delete
												</button>
											</div>
										</div>

										{#if scribble.error}
											<p class="text-xs text-red-600">{scribble.error}</p>
										{/if}

										{#if scribble.kind === 'text'}
											<div class="space-y-1.5">
												{#each textLinesOf(scribble) as line, lineIndex (lineIndex)}
													<input
														value={line}
														data-text-line="{scribble.id}-{lineIndex}"
														oninput={(event) =>
															updateTextLine(scribble, lineIndex, event.currentTarget.value)}
														onkeydown={(event) => onTextLineKeydown(scribble, lineIndex, event)}
														aria-label="Scribble line"
														placeholder="Type a line…"
														class="w-full rounded-lg border border-dashed border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-solid focus:border-neutral-500 focus:outline-none"
													/>
												{/each}
												<button
													type="button"
													onclick={() => addTextLine(scribble, textLinesOf(scribble).length - 1)}
													class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
												>
													＋ Add line
												</button>
											</div>
										{:else if scribble.status === 'done' && scribbleAudio(scribble)}
											<EntryPlayer
												src={scribbleAudio(scribble)}
												lyrics={scribble.lyrics}
												framed={false}
												downloadName={scribble.name}
												onEditLine={(lineIndex, text) =>
													editScribbleLine(scribble, lineIndex, text)}
												onMergeSelected={(indices) => mergeScribbleLines(scribble, indices)}
												onCarve={(lineIndex, from, to) =>
													carveScribbleLine(scribble, lineIndex, from, to)}
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
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</section>
			</div>
		{:else}
			<div class="space-y-6">
				<div class="space-y-2 text-center">
					<h1 class="text-3xl font-semibold tracking-tight">Catchy Catcher</h1>
					<p class="text-sm text-neutral-500">
						Enter the share code for your Gradio app to get started.
					</p>
				</div>

				{#if connection.notice}
					<div class="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
						<p class="text-xs text-amber-800">{connection.notice}</p>
						{#if connection.saved}
							<button
								onclick={retry}
								class="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
							>
								Try again
							</button>
						{/if}
					</div>
				{/if}

				<form onsubmit={handleSubmit} class="space-y-6">
					<div class="space-y-2">
						<label
							for="share-code"
							class="block text-xs font-medium tracking-wide text-neutral-500 uppercase"
						>
							Share code
						</label>
						<input
							id="share-code"
							name="share_code"
							type="text"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							placeholder="e.g. zz4k-1q"
							bind:this={inputEl}
							bind:value={input}
							class="w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200 focus:outline-none"
						/>
						{#if error}
							<p class="text-xs text-red-600">{error}</p>
						{/if}
					</div>

					<button
						type="submit"
						disabled={submitting}
						class="w-full rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{submitting ? 'Connecting…' : 'Connect'}
					</button>
				</form>
			</div>
		{/if}
	</div>
</main>
