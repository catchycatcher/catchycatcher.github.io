<script lang="ts">
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api.svelte.ts';
	import {
		bootstrap,
		connection,
		disconnect,
		establish,
		refreshSessions,
		retry,
		startNewSession
	} from '#lib/connection.svelte.ts';
	import { parseShareInput, toHref } from '#lib/share.ts';

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let input = $state('');
	let error = $state<string | null>(null);
	let submitting = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	// Effects never run on the server, so this is our "read the url on load" hook.
	// Reading page.url keeps it reactive: back/forward re-resolves for free, and
	// `bootstrap` also falls back to the connection saved from last time.
	$effect(() => {
		bootstrap(page.url.searchParams);
		ready = true;
	});

	// Our generated ids sort chronologically, so newest sessions come first.
	let sessions = $derived([...connection.sessions].sort().reverse());

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
</script>

<svelte:head>
	<title>CatchyCatcher</title>
	<meta name="description" content="CatchyCatcher — connect to your audio API." />
</svelte:head>

<main class="grid min-h-dvh place-items-center bg-black px-6 text-white">
	<div class="w-full max-w-md">
		{#if !ready}
			<p class="text-center text-sm text-white/40">Loading…</p>
		{:else if connection.status === 'checking'}
			<div class="space-y-3 text-center">
				<div
					class="mx-auto size-8 animate-spin rounded-full border-2 border-white/20 border-t-white"
				></div>
				<p class="text-sm text-white/50">Connecting…</p>
			</div>
		{:else if api.url}
			<div class="space-y-6">
				<div class="space-y-1 text-center">
					<h1 class="text-2xl font-semibold tracking-tight">Connected</h1>
					<p class="text-sm text-white/50">
						API url resolved from {connection.source || 'your share code'}.
					</p>
				</div>

				<p
					class="rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-xs break-all text-emerald-300"
				>
					{api.url}
				</p>

				<div class="flex gap-3">
					<button
						onclick={startNewSession}
						disabled={connection.busy}
						class="flex-1 rounded-lg bg-white px-4 py-3 text-sm font-medium text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{connection.busy ? 'Creating…' : 'New session'}
					</button>
					<button
						onclick={handleDisconnect}
						class="flex-1 rounded-lg border border-white/15 px-4 py-3 text-sm text-white/80 hover:bg-white/5"
					>
						Disconnect
					</button>
				</div>

				{#if connection.error}
					<p class="text-center text-xs text-red-400">{connection.error}</p>
				{:else if connection.activeSession}
					<p class="text-center text-xs text-emerald-300">
						{connection.activeSession} is ready for takes.
					</p>
				{/if}

				<section class="space-y-3">
					<div class="flex items-center justify-between">
						<h2 class="text-xs font-medium tracking-wide text-white/60 uppercase">Sessions</h2>
						<button
							onclick={refreshSessions}
							disabled={connection.sessionsStatus === 'loading'}
							class="text-xs text-white/50 hover:text-white disabled:opacity-50"
						>
							Refresh
						</button>
					</div>

					{#if sessions.length === 0}
						<p class="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/40">
							{connection.sessionsStatus === 'loading'
								? 'Loading…'
								: 'No sessions yet. Create one to get started.'}
						</p>
					{:else}
						<ul class="space-y-2">
							{#each sessions as session (session)}
								<li
									class="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3"
								>
									<span class="font-mono text-xs break-all text-white/80">{session}</span>
									{#if session === connection.activeSession}
										<span
											class="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] tracking-wide text-emerald-300 uppercase"
										>
											ready
										</span>
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
					<h1 class="text-3xl font-semibold tracking-tight">CatchyCatcher</h1>
					<p class="text-sm text-white/50">
						Enter the share code for your Gradio app to get started.
					</p>
				</div>

				{#if connection.notice}
					<div class="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3">
						<p class="text-xs text-amber-200">{connection.notice}</p>
						{#if connection.saved}
							<button
								onclick={retry}
								class="text-xs font-medium text-amber-200 underline underline-offset-2 hover:text-amber-100"
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
							class="block text-xs font-medium tracking-wide text-white/60 uppercase"
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
							class="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3 font-mono text-sm text-white placeholder:text-white/25 focus:border-white/40 focus:ring-2 focus:ring-white/10 focus:outline-none"
						/>
						{#if error}
							<p class="text-xs text-red-400">{error}</p>
						{/if}
					</div>

					<button
						type="submit"
						disabled={submitting}
						class="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{submitting ? 'Connecting…' : 'Connect'}
					</button>

					<p class="text-center text-xs text-white/30">
						Or add <code class="font-mono">?share_code=…</code> or
						<code class="font-mono">?url=…</code> to the address bar to skip this prompt.
					</p>
				</form>
			</div>
		{/if}
	</div>
</main>
