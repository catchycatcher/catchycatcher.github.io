<script lang="ts">
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
		getSession,
		getTakeResult,
		listScrapbooks,
		processTake,
		renderScrapbook,
		renameTake,
		scrapbookAudioUrl,
		setBookmark,
		takeAudioUrl,
		updateLineText,
		updateScrapbook,
		uploadTake,
		type LineRef,
		type LyricLine,
		type Scrapbook,
		type ScrapbookSummary,
		type TakeMeta
	} from '#lib/connection.svelte.ts';
	import { newEntryName } from '#lib/session.ts';
	import { extensionForMime, Recorder } from '#lib/recorder.svelte.ts';
	import EntryPlayer from '#lib/components/EntryPlayer.svelte';

	type EntryStatus = 'recorded' | 'processing' | 'done' | 'error';

	type Entry = {
		localId: string;
		serverId: string | null;
		index: number;
		name: string;
		bookmarked: boolean;
		status: EntryStatus;
		lyrics: LyricLine[];
		error?: string | null;
	};

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let sessionId = $state('');
	let sessionName = $state('');
	let error = $state<string | null>(null);

	/** The journal: one entry per take, newest first. */
	let entries = $state<Entry[]>([]);
	let nextIndex = $state(1);
	let tab = $state<'all' | 'bookmarked'>('all');

	/** Inline rename state. */
	let editingId = $state<string | null>(null);
	let nameDraft = $state('');

	/** Scrapbooks. */
	let scrapbooks = $state<ScrapbookSummary[]>([]);
	let activeScrapbookId = $state('');
	let scrapbook = $state<Scrapbook | null>(null);
	let scrapbookBusy = $state(false);
	let scrapbookError = $state<string | null>(null);
	let dragOverScrapbook = $state(false);
	/** True while an edited scrapbook's mix is (re)rendering. */
	let renderPending = $state(false);

	const recorder = new Recorder();
	let segmentStartedAt = $state(0);
	let elapsed = $state(0);
	let loadedFor = '';

	$effect(() => {
		bootstrap(page.url.searchParams);
		sessionId = page.url.searchParams.get('id') ?? '';
		ready = true;
	});

	$effect(() => {
		const url = api.url;
		const id = sessionId;
		if (!url || !id || loadedFor === id) return;
		loadedFor = id;
		void loadSession(url, id);
		void refreshScrapbooks(url);
	});

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

	$effect(() => {
		const onUnload = () => recorder.stop();
		window.addEventListener('keydown', onKeydown);
		window.addEventListener('beforeunload', onUnload);
		return () => {
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('beforeunload', onUnload);
			recorder.stop();
		};
	});

	let visibleEntries = $derived(
		tab === 'bookmarked' ? entries.filter((entry) => entry.bookmarked) : entries
	);
	let pageTitle = $derived(sessionName ? `${sessionName} — Catchy Catcher` : 'Catchy Catcher');

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
				lyrics: []
			}));
			loaded.sort((a, b) => b.index - a.index);
			entries = loaded;
			nextIndex = loaded.reduce((max, entry) => Math.max(max, entry.index), 0) + 1;
			error = null;

			for (const entry of loaded) {
				if (entry.status === 'done' && entry.serverId) {
					const result = await getTakeResult(url, id, entry.serverId);
					if (result) updateEntry(entry.localId, { lyrics: result.lyrics });
				}
			}
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Could not load the session.';
		}
	}

	// --- Recording ---------------------------------------------------------

	async function startRecording() {
		await recorder.start();
		if (recorder.recording) segmentStartedAt = performance.now();
	}

	async function commit(process: boolean) {
		const url = api.url;
		if (!url || !sessionId || !recorder.recording) return;

		const blob = await recorder.takeSegment();
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
				status: process ? 'processing' : 'recorded',
				lyrics: [],
				error: null
			},
			...entries
		];

		const file = new File([blob], `entry-${index}.${extensionForMime(blob.type)}`, {
			type: blob.type || 'audio/webm'
		});

		try {
			const upload = await uploadTake(url, sessionId, file, { process, index, name });
			updateEntry(localId, {
				serverId: upload.takeId,
				status: upload.result ? 'done' : 'recorded',
				lyrics: upload.result ? upload.result.lyrics : []
			});
		} catch (uploadError) {
			updateEntry(localId, {
				status: 'error',
				error: uploadError instanceof Error ? uploadError.message : 'Could not save the take.'
			});
		}
	}

	async function scrapCurrent() {
		if (!recorder.recording) return;
		await recorder.discardSegment();
		segmentStartedAt = performance.now();
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
			if (recorder.recording) void commit(true);
			else void startRecording();
			return;
		}
		if (event.key === 'Enter' && recorder.recording) {
			event.preventDefault();
			void commit(false);
			return;
		}
		if ((event.key === 'Backspace' || event.key === 'Delete') && recorder.recording) {
			event.preventDefault();
			void scrapCurrent();
		}
	}

	function formatElapsed(seconds: number): string {
		const whole = Math.floor(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	// --- Journal entries ---------------------------------------------------

	async function processEntry(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		updateEntry(entry.localId, { status: 'processing', error: null });
		try {
			const result = await processTake(url, sessionId, entry.serverId);
			updateEntry(entry.localId, { status: 'done', lyrics: result.lyrics });
		} catch (processError) {
			updateEntry(entry.localId, {
				status: 'error',
				error: processError instanceof Error ? processError.message : 'Could not process the take.'
			});
		}
	}

	async function removeEntry(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		try {
			await deleteTake(url, sessionId, entry.serverId);
			entries = entries.filter((candidate) => candidate.localId !== entry.localId);
		} catch (deleteError) {
			error = deleteError instanceof Error ? deleteError.message : 'Could not delete the entry.';
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
		return takeAudioUrl(
			url,
			sessionId,
			entry.serverId,
			entry.status === 'done' ? 'vocals' : 'original'
		);
	}

	function journalLineRef(entry: Entry, lineIndex: number): LineRef | null {
		if (!entry.serverId || entry.status !== 'done') return null;
		return { session_id: sessionId, take_id: entry.serverId, line_index: lineIndex };
	}

	// --- Scrapbooks --------------------------------------------------------

	async function refreshScrapbooks(url: string) {
		try {
			scrapbooks = await listScrapbooks(url);
		} catch (listError) {
			scrapbookError =
				listError instanceof Error ? listError.message : 'Could not load scrapbooks.';
		}
	}

	async function selectScrapbook(id: string) {
		const url = api.url;
		activeScrapbookId = id;
		scrapbook = null;
		scrapbookError = null;
		if (!url || !id) return;
		try {
			scrapbook = await getScrapbook(url, id);
			if (scrapbook.lines.length) await renderActive();
		} catch (loadError) {
			scrapbookError =
				loadError instanceof Error ? loadError.message : 'Could not load the scrapbook.';
		}
	}

	async function copyEntryToScrapbook(entry: Entry) {
		const url = api.url;
		if (!url || !entry.serverId || entry.status !== 'done') return;
		const lines: LineRef[] = entry.lyrics.map((_line, lineIndex) => ({
			session_id: sessionId,
			take_id: entry.serverId as string,
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
			const created = await createScrapbook(url, { name: entry.name, lines });
			await refreshScrapbooks(url);
			await selectScrapbook(created.scrapbook_id);
		} catch (createError) {
			scrapbookError =
				createError instanceof Error ? createError.message : 'Could not create the scrapbook.';
		} finally {
			scrapbookBusy = false;
		}
	}

	async function newScrapbook() {
		const url = api.url;
		if (!url) return;
		scrapbookBusy = true;
		try {
			const created = await createScrapbook(url, { name: newEntryName(), lines: [] });
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
			await deleteScrapbook(url, activeScrapbookId);
			activeScrapbookId = '';
			scrapbook = null;
			await refreshScrapbooks(url);
		} catch (deleteError) {
			scrapbookError = deleteError instanceof Error ? deleteError.message : 'Could not delete.';
		}
	}

	async function saveScrapbook(body: { name?: string; lines?: LineRef[] }) {
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
			scrapbook = await updateScrapbook(url, activeScrapbookId, body);
			await refreshScrapbooks(url);
			await renderActive();
		} catch (saveError) {
			scrapbookError = saveError instanceof Error ? saveError.message : 'Could not save.';
			renderPending = false;
		} finally {
			scrapbookBusy = false;
		}
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
			const render = await renderScrapbook(url, activeScrapbookId);
			if (scrapbook) scrapbook = { ...scrapbook, render, rendered: true };
		} catch (renderError) {
			scrapbookError = renderError instanceof Error ? renderError.message : 'Could not render.';
		} finally {
			renderPending = false;
			scrapbookBusy = false;
		}
	}

	function saveLines(lines: LineRef[]) {
		void saveScrapbook({ lines });
	}

	function addLinesAt(refs: LineRef[], index?: number) {
		const current = scrapbook ? [...scrapbook.lines] : [];
		current.splice(index ?? current.length, 0, ...refs);
		saveLines(current);
	}

	function removeLineAt(index: number) {
		const current = scrapbook ? [...scrapbook.lines] : [];
		current.splice(index, 1);
		saveLines(current);
	}

	/** Move the selected indices together so they land before ``to``. */
	function moveLines(from: number[], to: number) {
		const current = scrapbook ? [...scrapbook.lines] : [];
		const valid = from
			.filter((index) => index >= 0 && index < current.length)
			.sort((a, b) => a - b);
		if (!valid.length) return;

		const moving = valid.map((index) => current[index]);
		const removedBefore = valid.filter((index) => index < to).length;
		const remaining = current.filter((_line, index) => !valid.includes(index));
		const target = Math.max(0, Math.min(remaining.length, to - removedBefore));
		remaining.splice(target, 0, ...moving);
		saveLines(remaining);
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

	function lineLabel(ref: LineRef): string {
		const entry = entries.find((candidate) => candidate.serverId === ref.take_id);
		const line = entry?.lyrics[ref.line_index];
		const text =
			(line?.text && line.text.trim()) ||
			line?.words
				.map((word) => word.word)
				.join(' ')
				.trim();
		return text || `Line ${ref.line_index + 1}`;
	}

	/** Double-clicked a line's text in the journal; persist the display override. */
	async function editLine(entry: Entry, index: number, text: string) {
		const url = api.url;
		if (!url || !entry.serverId) return;
		const trimmed = text.trim();
		updateEntry(entry.localId, {
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

	/** Ctrl-clicked a scrapbook line: scroll the journal to the same line. */
	function locateScrapbookLine(index: number) {
		const ref = scrapbook?.lines[index];
		if (!ref) return;
		const entry = document.querySelector<HTMLElement>(`[data-take-id="${ref.take_id}"]`);
		const bubble = entry?.querySelector<HTMLElement>(`[data-line-index="${ref.line_index}"]`);
		if (!bubble) return;
		bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
		bubble.classList.add('ring-2', 'ring-amber-500');
		window.setTimeout(() => bubble.classList.remove('ring-2', 'ring-amber-500'), 1200);
	}

	/** True when the stored render's lines match the scrapbook's current lines. */
	function renderMatchesLines(book: Scrapbook | null): boolean {
		const timeline = book?.render?.timeline;
		if (!book || !timeline?.length || timeline.length !== book.lines.length) return false;
		return book.lines.every((ref, index) => {
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
	let scrapbookLoading = $derived(Boolean(scrapbook?.lines.length) && !renderInSync);

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
		const rendered: Record<string, LyricLine> = {};
		for (const line of book.render?.timeline ?? []) {
			if (line.source) rendered[sourceKey(line.source)] = line;
		}
		return book.lines.map((ref) => {
			const base = rendered[sourceKey(ref)];
			return {
				bpm: base?.bpm ?? 0,
				'start time': base?.['start time'] ?? 0,
				'end time': base?.['end time'] ?? 0,
				words: base?.words ?? [],
				// The display text always comes from the journal line, so edits show
				// here immediately without re-rendering the mix.
				text: lineLabel(ref)
			};
		});
	}

	let scrapbookLines = $derived(scrapbookLinesFor());

	let scrapbookSrc = $derived(
		api.url && activeScrapbookId && scrapbook?.render && renderInSync
			? `${scrapbookAudioUrl(api.url, activeScrapbookId)}?v=${encodeURIComponent(scrapbook.render.rendered_at ?? '')}`
			: ''
	);
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

<main class="flex min-h-dvh flex-col bg-white text-neutral-900">
	<header class="flex items-start justify-between gap-4 border-b border-neutral-100 px-6 py-3">
		<div class="min-w-0">
			<a
				href={resolve('/')}
				class="text-[11px] font-medium tracking-wide text-neutral-400 uppercase hover:text-neutral-700"
			>
				Catchy Catcher
			</a>
			<h1 class="truncate text-xl font-semibold tracking-tight">{sessionName || 'Session'}</h1>
		</div>
		<a href={resolve('/')} class="shrink-0 text-xs text-neutral-500 hover:text-neutral-900">
			All sessions
		</a>
	</header>

	<div class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
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
			<!-- Recorder bar -->
			<section
				class="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5"
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
					<span class="ml-auto text-xs text-neutral-500">
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Space</kbd> keep
						&amp; process ·
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Enter</kbd> keep raw
						·
						<kbd class="rounded border border-neutral-300 bg-white px-1 py-0.5">Delete</kbd> scrap
					</span>
					<button
						onclick={() => recorder.stop()}
						class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
					>
						Stop
					</button>
				{:else}
					<button
						onclick={startRecording}
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

			<div class="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-2">
				<!-- Scrapbook (left) -->
				<section class="order-2 flex flex-col gap-3 lg:order-1">
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-xs font-medium tracking-wide text-neutral-500 uppercase">Scrapbook</h2>
						<button
							onclick={newScrapbook}
							disabled={scrapbookBusy}
							class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
						>
							New
						</button>
					</div>

					<select
						value={activeScrapbookId}
						onchange={(event) => selectScrapbook((event.currentTarget as HTMLSelectElement).value)}
						class="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
					>
						<option value="">Select a scrapbook…</option>
						{#each scrapbooks as item (item.scrapbook_id)}
							<option value={item.scrapbook_id}>{item.name} ({item.line_count})</option>
						{/each}
					</select>

					{#if scrapbookError}
						<p class="text-xs text-red-600">{scrapbookError}</p>
					{/if}

					{#if scrapbook}
						<div class="flex items-center gap-2">
							<input
								value={scrapbook.name}
								onchange={(event) =>
									saveScrapbook({ name: (event.currentTarget as HTMLInputElement).value })}
								aria-label="Scrapbook name"
								class="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm"
							/>
							<button
								onclick={removeScrapbook}
								class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600"
							>
								Delete
							</button>
						</div>

						<!-- Lines live in the player: drag to add/reorder, × to remove -->
						{#if scrapbook.lines.length === 0}
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
							<EntryPlayer
								src={scrapbookSrc}
								lyrics={scrapbookLines}
								loading={scrapbookLoading}
								downloadName={scrapbook.name}
								allowReorder
								onDropLines={(refs, index) => addLinesAt(refs as LineRef[], index)}
								onMoveLines={moveLines}
								onRemove={removeLineAt}
								onLocateLine={locateScrapbookLine}
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

				<!-- Journal (right) -->
				<section class="order-1 flex flex-col gap-3 lg:order-2">
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
						</div>
						<span class="text-xs text-neutral-400">{visibleEntries.length} entries</span>
					</div>

					{#if visibleEntries.length === 0}
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
									class="space-y-3 rounded-xl border border-neutral-200 bg-white px-4 py-3"
								>
									<div class="flex items-center justify-between gap-3">
										<div class="flex min-w-0 flex-1 items-center gap-2">
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
												{:else}
													<span class="shrink-0 text-xs text-emerald-600">Ready</span>
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

									{#if entry.status === 'done' && entryAudio(entry)}
										<EntryPlayer
											src={entryAudio(entry)}
											lyrics={entry.lyrics}
											downloadName={entry.name}
											dragLine={(lineIndex) => journalLineRef(entry, lineIndex)}
											onEditLine={(lineIndex, text) => editLine(entry, lineIndex, text)}
										/>
									{:else if entryAudio(entry)}
										<EntryPlayer
											src={entryAudio(entry)}
											lyrics={[]}
											emptyLabel={null}
											downloadName={entry.name}
										/>
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
