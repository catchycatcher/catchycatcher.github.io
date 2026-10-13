<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		deleteTake,
		getSession,
		getTakeResult,
		processTake,
		renameTake,
		takeAudioUrl,
		uploadTake,
		type LyricLine,
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

	/** Inline rename state (which entry is being renamed and the draft name). */
	let editingId = $state<string | null>(null);
	let nameDraft = $state('');

	const recorder = new Recorder();

	/** When the current segment (audio since the last key) began. */
	let segmentStartedAt = $state(0);
	let elapsed = $state(0);

	/** Guards the load effect so a session is fetched only once per id. */
	let loadedFor = '';

	// Effects never run on the server, so this reads the url in the browser and
	// also restores the saved server connection on a direct visit / refresh.
	$effect(() => {
		bootstrap(page.url.searchParams);
		sessionId = page.url.searchParams.get('id') ?? '';
		ready = true;
	});

	// Once we have a server and a session id, pull the name and journal.
	$effect(() => {
		const url = api.url;
		const id = sessionId;
		if (!url || !id || loadedFor === id) return;
		loadedFor = id;
		void loadSession(url, id);
	});

	// The current segment's clock (it resets every time a key commits/scraps).
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

	// Keyboard workflow + microphone cleanup for the lifetime of the page.
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

	function normalizeStatus(status: string | undefined): EntryStatus {
		if (status === 'done' || status === 'processing' || status === 'error') return status;
		return 'recorded';
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
				status: normalizeStatus(take.status),
				lyrics: []
			}));
			loaded.sort((a, b) => b.index - a.index);
			entries = loaded;
			nextIndex = (loaded[loaded.length - 1]?.index ?? 0) + 1;
			error = null;

			// Load the lyrics for entries that were already processed.
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

	function updateEntry(localId: string, patch: Partial<Entry>) {
		entries = entries.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry));
	}

	async function startRecording() {
		await recorder.start();
		if (recorder.recording) segmentStartedAt = performance.now();
	}

	/** Commit the audio since the last key as a journal entry. */
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
				status: process ? 'processing' : 'recorded',
				lyrics: [],
				error: null
			},
			...entries
		];

		const extension = extensionForMime(blob.type);
		const file = new File([blob], `entry-${index}.${extension}`, {
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

	/** Scrap the audio recorded since the last key and carry on recording. */
	async function scrapCurrent() {
		if (!recorder.recording) return;
		await recorder.discardSegment();
		segmentStartedAt = performance.now();
	}

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
		if (!entry || !entry.serverId || entry.name === name) {
			if (entry && !entry.serverId) updateEntry(id, { name });
			return;
		}
		updateEntry(id, { name });
		try {
			await renameTake(api.url as string, sessionId, entry.serverId, name);
		} catch (renameError) {
			error = renameError instanceof Error ? renameError.message : 'Could not rename the entry.';
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
		if (event.key === 'Enter') {
			if (recorder.recording) {
				event.preventDefault();
				void commit(false);
			}
			return;
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			if (recorder.recording) {
				event.preventDefault();
				void scrapCurrent();
			}
		}
	}

	function formatElapsed(seconds: number): string {
		const whole = Math.floor(seconds);
		const minutes = Math.floor(whole / 60);
		return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
	}

	let pageTitle = $derived(sessionName ? `${sessionName} — Catchy Catcher` : 'Catchy Catcher');
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

<main class="flex min-h-dvh flex-col bg-white text-neutral-900">
	<header class="flex items-start justify-between gap-4 border-b border-neutral-100 px-6 py-4">
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

	<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-8">
		{#if !ready}
			<p class="text-sm text-neutral-400">Loading…</p>
		{:else if connection.status === 'checking'}
			<p class="text-sm text-neutral-500">Connecting…</p>
		{:else if !api.url}
			<div class="space-y-3 text-center">
				<p class="text-sm text-neutral-500">Not connected to a processing server.</p>
				<a href={resolve('/')} class="text-sm font-medium text-neutral-900 underline">
					Connect with a share code
				</a>
			</div>
		{:else if !sessionId}
			<p class="text-sm text-neutral-500">No session selected.</p>
		{:else}
			<section
				class="flex flex-col items-center gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-6 py-8 text-center"
			>
				{#if recorder.state === 'error'}
					<p class="text-sm text-red-600">{recorder.error}</p>
					<button
						onclick={startRecording}
						class="rounded-lg bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800"
					>
						Try again
					</button>
				{:else if recorder.recording}
					<div class="flex items-center gap-2 text-red-600">
						<span class="size-3 animate-pulse rounded-full bg-red-600"></span>
						<span class="text-sm font-medium">Recording</span>
						<span class="font-mono text-sm text-neutral-500">{formatElapsed(elapsed)}</span>
					</div>
					<p class="text-xs text-neutral-500">
						<kbd class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Space</kbd> keep
						&amp; process ·
						<kbd class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Enter</kbd> keep
						raw ·
						<kbd class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Delete</kbd> scrap
					</p>
					<button
						onclick={() => recorder.stop()}
						class="rounded-lg border border-neutral-300 px-5 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
					>
						Stop recording
					</button>
				{:else}
					<button
						onclick={startRecording}
						class="rounded-full bg-red-600 px-6 py-3 text-sm font-medium text-white hover:bg-red-700"
					>
						Start recording
					</button>
					<p class="text-xs text-neutral-500">
						Then sing and press <kbd
							class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Space</kbd
						>
						to keep &amp; process a phrase,
						<kbd class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Enter</kbd>
						to keep it raw, or
						<kbd class="rounded border border-neutral-300 bg-white px-1.5 py-0.5">Delete</kbd> to scrap
						it.
					</p>
				{/if}
			</section>

			{#if error}
				<p class="text-center text-xs text-red-600">{error}</p>
			{/if}

			<section class="space-y-3">
				<div class="flex items-center justify-between">
					<h2 class="text-xs font-medium tracking-wide text-neutral-500 uppercase">Journal</h2>
					<span class="text-xs text-neutral-400">{entries.length} entries</span>
				</div>

				{#if entries.length === 0}
					<p
						class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400"
					>
						Nothing yet — start recording and keep a phrase to fill your journal.
					</p>
				{:else}
					<ul class="space-y-3">
						{#each entries as entry (entry.localId)}
							<li class="space-y-3 rounded-xl border border-neutral-200 bg-white px-4 py-3">
								<div class="flex items-center justify-between gap-3">
									<div class="flex min-w-0 flex-1 items-center gap-2">
										<span class="font-mono text-xs text-neutral-400"
											>{String(entry.index).padStart(2, '0')}</span
										>
										{#if editingId === entry.localId}
											<form onsubmit={handleRename} class="flex min-w-0 flex-1 items-center gap-1">
												<input
													bind:value={nameDraft}
													aria-label="Entry name"
													class="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
												/>
												<button
													type="submit"
													class="shrink-0 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-800"
												>
													Save
												</button>
												<button
													type="button"
													onclick={cancelRename}
													class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
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
										{#if entry.status === 'recorded'}
											<button
												onclick={() => processEntry(entry)}
												class="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
											>
												Process
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
									<EntryPlayer src={entryAudio(entry)} lyrics={entry.lyrics} />
								{:else if entryAudio(entry)}
									<audio controls src={entryAudio(entry)} class="w-full"></audio>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>
</main>
