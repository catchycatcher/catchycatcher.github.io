<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		getSession,
		getTakeResult,
		uploadTake
	} from '#lib/connection.svelte.ts';

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let sessionId = $state('');
	let sessionName = $state('');
	let transcriptLines = $state<string[]>([]);
	let uploading = $state(false);
	let error = $state<string | null>(null);
	let dragActive = $state(false);

	/** Guards the load effect so a session is fetched only once per id. */
	let loadedFor = '';

	// Effects never run on the server, so this reads the url in the browser and
	// also restores the saved server connection on a direct visit / refresh.
	$effect(() => {
		bootstrap(page.url.searchParams);
		sessionId = page.url.searchParams.get('id') ?? '';
		ready = true;
	});

	// Once we have a server and a session id, pull the name and latest transcript.
	$effect(() => {
		const url = api.url;
		const id = sessionId;
		if (!url || !id || loadedFor === id) return;
		loadedFor = id;
		void loadSession(url, id);
	});

	async function loadSession(url: string, id: string) {
		try {
			const session = await getSession(url, id);
			sessionName = session.name;

			// Show the most recent finished take so reopening a session is useful.
			const lastDone = [...session.takes].reverse().find((take) => take.status === 'done');
			if (lastDone) {
				const result = await getTakeResult(url, id, lastDone.take_id);
				transcriptLines = toLines(result?.lyrics ?? []);
			}
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Could not load the session.';
		}
	}

	function toLines(lyrics: { words: { word: string }[] }[]): string[] {
		return lyrics
			.map((line) =>
				line.words
					.map((word) => word.word)
					.join(' ')
					.trim()
			)
			.filter((line) => line.length > 0);
	}

	async function handleFiles(files: FileList | null) {
		const file = files?.[0];
		const url = api.url;
		if (!file || !url || !sessionId) return;

		uploading = true;
		error = null;
		try {
			const result = await uploadTake(url, sessionId, file);
			transcriptLines = toLines(result.lyrics);
		} catch (uploadError) {
			error =
				uploadError instanceof Error ? uploadError.message : 'Could not process the recording.';
		} finally {
			uploading = false;
		}
	}

	function onFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void handleFiles(input.files);
		// Reset so picking the same file again still fires a change event.
		input.value = '';
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragActive = false;
		void handleFiles(event.dataTransfer?.files ?? null);
	}

	function onDragOver(event: DragEvent) {
		event.preventDefault();
		dragActive = true;
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

	<div
		class="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-6 py-10"
	>
		{#if !ready}
			<p class="text-sm text-neutral-400">Loading…</p>
		{:else if connection.status === 'checking'}
			<div class="space-y-3 text-center">
				<div
					class="mx-auto size-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
				></div>
				<p class="text-sm text-neutral-500">Connecting…</p>
			</div>
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
			<label
				class:drag-active={dragActive}
				class="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 bg-neutral-50 px-6 py-10 text-center transition-colors hover:border-neutral-400 hover:bg-neutral-100"
				ondragover={onDragOver}
				ondragleave={() => (dragActive = false)}
				ondrop={onDrop}
			>
				<input type="file" accept="audio/*" class="sr-only" onchange={onFileChange} />
				{#if uploading}
					<div
						class="size-6 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
					></div>
					<p class="text-sm font-medium text-neutral-700">Processing your recording…</p>
					<p class="text-xs text-neutral-400">This can take a few minutes.</p>
				{:else}
					<p class="text-sm font-medium text-neutral-700">Click to upload a recording</p>
					<p class="text-xs text-neutral-400">or drag an audio file here</p>
				{/if}
			</label>

			{#if error}
				<p class="text-center text-xs text-red-600">{error}</p>
			{/if}

			{#if transcriptLines.length}
				<div class="w-full space-y-3 text-center text-lg leading-relaxed text-neutral-800">
					{#each transcriptLines as line, index (index)}
						<p>{line}</p>
					{/each}
				</div>
			{:else if !uploading}
				<p class="text-center text-sm text-neutral-400">
					The transcript will appear here once a recording is processed.
				</p>
			{/if}
		{/if}
	</div>
</main>
