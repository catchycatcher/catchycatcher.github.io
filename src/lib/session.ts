/**
 * Session id/name helpers. Pure string maths, so they live in a plain `.ts`
 * module — `new Date()` and `Math.random()` are not reactive state and have no
 * business in a `.svelte.ts` file.
 */

/** A session as the API describes it: a stable `id` plus a friendly `name`. */
export type Session = { id: string; name: string };

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
 * A friendly default name for a new session, e.g. `Lazy Horse (10/12/2026)`.
 * The date is local and formatted month/day/year.
 */
export function newSessionName(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const date = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
	return `${pick(ADJECTIVES)} ${pick(NOUNS)} (${date})`;
}
