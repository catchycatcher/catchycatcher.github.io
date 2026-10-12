import { base62ToHex } from './base62';

/** Query parameters that supply a share code (the first one with a value wins). */
export const SHARE_CODE_PARAMS = ['share_code', 'shareCode', 'code', 's'];

/** Query parameters that supply a complete url, used verbatim. */
export const URL_PARAMS = ['url', 'api_url', 'apiUrl', 'api'];

export type ShareInput = { kind: 'share-code'; code: string } | { kind: 'url'; url: string };

export type ParseResult = ShareInput | { kind: 'invalid'; message: string };

/**
 * Build the API base url for a base62 share code by converting it to base16:
 * `https://<base16 share code>.gradio.live`.
 */
export function apiUrlForShareCode(code: string): string {
	return `https://${base62ToHex(code)}.gradio.live`;
}

/**
 * Work out what the user gave us: a base62 share code, or a whole url.
 *
 * Accepts anything that looks like a url (`https://x/y`, `x.gradio.live`) and
 * otherwise requires a valid base62 share code.
 */
export function parseShareInput(raw: string): ParseResult {
	const value = raw.trim();

	if (!value) {
		return { kind: 'invalid', message: 'Enter a share code.' };
	}

	// Looks like a url rather than a bare code.
	if (value.includes('://') || /[./]/.test(value)) {
		const candidate = value.includes('://') ? value : `https://${value}`;

		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			return { kind: 'invalid', message: `"${value}" is not a valid url.` };
		}

		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { kind: 'invalid', message: 'Only http and https urls are supported.' };
		}

		// Drop a trailing slash so `https://x.live/` and `https://x.live` agree.
		const path = url.pathname.replace(/\/$/, '');
		return { kind: 'url', url: url.origin + path + url.search };
	}

	if (!/^[0-9A-Za-z]+$/.test(value)) {
		return {
			kind: 'invalid',
			message: `"${value}" is not a valid share code — use letters and digits only.`
		};
	}

	return { kind: 'share-code', code: value };
}

/** Resolve a parsed input down to the url we will actually call. */
export function toApiUrl(input: ShareInput): string {
	return input.kind === 'url' ? input.url : apiUrlForShareCode(input.code);
}

/** The in-app href that reproduces a given input, keeping the address bar shareable. */
export function toHref(input: ShareInput): `/?${string}` {
	const key = input.kind === 'url' ? 'url' : 'share_code';
	const value = input.kind === 'url' ? input.url : input.code;
	return `/?${key}=${encodeURIComponent(value)}`;
}

/** Just the part of `URLSearchParams` we need, so `ReadonlyURLSearchParams` fits too. */
export type SearchParamsLike = { get(name: string): string | null };

export type Resolution =
	| { status: 'ready'; url: string; source: string }
	| { status: 'error'; message: string }
	| { status: 'prompt' };

/**
 * Work out the API url from a query string.
 *
 * Order of precedence: `?url=` > `?share_code=` > ask the user.
 * Pure — the caller decides whether to store the result.
 */
export function resolveFromParams(params: SearchParamsLike): Resolution {
	const rawUrl = firstParam(params, URL_PARAMS);
	if (rawUrl) {
		const parsed = parseShareInput(rawUrl);
		if (parsed.kind === 'invalid') {
			return { status: 'error', message: `Invalid \`url\` parameter: ${parsed.message}` };
		}
		return { status: 'ready', url: toApiUrl(parsed), source: 'the ?url parameter' };
	}

	const rawCode = firstParam(params, SHARE_CODE_PARAMS);
	if (rawCode) {
		const parsed = parseShareInput(rawCode);
		if (parsed.kind === 'invalid') {
			return { status: 'error', message: `Invalid \`share_code\` parameter: ${parsed.message}` };
		}
		return { status: 'ready', url: toApiUrl(parsed), source: 'the ?share_code parameter' };
	}

	return { status: 'prompt' };
}

function firstParam(params: SearchParamsLike, names: string[]): string | null {
	for (const name of names) {
		const value = params.get(name)?.trim();
		if (value) return value;
	}
	return null;
}
