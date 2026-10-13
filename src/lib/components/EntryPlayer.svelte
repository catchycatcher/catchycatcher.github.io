<script lang="ts">
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
		onDropLines,
		onMoveLines,
		onRemove,
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
		/** A selection of lines dropped in at ``index`` (``outside`` = before a section). */
		onDropLines?: (refs: unknown[], index: number, outside?: boolean) => void;
		/** Move the selected line indices to sit before ``index``. */
		onMoveLines?: (from: number[], to: number, outside?: boolean) => void;
		onRemove?: (index: number) => void;
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
		onGroupLines?: (indices: number[], type: string) => void;
		/** Break a group apart again. */
		onUngroup?: (groupId: string) => void;
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

	/** Colours for the section groups: chorus orange, verse rose, bridge green, other grey. */
	const SECTION_STYLES: Record<string, string> = {
		chorus: 'border-orange-400 bg-orange-200 text-orange-900',
		verse: 'border-rose-400 bg-rose-200 text-rose-900',
		bridge: 'border-green-400 bg-green-200 text-green-900',
		other: 'border-neutral-300 bg-neutral-200 text-neutral-700'
	};
	const SECTIONS: { type: string; label: string }[] = [
		{ type: 'chorus', label: 'Chorus' },
		{ type: 'verse', label: 'Verse' },
		{ type: 'bridge', label: 'Bridge' },
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
	/** True when the drop is landing *before* a section (leaves it, not joins it). */
	let dropOutside = $state(false);
	/** Absolute top (px) for the insertion line, so it never shifts the rows. */
	let dropTop = $state<number | null>(null);
	/** Index of the line being text-edited, if any. */
	let editing = $state<number | null>(null);
	let editDraft = $state('');
	/** Word range being dragged out for carving (only on a raw line). */
	let carving = $state<{ index: number; from: number; to: number } | null>(null);

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
					group: line.group
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
	let selectable = $derived(Boolean(dragLine || allowReorder));
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
	}

	function sectionStyle(type: string): string {
		return SECTION_STYLES[type] ?? SECTION_STYLES.other;
	}

	function sectionLabel(type: string): string {
		return SECTIONS.find((section) => section.type === type)?.label ?? 'Other';
	}

	function groupBubbleClass(type: string): string {
		return `w-fit max-w-full break-words select-none rounded-xl border px-2.5 py-1 text-left text-sm font-medium leading-snug ${sectionStyle(type)}`;
	}

	function onGroupDoubleClick(id: string, event: MouseEvent) {
		event.preventDefault();
		expandedGroups[id] = !expandedGroups[id];
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

	// Clicking anywhere outside this player deselects its bubbles.
	$effect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!selectable) return;
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
		if (!selectable) return;
		if (event.shiftKey && anchor !== null) {
			const low = Math.min(anchor, index);
			const high = Math.max(anchor, index);
			selected = Array.from({ length: high - low + 1 }, (_unused, step) => low + step);
			return;
		}
		selected = [index];
		anchor = index;
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

	/** Selected = blue; the playing line = yellow; inside an open section = its colour. */
	function bubbleClass(index: number): string {
		if (lines[index]?.raw) {
			return 'w-full touch-none break-words select-none rounded-md px-1 py-1 text-left text-sm leading-snug text-neutral-700';
		}
		const group = lines[index]?.group;
		const groupKey = group?.instance ?? group?.id;
		const inOpenGroup = groupKey ? Boolean(expandedGroups[groupKey]) : false;
		const isSelected = selected.includes(index);
		const isActive = index === activeLine;
		let state = inOpenGroup
			? sectionStyle(group?.type ?? 'other')
			: 'border-neutral-200 bg-white/60 hover:bg-white';
		if (isSelected && isActive) {
			// Yellow outline replaces the blue one (no double outline).
			state = 'border-amber-400 bg-blue-200';
		} else if (isSelected) {
			state = 'border-blue-400 bg-blue-200';
		} else if (isActive) {
			state = 'border-amber-300 bg-amber-200 text-neutral-900';
		}
		return `w-fit max-w-full break-words select-none rounded-xl border px-2.5 py-1 text-left text-sm leading-snug transition-colors ${state}`;
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
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	function dragStart(event: DragEvent, index: number) {
		writeDragPayload(event, selectedIndices(index));
	}

	/** Dragging a group bubble moves every line inside it. */
	function dragGroupStart(event: DragEvent, indices: number[]) {
		writeDragPayload(event, indices);
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
	 * Where a drop at ``clientY`` lands. Landing in the top half of a section
	 * header means "before the section" (outside); anywhere else maps to the line
	 * that would follow the drop.
	 */
	function insertionIndex(clientY: number): { index: number; outside: boolean; top: number } {
		if (!listEl) return { index: lines.length, outside: false, top: 0 };
		const rowEls = [...listEl.querySelectorAll<HTMLElement>('[data-row][data-line-start]')];
		for (const element of rowEls) {
			const rect = element.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) {
				// Top half of a section header drops before it (outside); anywhere
				// else maps onto the line that would follow the drop.
				return {
					index: rowStart(element),
					outside: element.dataset.groupRow === 'true',
					top: Math.max(0, element.offsetTop - 2)
				};
			}
		}
		const last = rowEls[rowEls.length - 1];
		return {
			index: lines.length,
			outside: false,
			top: last ? last.offsetTop + last.offsetHeight + 2 : 0
		};
	}

	function onListDragOver(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		const hit = insertionIndex(event.clientY);
		dropIndex = hit.index;
		dropOutside = hit.outside;
		dropTop = hit.top;
	}

	function onListDragLeave(event: DragEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && listEl?.contains(next)) return;
		clearDrop();
	}

	function clearDrop() {
		dropIndex = null;
		dropOutside = false;
		dropTop = null;
	}

	function onListDrop(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		const index = dropIndex ?? lines.length;
		const outside = dropOutside;
		clearDrop();

		const external = event.dataTransfer?.getData('application/x-catchy-lines');
		if (external && onDropLines) {
			try {
				const refs: unknown = JSON.parse(external);
				if (Array.isArray(refs)) onDropLines(refs, index, outside);
			} catch {
				/* ignore malformed drag data */
			}
			return;
		}

		const internal = event.dataTransfer?.getData('application/x-catchy-indices');
		if (internal && onMoveLines) {
			try {
				const from: unknown = JSON.parse(internal);
				if (Array.isArray(from)) onMoveLines(from as number[], index, outside);
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
				<span class="text-xs text-neutral-400">Group {selected.length} as</span>
				{#each SECTIONS as section (section.type)}
					<button
						type="button"
						onclick={() => onGroupLines([...selected], section.type)}
						class="rounded-xl border px-2.5 py-1 text-xs font-medium {sectionStyle(section.type)}"
					>
						{section.label}
					</button>
				{/each}
			{:else if groupList.length}
				<span class="text-xs text-neutral-400">Sections</span>
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

	<div
		bind:this={listEl}
		role="list"
		aria-label="Lines"
		class="relative flex flex-col gap-1 select-none"
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
				<div role="listitem" class="flex flex-col gap-1">
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
									onclick={cancelGroupRename}
									class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
								>
									Cancel
								</button>
							</form>
						{:else}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								draggable={Boolean(dragLine || allowReorder)}
								ondragstart={(event) => dragGroupStart(event, row.indices)}
								ondragend={clearDrop}
								ondblclick={(event) => onGroupDoubleClick(row.instance, event)}
								title="Double-click to show the lines inside"
								class={groupBubbleClass(row.type)}
							>
								<span class="mb-0.5 flex items-center gap-1">
									<span class="text-[10px] font-semibold tracking-wide uppercase opacity-70">
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
								</span>
								{#if expandedGroups[row.instance]}
									<span class="block text-xs opacity-60">Double-click to close</span>
								{:else}
									{#each row.indices as lineIndex (lineIndex)}
										<span class="block">{lineText(lineIndex)}</span>
									{/each}
								{/if}
							</div>
							{#if onUngroup}
								<button
									type="button"
									onclick={() => onUngroup(row.id)}
									class="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
								>
									Ungroup
								</button>
							{/if}
							{#if onRemoveGroup}
								<button
									type="button"
									onclick={() => onRemoveGroup(row.indices)}
									title="Delete the whole section"
									class="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-600"
								>
									×
								</button>
							{/if}
						{/if}
					</div>
					{#if expandedGroups[row.id]}
						<div class="flex flex-col gap-1 pl-3">
							{#each row.indices as lineIndex (lineIndex)}{@render lineRow(lineIndex)}{/each}
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
		onloadedmetadata={() => (duration = audio?.duration ?? 0)}
		ondurationchange={() => (duration = audio?.duration ?? 0)}
	></audio>
</div>
