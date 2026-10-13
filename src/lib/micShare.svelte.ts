/**
 * Microphone sharing between two devices on the same server.
 *
 * A phone connects as the *sharer* and streams raw mono PCM frames over a
 * WebSocket, each stamped with the wall-clock time of its first sample. A
 * computer connects as a *listener*, buffers those frames, and cuts takes at the
 * moment a key was pressed — so a laggy stream still splits exactly where the
 * button was hit, not where the audio happened to arrive.
 *
 * The two clocks are aligned with a tiny ping/pong handshake (the way NTP
 * works), keeping the split accurate to roughly half the round-trip time.
 */

const ROOM = 'main';
const FRAME_HEADER = 12; // float64 timestamp + float32 sample rate

function wsUrl(base: string, role: 'sharer' | 'listener'): string {
	const ws = base.replace(/^http/, 'ws').replace(/\/+$/, '');
	return `${ws}/mic/${ROOM}?role=${role}`;
}

function encodeWav(samples: Int16Array, sampleRate: number): Blob {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const write = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	write(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true);
	write(8, 'WAVE');
	write(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, 'data');
	view.setUint32(40, samples.length * 2, true);
	new Int16Array(buffer, 44).set(samples);
	return new Blob([buffer], { type: 'audio/wav' });
}

/** The phone side: capture the mic and stream it to the room. */
export class MicSharer {
	state = $state<'idle' | 'sharing' | 'error'>('idle');
	error = $state<string | null>(null);

	private socket: WebSocket | null = null;
	private stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private nodes: AudioNode[] = [];

	get sharing(): boolean {
		return this.state === 'sharing';
	}

	async start(url: string): Promise<void> {
		if (this.state === 'sharing') return;
		this.error = null;
		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			this.error = 'This browser cannot share a microphone.';
			this.state = 'error';
			return;
		}
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
		} catch {
			this.error = 'Microphone access was blocked.';
			this.state = 'error';
			return;
		}

		const socket = new WebSocket(wsUrl(url, 'sharer'));
		socket.binaryType = 'arraybuffer';
		this.socket = socket;

		const context = new AudioContext();
		this.context = context;
		await context.resume().catch(() => {});
		const source = context.createMediaStreamSource(this.stream);
		const processor = context.createScriptProcessor(4096, 1, 1);
		// Sink to a muted gain so the phone doesn't play its own mic back.
		const silent = context.createGain();
		silent.gain.value = 0;

		processor.onaudioprocess = (event) => {
			if (socket.readyState !== WebSocket.OPEN) return;
			const input = event.inputBuffer.getChannelData(0);
			const samples = new Int16Array(input.length);
			for (let i = 0; i < input.length; i++) {
				const value = Math.max(-1, Math.min(1, input[i]));
				samples[i] = value * 0x7fff;
			}
			const buffer = new ArrayBuffer(FRAME_HEADER + samples.length * 2);
			const view = new DataView(buffer);
			view.setFloat64(0, Date.now() - (input.length / context.sampleRate) * 1000, true);
			view.setFloat32(8, context.sampleRate, true);
			new Int16Array(buffer, FRAME_HEADER).set(samples);
			socket.send(buffer);
		};

		socket.onmessage = (event) => {
			// The computer pings us to line its clock up with ours.
			try {
				const message = JSON.parse(event.data as string) as { type?: string; t?: number };
				if (message.type === 'ping' && socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'pong', t: message.t, now: Date.now() }));
				}
			} catch {
				/* ignore malformed control messages */
			}
		};
		socket.onclose = () => {
			if (this.state === 'sharing') this.stop();
		};

		source.connect(processor);
		processor.connect(silent);
		silent.connect(context.destination);
		this.nodes = [source, processor, silent];
		this.state = 'sharing';
	}

	stop(): void {
		for (const node of this.nodes) {
			try {
				node.disconnect();
			} catch {
				/* already detached */
			}
		}
		this.nodes = [];
		if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close();
		this.socket = null;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		void this.context?.close().catch(() => {});
		this.context = null;
		this.state = 'idle';
	}
}

type Frame = { t0: number; rate: number; samples: Int16Array };

