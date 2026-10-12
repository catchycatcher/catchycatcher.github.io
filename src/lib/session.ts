/**
 * Session id/name helpers. Pure string maths, so they live in a plain `.ts`
 * module — `new Date()` and `Math.random()` are not reactive state and have no
 * business in a `.svelte.ts` file.
 */

/** A session as the API describes it: a stable `id`, a friendly `name`, and
 * when it was last changed (`updatedAt`, an ISO-8601 string or null). */
export type Session = { id: string; name: string; updatedAt: string | null };

/**
 * A readable, collision-resistant id for a new session, e.g.
 * `session-20261012-143207-x4f`. Sorting ids lexically sorts them by creation
 * time, which is what the session list relies on.
 */
export function newSessionId(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = Math.random().toString(36).slice(2, 5);
	return `session-${stamp}-${suffix}`;
}

/** Words a fresh session name is built from: an adjective, a noun and a date. */
const ADJECTIVES = [
	'Brave',
	'Breezy',
	'Clever',
	'Cosmic',
	'Crimson',
	'Daring',
	'Dreamy',
	'Electric',
	'Fancy',
	'Feisty',
	'Frosty',
	'Gentle',
	'Glowing',
	'Golden',
	'Grumpy',
	'Happy',
	'Hazy',
	'Jolly',
	'Lazy',
	'Lucky',
	'Merry',
	'Misty',
	'Nimble',
	'Plucky',
	'Proud',
	'Quiet',
	'Rowdy',
	'Rusty',
	'Silent',
	'Silver',
	'Sleepy',
	'Snappy',
	'Spicy',
	'Spry',
	'Stormy',
	'Sunny',
	'Swift',
	'Tiny',
	'Wandering',
	'Whistling',
	'Wild',
	'Wobbly',
	'Zesty',
	'Zippy'
];

const NOUNS = [
	'Badger',
	'Cactus',
	'Canyon',
	'Cloud',
	'Comet',
	'Dolphin',
	'Dragon',
	'Echo',
	'Ember',
	'Falcon',
	'Forest',
	'Garden',
	'Harbor',
	'Horse',
	'Island',
	'Jaguar',
	'Kite',
	'Lagoon',
	'Lantern',
	'Maple',
	'Marble',
	'Meadow',
	'Meteor',
	'Moon',
	'Otter',
	'Panda',
	'Pebble',
	'Phoenix',
	'Pigeon',
	'Puppy',
	'River',
	'Rocket',
	'Sailboat',
	'Sparrow',
	'Star',
	'Sunflower',
	'Thunder',
	'Tiger',
	'Trail',
	'Turtle',
	'Violin',
	'Volcano',
	'Willow',
	'Wolf',
	'Wren',
	'Zephyr'
];

function pick(words: string[]): string {
	return words[Math.floor(Math.random() * words.length)];
}

/**
 * A friendly default name for a new session, e.g. `Lazy Horse`. The date is not
 * part of the name; the UI shows the session's last-modified date separately.
 */
export function newSessionName(): string {
	return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/**
 * A unique, path-safe id for an uploaded take, e.g. `take-m1x2y3-4f2`.
 * Takes are identified by id in the API, so this only needs to not collide.
 */
export function newTakeId(now: number = Date.now()): string {
	const stamp = now.toString(36);
	const suffix = Math.random().toString(36).slice(2, 5);
	return `take-${stamp}-${suffix}`;
}

/**
 * Format a session's last-modified timestamp as `MM/DD/YYYY` for display.
 * Returns an empty string when there is no usable timestamp.
 */
export function formatSessionDate(value: string | null): string {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (part: number) => String(part).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
}
