<script lang="ts">
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		deleteSession,
		disconnect,
		establish,
		refreshSessions,
		renameSession,
		retry,
		startNewSession
	} from '#lib/connection.svelte.ts';
	import { parseShareInput, toHref } from '#lib/share.ts';
	import { formatSessionDate, type Session } from '#lib/session.ts';

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

	// Effects never run on the server, so this is our "read the url on load" hook.
	// Reading page.url keeps it reactive: back/forward re-resolves for free, and
	// `bootstrap` also falls back to the connection saved from last time.
	$effect(() => {
		bootstrap(page.url.searchParams);
		ready = true;
	});

	// Our generated ids sort chronologically, so newest sessions come first.
	let sessions = $derived([...connection.sessions].sort((a, b) => (a.id < b.id ? 1 : -1)));

	// The friendly name of the session we just made, for the "ready" note.
	let activeName = $derived(
		connection.sessions.find((s) => s.id === connection.activeSession)?.name ??
			connection.activeSession
	);

	$effect(() => {
		if (ready && !api.url && connection.status !== 'checking') inputEl?.focus();
	});

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
	<div class="w-full max-w-md">
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
						onclick={startNewSession}
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
				{:else if connection.activeSession}
					<p class="text-center text-xs text-emerald-600">
						{activeName} is ready for takes.
					</p>
				{/if}

				<section class="space-y-3">
					<div class="flex items-center justify-between">
						<h2 class="text-xs font-medium tracking-wide text-neutral-500 uppercase">Sessions</h2>
						<button
							onclick={refreshSessions}
							disabled={connection.sessionsStatus === 'loading'}
							class="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
						>
							Refresh
						</button>
					</div>

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
												<span class="truncate text-sm text-neutral-800" title={session.name}>
													{session.name}
												</span>
												{#if formatSessionDate(session.updatedAt)}
													<span
														class="shrink-0 text-xs text-neutral-400"
														title="Last modified {formatSessionDate(session.updatedAt)}"
													>
														{formatSessionDate(session.updatedAt)}
													</span>
												{/if}
												{#if session.id === connection.activeSession}
													<span
														class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] tracking-wide text-emerald-700 uppercase"
													>
														ready
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
							placeholder="e.g. zz4k1q"
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
