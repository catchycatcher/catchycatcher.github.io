/**
 * Standard base62 alphabet (case-sensitive): digits, then A-Z, then a-z.
 * A character's digit is its index in this string.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = BigInt(ALPHABET.length);

export function isValidBase62(code: string): boolean {
	if (code.length === 0) return false;
	for (const char of code) {
		if (!ALPHABET.includes(char)) return false;
	}
	return true;
}

/**
 * Convert a base62 string to base16 (hex), e.g. `zz` -> `f03`.
 *
 * Uses BigInt so arbitrarily long share codes don't lose precision.
 * Leading `0`s carry no value and are dropped, exactly like `parseInt`.
 */
export function base62ToHex(code: string): string {
	if (!isValidBase62(code)) {
		throw new Error(`"${code}" is not a valid base62 string`);
	}

	let value = 0n;
	for (const char of code) {
		value = value * BASE + BigInt(ALPHABET.indexOf(char));
	}

	return value.toString(16);
}

/** Inverse of {@link base62ToHex}, handy for round-tripping a gradio.live subdomain. */
export function hexToBase62(hex: string): string {
	if (!/^[0-9a-fA-F]+$/.test(hex)) {
		throw new Error(`"${hex}" is not a valid hex string`);
	}

	let value = BigInt(`0x${hex}`);
	let out = '';
	while (value > 0n) {
		out = ALPHABET[Number(value % BASE)] + out;
		value /= BASE;
	}

	return out || '0';
}
