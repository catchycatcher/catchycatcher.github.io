/**
 * Microphone recorder for the journal screen.
 *
 * Recording is continuous between ``start()`` and ``stop()``. ``takeSegment()``
 * ends the current MediaRecorder, returns the audio recorded since the previous
 * segment, and immediately starts a new recording — so a "segment" is exactly
 * the audio since the last time the user pressed a key.
 */

const MIME_CANDIDATES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/ogg;codecs=opus',
	'audio/mp4'
];

function pickMimeType(): string {
	if (typeof MediaRecorder === 'undefined') return '';
	for (const type of MIME_CANDIDATES) {
		if (MediaRecorder.isTypeSupported(type)) return type;
	}
	return '';
}

/** Map a recorded blob's mime type to an extension ffmpeg understands. */
export function extensionForMime(mime: string): string {
	if (mime.includes('ogg')) return 'ogg';
	if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
	if (mime.includes('mpeg')) return 'mp3';
	if (mime.includes('wav')) return 'wav';
	return 'webm';
}

export class Recorder {
	state = $state<'idle' | 'recording' | 'error'>('idle');
	error = $state<string | null>(null);

	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private mimeType = '';

	get recording(): boolean {
		return this.state === 'recording';
	}

	/** Ask for the microphone and begin a continuous recording. */
	async start(): Promise<void> {
		if (this.state === 'recording') return;
		this.error = null;
		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			this.error = 'This browser cannot record audio.';
			this.state = 'error';
			return;
		}
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			this.error = 'Microphone access was blocked.';
			this.state = 'error';
			return;
		}
		this.mimeType = pickMimeType();
		this.startRecorder();
		if (this.state === 'error') return; // startRecorder could not find a codec
		this.state = 'recording';
	}

	private startRecorder(): void {
		if (!this.stream) return;
		this.chunks = [];
		try {
			this.recorder = new MediaRecorder(
				this.stream,
				this.mimeType ? { mimeType: this.mimeType } : undefined
			);
		} catch {
			this.error = 'This browser cannot record in a supported format.';
			this.state = 'error';
			this.stop();
			return;
		}
		this.recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) this.chunks.push(event.data);
		};
		this.recorder.start();
	}

	/** End the current segment and return it, keeping the recording going. */
	async takeSegment(): Promise<Blob | null> {
		const recorder = this.recorder;
		if (!recorder || recorder.state === 'inactive') return null;
		const chunks = await this.stopRecorder(recorder);
		this.startRecorder();

		const usable = chunks.filter((chunk) => chunk.size > 0);
		if (usable.length === 0) return null;
		const type = this.mimeType || usable[0].type || 'audio/webm';
		return new Blob(usable, { type });
	}

	/** Throw away the current segment and keep recording. */
	async discardSegment(): Promise<void> {
		const recorder = this.recorder;
		if (!recorder || recorder.state === 'inactive') return;
		await this.stopRecorder(recorder);
		this.startRecorder();
	}

	private stopRecorder(recorder: MediaRecorder): Promise<Blob[]> {
		const chunks = this.chunks;
		return new Promise((resolve) => {
			recorder.onstop = () => resolve(chunks);
			recorder.stop();
		});
	}

	/** Stop recording and release the microphone. */
	stop(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			this.recorder.onstop = null;
			this.recorder.stop();
		}
		this.recorder = null;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.state = 'idle';
	}
}