/** The computer side: listen for a shared mic and cut takes on demand. */
export class SharedMic {
	present = $state(false);
	connected = $state(false);
	recording = $state(false);
	error = $state<string | null>(null);

	private socket: WebSocket | null = null;
	private frames: Frame[] = [];
	/** phone clock − local clock, in ms (from the ping/pong handshake). */
	private offset = 0;
	private bestRtt = Infinity;
	private segmentStart = 0;
	private pingTimer: number | undefined;

	connect(url: string): void {
		if (this.socket) return;
		const socket = new WebSocket(wsUrl(url, 'listener'));
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		socket.onopen = () => {
			this.connected = true;
			this.ping();
			this.pingTimer = window.setInterval(() => this.ping(), 5000);
		};
		socket.onmessage = (event) => this.onMessage(event);
		socket.onclose = () => {
			this.connected = false;
			this.present = false;
		};
	}

	disconnect(): void {
		window.clearInterval(this.pingTimer);
		this.pingTimer = undefined;
		this.socket?.close();
		this.socket = null;
		this.connected = false;
		this.present = false;
		this.stop();
	}

	private ping(): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
		}
	}

	private onMessage(event: MessageEvent): void {
		if (event.data instanceof ArrayBuffer) {
			const view = new DataView(event.data);
			const t0 = view.getFloat64(0, true);
			const rate = view.getFloat32(8, true);
			const samples = new Int16Array(event.data, FRAME_HEADER);
			if (rate > 0 && samples.length) this.frames.push({ t0, rate, samples });
			return;
		}
		try {
			const message = JSON.parse(event.data as string) as {
				type?: string;
				present?: boolean;
				t?: number;
				now?: number;
			};
			if (message.type === 'sharer') this.present = Boolean(message.present);
			if (message.type === 'pong' && typeof message.t === 'number' && message.now) {
				const rtt = Date.now() - message.t;
				if (rtt <= this.bestRtt) {
					this.bestRtt = rtt;
					this.offset = message.now - (message.t + rtt / 2);
				}
			}
		} catch {
			/* ignore malformed control messages */
		}
	}

	private now(): number {
		return Date.now() + this.offset;
	}

	private latest(): number {
		const last = this.frames[this.frames.length - 1];
		return last ? last.t0 + (last.samples.length / last.rate) * 1000 : -Infinity;
	}

	start(): void {
		if (!this.present) {
			this.error = 'No shared microphone is connected.';
			return;
		}
		this.error = null;
		this.segmentStart = this.now();
		this.pruneBefore(this.segmentStart);
		this.recording = true;
	}

	stop(): void {
		this.recording = false;
		this.frames = [];
	}

	/** Throw away the current phrase and start a fresh one at "now". */
	discardSegment(): void {
		this.segmentStart = this.now();
		this.pruneBefore(this.segmentStart);
	}

	/** Build a WAV of the phrase that ended at "now" (waiting for the audio). */
	async takeSegment(): Promise<Blob | null> {
		const end = this.now();
		const deadline = Date.now() + 4000;
		while (this.latest() < end && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const chunks: Int16Array[] = [];
		let rate = 48000;
		for (const frame of this.frames) {
			const frameEnd = frame.t0 + (frame.samples.length / frame.rate) * 1000;
			if (frameEnd <= this.segmentStart || frame.t0 >= end) continue;
			rate = rate || frame.rate;
			const from = Math.max(0, Math.round(((this.segmentStart - frame.t0) / 1000) * frame.rate));
			const to = Math.min(frame.samples.length, Math.round(((end - frame.t0) / 1000) * frame.rate));
			if (to > from) chunks.push(frame.samples.slice(from, to));
		}
		this.segmentStart = end;
		this.pruneBefore(end);
		if (!chunks.length) return null;
		const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const merged = new Int16Array(total);
		let cursor = 0;
		for (const chunk of chunks) {
			merged.set(chunk, cursor);
			cursor += chunk.length;
		}
		return encodeWav(merged, rate);
	}

	private pruneBefore(time: number): void {
		this.frames = this.frames.filter(
			(frame) => frame.t0 + (frame.samples.length / frame.rate) * 1000 > time
		);
	}
}
