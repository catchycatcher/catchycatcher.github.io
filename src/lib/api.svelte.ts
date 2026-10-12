/**
 * The API url the rest of the app talks to, e.g. `https://1f4a9c.gradio.live`.
 * `null` until one has been resolved — see `#lib/share` for how it is derived.
 *
 * This lives in a `.svelte.ts` module so the whole app shares one reactive value.
 */
export const api = $state<{ url: string | null }>({ url: null });

/** Store the resolved API url and hand it back for convenience. */
export function setApiUrl(url: string): string {
	api.url = url;
	return url;
}

/** Forget the current url (used by the "use a different share code" action). */
export function clearApiUrl(): void {
	api.url = null;
}
