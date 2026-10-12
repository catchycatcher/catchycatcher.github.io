<script lang="ts">
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { clearApiUrl, setApiUrl } from '#lib/api.svelte.ts';
	import { parseShareInput, resolveFromParams, toApiUrl, toHref } from '#lib/share.ts';

	type Resolved = { url: string; source: string };

	/** False until the query string has been read in the browser. */
	let ready = $state(false);
	let resolved = $state<Resolved | null>(null);
	let input = $state('');
	let error = $state<string | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	// Effects never run on the server, so this is our "read the url on load" hook.
	// Reading page.url keeps it reactive: back/forward re-resolves for free.
	$effect(() => {
		const result = resolveFromParams(page.url.searchParams);

		if (result.status === 'ready') {
			resolved = { url: setApiUrl(result.url), source: result.source };
			error = null;
		} else if (result.status === 'error') {
			resolved = null;
			error = result.message;
		} else {
			resolved = null;
			error = null;
		}

		ready = true;
	});

	$effect(() => {
		if (ready && !resolved) inputEl?.focus();
	});

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();

		const parsed = parseShareInput(input);
		if (parsed.kind === 'invalid') {
			error = parsed.message;
			return;
		}

		error = null;
		resolved = { url: setApiUrl(toApiUrl(parsed)), source: 'your share code' };
		// Keep the address bar shareable/refreshable.
		await pushState(resolve(toHref(parsed)), {});
	}

	async function changeCode() {
		clearApiUrl();
		resolved = null;
		input = '';
		error = null;
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
		{:else if resolved}
			<div class="space-y-6">
				<div class="space-y-1 text-center">
					<h1 class="text-2xl font-semibold tracking-tight">Connected</h1>
					<p class="text-sm text-white/50">API url resolved from {resolved.source}.</p>
				</div>

				<p
					class="rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-xs break-all text-emerald-300"
				>
					{resolved.url}
				</p>

				<div class="flex justify-center">
					<button
						onclick={changeCode}
						class="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/5"
					>
						Use a different share code
					</button>
				</div>
			</div>
		{:else}
			<form onsubmit={handleSubmit} class="space-y-6">
				<div class="space-y-2 text-center">
					<h1 class="text-3xl font-semibold tracking-tight">CatchyCatcher</h1>
					<p class="text-sm text-white/50">
						Enter the share code for your Gradio app to get started.
					</p>
				</div>

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
					class="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-black hover:bg-white/90"
				>
					Connect
				</button>

				<p class="text-center text-xs text-white/30">
					Or add <code class="font-mono">?share_code=…</code> or
					<code class="font-mono">?url=…</code> to the address bar to skip this prompt.
				</p>
			</form>
		{/if}
	</div>
</main>
