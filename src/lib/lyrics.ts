/**
 * Pure lyric-line maths shared by the journal and the scribble editors.
 *
 * Re-lining is optimistic in the UI: each edit builds the new line list locally
 * (with {@link localLine}) so it shows instantly, then the server recomputes the
 * real BPM/timings and replaces it. These helpers only build that local list —
 * no state, no requests.
 */
import type { LyricLine, LyricWord } from './connection.svelte.ts';

/** The body the server's re-split endpoints expect. */
export function lyricsPayload(lines: LyricLine[]): { words: LyricWord[]; raw?: boolean }[] {
	return lines.map((line) => ({ words: line.words, raw: line.raw }));
}

/**
 * Build a display line locally so a re-line is instant. Timing comes from the
 * words when they carry it, falling back to the line the words came from.
 */
export function localLine(words: LyricWord[], raw: boolean, fallback: LyricLine): LyricLine {
	const starts = words
		.map((word) => word.start)
		.filter((value): value is number => typeof value === 'number');
	const ends = words
		.map((word) => word.end)
		.filter((value): value is number => typeof value === 'number');
	const line: LyricLine = {
		bpm: fallback.bpm ?? 0,
		'start time': starts.length ? Math.min(...starts) : fallback['start time'],
		'end time': ends.length ? Math.max(...ends) : fallback['end time'],
		words
	};
	if (raw) line.raw = true;
	return line;
}

/**
 * Merge a contiguous selection into one raw (bubble-less) line. A single line
 * just loses its bubbles so it can be carved back up. Returns ``null`` when
 * nothing would change.
 */
export function mergeSelected(lines: LyricLine[], indices: number[]): LyricLine[] | null {
	if (!indices.length) return null;
	const low = Math.max(0, indices[0]);
	const high = Math.min(lines.length - 1, indices[indices.length - 1]);
	if (high < low) return null;
	if (low === high && lines[low].raw) return null;
	const mergedWords: LyricWord[] = [];
	for (let index = low; index <= high; index++) mergedWords.push(...lines[index].words);
	if (!mergedWords.length) return null;
	return [
		...lines.slice(0, low),
		localLine(mergedWords, true, lines[low]),
		...lines.slice(high + 1)
	];
}

/**
 * Carve the words ``from..to`` of one raw line into a bubble, leaving the rest
 * raw so it can keep being carved. Returns ``null`` when nothing would change.
 */
export function carve(
	lines: LyricLine[],
	index: number,
	from: number,
	to: number
): LyricLine[] | null {
	const line = lines[index];
	if (!line) return null;
	const words = line.words;
	if (from === 0 && to === words.length - 1 && !line.raw) return null;
	const raw = Boolean(line.raw);
	const parts: LyricLine[] = [];
	if (from > 0) parts.push(localLine(words.slice(0, from), raw, line));
	parts.push(localLine(words.slice(from, to + 1), false, line));
	if (to + 1 < words.length) parts.push(localLine(words.slice(to + 1), raw, line));
	return [...lines.slice(0, index), ...parts, ...lines.slice(index + 1)];
}
