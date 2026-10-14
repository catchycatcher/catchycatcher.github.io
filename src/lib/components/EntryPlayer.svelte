<script lang="ts">
	import { untrack } from 'svelte';
	import type { LyricLine } from '#lib/connection.svelte.ts';
	import { extensionForMime } from '#lib/recorder.svelte.ts';

	let {
		src,
		lyrics,
		loading = false,
		emptyLabel = 'No words detected in this take.',
		downloadName = 'audio',
		dragLine,
		allowReorder = false,
		selectable = false,
		onDropLines,
		onMoveLines,
		onRemove,
		onRemoveSelected,
		onRemoveGroup,
		onEditLine,
		onLocateLine,
		onMergeSelected,
		onCarve,
		onGroupLines,
		onUngroup,
		onRenameGroup,
		lineRef,
		framed = true
	}: {
		src: string;
		lyrics: LyricLine[];
		/** Show a spinner on the play button (e.g. while the mix re-renders). */
		loading?: boolean;
		/** Message shown when there are no lines; ``null`` hides it entirely. */
		emptyLabel?: string | null;
		/** Base filename (an extension is chosen from the audio type). */
		downloadName?: string;
		/** Per-line payload for dragging out (journal → scrapbook); null = no drag. */
		dragLine?: (lineIndex: number) => unknown | null;
		/** Per-line ref, used to drag an existing group out as a linked copy. */
		lineRef?: (lineIndex: number) => unknown | null;
		/** Allow dragging the selection to reorder within this player. */
		allowReorder?: boolean;
		/** Allow selecting lines (e.g. to reline) without drag-reorder. */
		selectable?: boolean;
		/** A selection of lines dropped in at ``index`` (``group`` = section to join). */
		onDropLines?: (refs: unknown[], index: number, group?: Group | null) => void;
		/** Move the selected line indices to sit before ``index`` (or copy them). */
		onMoveLines?: (from: number[], to: number, group?: Group | null, copy?: boolean) => void;
		onRemove?: (index: number) => void;
		/** Delete every selected line at once (Backspace/Delete). */
		onRemoveSelected?: (indices: number[]) => void;
		/** Delete a whole section (all of the given line indices). */
		onRemoveGroup?: (indices: number[]) => void;
		/** Double-clicking a line edits its text (timings are re-guessed). */
		onEditLine?: (index: number, text: string) => void;
		/** Ctrl/cmd-clicking a line jumps to it in the journal. */
		onLocateLine?: (index: number) => void;
		/** Ctrl/cmd-clicking merges the selected lines into one raw text line. */
		onMergeSelected?: (indices: number[]) => void;
		/** Drag across words of a raw line to carve a bubble. */
		onCarve?: (index: number, from: number, to: number) => void;
		/** Group the selected lines under a section type (chorus/verse/bridge/other). */
		onGroupLines?: (indices: number[], type: string, name?: string) => void;
		/** Ungroup one section instance (the given line indices). */
		onUngroup?: (indices: number[]) => void;
		/** Rename a section. */
		onRenameGroup?: (groupId: string, name: string) => void;
		/** Draw the rounded border/background bubble. Off when the parent supplies it. */
		framed?: boolean;
	} = $props();

	type Group = { id: string; type: string; name?: string; instance?: string };
	type Line = {
		text: string;
		start: number;
		end: number;
		words: string[];
		raw: boolean;
		group?: Group;
		/** Small badge telling apart same-lyric lines from different recordings. */
		tag?: number;
	};
	type Row =
		| { kind: 'line'; index: number }
		| {
				kind: 'group';
				id: string;
				instance: string;
				type: string;
				name: string;
				indices: number[];
		  };

	/** Colours for the section groups. */
	const SECTION_STYLES: Record<string, string> = {
		chorus: 'border-orange-400 bg-orange-200 text-orange-900',
		verse: 'border-rose-400 bg-rose-200 text-rose-900',
		bridge: 'border-green-400 bg-green-200 text-green-900',
		'pre-chorus': 'border-purple-400 bg-purple-200 text-purple-900',
		tag: 'border-yellow-400 bg-yellow-200 text-yellow-900',
		intro: 'border-pink-400 bg-pink-200 text-pink-900',
		outro: 'border-pink-400 bg-pink-200 text-pink-900',
		other: 'border-neutral-300 bg-neutral-200 text-neutral-700'
	};
	/** The bubbles inside an open section sit on its colour as white pills. */
	const SECTION_INNER_STYLES: Record<string, string> = {
		chorus: 'border-orange-400 bg-white text-orange-900',
		verse: 'border-rose-400 bg-white text-rose-900',
		bridge: 'border-green-400 bg-white text-green-900',
		'pre-chorus': 'border-purple-400 bg-white text-purple-900',
		tag: 'border-yellow-400 bg-white text-yellow-900',
		intro: 'border-pink-400 bg-white text-pink-900',
		outro: 'border-pink-400 bg-white text-pink-900',
		other: 'border-neutral-400 bg-white text-neutral-800'
	};
	const SECTION_LABELS: Record<string, string> = {
		chorus: 'Chorus',
		verse: 'Verse',
		bridge: 'Bridge',
		'pre-chorus': 'Pre-chorus',
		tag: 'Tag',
		intro: 'Intro',
		outro: 'Outro',
		other: 'Other'
	};
	/** The buttons shown when lines are selected. */
	const SECTIONS: { type: string; label: string }[] = [
		{ type: 'chorus', label: 'Chorus' },
		{ type: 'verse', label: 'Verse' },
		{ type: 'bridge', label: 'Bridge' },
		{ type: 'pre-chorus', label: 'Pre-chorus' },
		{ type: 'tag', label: 'Tag' },
		{ type: 'other', label: 'Other' }
	];

	let audio = $state<HTMLAudioElement | null>(null);
	let rootEl = $state<HTMLDivElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);
	let playing = $state(false);
	let currentTime = $state(0);
	let duration = $state(0);
	/** Indices the user has selected (click / shift-click). */
	let selected = $state<number[]>([]);
	/** Where a shift-click range starts from. */
	let anchor = $state<number | null>(null);
	/** Insertion point for a drag, drawn as a line between bubbles. */
	let dropIndex = $state<number | null>(null);
	/** The section a drop would join (null = outside every section). */
	let dropGroup = $state<Group | null>(null);
	/** Absolute top (px) for the insertion line, so it never shifts the rows. */
	let dropTop = $state<number | null>(null);
	/** Index of the line being text-edited, if any. */
	let editing = $state<number | null>(null);
	let editDraft = $state('');
	/** Word range being dragged out for carving (only on a raw line). */
	let carving = $state<{ index: number; from: number; to: number } | null>(null);

	/**
	 * Swapping ``src`` (e.g. the scrapbook's vocals-only ⇄ backgrounds mix)
	 * reloads the element and drops the playhead, so remember where we were and
	 * restore it once the new source's metadata arrives. Only for a direct swap
	 * between two sources — not a first load, and not a clear-to-empty.
	 */
	let lastSrc = '';
	let pendingSwap: { time: number; play: boolean } | null = null;

	$effect.pre(() => {
		const next = src;
		if (next === lastSrc) return;
		const previous = lastSrc;
		lastSrc = next;
		if (!next || !previous) return;
		pendingSwap = { time: untrack(() => currentTime), play: untrack(() => playing) };
	});

	function onLoadedMetadata() {
		duration = audio?.duration ?? 0;
		const swap = pendingSwap;
		if (!swap || !audio) return;
		pendingSwap = null;
		audio.currentTime = swap.time;
		currentTime = swap.time;
		if (swap.play) void audio.play();
	}

	/** Each line's display text (edited override, else its words joined). */
	function resolve(rawLines: LyricLine[]): Line[] {
		return rawLines
			.map((line) => {
				const start = Number(line['start time']) || 0;
				const end = Math.max(Number(line['end time']) || start, start);
				const rawWords = line.words ?? [];
				const text =
					typeof line.text === 'string' && line.text.trim()
						? line.text.trim()
						: rawWords
								.map((word) => word.word)
								.join(' ')
								.trim();
				return {
					text,
					start,
					end,
					words: rawWords.map((word) => word.word),
					raw: Boolean(line.raw),
					group: line.group,
					tag: line.tag
				};
			})
			.filter((line) => line.text.length > 0);
	}

	function findLine(lines: Line[], time: number): number {
		for (let index = 0; index < lines.length; index++) {
			const next = lines[index + 1];
			const end = next ? next.start : lines[index].end;
			if (time >= lines[index].start && time < end) return index;
		}
		return -1;
	}

	let lines = $derived(resolve(lyrics));
	let playable = $derived(Boolean(src));
	let canSelect = $derived(Boolean(dragLine || allowReorder || selectable));
	let droppable = $derived(Boolean(onDropLines || onMoveLines));
	let activeLine = $derived(playable && playing ? findLine(lines, currentTime) : -1);

	/** Which groups are expanded to show their lines (double-click toggles). */
	let expandedGroups = $state<Record<string, boolean>>({});

	/** Collapse runs of lines that share a section *instance* into one group row. */
	function buildRows(items: Line[]): Row[] {
		const rows: Row[] = [];
		const keyOf = (line: Line): string | undefined => line.group?.instance ?? line.group?.id;
		let i = 0;
		while (i < items.length) {
			const group = items[i].group;
			if (group) {
				const key = keyOf(items[i]);
				const indices = [i];
				let j = i + 1;
				while (j < items.length && keyOf(items[j]) === key) {
					indices.push(j);
					j++;
				}
				rows.push({
					kind: 'group',
					id: group.id,
					instance: key ?? group.id,
					type: group.type,
					name: group.name || sectionLabel(group.type),
					indices
				});
				i = j;
			} else {
				rows.push({ kind: 'line', index: i });
				i++;
			}
		}
		return rows;
	}

	let rows = $derived(buildRows(lines));

	/** Distinct sections present, in order of first appearance (for the top row). */
	let groupList = $derived.by(() => {
		const seen: Record<string, { id: string; type: string; name: string }> = {};
		const list: { id: string; type: string; name: string }[] = [];
		for (const row of rows) {
			if (row.kind === 'group' && !seen[row.id]) {
				const entry = { id: row.id, type: row.type, name: row.name };
				seen[row.id] = entry;
				list.push(entry);
			}
		}
		return list;
	});

	function rowKey(row: Row): string {
		return row.kind === 'line' ? `line-${row.index}` : `group-${row.instance}`;
	}

	/** Dragging a section chip out makes a linked copy where it is dropped. */
	function dragGroupChip(event: DragEvent, groupId: string) {
		if (!event.dataTransfer || !lineRef) return;
		const row = rows.find((candidate) => candidate.kind === 'group' && candidate.id === groupId);
		if (!row || row.kind !== 'group') return;
		const refs = row.indices.map((index) => lineRef(index)).filter((ref) => ref != null);
		if (!refs.length) return;
		event.dataTransfer.setData('application/x-catchy-lines', JSON.stringify(refs));
		event.dataTransfer.effectAllowed = 'copy';
		showDragPreview(event, [previewGroup(row.indices)]);
	}

	function sectionStyle(type: string): string {
		return SECTION_STYLES[type] ?? SECTION_STYLES.other;
	}

	function sectionInnerStyle(type: string): string {
		return SECTION_INNER_STYLES[type] ?? SECTION_INNER_STYLES.other;
	}

	function sectionLabel(type: string): string {
		return SECTION_LABELS[type] ?? 'Other';
	}

	/** Create a section from the selection (naming it first for "other"). */
	function createSection(type: string) {
		if (!onGroupLines || !selected.length) return;
		if (type === 'other') {
			const name = window.prompt('Name this section', 'Other');
			if (name === null) return;
			onGroupLines([...selected], type, name.trim() || 'Other');
			return;
		}
		onGroupLines([...selected], type);
	}

	/** The coloured block that wraps a section's label and its lines. */
	function groupWrapClass(type: string): string {
		return `w-fit max-w-full rounded-xl border px-2 py-1.5 ${sectionStyle(type)}`;
	}

	function toggleGroupOpen(id: string, event: MouseEvent) {
		event.preventDefault();
		expandedGroups[id] = !expandedGroups[id];
	}

	/** Select every line of a section (so playback starts there). */
	function selectGroup(indices: number[], event: MouseEvent) {
		event.stopPropagation();
		if (!canSelect) return;
		selected = [...indices];
		anchor = indices[0];
	}
	let renamingGroup = $state<string | null>(null);
	let groupNameDraft = $state('');

	function beginGroupRename(id: string, name: string) {
		renamingGroup = id;
		groupNameDraft = name;
	}

	function cancelGroupRename() {
		renamingGroup = null;
		groupNameDraft = '';
	}

	function commitGroupRename(event: SubmitEvent) {
		event.preventDefault();
		const id = renamingGroup;
		const name = groupNameDraft.trim();
		renamingGroup = null;
		if (id && name && onRenameGroup) onRenameGroup(id, name);
	}

	// A new line set (re-render, reorder, add) invalidates selection/editing.
	$effect(() => {
		const current = lyrics;
		selected = [];
		anchor = null;
		editing = null;
		carving = null;
		void current;
	});

	// Backspace/Delete removes every selected line.
	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Backspace' && event.key !== 'Delete') return;
			if (!selected.length || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
			) {
				return;
			}
			if (!onRemoveSelected && !onRemove) return;
			event.preventDefault();
			removeSelection();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// Clicking anywhere outside this player deselects its bubbles.
	$effect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!canSelect) return;
			const target = event.target;
			if (!rootEl || !(target instanceof Node)) return;
			if (rootEl.contains(target)) return;
			selected = [];
			anchor = null;
		};
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => window.removeEventListener('pointerdown', onPointerDown, true);
	});

	// Keep the line being sung in view as playback moves along.
	$effect(() => {
		const index = activeLine;
		if (index < 0 || !listEl) return;
		listEl.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
			block: 'nearest',
			behavior: 'smooth'
		});
	});

	// Smooth highlighting: `timeupdate` only fires ~4x/second, which reads as
	// laggy, so follow the playhead every animation frame while playing.
	$effect(() => {
		if (!playing) return;
		const element = audio;
		let frame = 0;
		const tick = () => {
			if (element) currentTime = element.currentTime;
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	});

	/** Pressing play starts at the first selected line, else resumes/pauses. */
	function toggle() {
		if (!audio || !playable) return;
		if (playing) {
			audio.pause();
			return;
		}
		const start = selected.length ? lines[selected[0]]?.start : undefined;
		playFrom(start ?? audio.currentTime);
	}

	function playFrom(seconds: number) {
		if (!audio || !playable) return;
		audio.currentTime = seconds;
		currentTime = seconds;
		void audio.play();
	}

	function onSeek(event: Event) {
		playFrom(Number((event.currentTarget as HTMLInputElement).value));
	}

	function onLineClick(index: number, event: MouseEvent) {
		if ((event.ctrlKey || event.metaKey) && onLocateLine) {
			event.preventDefault();
			onLocateLine(index);
			return;
		}
		if ((event.ctrlKey || event.metaKey) && onMergeSelected) {
			event.preventDefault();
			const indices = selected.includes(index) ? [...selected] : [...selected, index];
			onMergeSelected([...indices].sort((a, b) => a - b));
			return;
		}
		if (!canSelect) return;
		if (event.shiftKey && anchor !== null) {
			const low = Math.min(anchor, index);
			const high = Math.max(anchor, index);
			selected = Array.from({ length: high - low + 1 }, (_unused, step) => low + step);
			return;
		}
		// Clicking the only selected line again clears the selection.
		if (selected.length === 1 && selected[0] === index) {
			selected = [];
			anchor = null;
			return;
		}
		selected = [index];
		anchor = index;
	}

	/** Clicking the empty space of the list clears the selection. */
	function onListClick(event: MouseEvent) {
		if (!canSelect) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('button, input, a, [data-group-row]')) return;
		selected = [];
		anchor = null;
	}

	function onLineDoubleClick(index: number, event: MouseEvent) {
		if (!onEditLine) return;
		event.preventDefault();
		selected = [];
		anchor = null;
		editing = index;
		editDraft = lines[index].text;
	}

	function wordPointerDown(index: number, wordIndex: number, event: PointerEvent) {
		if (!onCarve || !lines[index]?.raw) return;
		event.preventDefault();
		try {
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		} catch {
			/* synthetic or stale pointer id; carving still works without capture */
		}
		carving = { index, from: wordIndex, to: wordIndex };
		// The line re-renders while dragging (the bubble grows/wraps), which can
		// drop the captured element, so track move/up from window listeners.
		window.addEventListener('pointermove', wordPointerMove);
		window.addEventListener('pointerup', wordPointerUp, { once: true });
		window.addEventListener('pointercancel', cancelCarve, { once: true });
	}

	function cancelCarve() {
		carving = null;
		window.removeEventListener('pointermove', wordPointerMove);
		window.removeEventListener('pointerup', wordPointerUp);
	}

	function wordPointerMove(event: PointerEvent) {
		if (!carving) return;
		const element = document.elementFromPoint(event.clientX, event.clientY);
		const span = element?.closest<HTMLElement>('[data-word-index]');
		if (!span) return;
		const lineIndex = Number(span.dataset.lineIndex);
		if (lineIndex !== carving.index) return;
		const wordIndex = Number(span.dataset.wordIndex);
		if (Number.isNaN(wordIndex) || wordIndex === carving.to) return;
		carving = { index: carving.index, from: carving.from, to: wordIndex };
	}

	function wordPointerUp() {
		const active = carving;
		carving = null;
		window.removeEventListener('pointermove', wordPointerMove);
		window.removeEventListener('pointercancel', cancelCarve);
		if (active && onCarve) {
			onCarve(active.index, Math.min(active.from, active.to), Math.max(active.from, active.to));
		}
	}

	/** Whether a word falls inside the in-progress carve selection. */
	function isCarving(index: number, wordIndex: number): boolean {
		if (!carving || carving.index !== index) return false;
		const low = Math.min(carving.from, carving.to);
		const high = Math.max(carving.from, carving.to);
		return wordIndex >= low && wordIndex <= high;
	}

	function commitEdit(event: SubmitEvent) {
		event.preventDefault();
		const index = editing;
		editing = null;
		const text = editDraft.trim();
		if (index !== null && text && onEditLine) onEditLine(index, text);
	}

	function cancelEdit() {
		editing = null;
		editDraft = '';
	}

	function selectedIndices(index: number): number[] {
		const indices = selected.includes(index) ? selected : [index];
		return [...indices].sort((a, b) => a - b);
	}

	/** Delete the current selection (Backspace/Delete). */
	function removeSelection() {
		const indices = [...selected].sort((a, b) => a - b);
		if (!indices.length) return;
		selected = [];
		anchor = null;
		if (onRemoveSelected) {
			onRemoveSelected(indices);
			return;
		}
		for (let position = indices.length - 1; position >= 0; position--)
			onRemove?.(indices[position]);
	}

	/** Structure shared by every bubble (colour is chosen separately). */
	const BUBBLE_BASE =
		'w-fit max-w-full break-words select-none rounded-xl border px-2.5 py-1 text-left text-sm leading-snug transition-colors';
	const RAW_BUBBLE =
		'w-full touch-none break-words select-none rounded-md px-1 py-1 text-left text-sm leading-snug text-neutral-700';

	/** The bubble's colour classes: selection/playback highlight, or the plain look. */
	function bubbleState(index: number, highlight: boolean): string {
		const group = lines[index]?.group;
		const groupKey = group?.instance ?? group?.id;
		const inOpenGroup = groupKey ? Boolean(expandedGroups[groupKey]) : false;
		const plain = inOpenGroup
			? sectionInnerStyle(group?.type ?? 'other')
			: 'border-neutral-200 bg-white/60 hover:bg-white';
		if (!highlight) return plain;
		if (selected.includes(index) && index === activeLine) {
			// Yellow outline replaces the blue one (no double outline).
			return 'border-amber-400 bg-blue-200';
		}
		if (selected.includes(index)) return 'border-blue-400 bg-blue-200';
		if (index === activeLine) return 'border-amber-300 bg-amber-200 text-neutral-900';
		return plain;
	}

	/** The bubble's colour on its own, ignoring selection/playback highlights. */
	function bubbleBaseClass(index: number): string {
		if (lines[index]?.raw) return RAW_BUBBLE;
		return `${BUBBLE_BASE} ${bubbleState(index, false)}`;
	}

	function bubbleClass(index: number): string {
		if (lines[index]?.raw) return RAW_BUBBLE;
		return `${BUBBLE_BASE} ${bubbleState(index, true)}`;
	}

	function writeDragPayload(event: DragEvent, indices: number[]) {
		if (!event.dataTransfer) return;
		if (dragLine) {
			const refs = indices.map((item) => dragLine(item)).filter((ref) => ref != null);
			if (!refs.length) return;
			event.dataTransfer.setData('application/x-catchy-lines', JSON.stringify(refs));
			event.dataTransfer.effectAllowed = 'copy';
		} else if (allowReorder) {
			event.dataTransfer.setData('application/x-catchy-indices', JSON.stringify(indices));
			// Alt at the drop turns this into a copy, so allow both effects.
			event.dataTransfer.effectAllowed = 'copyMove';
		}
	}

	/** A DOM snapshot of one line, in its original (unselected) colour. */
	function previewLine(index: number): HTMLElement {
		const line = lines[index];
		const node = document.createElement('div');
		node.className = bubbleBaseClass(index);
		if (line?.raw) {
			node.textContent = line.text;
			return node;
		}
		for (const word of line?.words ?? []) {
			const span = document.createElement('span');
			span.className = 'mr-1 inline-block rounded px-0.5';
			span.textContent = word;
			node.appendChild(span);
		}
		if (line?.tag) {
			const tag = document.createElement('span');
			tag.className =
				'ml-1.5 inline-block rounded-full bg-black/10 px-1.5 align-middle text-[10px] leading-tight font-semibold';
			tag.textContent = String(line.tag);
			node.appendChild(tag);
		}
		return node;
	}

	/** A DOM snapshot of a whole section, in its own colour. */
	function previewGroup(indices: number[]): HTMLElement {
		const group = lines[indices[0]]?.group;
		const wrap = document.createElement('div');
		wrap.className = groupWrapClass(group?.type ?? 'other');
		const header = document.createElement('div');
		header.className = 'text-[11px] font-semibold tracking-wide uppercase';
		header.textContent = group?.name || sectionLabel(group?.type ?? 'other');
		wrap.appendChild(header);
		const body = document.createElement('div');
		body.className = 'mt-1.5 flex flex-col gap-1 pl-1';
		for (const index of indices) body.appendChild(previewLine(index));
		wrap.appendChild(body);
		return wrap;
	}

	/** The line indices of the first section instance with ``groupId``. */
	function rowsOfGroup(groupId: string): number[] {
		const row = rows.find((candidate) => candidate.kind === 'group' && candidate.id === groupId);
		return row && row.kind === 'group' ? row.indices : [];
	}

	/**
	 * Show a custom image of what is being dragged under the cursor: every row in
	 * the selection, or a whole section — with no extra chrome and no selection
	 * highlight, so it looks just like the rows on the page.
	 */
	function showDragPreview(event: DragEvent, nodes: HTMLElement[]) {
		if (!event.dataTransfer || !nodes.length) return;
		const preview = document.createElement('div');
		preview.setAttribute('aria-hidden', 'true');
		preview.style.cssText = [
			'position: fixed',
			'top: -10000px',
			'left: -10000px',
			'display: flex',
			'flex-direction: column',
			'gap: 6px',
			'align-items: flex-start',
			'max-width: 320px',
			'pointer-events: none'
		].join(';');
		for (const node of nodes) {
			node.style.margin = '0';
			node.style.flexShrink = '0';
			preview.appendChild(node);
		}
		document.body.appendChild(preview);
		const rect = preview.getBoundingClientRect();
		event.dataTransfer.setDragImage(preview, Math.min(20, rect.width / 2), 14);
		// The browser snapshots the node now; this is just a placeholder to drop.
		window.setTimeout(() => preview.remove(), 0);
	}

	function dragStart(event: DragEvent, index: number) {
		// Keep the row drag from also triggering the section drag it sits in.
		event.stopPropagation();
		const indices = selectedIndices(index);
		writeDragPayload(event, indices);
		showDragPreview(
			event,
			[...indices].sort((a, b) => a - b).map((item) => previewLine(item))
		);
	}

	/** Dragging a section (from anywhere on it) moves every line inside. */
	function dragGroupStart(event: DragEvent, indices: number[], groupId: string) {
		writeDragPayload(event, indices);
		const groupLines = rowsOfGroup(groupId);
		showDragPreview(event, [previewGroup(groupLines.length ? groupLines : indices)]);
		if (allowReorder && !dragLine) {
			selected = [...indices];
			anchor = indices[0];
		}
	}

	function lineText(index: number): string {
		return lines[index]?.text ?? '';
	}

	function rowStart(element: HTMLElement): number {
		return Number(element.dataset.lineStart ?? 0);
	}

	/**
	 * Where a drop at ``clientY`` lands, and which section (if any) it joins.
	 *
	 * The top half of a section header means "before the section" (outside); its
	 * bottom half joins at the start. A little footer row under the lines joins at
	 * the end; below that the line lands after the section.
	 */
	function insertionIndex(clientY: number): { index: number; group: Group | null; top: number } {
		if (!listEl) return { index: lines.length, group: null, top: 0 };
		const rowEls = [...listEl.querySelectorAll<HTMLElement>('[data-row][data-line-start]')];
		for (const element of rowEls) {
			const rect = element.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) {
				const index = rowStart(element);
				const top = Math.max(0, element.offsetTop - 2);
				if (element.dataset.groupRow === 'true') return { index, group: null, top };
				if (element.dataset.groupEnd === 'true') {
					return { index, group: lines[index - 1]?.group ?? null, top };
				}
				return { index, group: lines[index]?.group ?? null, top };
			}
		}
		const last = rowEls[rowEls.length - 1];
		return {
			index: lines.length,
			group: null,
			top: last ? last.offsetTop + last.offsetHeight + 2 : 0
		};
	}

	function onListDragOver(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		// An internal reorder is a move (Alt makes it a copy); anything dragged in
		// from elsewhere is a copy. Default to 'copy' so a missing type list can
		// never make the browser reject the drop.
		if (event.dataTransfer) {
			const internal = Array.from(event.dataTransfer.types).includes(
				'application/x-catchy-indices'
			);
			event.dataTransfer.dropEffect = internal && !event.altKey ? 'move' : 'copy';
		}
		const hit = insertionIndex(event.clientY);
		dropIndex = hit.index;
		dropGroup = hit.group;
		dropTop = hit.top;
	}

	function onListDragLeave(event: DragEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && listEl?.contains(next)) return;
		clearDrop();
	}

	function clearDrop() {
		dropIndex = null;
		dropGroup = null;
		dropTop = null;
	}

	function onListDrop(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		const index = dropIndex ?? lines.length;
		const group = dropGroup;
		clearDrop();

		const external = event.dataTransfer?.getData('application/x-catchy-lines');
		if (external && onDropLines) {
			try {
				const refs: unknown = JSON.parse(external);
				if (Array.isArray(refs)) onDropLines(refs, index, group);
			} catch {
				/* ignore malformed drag data */
			}
			return;
		}

		const internal = event.dataTransfer?.getData('application/x-catchy-indices');
		if (internal && onMoveLines) {
			try {
				const from: unknown = JSON.parse(internal);
				if (Array.isArray(from)) onMoveLines(from as number[], index, group, event.altKey);
			} catch {
				/* ignore malformed drag data */
			}
		}
	}

	function format(seconds: number): string {
		if (!Number.isFinite(seconds)) return '0:00';
		const whole = Math.floor(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	/** Save the current audio to a file (fetch → blob, so it works cross-origin). */
	function download() {
		if (!src) return;
		void (async () => {
			try {
				const response = await fetch(src);
				const blob = await response.blob();
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = `${downloadName}.${extensionForMime(blob.type || '')}`;
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				URL.revokeObjectURL(url);
			} catch {
				window.open(src, '_blank');
			}
		})();
	}
</script>

<div
	bind:this={rootEl}
	class="space-y-3 {framed ? 'rounded-xl border border-neutral-200 bg-neutral-50 p-3' : ''}"
>
	{#snippet wordSpan(lineIndex: number, word: string, wordIndex: number, highlight: boolean)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			data-word-index={wordIndex}
			data-line-index={lineIndex}
			class="mr-1 inline-block rounded px-0.5 {highlight
				? 'bg-amber-200 text-neutral-900 ring-1 ring-amber-400 ring-inset'
				: ''}"
			onpointerdown={(event) => wordPointerDown(lineIndex, wordIndex, event)}>{word}</span
		>
	{/snippet}

	{#snippet lineRow(index: number)}
		<div role="listitem" data-row data-line-start={index} class="flex items-center gap-1">
			{#if editing === index}
				<form onsubmit={commitEdit} class="flex items-center gap-1">
					<input
						bind:value={editDraft}
						aria-label="Line text"
						class="min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
					/>
					<button
						type="submit"
						class="shrink-0 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-800"
					>
						Save
					</button>
					<button
						type="button"
						onclick={cancelEdit}
						class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
					>
						Cancel
					</button>
				</form>
			{:else}
				<button
					type="button"
					data-active={index === activeLine}
					data-line
					data-line-index={index}
					draggable={Boolean(dragLine || allowReorder) && !lines[index]?.raw}
					ondragstart={(event) => dragStart(event, index)}
					ondragend={clearDrop}
					onmousedown={(event) => {
						if (event.shiftKey) event.preventDefault();
					}}
					onclick={(event) => onLineClick(index, event)}
					ondblclick={(event) => onLineDoubleClick(index, event)}
					title={onLocateLine
						? 'Ctrl-click to reveal the recording this line came from'
						: undefined}
					class={bubbleClass(index)}
				>
					{#each lines[index]?.words ?? [] as word, wordIndex (wordIndex)}{@render wordSpan(
							index,
							word,
							wordIndex,
							isCarving(index, wordIndex)
						)}{/each}
					{#if lines[index]?.tag}
						<span
							class="ml-1.5 inline-block rounded-full bg-black/10 px-1.5 align-middle text-[10px] leading-tight font-semibold"
							title="A different recording of the same words">{lines[index].tag}</span
						>
					{/if}
				</button>
				{#if onRemove}
					<button
						type="button"
						onclick={() => onRemove(index)}
						aria-label="Remove line"
						class="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-600"
					>
						×
					</button>
				{/if}
			{/if}
		</div>
	{/snippet}

	<div class="flex items-center gap-3">
		<button
			type="button"
			onclick={toggle}
			aria-label={loading ? 'Rendering…' : playing ? 'Pause' : 'Play'}
			disabled={!playable || loading}
			title={selected.length ? 'Play from the first selected line' : 'Play'}
			class="flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{#if loading}
				<span
					class="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
					aria-hidden="true"
				></span>
			{:else if playing}
				<svg viewBox="0 0 24 24" class="size-4 fill-current" aria-hidden="true">
					<rect x="6" y="5" width="4" height="14" rx="1" />
					<rect x="14" y="5" width="4" height="14" rx="1" />
				</svg>
			{:else}
				<svg viewBox="0 0 24 24" class="size-4 fill-current" aria-hidden="true">
					<path d="M8 5.5v13l11-6.5-11-6.5Z" />
				</svg>
			{/if}
		</button>
		<input
			type="range"
			min="0"
			max={duration || 0}
			step="0.01"
			value={currentTime}
			oninput={onSeek}
			disabled={!playable}
			aria-label="Seek"
			class="h-1.5 flex-1 cursor-pointer accent-neutral-900 disabled:opacity-40"
		/>
		<span class="shrink-0 font-mono text-xs text-neutral-500">
			{format(currentTime)} / {format(duration)}
		</span>
		<button
			type="button"
			onclick={download}
			disabled={!playable}
			aria-label="Download"
			title="Download audio"
			class="shrink-0 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
		>
			<svg
				viewBox="0 0 24 24"
				class="size-4"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M12 3v12" />
				<path d="m7 11 5 5 5-5" />
				<path d="M5 21h14" />
			</svg>
		</button>
	</div>

	{#if onGroupLines}
		<!-- Always-present row: group the selection, or drag out an existing section. -->
		<div class="flex min-h-7 flex-wrap items-center gap-1.5">
			{#if selected.length}
				{#each SECTIONS as section (section.type)}
					<button
						type="button"
						onclick={() => createSection(section.type)}
						class="rounded-xl border px-2.5 py-1 text-xs font-medium {sectionStyle(section.type)}"
					>
						{section.label}
					</button>
				{/each}
			{:else if groupList.length}
				{#each groupList as group (group.id)}
					<button
						type="button"
						draggable={Boolean(lineRef)}
						ondragstart={(event) => dragGroupChip(event, group.id)}
						title="Drag into the scrapbook to reuse this section"
						class="rounded-xl border px-2.5 py-1 text-xs font-medium {sectionStyle(
							group.type
						)} {lineRef ? 'cursor-grab' : ''}"
					>
						{group.name}
					</button>
				{/each}
			{/if}
		</div>
	{/if}

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={listEl}
		role="list"
		aria-label="Lines"
		class="relative flex flex-col gap-1 select-none"
		onclick={onListClick}
		ondragover={onListDragOver}
		ondragleave={onListDragLeave}
		ondrop={onListDrop}
	>
		{#if lines.length === 0 && emptyLabel}
			<p class="px-1 py-2 text-sm text-neutral-400">{emptyLabel}</p>
		{/if}
		{#each rows as row (rowKey(row))}
			{#if row.kind === 'line'}
				{@render lineRow(row.index)}
			{:else}
				<div
					role="listitem"
					data-group-instance={row.instance}
					data-group-id={row.id}
					draggable={Boolean(dragLine || allowReorder)}
					ondragstart={(event) => dragGroupStart(event, row.indices, row.id)}
					ondragend={clearDrop}
					class={groupWrapClass(row.type)}
				>
					<div
						data-row
						data-group-row="true"
						data-line-start={row.indices[0]}
						class="flex items-center gap-1"
					>
						{#if renamingGroup === row.id}
							<form onsubmit={commitGroupRename} class="flex items-center gap-1">
								<input
									bind:value={groupNameDraft}
									aria-label="Section name"
									class="min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
								/>
								<button
									type="submit"
									class="shrink-0 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-800"
								>
									Save
								</button>
								<button
									type="button"
									onclick={cancelGroupRename}
									class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-black/10"
								>
									Cancel
								</button>
							</form>
						{:else}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								onclick={(event) => toggleGroupOpen(row.instance, event)}
								title="Click to show or hide the lines inside"
								class="flex min-w-0 cursor-pointer items-center gap-1"
							>
								<span class="text-[11px] font-semibold tracking-wide uppercase">
									{row.name}
								</span>
								{#if row.type === 'other' && onRenameGroup}
									<button
										type="button"
										onclick={(event) => {
											event.stopPropagation();
											beginGroupRename(row.id, row.name);
										}}
										title="Rename section"
										aria-label="Rename section"
										class="rounded px-1 text-[11px] leading-none hover:bg-black/10"
									>
										✎
									</button>
								{/if}
								<span class="text-[11px] opacity-60"
									>{expandedGroups[row.instance] ? '▾' : '▸'}</span
								>
							</div>
							{#if onUngroup}
								<button
									type="button"
									onclick={(event) => {
										event.stopPropagation();
										onUngroup(row.indices);
									}}
									title="Ungroup section"
									aria-label="Ungroup section"
									class="ml-auto shrink-0 rounded p-1 text-neutral-500 hover:bg-black/10"
								>
									<svg
										viewBox="0 0 24 24"
										class="size-3.5 rotate-90"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<rect x="3" y="5" width="7" height="14" rx="1.5" />
										<rect x="14" y="5" width="7" height="14" rx="1.5" />
									</svg>
								</button>
							{/if}
							{#if onRemoveGroup}
								<button
									type="button"
									onclick={(event) => {
										event.stopPropagation();
										onRemoveGroup(row.indices);
									}}
									title="Delete the whole section"
									class="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-red-500/15 hover:text-red-700"
								>
									×
								</button>
							{/if}
						{/if}
					</div>
					{#if expandedGroups[row.instance]}
						<div class="mt-1.5 flex flex-col gap-1 pl-1">
							{#each row.indices as lineIndex (lineIndex)}{@render lineRow(lineIndex)}{/each}
						</div>
						<!-- Drop zone: land here to add at the end of the open section; below = after. -->
						<div
							data-row
							data-group-end="true"
							data-line-start={row.indices[0] + row.indices.length}
							class="h-2"
							aria-hidden="true"
						></div>
					{:else}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							class="mt-2 flex cursor-pointer flex-col gap-3 pl-1"
							onclick={(event) => selectGroup(row.indices, event)}
						>
							{#each row.indices as lineIndex (lineIndex)}
								<span
									data-line-index={lineIndex}
									class="block rounded px-1 text-sm leading-snug {lineIndex === activeLine
										? 'bg-amber-200 text-neutral-900'
										: ''}">{lineText(lineIndex)}</span
								>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/each}
		{#if droppable && dropTop !== null}
			<div
				class="pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-amber-500"
				style="top:{dropTop}px"
				aria-hidden="true"
			></div>
		{/if}
	</div>

	<audio
		bind:this={audio}
		src={src || undefined}
		preload="metadata"
		onplay={() => (playing = true)}
		onpause={() => (playing = false)}
		onended={() => (playing = false)}
		ontimeupdate={() => (currentTime = audio?.currentTime ?? 0)}
		onloadedmetadata={onLoadedMetadata}
		ondurationchange={() => (duration = audio?.duration ?? 0)}
	></audio>
</div>
