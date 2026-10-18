// Capture consent is for one draft, never for sending a prompt. Keep the
// owner/session key before the selector takes focus; never consult it again.
export function screenshotDraft({ target, claim, load, attach, pending, focused = () => document.hasFocus() }) {
	const window = crypto.randomUUID();
	const captures = new Map();
	const completed = new Set();
	return {
		async begin(capture) {
			if (!focused()) return;
			const key = target();
			if (!key) return;
			if (captures.size >= 128) captures.delete(captures.keys().next().value);
			captures.set(capture, key);
			try { if (!await claim(capture, window)) captures.delete(capture); }
			catch { captures.delete(capture); }
		},
		async taken(message) {
			if (message.window !== window || !message.capture) return false;
			if (completed.has(message.capture)) return true;
			if (completed.size >= 256) completed.delete(completed.values().next().value);
			completed.add(message.capture);
			const key = captures.get(message.capture);
			captures.delete(message.capture);
			try {
				if (!key) throw new Error('original conversation is no longer available');
				await attach(await load(message.name), key);
			} catch (error) { pending(message.name, error.message); }
			return true;
		},
	};
}
