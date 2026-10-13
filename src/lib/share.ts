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
 * Strip everything that is not a base62 character, so a code that the user
 * typed or pasted with hyphens/spaces can be compared/used.
 */
export function normalizeShareCode(raw: string): string {
	return raw.replace(/[^0-9A-Za-z]/g, '');
}

/**
 * The group sizes a code of ``length`` characters splits into.
 *
 * Groups of four, with the tail arranged so there is never a stray one or two:
 * one left over becomes a group of five, two left over become two groups of
 * three, three left over stay as a group of four and a group of three.
 */
export function codeGroupSizes(length: number): number[] {
	if (length <= 0) return [];
	const full = Math.floor(length / 4);
	const remainder = length % 4;
	if (remainder === 0) return Array(full).fill(4);
	if (full === 0) return [length];
	if (remainder === 1) return [...Array(full - 1).fill(4), 5];
	if (remainder === 2) return [...Array(full - 1).fill(4), 3, 3];
	return [...Array(full).fill(4), 3];
}

/** Render a code with a hyphen every four characters (see {@link codeGroupSizes}). */
export function formatShareCode(code: string): string {
	const clean = normalizeShareCode(code);
	if (!clean) return '';
	const groups: string[] = [];
	let cursor = 0;
	for (const size of codeGroupSizes(clean.length)) {
		groups.push(clean.slice(cursor, cursor + size));
		cursor += size;
	}
	return groups.join('-');
}

/**
 * Work out what the user gave us: a base62 share code, or a whole url.
 *
 * Accepts anything that looks like a url (`https://x/y`, `x.gradio.live`) and
 * otherwise requires a valid base62 share code. Hyphens (and other separators)
 * in a code are ignored, so a grouped code like `zz4k-1q` is accepted.
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

	const code = normalizeShareCode(value);
	if (!code) {
		return {
			kind: 'invalid',
			message: `"${value}" is not a valid share code — use letters and digits only.`
		};
	}

	return { kind: 'share-code', code };
}

/** Resolve a parsed input down to the url we will actually call. */
export function toApiUrl(input: ShareInput): string {
	return input.kind === 'url' ? input.url : apiUrlForShareCode(input.code);
}

/** The in-app href that reproduces a given input, keeping the address bar shareable. */
export function toHref(input: ShareInput): `/?${string}` {
	const key = input.kind === 'url' ? 'url' : 'share_code';
	// Show a code grouped in the address bar; parsing strips the hyphens back out.
	const value = input.kind === 'url' ? input.url : formatShareCode(input.code);
	return `/?${key}=${encodeURIComponent(value)}`;
}

/** Just the part of `URLSearchParams` we need, so `ReadonlyURLSearchParams` fits too. */
export type SearchParamsLike = { get(name: string): string | null };

export type Resolution =
	| { status: 'ready'; url: string; source: string }
	| { status: 'error'; message: string }
	| { status: 'prompt' };

/** A parsed input plus where it came from, so the caller can also persist it. */
export type ParamInput =
	| { kind: 'input'; input: ShareInput; url: string; source: string }
	| { kind: 'error'; message: string }
	| { kind: 'none' };

/**
 * Like {@link resolveFromParams}, but keeps the parsed {@link ShareInput} so the
 * caller can save the code (not just the resolved url) for next time.
 *
 * Order of precedence: `?url=` > `?share_code=` > nothing.
 */
export function inputFromParams(params: SearchParamsLike): ParamInput {
	const rawUrl = firstParam(params, URL_PARAMS);
	if (rawUrl) {
		const parsed = parseShareInput(rawUrl);
		if (parsed.kind === 'invalid') {
			return { kind: 'error', message: `Invalid \`url\` parameter: ${parsed.message}` };
		}
		return { kind: 'input', input: parsed, url: toApiUrl(parsed), source: 'the ?url parameter' };
	}

	const rawCode = firstParam(params, SHARE_CODE_PARAMS);
	if (rawCode) {
		const parsed = parseShareInput(rawCode);
		if (parsed.kind === 'invalid') {
			return { kind: 'error', message: `Invalid \`share_code\` parameter: ${parsed.message}` };
		}
		return {
			kind: 'input',
			input: parsed,
			url: toApiUrl(parsed),
			source: 'the ?share_code parameter'
		};
	}

	return { kind: 'none' };
}

/**
 * Work out the API url from a query string.
 *
 * Order of precedence: `?url=` > `?share_code=` > ask the user.
 * Pure — the caller decides whether to store the result.
 */
export function resolveFromParams(params: SearchParamsLike): Resolution {
	const result = inputFromParams(params);
	if (result.kind === 'error') return { status: 'error', message: result.message };
	if (result.kind === 'input') {
		return { status: 'ready', url: result.url, source: result.source };
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
