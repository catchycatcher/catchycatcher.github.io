<script lang="ts">
	import type { LyricLine } from '#lib/connection.svelte.ts';

	let {
		src,
		lyrics,
		loading = false,
		dragLine,
		allowReorder = false,
		onDropLines,
		onMoveLines,
		onRemove
	}: {
		src: string;
		lyrics: LyricLine[];
		/** Show a spinner on the play button (e.g. while the mix re-renders). */
		loading?: boolean;
		/** Per-line payload for dragging out (journal → scrapbook); null = no drag. */
		dragLine?: (lineIndex: number) => unknown | null;
		/** Allow dragging the selection to reorder within this player. */
		allowReorder?: boolean;
		/** A selection of lines dropped in at ``index``. */
		onDropLines?: (refs: unknown[], index: number) => void;
		/** Move the selected line indices to sit before ``index``. */
		onMoveLines?: (from: number[], to: number) => void;
		onRemove?: (index: number) => void;
	} = $props();

	type Word = { text: string; start: number; end: number };
	type Line = { text: string; start: number; end: number; words: Word[] };

	let audio = $state<HTMLAudioElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);
	let playing = $state(false);
	let currentTime = $state(0);
	let duration = $state(0);
	/** Indices the user has selected (click / shift-click). */
	let selected = $state<number[]>([]);
	/** Where a shift-click range starts from. */
	let anchor = $state<number | null>(null);

	/** Give every word a start/end, deriving them when the server omits them. */
	function resolve(rawLines: LyricLine[]): Line[] {
		return rawLines
			.map((line) => {
				const start = Number(line['start time']) || 0;
				const end = Math.max(Number(line['end time']) || start, start);
				const rawWords = line.words ?? [];
				const total = rawWords.reduce((sum, word) => sum + (word.length || 0), 0);
				const slack = Math.max(0, end - start - total);
				const gap = rawWords.length > 1 ? slack / (rawWords.length - 1) : 0;

				let cursor = start;
				const words = rawWords.map((word) => {
					const wordStart = word.start ?? cursor;
					const wordEnd = word.end ?? wordStart + (word.length || 0);
					cursor = wordEnd + gap;
					return { text: word.word, start: wordStart, end: wordEnd };
				});

				const lastEnd = words.length ? words[words.length - 1].end : end;
				return {
					text: rawWords
						.map((word) => word.word)
						.join(' ')
						.trim(),
					start,
					end: Math.max(end, lastEnd),
					words
				};
			})
			.filter((line) => line.words.length > 0);
	}

	function findLine(lines: Line[], time: number): number {
		for (let index = 0; index < lines.length; index++) {
			const next = lines[index + 1];
			const end = next ? next.start : lines[index].end;
			if (time >= lines[index].start && time < end) return index;
		}
		return -1;
	}

	function findWord(words: Word[], time: number): number {
		for (let index = 0; index < words.length; index++) {
			if (time >= words[index].start && time < words[index].end) return index;
		}
		return -1;
	}

	let lines = $derived(resolve(lyrics));
	let playable = $derived(Boolean(src));
	let selectable = $derived(Boolean(dragLine || allowReorder));
	let droppable = $derived(Boolean(onDropLines || onMoveLines));
	let activeLine = $derived(playable ? findLine(lines, currentTime) : -1);
	let activeWord = $derived(findWord(lines[activeLine]?.words ?? [], currentTime));

	// A new line set (re-render, reorder, add) invalidates any selection.
	$effect(() => {
		const current = lyrics;
		selected = [];
		anchor = null;
		void current;
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
		if (!selectable) {
			playFrom(lines[index].start);
			return;
		}
		if (event.shiftKey && anchor !== null) {
			const low = Math.min(anchor, index);
			const high = Math.max(anchor, index);
			selected = Array.from({ length: high - low + 1 }, (_unused, step) => low + step);
			return;
		}
		selected = [index];
		anchor = index;
	}

	function selectedIndices(index: number): number[] {
		const indices = selected.includes(index) ? selected : [index];
		return [...indices].sort((a, b) => a - b);
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

	function dropAt(event: DragEvent, index: number) {
		const external = event.dataTransfer?.getData('application/x-catchy-lines');
		if (external && onDropLines) {
			event.preventDefault();
			event.stopPropagation();
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
			event.preventDefault();
			event.stopPropagation();
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
</script>

<div class="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
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
	</div>

	<div
		bind:this={listEl}
		role="list"
		aria-label="Lines"
		class="flex max-h-72 flex-col gap-1 overflow-y-auto"
		ondragover={(event) => {
			if (droppable) event.preventDefault();
		}}
		ondrop={(event) => {
			if (droppable) dropAt(event, lines.length);
		}}
	>
		{#if lines.length === 0}
			<p class="px-1 py-2 text-sm text-neutral-400">No words detected in this take.</p>
		{/if}
		{#each lines as line, index (index)}
			<div
				role="listitem"
				class="flex items-center gap-1 self-start"
				ondragover={(event) => {
					if (droppable) {
						event.preventDefault();
						event.stopPropagation();
					}
				}}
				ondrop={(event) => dropAt(event, index)}
			>
				<button
					type="button"
					data-active={index === activeLine}
					data-selected={selected.includes(index)}
					draggable={Boolean(dragLine || allowReorder)}
					ondragstart={(event) => dragStart(event, index)}
					onclick={(event) => onLineClick(index, event)}
					class="w-fit max-w-full rounded-xl border px-2.5 py-1 text-left text-sm leading-snug transition-colors {index ===
					activeLine
						? 'border-neutral-900 bg-white'
						: selected.includes(index)
							? 'border-amber-400 bg-amber-50'
							: 'border-neutral-200 bg-white/60 hover:bg-white'}"
				>
					{#each line.words as word, wordIndex (wordIndex)}
						<span
							class="rounded px-0.5 {index === activeLine && wordIndex === activeWord
								? 'bg-amber-200 text-neutral-900'
								: 'text-neutral-700'}"
						>
							{word.text}
						</span>
						{#if wordIndex < line.words.length - 1}<span> </span>{/if}
					{/each}
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
			</div>
		{/each}
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
