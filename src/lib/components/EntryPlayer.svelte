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
		onEditLine,
		onLocateLine,
		onMergeSelected,
		onCarve,
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
		/** Allow dragging the selection to reorder within this player. */
		allowReorder?: boolean;
		/** A selection of lines dropped in at ``index``. */
		onDropLines?: (refs: unknown[], index: number) => void;
		/** Move the selected line indices to sit before ``index``. */
		onMoveLines?: (from: number[], to: number) => void;
		onRemove?: (index: number) => void;
		/** Double-clicking a line edits its text (timings are re-guessed). */
		onEditLine?: (index: number, text: string) => void;
		/** Ctrl/cmd-clicking a line jumps to it in the journal. */
		onLocateLine?: (index: number) => void;
		/** Ctrl/cmd-clicking merges the selected lines into one raw text line. */
		onMergeSelected?: (indices: number[]) => void;
		/** Drag across words of a raw line to carve a bubble. */
		onCarve?: (index: number, from: number, to: number) => void;
		/** Draw the rounded border/background bubble. Off when the parent supplies it. */
		framed?: boolean;
	} = $props();

	type Line = { text: string; start: number; end: number; words: string[]; raw: boolean };

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
					raw: Boolean(line.raw)
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

	/** Selected = blue; the playing line = yellow; both = blue fill, yellow outline. */
	function bubbleClass(index: number): string {
		if (lines[index]?.raw) {
			return 'w-full touch-none break-words select-none rounded-md px-1 py-1 text-left text-sm leading-snug text-neutral-700';
		}
		const isSelected = selected.includes(index);
		const isActive = index === activeLine;
		let state = 'border-neutral-200 bg-white/60 hover:bg-white';
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

	function dragStart(event: DragEvent, index: number) {
		if (!event.dataTransfer) return;
		const indices = selectedIndices(index);
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

	/** The gap nearest the pointer: 0 = before the first bubble, n = after the last. */
	function insertionIndex(clientY: number): number {
		if (!listEl) return lines.length;
		const rows = [...listEl.querySelectorAll<HTMLElement>('[data-row]')];
		for (let index = 0; index < rows.length; index++) {
			const rect = rows[index].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return index;
		}
		return rows.length;
	}

	function onListDragOver(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		dropIndex = insertionIndex(event.clientY);
		dropTop = indicatorTop(dropIndex);
	}

	function indicatorTop(index: number): number {
		if (!listEl) return 0;
		const rows = [...listEl.querySelectorAll<HTMLElement>('[data-row]')];
		if (rows.length === 0) return 0;
		if (index >= rows.length) {
			const last = rows[rows.length - 1];
			return last.offsetTop + last.offsetHeight + 2;
		}
		return Math.max(0, rows[index].offsetTop - 2);
	}

	function onListDragLeave(event: DragEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && listEl?.contains(next)) return;
		clearDrop();
	}

	function clearDrop() {
		dropIndex = null;
		dropTop = null;
	}

	function onListDrop(event: DragEvent) {
		if (!droppable) return;
		event.preventDefault();
		const index = dropIndex ?? lines.length;
		clearDrop();

		const external = event.dataTransfer?.getData('application/x-catchy-lines');
		if (external && onDropLines) {
			try {
				const refs: unknown = JSON.parse(external);
				if (Array.isArray(refs)) onDropLines(refs, index);
			} catch {
				/* ignore malformed drag data */
			}
			return;
		}

		const internal = event.dataTransfer?.getData('application/x-catchy-indices');
		if (internal && onMoveLines) {
			try {
				const from: unknown = JSON.parse(internal);
				if (Array.isArray(from)) onMoveLines(from as number[], index);
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
		{#each lines as line, index (index)}
			<div role="listitem" data-row class="flex items-center gap-1">
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
						draggable={Boolean(dragLine || allowReorder) && !lines[index].raw}
						ondragstart={(event) => dragStart(event, index)}
						ondragend={clearDrop}
						onmousedown={(event) => {
							if (event.shiftKey) event.preventDefault();
						}}
						onclick={(event) => onLineClick(index, event)}
						ondblclick={(event) => onLineDoubleClick(index, event)}
						title={onLocateLine
							? 'Ctrl-click to find in journal · double-click to edit'
							: undefined}
						class={bubbleClass(index)}
					>
						{#each line.words as word, wordIndex (wordIndex)}{@render wordSpan(
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
