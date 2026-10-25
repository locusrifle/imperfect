// The conversation, drawn into imperfect's terminal.
//
// site.js owns the sheets (the keys, the themes) and the phone keyboard.
// This file owns what is inside the screen, and it talks to a Pi SDK session
// over persistent owner-scoped websockets relayed by this origin,
// commands back. Nothing here reimplements Pi; it renders what Pi reports.
//
// Everything is built as nodes, never innerHTML: tool output is whatever the
// agent read off the disk, and it lands in this document.

import { createSessionCache, joinSnapshot } from './session-cache.js';
import { createOwnerTransport, ownerSessionKey } from './owner-transport.js';
import { createFreshness } from './freshness.js';
import { mountLoadingBar, mountConnectionLine } from './loading.js';
import { mountAuth } from './auth.js';
import { mountSettings } from './settings.js';
import { createNotifications } from './notify.js';
import { renderGuiTranscript, turnTime, turnTimeNode, compactionNode, formatWorking } from './gui-transcript.js';
import { animateInView } from './visible-animation.js';
import { mountWorkbench, defaultFilesBase } from './workbench-view.js';
import { postUpload, useUpload, uploadPercent, MAX_UPLOAD_BYTES } from './uploads.js';
import { mountVoice, isVoiceFile } from './voice.js';
import { mountUsage } from './usage.js';
import { usageOwner } from './usage-owner.js';
import { permissionFor, harnessMark, sessionMark, harnessName, harnessLabel, modelText, modelLabel } from './agent-faces.js';
import { newestOfEachLine } from './model-lines.js';
import { clipboardHasText, filesFromClipboardData, filesFromClipboardItems } from './clipboard-files.js';
import { containChoosing } from './choose-text.js';
import { registerKeyBinding, MOD } from './pi-card.js';
import { transcriptScroll } from './transcript-scroll.js';
import { liveMessage } from './live-message.js';
import { mountPages, windowNode, setFileBase } from './pages.js';
import { mountWindows, phone } from './windows.js';
import { mountSystem } from './system.js';
import { mountClipboardHistory } from './clipboard-history.js';
import { mountScreenshotPreview } from './screenshot-preview.js';
import { screenshotDraft } from './screenshot-draft.js';
import { turn, still, OPEN, OPENING } from './turn.js';
import { framedByLaunch, phoneByLaunch } from './arrival.js';
import { mountLaunchOpen } from './launch-open.js';
import { mountAssembly, ASSEMBLY_STEPS } from './assembly.js';
import { computerChoices } from './computer-choice.js';

const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};

// A picture in the conversation is an address on its machine (/media/<hash>,
// see server.mjs); only a picture still being composed carries its bytes.
function imageSrc(block) {
	if (typeof block?.url === 'string') return block.url;
	const mime = String(block?.mimeType ?? '');
	if (!/^image\/[a-z0-9.+-]+$/i.test(mime) || typeof block.data !== 'string' || !block.data) return null;
	return `data:${mime};base64,${block.data}`;
}

function imageNode(block, alt, at = src => src) {
	const src = imageSrc(block);
	if (!src) return null;
	const img = document.createElement('img');
	img.className = 'entry-image';
	img.alt = alt;
	img.src = at(src);
	return img;
}

// How long ago, in as few characters as a rail column has room for.
function whenLabel(ms) {
	const at = Number(ms);
	if (!Number.isFinite(at) || at <= 0) return '';
	const secs = Math.max(0, (Date.now() - at) / 1000);
	if (secs < 90) return 'now';
	if (secs < 3600) return `${Math.round(secs / 60)}m`;
	if (secs < 86400) return `${Math.round(secs / 3600)}h`;
	if (secs < 7 * 86400) return `${Math.round(secs / 86400)}d`;
	return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Queue images are already API image blocks: retain their bytes and MIME type.
export function restoreQueueItem(draft, item) {
	const attachments = [...draft.attachments, ...(item.images ?? []).map(image => ({ name: 'recovered image', image }))];
	const text = item.text;
	const prefix = text + (text && draft.text ? '\n\n' : '');
	return { ...draft, text: prefix + draft.text, attachments, start: (draft.start ?? 0) + prefix.length, end: (draft.end ?? 0) + prefix.length };
}

// The page's own elements (index.html) are found by id.
export function mountGueyPi({ hooks = {} } = {}) {
	const byId = id => document.getElementById(id);
	const output = byId('entry-output'), input = byId('entry-input'), dialog = byId('entry-dialog');
	const modelStatus = byId('entry-model-status'), modelName = byId('entry-pi-label'), thinking = byId('entry-thinking');
	const modelCaption = document.createElement('span');
	modelCaption.className = 'entry-model-name';
	modelName.replaceChildren(harnessMark('pi'), modelCaption);
	let socket = null, state = null;
	let usageView = null;
	let firstSnapshot;
	const snapshotReady = new Promise(resolve => { firstSnapshot = resolve; });
	// A recording from the mic goes into the input bar as "audio 1", and is
	// heard on the PC while the person goes on (holdRecording, below). Its
	// words take the stand-in's place when the message is sent (submit).
	const voice = mountVoice({ fail: error => fail(error), begin: () => ({ key: editorKey(state), upload: captureUploadTarget() }), hold: (recording, where) => void holdRecording(recording, where) });
	let caretMirror = null;
	// The serving connection is usable even before inventory arrives. Its internal
	// key never names a remote destination; remote keys are verified stable IDs.
	const LOCAL = '@serving';
	let selectedOwner = LOCAL, switching = false, selectionGeneration = 0;
	const transports = new Map();
	let foregroundRequests = 0, attachmentProcessing = 0;
	const ownerKey = owner => owner === LOCAL ? (hereOwner() || LOCAL) : owner;
	// The computer the conversation's session runs on, as its addresses go: ''
	// for this one, else through /peer/. What it shows plays from there.
	const ownerBase = (owner = selectedOwner) => (owner === LOCAL || ownerKey(owner) === hereOwner() ? '' : `/peer/${encodeURIComponent(ownerKey(owner))}`);
	// What agents showed, playing in the conversation. A window is made once
	// and kept, so a game or a video plays on while the turn around it is
	// redrawn: one already on screen is drawn as a stand-in (data-window-key)
	// that renderTranscript swaps back for it without moving it.
	const windows = new Map();
	function windowFor(spec, key) {
		const kept = windows.get(key);
		if (kept?.isConnected) { const stand = el('div'); stand.dataset.windowKey = key; return stand; }
		if (kept) return kept;
		const made = windowNode(spec, { base: ownerBase() });
		made.dataset.windowKey = key;
		windows.set(key, made);
		while (windows.size > 40) windows.delete(windows.keys().next().value);
		return made;
	}
	const keptWindow = node => (node.dataset?.windowKey && !node.classList.contains('gui-window') ? windows.get(node.dataset.windowKey) ?? node : node);
	function ownerCommand(owner, type, fields = {}, options = {}) {
		if (owner === selectedOwner && disconnectedOwners.has(owner) && !switching && !['hello', 'snapshot', 'tab-focus'].includes(type)) return Promise.reject(new Error('Execution selection unavailable; choose a session first'));
		const transport = transports.get(owner);
		if (!transport) return Promise.reject(new Error('Execution owner unavailable'));
		// An older page of the conversation is reading, not a request: it never holds up a switch.
		const foreground = !['hello', 'here', 'prompt', 'queue-take', 'messages-before'].includes(type);
		if (foreground) foregroundRequests++;
		return transport.command(type, fields, options).finally(() => { if (foreground) foregroundRequests--; });
	}
	const SURFACE_VIEW_KEY = 'imperfect.surface-code-view';
	let restoredView = null;
	let restoreFocusAsked = false;
	try {
		restoredView = JSON.parse(sessionStorage.getItem(SURFACE_VIEW_KEY) || 'null');
		sessionStorage.removeItem(SURFACE_VIEW_KEY);
	} catch { restoredView = null; }
	let overlay = null;          // a picker we are showing in #entry-dialog
	// A tab that exists on screen before it exists on the machine: the
	// question of which computer it runs on is asked on its own blank page.
	const launchFramed = framedByLaunch(), launchPhone = phoneByLaunch();
	let assemblyStep = launchFramed ? 'bare' : null;
	let choosing = launchFramed ? { owner: null, index: 0, auto: false, harnesses: null, agent: null, launch: true } : null;
	if (launchFramed) {
		restoredView = null;
		document.documentElement.classList.add(launchPhone ? 'launch-phone' : 'launch-framed');
		document.documentElement.dataset.assemblyStep = 'bare';
	}
	// Sessions this screen has already seen, by machine; see followNewSession.
	const knownSessions = new Set(), heardOwners = new Set();
	const queueBox = byId('entry-queue'), flash = byId('entry-flash');
	let flashTimer = 0;
	const showFlash = text => {
		const value = String(text ?? '').trim();
		flash.hidden = !value;
		flash.textContent = value;
		clearTimeout(flashTimer);
		if (value) flashTimer = setTimeout(() => showFlash(''), 2500);
	};

	/* ------------------------------------------------------------- transport */
	function command(type, fields = {}) {
		if (switching) return Promise.reject(new Error('Owner selection in progress; try again when ready'));
		if (disconnectedOwners.has(selectedOwner)) return Promise.reject(new Error('Choose a session on the reconnected owner first'));
		return ownerCommand(selectedOwner, type, fields);
	}
	// Capture before any await: a later picker/response must never use the
	// computer or session that happens to be on screen when it finishes.
	function sessionCommand() {
		const owner = selectedOwner, available = !switching && !disconnectedOwners.has(owner);
		const identity = { expectedSessionId: state?.sessionId, expectedTabId: focusedTabId() };
		return (type, fields = {}) => available ? ownerCommand(owner, type, { ...fields, ...identity }) : Promise.reject(new Error('Execution selection unavailable; choose a session first'));
	}

	const kind = () => (phone() ? 'phone' : 'desktop');
	const helloFields = () => ({
		kind: launchPhone ? 'viewer' : kind(),
		width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1,
		visible: !launchPhone && document.visibilityState === 'visible',
	});
	function hello() { ownerCommand(LOCAL, 'hello', helloFields()).catch(() => {}); }
	const disconnectedOwners = new Set();
	const AudioCtx = window.AudioContext || window.webkitAudioContext;
	let doneAudio = null;
	function unlockDoneSound() {
		if (!AudioCtx) return;
		try {
			if (!doneAudio) doneAudio = new AudioCtx();
			if (doneAudio.state === 'suspended') void doneAudio.resume().catch(() => {});
		} catch {}
	}
	function playTone(kind) {
		const counter = kind === 'blocked' ? '__gueyBlockedSounds' : '__gueyDoneSounds';
		window[counter] = (window[counter] || 0) + 1; // browser tests read this
		try {
			unlockDoneSound();
			if (!doneAudio || doneAudio.state === 'suspended') return;
			const osc = doneAudio.createOscillator();
			const gain = doneAudio.createGain();
			const now = doneAudio.currentTime;
			osc.type = kind === 'blocked' ? 'triangle' : 'sine';
			osc.frequency.value = kind === 'blocked' ? 440 : 880;
			gain.gain.setValueAtTime(0.05, now);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
			osc.connect(gain);
			gain.connect(doneAudio.destination);
			osc.start(now);
			osc.stop(now + 0.2);
		} catch {}
	}
	function playDoneSound() { playTone('done'); }
	function playBlockedSound() { playTone('blocked'); }
	function focusedTabId() {
		return (state?.tabs ?? []).find(tab => tab.focused)?.id ?? null;
	}
	const guiSnapshot = () => ({ sessionId: state?.sessionId ?? null, owner: ownerKey(selectedOwner), tabs: state?.tabs ?? [], messages: state?.messages ?? [] });
	function pingDone() {
		const looking = document.visibilityState === 'visible';
		// Phone and desktop both hear the finish while looking. A new AudioContext
		// at settle time is suspended, so we keep one unlocked on input. OS banners
		// only when the page is hidden — looking already has the tone.
		playDoneSound();
		if (looking) return;
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			try { new Notification('imperfect', { body: 'done', silent: false }); } catch {}
		}
	}
	function pingBlocked() { playBlockedSound(); }
	let previousTabStates = null, refreshing = null, returning = null;
	const localSessions = createSessionCache();
	const localDesktop = () => kind() === 'desktop' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
	const eagerLocal = () => localDesktop() && selectedOwner === LOCAL && !disconnectedOwners.has(LOCAL);
	function cacheLocal(data, id = data?.tabs?.find(tab => tab.focused)?.id) {
		const cached = localSessions.accept(id, data);
		if (cached) {
			localSessions.prune(cached.tabs ?? []);
			if (localDesktop()) prepareTranscript(cached);
		}
		return cached;
	}
	// Views seen before, of any computer, kept as they were last seen: going
	// back to one shows it at once, marked stale, while the current one comes.
	const seenViews = createSessionCache(16);
	// Whether the view on screen is current (freshness.js), the one bar that
	// says something is loading, and the line that says which computer when
	// it is taking a while.
	const loadingBar = mountLoadingBar(document.body);
	const connectionLine = mountConnectionLine(byId('entry-input-zone'), { onRetry: () => freshness.retry() });
	let staleHold = null;
	const freshness = createFreshness({ onChange: paintFreshness });
	function paintFreshness(info = freshness.state) {
		const stale = info.phase !== 'fresh';
		output.classList.toggle('entry-stale', stale);
		output.dataset.fresh = info.phase;
		if (stale && !staleHold) staleHold = loadingBar.begin();
		if (!stale && staleHold) { staleHold(); staleHold = null; }
		connectionLine.paint({ ...info, name: stale ? machineName(info.owner) : '' });
	}
	const machineName = owner => (owner === LOCAL || owner === hereOwner() ? machineRows.find(m => m.self)?.name : machineRows.find(m => m.id === owner)?.name) || (owner === LOCAL ? 'this computer' : owner);
	// While the view of `owner` is stale: its socket is asked whether it is
	// alive, and replaced if it is not. An answer to a question sent after the
	// doubt began means all the socket carried before it has been drawn. A
	// hidden window waits to be looked at, as its socket does (below).
	async function refreshView(owner) {
		if (document.hidden && !state?.busy) return;
		if (owner !== LOCAL) await refreshMachines();
		const transport = ensureTransport(owner);
		const alive = await transport.check({ fields: owner === LOCAL ? helloFields() : { kind: 'viewer', visible: !launchPhone } });
		// One that did not answer is replaced straight away.
		if (!alive && !transport.socket) transport.connect();
		if (!alive || owner !== selectedOwner || switching) return;
		// Back, but not yet on the session that was on screen: its view is
		// asked for again, which goes back to that session (receiveOwner).
		if (disconnectedOwners.has(owner)) {
			if (!returning) receiveOwner(owner, { type: 'snapshot', data: await ownerCommand(owner, 'snapshot', {}, { timeoutMs: 5000 }) });
			return;
		}
		freshness.fresh(alive.at, owner, viewKey());
	}
	const viewKey = () => ownerSessionKey(ownerKey(selectedOwner), focusedTabId());
	// The last resort, for a view that would not come back however often it was
	// tried while its computer answers plainly over HTTP: the page's sockets
	// are what is stuck, and loading it again is what killing the app did.
	// Never with anything in hand a reload would lose, never while hidden, and
	// at most once in a few minutes.
	const SELF_RELOAD_KEY = 'imperfect.self-reload';
	async function reloadIfStuck(owner) {
		if (document.hidden || !reloadSafe()) return false;
		try { if (Date.now() - Number(sessionStorage.getItem(SELF_RELOAD_KEY) || 0) < 3 * 60_000) return false; } catch { return false; }
		const answers = await fetch(`${ownerBase(owner)}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then(res => res.ok, () => false);
		if (!answers || document.hidden || !reloadSafe()) return false;
		try { sessionStorage.setItem(SELF_RELOAD_KEY, String(Date.now())); } catch {}
		prepareReload();
		location.reload();
		return true;
	}
	function doubtOwner(owner, { restart = false } = {}) {
		freshness.stale({ owner, attempt: () => refreshView(owner), reload: () => reloadIfStuck(owner), restart });
	}
	function connect() { doubtOwner(LOCAL); ensureTransport(LOCAL).connect(); }
	function ensureTransport(owner) {
		if (transports.has(owner)) return transports.get(owner);
		let drops = 0;
		const transport = createOwnerTransport({ owner, selfId: LOCAL, base: location.href,
			onStatus: (_, status) => {
				if (owner === selectedOwner) socket = transport.socket;
				if (status === 'open') {
					drops = 0;
					if (owner === LOCAL) hello();
					else ownerCommand(owner, 'hello', { kind: 'viewer', visible: !launchPhone }).catch(() => {});
					// Used a moment ago and only now connected, as a phone is when it wakes.
					if (Date.now() - usedAt < 10_000) tellHere(owner);
				} else {
					disconnectedOwners.add(owner);
					if (owner === LOCAL) localSessions.clear();
					// What is on screen is no longer kept current: it says so,
					// and is brought back (refreshView), with backoff, however long that takes.
					if (owner === selectedOwner && !switching) doubtOwner(owner);
					// Another computer's: the first try comes straight back; only
					// repeated failure waits. A hidden page (a phone with its screen off)
					// does not try at all until it is looked at, unless an agent is
					// working and its finish is owed.
					else if (!document.hidden || state?.busy) setTimeout(() => {
						if (owner === LOCAL || machineRows.some(m => m.id === owner && m.reachable)) transport.connect();
					}, drops++ ? 1500 : 200);
				}
				paintSessionRail();
			},
			onMessage: (_, message) => receiveOwner(owner, message),
		});
		transports.set(owner, transport);
		return transport;
	}
	function receiveOwner(owner, message) {
		// This companion is a passive chooser, never the person's browser target,
		// notification/screenshot surface or a second set of agent-opened panes.
		if (launchPhone && !['snapshot', 'tab-snapshot', 'look'].includes(message.type)) return;
		if (owner === LOCAL && localDesktop() && ['snapshot', 'tab-snapshot'].includes(message.type)) {
			const cached = cacheLocal(message.data, message.tabId);
			if (cached) message = { ...message, data: cached };
		}
		if (['snapshot', 'tab-snapshot'].includes(message.type)) migrateDraftIdentities(owner, message.data);
		if (message.type === 'tab-snapshot') return;
		if (message.type === 'look' && owner !== LOCAL) return;
		// The agent may present its browser, never choose the person's pane.
		// Explicit navigation/swiping reveals it on desktop and phone alike.
		if (message.type === 'browse') {
			pages.watch(message.machine ? ownerBase(String(message.machine)) : ownerBase(owner), { quiet: true });
			return;
		}
		// What an agent opened, from any session on any computer, opens in the
		// one Workbench or as a tab in the one browser, taking nobody's eyes.
		if (message.type === 'power-menu') {
			if (owner === LOCAL && (window.imperfectDesk?.isFocused?.() ?? document.hasFocus())) systemControls.showPower();
			return;
		}
		if (message.type === 'screenshot-begin') {
			if (owner === LOCAL) void shotDraft.begin(message.capture);
			return;
		}
		if (message.type === 'screenshot') {
			if (owner === LOCAL) {
				shotPreview.show(String(message.name));
				if (message.capture && !message.window) shotPreview.note('pending attachment · no initiating conversation; attach explicitly', true);
				void shotDraft.taken(message);
			}
			return;
		}
		if (message.type === 'notify') { notifications.received(message, owner); return; }
		if (message.type === 'shown') {
			if (message.kind === 'folder' || (message.kind === 'page' && message.target.startsWith('/'))) openFiles(message.target, { quiet: true, base: ownerBase(owner) });
			else pages.shown(message.target, ownerBase(owner));
			return;
		}
		if (owner !== selectedOwner && message.type !== 'look') {
			if (message.type === 'snapshot') {
				// a sign-in begun there from the new-session question goes on showing here
				ownerAuth.get(owner)?.render(message.data?.auth);
				paintSessionRail(); followNewSession();
				if (choosing?.harnesses && !creating) render();
			}
			return;
		}

		// A settle is a tab event, not a view event: even the tab already on screen
		// needs the same finish signal as one being watched elsewhere. A turn
		// Claude began itself (a background task reporting back) is quiet.
		if (message.type === 'turn' && message.asked !== false) pingDone();
		if (message.type === 'look') {
			dispatchEvent(new CustomEvent('imperfect-look', { detail: message.data }));
		}
		if (message.type === 'snapshot') {
			if (switching) return;
			let data = message.data;
			// Back after a drop, and the owner offers its own focus, not this
			// window's. The window was on a session: if that session is still
			// there it goes straight back to it, and only asks when it is gone.
			if (!choosing?.launch && disconnectedOwners.has(owner) && state && state.sessionId !== data?.sessionId) {
				const wanted = focusedTabId();
				if (wanted && !returning && (data?.tabs ?? []).some(tab => tab.id === wanted)) {
					returning = ownerCommand(owner, 'tab-focus', { tabId: wanted, snapshot: true })
						.then(focused => { disconnectedOwners.delete(owner); if (focused?.snapshot) receiveOwner(owner, { type: 'snapshot', data: focused.snapshot }); })
						.catch(() => { showFlash('Owner reconnected with another selection; choose a session to resume'); paintSessionRail(); })
						.finally(() => { returning = null; });
					return;
				}
				if (returning) return;
				// The session that was on screen has gone from it while away: what
				// is open there now is shown, rather than a view that cannot come back.
				if (wanted) showFlash('That session was closed while away');
			}
			disconnectedOwners.delete(owner);
			// An update carries only what was added since the session was last
			// sent (server.mjs). If that is not what this window holds -- a
			// dropped update, a session change -- the whole is asked for once.
			// A whole one keeps the older pages already fetched before it.
			if (Array.isArray(data?.messagesTail) || Array.isArray(data?.messages)) {
				const joined = joinSnapshot(state, data);
				if (!joined) {
					if (!refreshing) refreshing = ownerCommand(owner, 'snapshot').then(whole => receiveOwner(owner, { type: 'snapshot', data: whole })).catch(() => {}).finally(() => { refreshing = null; });
					return;
				}
				data = joined;
			}
			const nextTabs = data?.tabs ?? [];
			if ((!restoredView?.owner || restoredView.owner === ownerKey(selectedOwner)) && restoredView?.tabId && !restoreFocusAsked && nextTabs.some(tab => tab.id === restoredView.tabId)
				&& !nextTabs.some(tab => tab.id === restoredView.tabId && tab.focused)) {
				restoreFocusAsked = true;
				command('tab-focus', { tabId: restoredView.tabId, snapshot: true })
					.then(focused => { if (focused?.snapshot) receiveOwner(owner, { type: 'snapshot', data: focused.snapshot }); })
					.catch(() => { restoredView = null; });
			}
			if (previousTabStates) {
				for (const tab of nextTabs) {
					if (tab.status === 'blocked' && previousTabStates.get(tab.id) !== 'blocked') pingBlocked();
				}
			}
			previousTabStates = new Map(nextTabs.map(tab => [tab.id, tab.status]));
			const oldKey = editorKey(state), nextKey = editorKey({ ...data, executionOwner: ownerKey(owner) });
			// A model change that opened another tab takes the typed words with it (pickModel).
			const carry = carriedDraft?.from === oldKey && carriedDraft.generation === selectionGeneration ? carriedDraft : null;
			let carried = null;
			if (carry && oldKey !== nextKey) {
				carried = captureQueueDraft(); queueDrafts.delete(oldKey);
				try { localStorage.removeItem(draftKey(oldKey)); } catch {}
			}
			if (carried || carry?.answered) carriedDraft = null;
			if (oldKey && oldKey !== nextKey) { if (!carried) queueDrafts.set(oldKey, captureQueueDraft()); suspendDialog(); }
			state = { ...data, executionOwner: ownerKey(owner) };
			firstSnapshot();
			if (!oldKey) {
				const saved = storedDraft(nextKey);
				if (saved.text) displayQueueDraft(saved);
				else if (owner === LOCAL) saveDraft();
			}
			if (oldKey && oldKey !== nextKey) displayQueueDraft(carried ?? queueDrafts.get(nextKey) ?? storedDraft(nextKey));
			render();
			seenViews.keep(viewKey(), state);
			// Arrived on a socket opened since the view was doubted: current.
			freshness.fresh(transports.get(owner)?.openedAt ?? 0, owner, viewKey());
			// Closing the last tab leaves nothing to read, so the console asks
			// which harness to start rather than showing an empty screen. Same
			// page the rail's + opens; it is just not optional here.
			followNewSession();
			if (!nextTabs.length && !choosing && !creating) void beginNewAgent({ auto: true });
		}
	}
	// `retry`, for a switch that is only a look (a tab, a session from the
	// list): a computer that could not be reached is tried again, with
	// backoff, until it answers or something else is asked for (freshness.js).
	const unreachable = error => Boolean(error?.acceptanceUnknown || error?.unreachable || /not connected/i.test(error?.message ?? ''));
	let sessionTurn = null;
	async function selectOwner(owner, action, requestedTab = null, { retry = null } = {}) {
		const key = owner === hereOwner() ? LOCAL : owner;
		if (switching) throw new Error('Owner selection already in progress');
		if (key !== LOCAL && !machineRows.some(m => m.id === key && m.reachable)) throw new Error('Execution owner is offline; session remains there');
		const transport = ensureTransport(key);
		switching = true;
		suspendDialog();
		const generation = ++selectionGeneration;
		let actionStarted = false, committed = false;
		// Until it comes, what is on screen is not what was asked for.
		freshness.stale({ owner: key, want: requestedTab, attempt: retry && (() => (switching ? null : retry())) });
		try {
			transport.connect();
			const deadline = Date.now() + 6000;
			while (!transport.snapshot || transport.socket?.readyState !== WebSocket.OPEN) {
				if (Date.now() > deadline) throw Object.assign(new Error('Execution owner unavailable; previous view retained'), { unreachable: true });
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			actionStarted = Boolean(action);
			const result = action ? await action((type, fields) => ownerCommand(key, type, fields), {
				owner: ownerKey(key), connected: transport.socket?.readyState === WebSocket.OPEN,
			}) : null;
			const fresh = result?.snapshot ?? await ownerCommand(key, 'snapshot');
			if (!fresh?.tabs || transport.socket?.readyState !== WebSocket.OPEN) throw Object.assign(new Error('Owner snapshot unavailable; previous view retained'), { unreachable: true });
			const snapshot = key === LOCAL && localDesktop() ? (cacheLocal(fresh) ?? fresh) : fresh;
			if (requestedTab && wantedTab && wantedTab !== requestedTab) { committed = true; return; }
			if (generation !== selectionGeneration) return;
			migrateDraftIdentities(key, snapshot);
			const oldKey = editorKey(state);
			if (oldKey) queueDrafts.set(oldKey, captureQueueDraft());
			const held = state?.executionOwner === ownerKey(key) ? state : null;
			const moved = key !== selectedOwner;
			const changed = moved || state?.sessionId !== snapshot.sessionId || state?.tabId !== snapshot.tabId;
			const display = () => {
				selectedOwner = key; socket = transport.socket; disconnectedOwners.delete(key);
				state = { ...(joinSnapshot(held, snapshot) ?? snapshot), executionOwner: ownerKey(key) };
				firstSnapshot();
				previousTabStates = null; overlay = null; choosing = null;
				displayQueueDraft(queueDrafts.get(editorKey(state)) ?? storedDraft(editorKey(state)));
				committed = true;
				render();
			};
			if (changed) {
				sessionTurn?.skipTransition();
				const turned = sessionTurn = turn('session-turn', display, 'session-panel', output.closest('.entry-screen'));
				if (turned) {
					turned.finished.catch(() => {}).finally(() => { if (sessionTurn === turned) sessionTurn = null; });
					await turned.updateCallbackDone;
				}
			} else display();
			if (moved) followFiles();
			seenViews.keep(viewKey(), state);
			// What is on screen now is this, current: a doubt about any other is moot.
			if (!freshness.fresh(Date.now(), key, viewKey()) && freshness.state.owner !== key) freshness.forget(freshness.state.owner);
		} catch (error) {
			// Focus may have succeeded before a lost acknowledgement/read. Do not
			// let an unguarded command use the old displayed session in that case.
			if (actionStarted && key === selectedOwner) disconnectedOwners.add(key);
			// Refused, not unreachable: it is said (fail), and asking again would not help.
			if (!(retry && unreachable(error))) freshness.forget(key);
			throw error;
		} finally {
			switching = false;
			if (committed) render();
			if (!committed && !disconnectedOwners.has(selectedOwner)) {
				const previous = transports.get(selectedOwner)?.snapshot;
				if (previous && (!state || previous.sessionId === state.sessionId)) receiveOwner(selectedOwner, { type: 'snapshot', data: previous });
			}
		}
	}

	// The model picker lives inside imperfect, which may be closed when the sign-in dialog
	// closes: pressing "Choose a default model" opened a list nobody could see. Open imperfect first.
	const ownerAuth = new Map();
	function currentAuth(owner = selectedOwner) {
		if (!ownerAuth.has(owner)) ownerAuth.set(owner, mountAuth({ command: (type, fields) => ownerCommand(owner, type, fields),
			chooseModel: () => { if (selectedOwner === owner) chooseModel().catch(fail); } }));
		return ownerAuth.get(owner);
	}

	const fail = error => {
		const text = error.message ?? String(error);
		showFlash(text);
		modelStatus.textContent = text;
	};

	const terminal = byId('entry-terminal');
	// The agents: a column of the terminal, so it travels with the terminal.
	const sessionRail = el('aside', null, 'session-rail');
	sessionRail.id = 'session-rail';
	sessionRail.setAttribute('aria-label', 'agents');
	terminal.prepend(sessionRail);
	// Local desktop conversations are kept ready; phones and peers wait for
	// the selected conversation. Focus is still confirmed before commands can
	// run, and another tap supersedes an acknowledgement still in flight.
	let wantedTab = null, tabSwitchActive = false;
	// Elsewhere, a session seen before is shown as it was last seen, marked
	// stale until the current one arrives, rather than leaving the last one up
	// unmarked; on the same computer only, whose pictures and windows it can
	// reach.
	function showCachedTab(tabId, owner) {
		if (!tabSwitchActive || !switching || owner !== ownerKey(selectedOwner)) return false;
		const tab = state?.tabs?.find(tab => tab.id === tabId);
		const warm = tab && eagerLocal() && owner === ownerKey(LOCAL) && localSessions.get(tabId, tab.sessionId);
		const cached = warm || (tab && seenViews.get(ownerSessionKey(owner, tabId), tab.sessionId));
		if (!cached) return false;
		const oldKey = editorKey(state);
		if (oldKey) queueDrafts.set(oldKey, captureQueueDraft());
		// A question it was asking then is not asked again until it is current.
		state = { ...cached, ui: { ...cached.ui, dialogs: [] }, tabs: state.tabs.map(tab => ({ ...tab, focused: tab.id === tabId })), executionOwner: owner };
		displayQueueDraft(queueDrafts.get(editorKey(state)) ?? storedDraft(editorKey(state)));
		output.classList.remove('entry-switching');
		render();
		const screen = output.closest('.entry-screen');
		if (screen && !still()) {
			screen.getAnimations().forEach(animation => animation.cancel());
			screen.animate(OPEN, OPENING);
		}
		return true;
	}
	// `again`: tried again by itself (freshness.js), which leaves the reader's
	// place alone until it has something to show.
	function enterTab(tabId, owner = ownerKey(selectedOwner), { again = false } = {}) {
		wantedTab = ownerSessionKey(owner, tabId);
		paintSessionRail();
		if (switching) { showCachedTab(tabId, owner); return Promise.resolve(); }
		return switchTab(tabId, owner, again);
	}
	async function switchTab(tabId, owner, again = false) {
		tabSwitchActive = true;
		try {
			for (;;) {
				const key = ownerSessionKey(owner, tabId);
				if (!again) transcriptScroller.latest();
				const focusing = selectOwner(owner, send => send('tab-focus', { tabId, snapshot: true }), key, { retry: async () => { await refreshMachines(); await enterTab(tabId, owner, { again: true }); } });
				if (!showCachedTab(tabId, owner)) output.classList.add('entry-switching');
				// One that failed after another was asked for gives way to it.
				try { await focusing; } catch (error) { if (!wantedTab || wantedTab === key) throw error; }
				if (!wantedTab || wantedTab === key) return;
				[owner, tabId] = JSON.parse(wantedTab);
				again = false;
			}
		} finally {
			wantedTab = null; tabSwitchActive = false;
			output.classList.remove('entry-switching');
			paintSessionRail();
		}
	}
	// One client-side page picks the computer and its harness. Nothing starts
	// until a harness is explicitly activated; it keeps its own last model.
	function newTab() {
		return beginNewAgent();
	}
	// Nothing about the tab you were reading changes while you decide, and
	// cancelling leaves no half-made tab behind.
	let creating = false;
	// `auto` is the question asked because this machine has no session. If
	// another machine has one, that is where this screen goes instead.
	async function beginNewAgent({ auto = false } = {}) {
		if (creating || choosing) return;
		choosing = { owner: hereOwner() || null, index: 0, auto, harnesses: null, agent: null };
		render();
		await refreshMachines();
		followNewSession();
		const machine = machineRows.find(machine => machine.self) ?? machineRows.find(machine => machine.reachable);
		if (choosing && machine) await chooseOwner(machine.id);
		if (choosing) { render(); focusChoice(); }
	}
	async function chooseOwner(id) {
		if (!choosing || creating) return;
		const asked = choosing;
		choosing.owner = id;
		choosing.error = '';
		// Never offer the previous computer's harnesses while this one connects.
		choosing.harnesses = null;
		render();
		const harnesses = await harnessesOn(id);
		if (choosing !== asked || choosing.owner !== id) return;
		choosing.harnesses = harnesses;
		if (!harnesses) choosing.error = 'Harnesses unavailable on this computer. Choose it again to retry.';
		const computerCount = computerChoices(machineRows, id).filter(row => !row.disabled).length;
		choosing.index = computerCount + Math.max(0, harnesses?.findIndex(row => row.usual) ?? 0);
		render(); focusChoice();
	}
	// A harness not signed in on that computer offers its sign-in there, at
	// the button that starts it: nothing begins until that is pressed.
	const SIGN_IN = { claude: 'claude-agent', codex: 'codex' };
	function signInTo(agent) {
		if (!choosing?.owner || !SIGN_IN[agent]) return;
		const key = choosing.owner === hereOwner() ? LOCAL : choosing.owner;
		const auth = currentAuth(key);
		if (key !== selectedOwner) auth.render(transports.get(key)?.snapshot?.auth);
		auth.login(SIGN_IN[agent]).catch(fail);
	}
	async function chooseHarness(agent) {
		if (!choosing?.owner || creating) return;
		choosing.agent = agent;
		choosing.error = '';
		await startTab();
	}
	// The harnesses a computer offers, in the order Noah names them, from its
	// snapshot: this window's own, or the one its connection to that computer
	// keeps. A computer just connected to is given a moment to send one.
	const HARNESS_ORDER = ['codex', 'claude', 'pi'];
	function liveHarnesses(id) {
		const key = id === hereOwner() ? LOCAL : id;
		const rows = (key === selectedOwner ? state : transports.get(key)?.snapshot)?.harnesses;
		if (!Array.isArray(rows)) return null;
		const rank = agent => (HARNESS_ORDER.includes(agent) ? HARNESS_ORDER.indexOf(agent) : HARNESS_ORDER.length);
		return [...rows].sort((a, b) => rank(a.agent) - rank(b.agent));
	}
	async function harnessesOn(id) {
		for (let waited = 0; !liveHarnesses(id) && waited < 3000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
		return liveHarnesses(id);
	}
	// Every screen is a window on the same computer, so a session started on
	// any of them is where all of them go -- unless this one has something
	// half-typed or a dialog open, which a jump would lose. A machine first
	// heard from is only taking attendance: the sessions it already had are not
	// new.
	function followNewSession() {
		if (choosing?.launch) return;
		let started = null;
		for (const [owner, transport] of transports) {
			const tabs = owner === selectedOwner ? state?.tabs : transport.snapshot?.tabs;
			if (!tabs) continue;
			const first = !heardOwners.has(owner);
			heardOwners.add(owner);
			for (const tab of tabs) {
				const key = ownerSessionKey(ownerKey(owner), tab.id);
				if (!knownSessions.has(key) && !first) started ??= { id: tab.id, owner: ownerKey(owner), here: owner === selectedOwner && tab.focused };
				knownSessions.add(key);
			}
		}
		if (!started && choosing?.auto) started = sortedTabs().find(tab => !tab.offline) ?? null;
		if (!started || started.here || creating || switching || overlay || input.value || attachments.length || voice.holding()) return;
		choosing = null;
		render();
		enterTab(started.id, started.owner).catch(fail);
	}
	function cancelChoosing() {
		if (!choosing || creating || (assemblyStep && assemblyStep !== 'done')) return false;
		// With no tabs behind it there is nothing to cancel back to, so the
		// question stays until it is answered.
		if (!(state?.tabs ?? []).length) return false;
		choosing = null;
		render();
		input?.focus();
		return true;
	}
	function focusChoice() {
		const options = [...output.querySelectorAll('.agent-choose-option:not(:disabled)')];
		options[choosing?.index ?? 0]?.focus();
	}
	async function startTab() {
		if (creating || !choosing?.owner) return;
		const selection = choosing;
		creating = true;
		render();
		try {
			await refreshMachines();
			if (choosing !== selection) return;
			const machine = machineRows.find(row => row.id === selection.owner);
			if (!machine || (!machine.self && !machine.reachable)) throw new Error('Selected computer is offline; no session created');
			// Creation is authorized by the selected, inventory-verified
			// transport, not by which machine served the page. Without a harness
			// named, the device starts the tab on its last model.
			await selectOwner(machine.id, (send, destination) => {
				if (destination.owner !== machine.id || !destination.connected) throw new Error('Selected execution owner is unavailable or changed; no session created');
				return send('tab-new', selection.agent ? { agent: selection.agent } : {});
			});
			choosing = null;
		} catch (error) { if (choosing) choosing.error = error.message; fail(error); }
		finally { creating = false; render(); }
		if (!choosing) input?.focus();
	}
	const chooserAgentsSeen = new Set();
	function renderChooser(into) {
		const page = el('section', null, 'agent-choose');
		const first = !(state?.tabs ?? []).length;
		const building = assemblyStep && assemblyStep !== 'done';
		if (creating) { into.append(page); return; }
		page.append(el('p', 'pick a computer', 'agent-choose-title'));
		const computers = el('div', null, 'agent-choose-row agent-choose-computers');
		for (const group of computerChoices(machineRows, choosing.owner)) {
			const name = group.kind === 'local' ? 'Local' : 'Cloud';
			const option = el('button', name, 'agent-choose-option');
			option.type = 'button'; option.dataset.computer = group.kind;
			if (group.machine) option.dataset.owner = group.machine.id;
			option.disabled = group.disabled;
			option.setAttribute('aria-pressed', String(group.selected));
			option.title = group.machine?.name || `${name} computer unavailable`;
			option.onclick = () => { if (!building) void chooseOwner(group.machine.id); };
			computers.append(option);
		}
		page.append(computers);
		// More than one computer of a kind stays reachable without a second
		// question. Offline inventory is visible but never an execution target.
		const selectedGroup = computerChoices(machineRows, choosing.owner).find(group => group.selected);
		if (selectedGroup?.rows.length > 1) {
			const devices = el('select', null, 'agent-choose-machine');
			devices.setAttribute('aria-label', `${selectedGroup.kind === 'local' ? 'Local' : 'Cloud'} computer`);
			for (const machine of selectedGroup.rows) {
				const option = el('option', machine.name + (!machine.self && !machine.reachable ? ' · offline' : ''));
				option.value = machine.id; option.disabled = !machine.self && !machine.reachable;
				option.selected = machine.id === choosing.owner;
				devices.append(option);
			}
			devices.disabled = building;
			devices.onchange = () => { void chooseOwner(devices.value); };
			page.append(devices);
		}
		page.append(el('p', 'pick a harness', 'agent-choose-title'));
		const options = el('div', null, 'agent-choose-row');
		// Live inventory also updates sign-in readiness on this same blank page.
		const harnesses = liveHarnesses(choosing.owner) ?? choosing.harnesses ?? [];
		const revealed = building ? ['pi', 'claude', 'codex'].slice(0, Math.min(3, ASSEMBLY_STEPS.indexOf(assemblyStep) + 1)) : null;
		for (const row of harnesses) {
			if (revealed && !revealed.includes(row.agent)) continue;
			const option = el('button', null, `agent-choose-option agent-choose-harness${row.ready ? '' : ' agent-choose-unready'}`);
			option.type = 'button'; option.dataset.agent = row.agent;
			if (building && row.agent !== 'pi' && !chooserAgentsSeen.has(row.agent)) option.classList.add('assembly-pop');
			chooserAgentsSeen.add(row.agent);
			option.disabled = !row.ready && !SIGN_IN[row.agent];
			if (row.blocked) option.title = row.blocked;
			option.append(harnessMark(row.agent), el('span', harnessName(row.agent) + (row.ready ? '' : ' · sign in')));
			option.onclick = () => { if (!building) { if (row.ready) void chooseHarness(row.agent); else signInTo(row.agent); } };
			options.append(option);
		}
		page.append(options);
		if (choosing.error) page.append(el('p', choosing.error, 'agent-choose-error'));
		if (!first && !building) {
			const cancel = el('button', 'cancel', 'agent-choose-cancel');
			cancel.type = 'button'; cancel.disabled = creating;
			cancel.onclick = cancelChoosing;
			page.append(cancel);
		}
		// Arrows move between the two; enter is the button's own, and escape is
		// answered here because the shared Esc binding listens on the composer,
		// which is not on screen while this page is.
		page.addEventListener('focusin', event => {
			const index = [...page.querySelectorAll('.agent-choose-option:not(:disabled)')].indexOf(event.target);
			if (index >= 0 && choosing) choosing.index = index;
		});
		page.addEventListener('keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); cancelChoosing(); return; }
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
			event.preventDefault();
			const options = [...page.querySelectorAll('.agent-choose-option:not(:disabled)')];
			const n = options.length;
			if (!n) return;
			choosing.index = (options.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1) + n) % n;
			focusChoice();
		});
		into.append(page);
	}

	// Inventory authorizes persistent owner streams; switching never moves a runtime.
	let machineRows = [], machinesAsked = null, machinesKnown = false, usageAuthority = '';
	function refreshMachines() {
		machinesAsked ??= askMachines().finally(() => { machinesAsked = null; });
		return machinesAsked;
	}
	async function askMachines() {
		try {
			const data = await (await fetch('/machines.json', { cache: 'no-store' })).json();
			machineRows = data.machines ?? [];
			if (choosing?.launch && !choosing.owner) {
				const self = machineRows.find(machine => machine.self);
				if (self) { choosing.owner = self.id; choosing.harnesses = liveHarnesses(self.id); }
			}
			usageAuthority = data.authority || '';
			machinesKnown = true;
			for (const [from, to] of [...draftAliases]) {
				const [owner, session] = JSON.parse(from);
				const canonical = ownerSessionKey(ownerKey(owner), session);
				if (canonical !== from) { draftAliases.set(canonical, canonicalEditorKey(to)); draftAliases.delete(from); }
			}
			if (state && selectedOwner === LOCAL && state.executionOwner !== ownerKey(LOCAL)) {
				const oldKey = editorKey(state); queueDrafts.set(oldKey, captureQueueDraft());
				state.executionOwner = ownerKey(LOCAL);
				for (const [key, draft] of [...queueDrafts]) {
					const canonical = canonicalEditorKey(key);
					if (canonical !== key) { queueDrafts.set(canonical, draft); queueDrafts.delete(key); }
				}
				if (!input.value && !attachments.length) displayQueueDraft(storedDraft(editorKey(state)));
				queueDrafts.set(editorKey(state), captureQueueDraft()); saveDraft();
				queueDrafts.delete(oldKey);
			}
			if (restoredView?.owner && restoredView.owner !== hereOwner() && !restoreFocusAsked) {
				restoreFocusAsked = true;
				void selectOwner(restoredView.owner, send => send('tab-focus', { tabId: restoredView.tabId, snapshot: true })).catch(fail);
			}
			for (const machine of machineRows) if (!machine.self && machine.reachable && machine.id) ensureTransport(machine.id).connect();
		} catch {
			machineRows = machineRows.map(machine => ({ ...machine, reachable: false }));
			machinesKnown = true;
			for (const [from, to] of [...draftAliases]) {
				const [owner, session] = JSON.parse(from);
				const canonical = ownerSessionKey(ownerKey(owner), session);
				if (canonical !== from) { draftAliases.set(canonical, canonicalEditorKey(to)); draftAliases.delete(from); }
			}
		}
		paintSessionRail();
		paintFreshness();
		if (choosing) render();
	}
	void refreshMachines();
	setInterval(() => void refreshMachines(), 15_000);
	const hereOwner = () => machineRows.find(machine => machine.self)?.id ?? '';

	// Opening one already open goes to its tab (tabs.mjs), so it is safe to ask again.
	function openSession(row, { quiet = false } = {}) {
		if (!quiet) transcriptScroller.latest();
		const owner = row.owner || ownerKey(selectedOwner);
		return selectOwner(owner, send => row.owner
			? send('session-attach', { owner, sessionId: row.id ?? row.sessionId, agent: row.agent ?? 'pi' })
			: send('tab-open', { path: row.path ?? row.id, agent: row.agent ?? 'pi', cwd: row.cwd ?? '' }), null, { retry: async () => { await refreshMachines(); await openSession(row, { quiet: true }); } }).catch(quiet ? () => {} : fail);
	}

	// The agents are a strip of tabs across the top, on the desk as on the
	// phone, and unfolding it is the full list laid over the work for as long
	// as it takes to choose one -- a sheet, not a place to live, so it is
	// never remembered open. Collapsing takes the words away, never the way
	// back: the » that unfolds it stays. A finger swipes tabs away.
	let railCollapsed = true;
	// The usage line at the sidebar's foot, once the dock is built.
	let railFooter = null;
	// In a Mac's window, laid out in focus (windows.js), the agents are a
	// sidebar down the left instead: a place to live, kept open while one is
	// chosen, and folded or not as the person last left it.
	const RAIL_SIDEBAR = 'imperfect.sidebar';
	// The sidebar's sections (Sessions with History, Files, Sites; Settings
	// and, under a line, usage at its foot):
	// a desk's focus window, and a phone's list when it is opened.
	const railSidebar = () => terminal.classList.contains('focus-layout') || terminal.classList.contains('phone-layout');
	let railWasSidebar = false;
	function syncRailSidebar() {
		const side = railSidebar();
		if (side === railWasSidebar) return;
		railWasSidebar = side;
		let folded = false;
		try { folded = localStorage.getItem(RAIL_SIDEBAR) === 'folded'; } catch { /* storage denied */ }
		// A phone's list is a sheet, opened when asked; a desk's sidebar stays as it was left.
		setRailCollapsed(side && !phone() ? folded : true);
	}
	// A session chosen, the list as a sheet goes; as a sidebar it stays.
	const railChosen = () => { if (!railCollapsed && (!railSidebar() || phone())) setRailCollapsed(true); };
	// History is the sessions no tab holds, under the open ones in the
	// unfolded list; choosing one brings it back as a tab.
	let pastSessions = [], historyCollapsed = true, historyLoading = false, historyRequest = 0;
	function setRailCollapsed(next) {
		railCollapsed = Boolean(next);
		if (railCollapsed) { historyCollapsed = true; historyLoading = false; historyRequest++; }
		if (railSidebar() && !phone()) try { localStorage.setItem(RAIL_SIDEBAR, railCollapsed ? 'folded' : 'open'); } catch { /* storage denied */ }
		paintSessionRail();
	}
	function toggleHistory() {
		historyCollapsed = !historyCollapsed;
		if (historyCollapsed) { historyLoading = false; historyRequest++; paintSessionRail(); return; }
		const request = ++historyRequest, owner = selectedOwner;
		historyLoading = true;
		paintSessionRail();
		command('sessions').then(rows => {
			if (request === historyRequest && owner === selectedOwner) pastSessions = rows ?? [];
		}).catch(fail).finally(() => {
			if (request !== historyRequest) return;
			historyLoading = false;
			paintSessionRail();
		});
	}

	const STATUS_PRIORITY = { blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 };
	function sortedTabs() {
		return [...transports].flatMap(([owner, transport]) => ((owner === selectedOwner ? state?.tabs : transport.snapshot?.tabs) ?? []).map(tab => ({ ...tab,
			owner: ownerKey(owner), focused: owner === selectedOwner && tab.focused,
			offline: transport.socket?.readyState !== WebSocket.OPEN || (owner !== LOCAL && !machineRows.some(m => m.id === owner && m.reachable)),
		}))).sort((a, b) =>
			(STATUS_PRIORITY[a.status] ?? STATUS_PRIORITY.unknown) - (STATUS_PRIORITY[b.status] ?? STATUS_PRIORITY.unknown));
	}
	// The sessions in the order the rail draws them: with more than one
	// computer, this one's first, then each other's.
	function railTabs() {
		const tabs = sortedTabs();
		const selfId = machineRows.find(machine => machine.self)?.id;
		const owners = [...new Set(tabs.map(tab => tab.owner))].sort((a, b) => Number(b === selfId) - Number(a === selfId));
		return owners.flatMap(owner => tabs.filter(tab => tab.owner === owner));
	}
	// MOD+1 to MOD+5: the first five sessions in the rail; a number with no
	// session, or one whose computer is offline, does nothing.
	function enterNthTab(n) {
		const tab = railTabs()[n - 1];
		if (!tab || tab.offline) return false;
		enterTab(tab.id, tab.owner).catch(fail);
		return true;
	}
	// Closing the session in view goes on to the one below it in the rail, or
	// above it when it was the last: next in line as the rail shows them,
	// whichever computer that one is on. Its own computer is told which, so
	// nothing else flashes up in between.
	function closeTarget(tabId, owner) {
		// Keep the transport key, not a mutable row or the eventual selection.
		const key = [...transports.keys()].find(key => ownerKey(key) === ownerKey(owner));
		const snap = key === selectedOwner ? state : transports.get(key)?.snapshot;
		const tab = snap?.tabs?.find(tab => tab.id === tabId);
		if (!tab || (tab.sessionId == null && !snap.instanceId)) throw new Error('Session changed; close cancelled');
		return { owner: key, tabId, expectedTabId: tabId, expectedSessionId: tab.sessionId ?? null,
			...(snap.instanceId ? { expectedInstanceId: snap.instanceId } : {}) };
	}
	async function closeSession(tabId, owner = selectedOwner, extra = {}) {
		const target = extra.expectedTabId === undefined ? closeTarget(tabId, owner) : { ...extra, owner, tabId };
		const snap = target.owner === selectedOwner ? state : transports.get(target.owner)?.snapshot;
		const tab = snap?.tabs?.find(tab => tab.id === tabId);
		if (!tab || (target.expectedSessionId == null
			? !target.expectedInstanceId || snap.instanceId !== target.expectedInstanceId
			: (tab.sessionId ?? null) !== target.expectedSessionId)
			|| (target.expectedInstanceId !== undefined && snap.instanceId !== target.expectedInstanceId)) throw new Error('Session changed; close cancelled');
		const canonicalOwner = ownerKey(target.owner), rail = sortedTabs();
		const at = rail.findIndex(tab => tab.id === tabId && tab.owner === canonicalOwner);
		const usable = tab => tab && !tab.offline;
		const next = rail[at]?.focused ? (rail.slice(at + 1).find(usable) ?? rail.slice(0, Math.max(0, at)).reverse().find(usable)) : null;
		const { owner: capturedOwner, ...identity } = target;
		const result = await ownerCommand(capturedOwner, 'tab-close', { ...extra, ...identity, ...(next?.owner === canonicalOwner ? { then: next.id } : {}) });
		if (next && next.owner !== canonicalOwner) await enterTab(next.id, next.owner);
		return result;
	}
	// A row is what distinguishes it: which agent, on which model, asked to do
	// what. Its mark's colour is its status; + starts one, MOD+Esc closes.
	// On the phone a session is swiped away like a notification: sideways in
	// the unfolded list, upwards off the strip. Past a third of the way it
	// goes; short of that it springs back. Swiping explicitly ends this
	// session's current turn, even when working; its saved history stays.
	let railSwiping = false;
	{
		let drag = null, swallowClick = false;
		const settle = (row, offset, axis) => {
			row.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
			row.style.transform = offset ? `translate${axis.toUpperCase()}(${offset}px)` : '';
			row.style.opacity = offset ? '0' : '';
		};
		sessionRail.addEventListener('pointerdown', event => {
			if (!phone() || drag) return;
			const row = event.target.closest('.session-rail-item:not(.session-rail-new)');
			if (!row?.dataset.tabId) return;
			let target;
			try { target = closeTarget(row.dataset.tabId, row.dataset.owner); } catch (error) { fail(error); return; }
			drag = { row, target, pointer: event.pointerId, x: event.clientX, y: event.clientY, axis: railCollapsed ? 'y' : 'x', offset: 0, live: false };
		});
		sessionRail.addEventListener('pointermove', event => {
			if (!drag || event.pointerId !== drag.pointer) return;
			const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
			if (!drag.live) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
				const along = drag.axis === 'x' ? Math.abs(dx) > Math.abs(dy) : dy < 0 && Math.abs(dy) > Math.abs(dx);
				if (!along) { drag = null; return; }
				drag.live = railSwiping = true;
				sessionRail.setPointerCapture(event.pointerId);
				drag.row.style.transition = 'none';
			}
			drag.offset = drag.axis === 'x' ? dx : Math.min(0, dy);
			const span = drag.axis === 'x' ? drag.row.offsetWidth : drag.row.offsetHeight * 1.5;
			drag.row.style.transform = `translate${drag.axis.toUpperCase()}(${drag.offset}px)`;
			drag.row.style.opacity = String(Math.max(0.15, 1 - Math.abs(drag.offset) / span));
		});
		const release = event => {
			if (!drag || event.pointerId !== drag.pointer) return;
			const { row, target, axis, offset, live } = drag;
			drag = null;
			if (!live) return;
			swallowClick = true;
			const span = axis === 'x' ? row.offsetWidth : row.offsetHeight * 1.5;
			const gone = event.type === 'pointerup' && Math.abs(offset) > span / 3;
			settle(row, gone ? Math.sign(offset) * span : 0, axis);
			const done = () => { railSwiping = false; railLook = ''; paintSessionRail(); };
			if (!gone) { setTimeout(done, 180); return; }
			closeSession(target.tabId, target.owner, { ...target, closeConfirmed: true })
				.catch(error => { settle(row, 0, axis); fail(error); })
				.finally(() => setTimeout(done, 180));
		};
		sessionRail.addEventListener('pointerup', release);
		sessionRail.addEventListener('pointercancel', release);
		// The tap that ends a swipe is not a tap on the row.
		sessionRail.addEventListener('click', event => {
			if (swallowClick) { swallowClick = false; event.stopPropagation(); event.preventDefault(); }
		}, true);
		sessionRail.addEventListener('pointerdown', () => { swallowClick = false; }, true);
	}

	// The rail is drawn again only when something on it changed, so the button
	// under a press is still there when the press comes up.
	// Time, and this computer's Wi-Fi and battery (system.js): one quiet group
	// at the top centre of the screen, whatever columns lie under it or how
	// they are turned; on a phone it is the conversation's, leaving with its bar.
	const screenStatus = el('div', null, 'screen-status');
	const screenClock = el('time', null, 'screen-clock');
	screenClock.setAttribute('aria-label', 'Local time');
	const localTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
	const updateClock = () => {
		const now = new Date();
		const text = localTime.format(now);
		// Do not invalidate the still galaxy for an unchanged clock label.
		if (screenClock.textContent !== text) {
			screenClock.textContent = text;
			screenClock.dateTime = now.toISOString();
		}
	};
	let clockInterval;
	const startClock = () => {
		updateClock();
		clearInterval(clockInterval);
		// Follow wall-clock minute boundaries, not the minute after page load.
		clockInterval = setInterval(updateClock, 1_000);
	};
	startClock();
	window.addEventListener('pagehide', () => clearInterval(clockInterval));
	window.addEventListener('pageshow', startClock);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });
	const systemControls = mountSystem({ anchor: screenStatus, band: sessionRail });
	screenStatus.append(screenClock, systemControls.status);
	terminal.append(screenStatus);
	// What was copied (Mod+V) and a screenshot just taken hang where the
	// system panel does, one at a time; only on the computer's own screen.
	const onlyOne = keep => {
		if (keep !== systemControls && systemControls.isOpen()) systemControls.close();
		for (const other of [clipHistory, shotPreview]) if (other && other !== keep) other.close();
	};
	const clipHistory = mountClipboardHistory({
		anchor: screenStatus, band: sessionRail, beforeOpen: () => onlyOne(clipHistory),
		composer: { input, paste: pasteText, attach: file => attachFiles([file]) },
	});
	const shotPreview = mountScreenshotPreview({
		anchor: screenStatus, band: sessionRail, beforeOpen: () => onlyOne(shotPreview),
		attach: async file => { await attachFiles([file]); input.focus({ preventScroll: true }); },
		files: path => openFiles(path, { base: '' }),
	});
	let railLook = '';
	// The sidebar (focus): Sessions, Files and Sites, as Finder's and
	// Safari's sidebars hold them. What it reads from the browser, Files and
	// the windows, once they exist (sidebarHooks, set below).
	let sidebarHooks = null, historyAll = false, historyOwner = null, historyTried = 0;
	// Settings, at the sidebar's foot over the line above usage: where models
	// and providers are signed in to and out of, the themes, and the keys
	// (settings.js).
	const GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
	let settings = null;
	function settingsButton() {
		const button = el('button', null, 'session-rail-settings');
		button.type = 'button';
		button.innerHTML = GEAR;
		button.append(el('span', 'Settings'));
		button.addEventListener('pointerdown', event => event.stopPropagation());
		button.onclick = () => {
			settings ??= mountSettings({
				signIn: () => currentAuth().login(),
				signOut: () => currentAuth().logout(),
				chooseModel: () => chooseModel(),
				usage: () => { if (!usageView?.isOpen) usageView?.button.click(); },
			});
			settings.toggle();
		};
		return button;
	}
	const SIDEBAR_ICONS = {
		home: '<path d="M3.5 10.5 12 3.5l8.5 7V19a1 1 0 0 1-1 1H15v-5.5H9V20H4.5a1 1 0 0 1-1-1z"/>',
		downloads: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v8.5m-3.6-3.6L12 16l3.6-3.6"/>',
		folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2H19A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
		globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.5 3.5 5.3 3.5 8.5s-1.2 6-3.5 8.5c-2.3-2.5-3.5-5.3-3.5-8.5s1.2-6 3.5-8.5z"/>',
		plus: '<path d="M12 6v12M6 12h12"/>',
		close: '<path d="M8 8l8 8M16 8l-8 8"/>',
		file: '<path d="M6.5 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.5 3.5v4h4"/>',
	};
	function sidebarIcon(name) {
		const holder = el('span', null, 'sidebar-icon');
		holder.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SIDEBAR_ICONS[name]}</svg>`;
		return holder;
	}
	// The sessions no tab holds, read once for this computer, again if it fails.
	function loadHistory() {
		const request = ++historyRequest, owner = selectedOwner;
		historyLoading = true; historyTried = Date.now();
		command('sessions').then(rows => {
			if (request === historyRequest && owner === selectedOwner) { pastSessions = rows ?? []; historyOwner = owner; }
		}).catch(() => { setTimeout(() => { railLook = ''; paintSessionRail(); }, 3500); }).finally(() => {
			if (request !== historyRequest) return;
			historyLoading = false; railLook = ''; paintSessionRail();
		});
	}
	function sidebarLook() {
		if (!railSidebar() || railCollapsed) return null;
		return [historyAll, sidebarHooks?.views?.() ?? [], sidebarHooks?.sites?.() ?? [], sidebarHooks?.panel?.() ?? null,
			machineRows.map(machine => [machine.id, machine.reachable])];
	}
	function sidebarRow({ icon, name, meta = null, active = false, dim = false, onclick, title = '', extra = null }) {
		const row = el('div', null, `session-rail-item sidebar-row${active ? ' active' : ''}${dim ? ' dim' : ''}`);
		const open = el('button', null, 'session-rail-open');
		open.type = 'button';
		const line = el('span', null, 'session-rail-line');
		line.append(icon, el('span', name, 'session-rail-asked'));
		if (meta !== null) line.append(typeof meta === 'string' ? el('span', meta, 'sidebar-meta') : meta);
		open.append(line);
		open.title = title;
		// On a phone the sidebar is a sheet: choosing in it puts it away.
		open.onclick = event => { if (phone()) railChosen(); onclick?.(event); };
		row.append(open);
		if (extra) row.append(extra);
		return row;
	}
	function sidebarHead(title, action = null) {
		const head = el('div', null, 'sidebar-head');
		head.append(el('span', title, 'sidebar-head-title'));
		if (action) head.append(action);
		return head;
	}
	function sidebarSections(agents) {
		const parts = [sidebarHead('Sessions'), agents];
		// New session, under the open ones -- unless one nobody has asked
		// anything yet is open: that one is the new session, named so.
		const blankSession = !choosing && railTabs().some(tab => !tab.offline && !String(tab.prompt ?? '').trim());
		if (!blankSession) parts.push(sidebarRow({ icon: sidebarIcon('plus'), name: 'New session', dim: true, onclick: () => (choosing ? focusChoice() : newTab().catch(fail)) }));
		// History, folded, under New session: the sessions no tab holds.
		parts.push(sidebarHistory());
		// Files: its views, like the browser's pages below, a folder each,
		// Home to begin with.
		const showingFiles = sidebarHooks?.panel?.() === 'files';
		parts.push(sidebarHead('Files'));
		const views = sidebarHooks?.views?.() ?? [];
		for (const view of views) {
			const machine = view.owner ? machineRows.find(machine => machine.id === view.owner) : null;
			const icon = sidebarIcon(view.home ? 'home' : view.file ? 'file' : view.name === 'Downloads' ? 'downloads' : 'folder');
			let close = null;
			if (views.length > 1) {
				close = el('button', null, 'sidebar-remove');
				close.type = 'button'; close.title = `Close ${view.name}`; close.setAttribute('aria-label', close.title);
				close.append(sidebarIcon('close'));
				close.onclick = () => sidebarHooks?.closeView(view.key);
			}
			parts.push(sidebarRow({ icon, name: view.name, meta: machine && !machine.self ? machine.name || machine.id : '',
				active: showingFiles && view.front, title: `${machine?.name || 'this computer'} · ${view.path || '~'}`,
				onclick: () => sidebarHooks?.selectView(view.key), extra: close }));
		}
		parts.push(sidebarRow({ icon: sidebarIcon('plus'), name: 'New view', dim: true, onclick: () => sidebarHooks?.newView() }));
		// Sites: the browser's pages.
		parts.push(sidebarHead('Sites'));
		const showingBrowser = sidebarHooks?.panel?.() === 'browser';
		const sites = sidebarHooks?.sites?.() ?? [];
		for (const site of sites) {
			// A page with nothing in it yet is the new page, and says so.
			const blank = site.url === 'about:blank';
			let icon = sidebarIcon('globe');
			if (/^https?:/.test(site.favicon)) {
				icon = el('span', null, 'sidebar-icon sidebar-favicon');
				const img = el('img'); img.src = site.favicon; img.alt = ''; img.onerror = () => { img.replaceWith(sidebarIcon('globe')); };
				icon.append(img);
			}
			let host = '';
			try { host = new URL(site.url).host.replace(/^www\./, ''); } catch { /* not an address */ }
			const close = el('button', null, 'sidebar-remove');
			const name = blank ? 'New page' : site.name;
			close.type = 'button'; close.title = `Close ${name}`; close.setAttribute('aria-label', close.title);
			close.append(sidebarIcon('close'));
			close.onclick = () => sidebarHooks?.closeSite(site.key);
			parts.push(sidebarRow({ icon, name, meta: site.unread ? el('span', null, 'sidebar-unread') : '', active: showingBrowser && site.front,
				title: blank ? '' : host || site.url, onclick: () => sidebarHooks?.selectSite(site.key), extra: close }));
		}
		if (!sites.some(site => site.url === 'about:blank')) parts.push(sidebarRow({ icon: sidebarIcon('plus'), name: 'New page', dim: true, onclick: () => sidebarHooks?.newPage() }));
		return parts;
	}
	// History: the sessions no tab holds, folded until asked for, in
	// Sessions under New session; opened, its rows follow it and scroll with
	// the rest of the list.
	function sidebarHistory() {
		const section = el('div', null, `sidebar-past${historyAll ? ' open' : ''}`);
		const toggle = el('button', null, `sidebar-history${historyAll ? ' open' : ''}`);
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(historyAll));
		toggle.append(el('span', null, 'sidebar-chevron'), el('span', historyAll && historyLoading && !pastSessions.length ? 'History · loading' : 'History'));
		toggle.onclick = () => { historyAll = !historyAll; railLook = ''; paintSessionRail(); };
		section.append(toggle);
		if (historyAll) {
			if (historyOwner !== selectedOwner && !historyLoading && Date.now() - historyTried > 3000) loadHistory();
			const open = new Set(railTabs().flatMap(tab => [tab.sessionFile, tab.sessionId]).filter(Boolean));
			const past = pastSessions.filter(session => !open.has(session.path) && !open.has(session.id) && !open.has(session.sessionId));
			for (const session of past.slice(0, 80)) {
				const icon = el('span', null, 'session-rail-agent'); icon.append(agentGlyph('unknown', session.agent));
				section.append(sidebarRow({ icon, name: session.name || String(session.firstMessage ?? '').trim().slice(0, 120) || session.id,
					meta: whenLabel(session.modified) || '', dim: true, title: session.cwd || '', onclick: () => openSession(session) }));
			}
		}
		return section;
	}
	function paintSessionRail() {
		usageView?.syncActivity();
		if (railSwiping) return;
		const look = JSON.stringify([railCollapsed, historyCollapsed, historyLoading, wantedTab, Boolean(choosing), phone(),
			sortedTabs().map(tab => [tab.id, tab.owner, tab.status, tab.agent, tab.model, tab.prompt, tab.offline, tab.focused]),
			machineRows.map(machine => [machine.id, machine.name, machine.self]),
			railCollapsed ? null : pastSessions.map(session => [session.id, session.path, session.agent, session.name, session.firstMessage, session.cwd, whenLabel(session.modified)]),
			sidebarLook()]);
		if (look === railLook) return;
		railLook = look;
		// Measure before changing the folded layout; keep + seated when unfolding.
		const previousPlus = sessionRail.querySelector('.session-rail-new');
		const plusLeft = previousPlus ? previousPlus.getBoundingClientRect().left - sessionRail.getBoundingClientRect().left : 0;
		sessionRail.classList.toggle('collapsed', railCollapsed);
		const heading = el('p', null, 'session-rail-heading');
		if (!railCollapsed) {
			const gap = parseFloat(getComputedStyle(sessionRail.querySelector('.session-rail-heading') || sessionRail).columnGap) || 0;
			const reserve = (previousPlus?.offsetWidth || 44) + (sessionRail.querySelector('.session-rail-fold')?.offsetWidth || 44) + gap;
			heading.style.paddingLeft = `${Math.max(0, Math.min(plusLeft, sessionRail.clientWidth - reserve))}px`;
		}
		const fold = el('button', railCollapsed ? '»' : '«', 'session-rail-fold');
		fold.type = 'button';
		fold.setAttribute('aria-label', railCollapsed ? 'show the agents' : 'collapse the agents');
		fold.title = railCollapsed ? 'Show agents' : 'Collapse agents';
		fold.setAttribute('aria-expanded', String(!railCollapsed));
		fold.onclick = () => setRailCollapsed(!railCollapsed);
		if (railCollapsed) {
			heading.append(fold);
		} else if (phone() && hooks.openThemes) {
			// The phone's one visible way to the theme sheet; three fingers
			// drawn together still open it too.
			const theme = el('button', 'theme', 'session-rail-theme');
			theme.type = 'button';
			theme.onclick = () => { setRailCollapsed(true); hooks.openThemes(); };
			heading.append(theme, fold);
		} else {
			heading.append(fold);
		}
		const agents = el('section', null, 'session-rail-group session-rail-agents');
		// With more than one computer, each computer's sessions sit under its
		// name, this one first, so where a session runs is the heading it is
		// under rather than an icon on every row.
		const ordered = railTabs();
		// The strip has room for a word between one computer's tabs and the next.
		const grouped = new Set(ordered.map(tab => tab.owner)).size > 1;
		let group = null;
		for (const [index, tab] of ordered.entries()) {
			if (grouped && tab.owner !== group) {
				group = tab.owner;
				const machine = machineRows.find(row => row.id === group);
				agents.append(el('p', machine?.name || group || 'this computer', 'session-rail-machine'));
			}
			const lit = wantedTab ? wantedTab === ownerSessionKey(tab.owner, tab.id) : tab.focused && !choosing;
			const row = el('div', null, `session-rail-item${lit ? ' active' : ''}`);
			row.dataset.tabId = tab.id; row.dataset.owner = tab.owner;
			row.dataset.state = tab.status || 'unknown';
			const open = el('button', null, 'session-rail-open');
			open.type = 'button';
			// One line: the mark and the model on one baseline, then what the
			// session was first asked to do.
			const line = el('span', null, 'session-rail-line');
			const identity = el('span', null, 'session-rail-agent');
			const mark = railCollapsed && !phone() ? el('span', romanNumeral(index + 1), 'session-rail-number') : agentGlyph(tab.status, tab.agent);
			mark.setAttribute('aria-hidden', 'true');
			identity.append(mark, el('span', modelLabel(tab.model) || 'model unknown', 'session-rail-model'));
			identity.setAttribute('aria-label', `${harnessLabel(tab.agent)} · ${modelLabel(tab.model) || 'model unknown'} · ${tab.status || 'unknown'}`);
			line.append(identity);
			const asked = String(tab.prompt ?? '').trim();
			if (asked) line.append(el('span', asked, 'session-rail-asked'));
			else if (railSidebar() && !railCollapsed) line.append(el('span', 'New session', 'session-rail-asked'));
			// Working, done or waiting, at the row's end (the sidebar shows it);
			// at work, it spins while it can be seen.
			const progress = el('span', null, 'session-rail-state');
			if (tab.status === 'working') animateInView(progress);
			line.append(progress);
			open.append(line);
			open.disabled = tab.offline; open.title = tab.offline ? 'Execution owner offline; session remains there' : '';
			// On a desk a tab is entered on the press, as a browser's tabs are. On
			// a phone a press may be the start of a swipe, so there it is the tap.
			const pressed = event => !phone() && event.pointerType === 'mouse';
			const enter = () => {
				if (open.disabled) return;
				railChosen();
				enterTab(tab.id, tab.owner).catch(fail);
			};
			open.onpointerdown = event => { if (pressed(event) && event.button === 0) enter(); };
			open.onclick = event => { if (!pressed(event)) enter(); };
			row.append(open);
			// In the sidebar, a little × on hover closes it, as the keys (MOD+Esc)
			// and a phone's swipe do.
			if (railSidebar() && !railCollapsed && !phone()) {
				const close = el('button', null, 'sidebar-remove');
				close.type = 'button'; close.title = 'Close session'; close.setAttribute('aria-label', close.title);
				close.append(sidebarIcon('close'));
				close.addEventListener('pointerdown', event => event.stopPropagation());
				close.onclick = event => {
					event.stopPropagation();
					let target;
					try { target = closeTarget(tab.id, tab.owner); } catch (error) { fail(error); return; }
					closeSession(target.tabId, target.owner, { ...target, closeConfirmed: true }).catch(fail);
				};
				row.append(close);
			}
			agents.append(row);
		}
		// New session stays in the heading, outside the scrolling tabs, so
		// even a full strip leaves its action and the fold reachable.
		{
			const row = el('div', null, `session-rail-item session-rail-new${choosing ? ' active' : ''}`);
			row.dataset.state = 'unknown';
			const open = el('button', null, 'session-rail-open');
			open.type = 'button';
			open.setAttribute('aria-label', 'new session');
			const line = el('span', null, 'session-rail-line');
			line.append(el('span', '+', 'session-rail-agent'));
			open.append(line);
			open.onclick = () => {
				railChosen();
				return choosing ? focusChoice() : newTab().catch(fail);
			};
			row.append(open);
			heading.insertBefore(row, fold);
		}
		const past = el('section', null, 'session-rail-group session-rail-history');
		if (!railCollapsed) {
			const open = new Set(ordered.flatMap(tab => [tab.sessionFile, tab.sessionId]).filter(Boolean));
			const rows = pastSessions.filter(session => !open.has(session.path) && !open.has(session.id) && !open.has(session.sessionId)).slice(0, 80);
			const toggle = el('button', `${historyCollapsed ? '»' : '«'} history${historyLoading ? ' · loading' : ''}`, 'session-rail-open session-rail-machine');
			toggle.type = 'button';
			toggle.setAttribute('aria-label', historyCollapsed ? 'Show history' : 'Collapse history');
			toggle.setAttribute('aria-expanded', String(!historyCollapsed));
			toggle.onclick = toggleHistory;
			past.append(toggle);
			for (const session of historyCollapsed || historyLoading ? [] : rows) {
				const row = el('div', null, 'session-rail-item session-rail-past');
				row.dataset.state = 'unknown';
				const open = el('button', null, 'session-rail-open');
				open.type = 'button';
				const line = el('span', null, 'session-rail-line');
				const identity = el('span', null, 'session-rail-agent');
				identity.append(agentGlyph('unknown', session.agent), el('span', whenLabel(session.modified) || '', 'session-rail-model'));
				line.append(identity, el('span', session.name || String(session.firstMessage ?? '').trim().slice(0, 120) || session.id, 'session-rail-asked'));
				open.append(line);
				open.title = session.cwd || '';
				open.onclick = () => { railChosen(); openSession(session); };
				row.append(open);
				past.append(row);
			}
		}
		if (railCollapsed) sessionRail.replaceChildren(heading, agents, past);
		else if (railSidebar()) {
			const list = el('div', null, 'session-rail-list session-rail-sidebar');
			list.append(...sidebarSections(agents));
			sessionRail.replaceChildren(heading, list);
		} else {
			// Only the list below the transparent band needs opaque paper.
			const list = el('div', null, 'session-rail-list');
			list.append(agents, past);
			sessionRail.replaceChildren(heading, list);
		}
		if (railFooter) sessionRail.append(railFooter);
	}

	// The windows (windows.js): the conversation is the first, Workbench is
	// always beside it, and the browser, which holds every page, website and
	// thing shown as a tab (pages.js), opens in one beside them, all shared by
	// every session.
	const conversation = terminal.closest('.code-face');
	// The keyboard stays where it is while something open is using it: a
	// dialog, the model box, the choice of computer for a new session, the
	// keys, the themes.
	const keysHeld = () => Boolean(overlay || choosing || usageView?.isOpen) || Boolean(document.querySelector('dialog[open]:not(.guey-auth), [role="dialog"]:not([hidden]):not(.guey-auth), [role="menu"]:not([hidden]), .keys-face:not([hidden])'));
	// The pointer come into the conversation, the input bar takes the keys,
	// ready to type; unless text is chosen in the conversation, to copy, when
	// the keys only leave wherever they were, so the copy is of that.
	function conversationKeys() {
		if (usageView?.isOpen) return;
		const active = document.activeElement;
		// A docked question owns the keys until it has been answered.
		if (!dialog.hidden && dialog.classList.contains('input-dialog')) {
			if (!dialog.contains(active)) dialog.querySelector('input, textarea, button:not(:disabled)')?.focus({ preventScroll: true });
			return;
		}
		if (active === input || (middle.contains(active) && active.matches?.('input, textarea, select, [contenteditable="true"]'))) return;
		const chosen = getSelection();
		if (chosen && !chosen.isCollapsed && middle.contains(chosen.anchorNode)) {
			if (active && active !== document.body && !middle.contains(active)) active.blur();
			return;
		}
		input.focus({ preventScroll: true });
	}
	const middle = terminal.querySelector('.entry-screen');
	const wm = mountWindows({ conversation, panel: middle, keys: conversationKeys, held: keysHeld,
		restoredOrder: restoredView?.order ?? (restoredView?.windows ? ['conversation', ...restoredView.windows.map(win => win.kind)] : []),
		// A layout saved before every desk started in focus is not restored:
		// the laptop opens in the same window as a Mac.
		restoredLayout: restoredView?.oneLayout ? restoredView.layout : null,
		onPanel: () => paintSessionRail(),
	});
	// Focus begun or ended (MOD+L, the window made phone-narrow and wide again).
	syncRailSidebar();
	new MutationObserver(syncRailSidebar).observe(terminal, { attributes: true, attributeFilter: ['class'] });
	// A session question replaces the shared footer. Pickers and the usage
	// dashboard still own only the conversation pane, never Files or a page.
	const placeDialog = () => {
		const footer = !dialog.hidden && dialog.classList.contains('input-dialog') && !middle.classList.contains('usage-open');
		const host = footer ? terminal : middle;
		if (dialog.parentElement === host) return;
		const active = dialog.contains(document.activeElement) ? document.activeElement : null;
		host.append(dialog);
		if (active && footer) active.focus({ preventScroll: true });
	};
	const dialogPlacement = new MutationObserver(placeDialog);
	dialogPlacement.observe(dialog, { attributes: true, attributeFilter: ['hidden', 'class'] });
	dialogPlacement.observe(middle, { attributes: true, attributeFilter: ['class'] });
	const pages = mountPages({ output, wm, base: () => ownerBase(),
		// The browser button on a phone or a browser page: the home computer's
		// browser (the desktop window opens its own: pages.js launch).
		launchBase: async () => {
			// Resolve authenticated home metadata, never the selected execution owner.
			// Fetch independently: opening the browser must not change drafts or focus.
			const response = await fetch('/machines.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('Browser computer unavailable');
			const { machines } = await response.json();
			if (!Array.isArray(machines) || !machines.some(machine => machine.home)) throw new Error('Home browser computer unavailable');
			return defaultFilesBase(machines);
		}, launchAllowed: () => !keysHeld(), onLaunchError: error => fail(new Error(`Browser unavailable: ${error.message}. Try again.`)), onFolder: (path, options) => openFiles(path, options),
		onProject: (name, options) => { wm.show(files); return workbench.project(name, options); },
		onApp: async (target, options) => { const opened = await workbench.preview(target, options); if (opened && !options.quiet) wm.show(files); return opened; },
		onTabs: () => paintSessionRail() });
	// On a phone a question in the conversation, or the choice of computer
	// for a new session, brings the conversation's panel into view.
	const asking = () => (!dialog.hidden && !dialog.classList.contains('centre-box')) || terminal.classList.contains('choosing');
	const asked = new MutationObserver(() => { if (phone() && asking()) wm.home(); });
	asked.observe(dialog, { attributeFilter: ['hidden'] });
	asked.observe(terminal, { attributeFilter: ['class'] });
	// Workbench: a computer's folders, from its home (workbench-view.js).
	// Always open: on a desk tiled beside the conversation from the start, on
	// a phone the panel to its right. It is never closed; the phone's back
	// takes the typed address or the map away, then shows the conversation.
	const filesHost = el('div');
	const workbench = mountWorkbench({ host: filesHost,
		onViews: () => { if (sidebarHooks) paintSessionRail(); },
		defaultBase: async machines => {
			// Restore and selected sessions are owned; only a blank surface uses home.
			if (restoredView?.tabId && restoredView.owner) return machines?.some(machine => machine.self && machine.id === restoredView.owner) ? '' : ownerBase(restoredView.owner);
			// A solitary hosted computer has no other execution owner to await.
			// Files is usable even while its conversation socket is reconnecting.
			if (machines?.length === 1 && machines[0].self && machines[0].home) return '';
			let timer;
			try {
				await Promise.race([snapshotReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Files owner unavailable')), 5000); })]);
			} finally { clearTimeout(timer); }
			if (state?.sessionId || focusedTabId()) return ownerBase();
			return defaultFilesBase(machines);
		},
		// On a phone a page playing in Workbench fills the screen, as the browser's does.
		onFull: () => wm.full(files) });
	const files = wm.open({ kind: 'files', body: filesHost.firstElementChild, quiet: true, stays: true,
		keys: () => workbench.focus(),
		closeOne: () => workbench.back() || (phone() && (wm.home(), true)) });
	sidebarHooks = {
		sites: () => pages.sites(),
		selectSite: key => pages.select(key),
		closeSite: key => pages.closeSite(key),
		newPage: () => { if (!keysHeld()) pages.newTab(); },
		panel: () => wm.panel(),
		views: () => workbench.views(),
		showFiles: () => { wm.show(files); if (!phone()) wm.reveal(files, true); },
		selectView: key => { workbench.selectView(key); sidebarHooks.showFiles(); },
		newView: () => { workbench.newView(); sidebarHooks.showFiles(); },
		closeView: key => workbench.closeView(key),
	};
	railLook = ''; paintSessionRail();
	// A folder, on the explicit computer, or the Files tab's resolved owner;
	// quiet, Workbench goes there without being shown.
	function openFiles(path = '', { quiet = false, base } = {}) {
		if (!quiet) {
			wm.show(files);
			if (!phone()) wm.reveal(files, true);
		}
		void workbench.open(path, { base, quiet });
	}
	// Workbench follows the conversation to the computer its session runs on,
	// where the agent's work is: a session on another computer takes it to
	// that computer's home, unless it is there already. Its own bar still
	// chooses another.
	function followFiles() {
		if (workbench.where().base !== ownerBase()) void workbench.open('', { base: ownerBase(), quiet: true });
	}
	// Explicit Files activation brings its column into view; quiet agent
	// folder openings above never reveal it. Phone show() already swipes.
	function showFiles() {
		wm.show(files);
		if (!phone()) wm.reveal(files, true);
		workbench.focus();
	}
	// After a reload Workbench is at the folder it was, and the browser's
	// tabs open again. The passive phone has neither to restore.
	if (!launchPhone) {
		const was = restoredView?.windows?.find(win => win.kind === 'files')?.at;
		void workbench.open(was?.path || '', { base: was?.base, quiet: true });
	}
	setTimeout(() => {
		for (const { kind, at } of restoredView?.windows ?? []) if (kind !== 'files' && at) pages.reopen(at);
	});

	function romanNumeral(number) {
		let text = '';
		for (const [value, numeral] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
			while (number >= value) { text += numeral; number -= value; }
		}
		return text;
	}

	// The matching harness at rest or at work (Claude's starburst, not the
	// crab); the state stays on the node for blocked, done and unknown.
	function agentGlyph(status, agent) {
		const state = status || 'unknown';
		const glyph = sessionMark(agent, { working: state === 'working' });
		glyph.classList.add('session-rail-logo');
		glyph.dataset.state = state;
		return state === 'working' ? animateInView(glyph) : glyph;
	}
	function cycleTab(delta) {
		const tabs = state?.tabs ?? [];
		if (tabs.length < 2) return false;
		// From the one last asked for while it is still coming (the rail
		// shows it already), else the one on screen.
		const asked = wantedTab ? JSON.parse(wantedTab)[1] : null;
		const at = asked ? tabs.findIndex(tab => tab.id === asked) : -1;
		const i = at >= 0 ? at : Math.max(0, tabs.findIndex(tab => tab.focused));
		const next = tabs[(i + delta + tabs.length) % tabs.length];
		if (!next) return false;
		enterTab(next.id).catch(fail);
		return true;
	}

	// A notification tapped, here or on the device's lock screen, opens the
	// session that sent it: its tab, or brought back from history.
	async function showSession(id, owner = LOCAL) {
		if (!id) return;
		await snapshotReady;
		const tabs = (owner === selectedOwner ? state?.tabs : transports.get(owner)?.snapshot?.tabs) ?? [];
		const tab = tabs.find(item => item.sessionId === id || item.id === id);
		if (tab) {
			if (owner !== selectedOwner || !tab.focused) await enterTab(tab.id, ownerKey(owner)).catch(fail);
			return;
		}
		if (owner !== selectedOwner) return;
		const row = (await command('sessions').catch(() => [])).find(item => item.id === id || item.sessionId === id);
		if (row) await openSession(row);
	}
	const notifications = createNotifications({
		open: showSession,
		tick: () => { try { globalThis.imperfectNative?.tick?.(); } catch { /* no motor */ } },
	});
	void notifications.start();

	const transcriptScroller = transcriptScroll(output);
	// The answer still arriving, let out a little every frame; the view stays
	// at the bottom in the frame the words are drawn.
	const liveAnswer = liveMessage(() => transcriptScroller.pin());
	// Another machine's pictures are fetched through it, like its other files.
	const mediaAt = src => src.startsWith('/media/') && selectedOwner !== LOCAL ? `/peer/${encodeURIComponent(ownerKey(selectedOwner))}${src}` : src;
	// The conversation is drawn the way T3 Code keeps its timeline: each
	// message is drawn once and kept, keyed by the message itself, and every
	// update lays the kept drawings out in order, drawing only what is new.
	// A message already on screen is never drawn again, so nothing moves
	// under the reader; a window (what an agent showed) stays where it is,
	// the rest put around it. What a session drew is kept while it is one of
	// the last few looked at (or drawn ahead, below), so going back to one
	// lays out what is already there.
	const drawings = new Map();
	function drawingsOf(key) {
		let kept = drawings.get(key);
		if (kept) drawings.delete(key);
		else kept = { messages: new WeakMap(), lines: new WeakMap() };
		drawings.set(key, kept);
		const most = kind() === 'desktop' ? 8 : 2;
		for (const old of drawings.keys()) { if (drawings.size <= most) break; if (old !== renderedSessionId && old !== key) drawings.delete(old); }
		return kept;
	}
	// A message's drawing: made once. The turn under way is laid out in full
	// (gui-live): a message skipped as off screen would be measured at a
	// stand-in height the moment it arrives, and the view kept at the bottom
	// would jump. Indices are in the whole conversation.
	function messageNodes(kept, view, message, index, live, resolve) {
		let nodes = kept.messages.get(message);
		if (!nodes) {
			const part = document.createDocumentFragment();
			renderGuiTranscript(part, { ...view, messages: [message], partial: null }, { imageNode: (block, alt) => imageNode(block, alt, resolve), windowNode: windowFor, from: index });
			if (live) for (const node of part.children) if (node.classList.contains('gui-message')) node.classList.add('gui-live');
			nodes = [...part.childNodes];
			kept.messages.set(message, nodes);
		}
		return nodes.map(keptWindow);
	}
	// A local session's conversation is drawn ahead while the computer is
	// idle, so opening it lays out what is already there.
	const preparing = new Set();
	function prepareTranscript(data) {
		const view = { ...data, executionOwner: ownerKey(LOCAL) };
		const id = editorKey(view);
		if (id === renderedSessionId || drawings.has(id) || preparing.has(id)) return;
		preparing.add(id);
		(globalThis.requestIdleCallback ?? (fn => setTimeout(fn, 0)))(() => {
			preparing.delete(id);
			if (id === renderedSessionId || drawings.has(id) || document.hidden || !eagerLocal()) return;
			const messages = view.messages ?? [], base = view.messagesFrom ?? 0, from = messages.findLastIndex(entry => entry?.role === 'user');
			const kept = drawingsOf(id);
			messages.forEach((message, i) => messageNodes(kept, view, message, base + i, i >= from, src => src));
		});
	}
	let renderedSessionId = null;
	let guiTop = 0;
	let older = null, olderFails = 0, olderAfter = 0;
	output.addEventListener('scroll', () => { guiTop = output.scrollTop; });

	function renderTranscript() {
		output.classList.toggle('gui-transcript', !choosing);
		if (choosing) {
			// A background tab finishing a turn repaints this page. Keep the
			// keyboard where it was, or choosing with the arrows loses its place
			// every time another agent says something.
			const held = output.contains(document.activeElement);
			output.replaceChildren();
			renderChooser(output);
			if (held) focusChoice();
			return;
		}
		if (renderedSessionId !== editorKey(state)) {
			renderedSessionId = editorKey(state);
			liveAnswer.reset();
			guiTop = 0;
			transcriptScroller.latest();
			// The rail button that changed sessions is replaced during this render.
			// Return keys to the composer, unless the person chose another window
			// while the session was arriving.
			const selectedKey = editorKey(state), generation = selectionGeneration;
			requestAnimationFrame(() => { if (generation === selectionGeneration && selectedKey === editorKey(state) && !overlay && !wm.owns(document.activeElement) && hooks.canFocus?.()) input.focus(); });
		}
		const previousTop = guiTop;
		const messages = state.messages ?? [], base = state.messagesFrom ?? 0;
		const kept = drawingsOf(renderedSessionId);
		// Where the turn under way begins: the person's last message.
		const from = messages.findLastIndex(entry => entry?.role === 'user');
		const next = [];
		if (!messages.length && !state.partial) {
			const empty = document.createDocumentFragment();
			renderGuiTranscript(empty, state, { imageNode: (block, alt) => imageNode(block, alt, mediaAt), windowNode: windowFor });
			next.push(...empty.childNodes);
		} else {
			// Under the answer that ends each turn, how long it took and when it
			// finished; the last turn's too once it is over.
			const ends = turnEnds(messages, !state.streaming && !state.partial && state.operation !== 'compacting');
			messages.forEach((message, i) => {
				next.push(...messageNodes(kept, state, message, base + i, i >= from, mediaAt));
				const timed = ends.get(i);
				if (timed) next.push(turnLine(kept, message, timed));
			});
			if (state.partial) next.push(...(liveAnswer.draw(state.partial) ?? messageNodes(kept, state, state.partial, base + messages.length, true, mediaAt)));
			else liveAnswer.reset();
			const working = workingLine(state, messages, from);
			if (working) next.push(working);
		}
		place(next);
		transcriptScroller.rendered(previousTop);
		loadOlder();
	}
	// The nodes in this order, and nothing else: what is no longer drawn
	// goes; one already in its place stays, and the others are put around it.
	function place(nodes) {
		const wanted = new Set(nodes);
		for (const child of [...output.childNodes]) if (!wanted.has(child)) child.remove();
		let cursor = output.firstChild;
		for (const node of nodes) { if (node === cursor) cursor = node.nextSibling; else output.insertBefore(node, cursor); }
	}
	// Within a screen of the top of what is held, the page before it is asked
	// for (server.mjs) and drawn above, the reader's place kept. One at a time;
	// an answer for a session no longer in view, or that no longer begins
	// where it was asked from, is dropped. A failure tries again, less often
	// each time.
	output.addEventListener('scroll', () => loadOlder(), { passive: true });
	function loadOlder() {
		if (!state?.sessionId || !(state.messagesFrom > 0) || choosing || switching || Date.now() < olderAfter) return;
		const key = editorKey(state), before = state.messagesFrom, owner = selectedOwner, tabId = focusedTabId();
		if (older?.key === key || output.scrollTop > output.clientHeight) return;
		const asked = older = { key };
		const loaded = loadingBar.begin();
		ownerCommand(owner, 'messages-before', { tabId, sessionId: state.sessionId, before }).then(page => {
			olderFails = 0;
			if (editorKey(state) !== key || state.messagesFrom !== before || switching || page?.sessionId !== state.sessionId
				|| !Array.isArray(page.messages) || page.from + page.messages.length !== before) return;
			const atBottom = output.scrollHeight - output.clientHeight - output.scrollTop < 2, fromBottom = output.scrollHeight - output.scrollTop;
			state = { ...state, messages: page.messages.concat(state.messages), messagesFrom: page.from };
			if (owner === LOCAL && localDesktop()) localSessions.accept(tabId, state);
			render();
			if (!atBottom) output.scrollTop = guiTop = output.scrollHeight - fromBottom;
			if (older === asked) { older = null; loadOlder(); }
		}).catch(() => {
			const wait = Math.min(30_000, 1000 * 2 ** olderFails++);
			olderAfter = Date.now() + wait;
			setTimeout(loadOlder, wait + 10);
		}).finally(() => { loaded(); if (older === asked) older = null; });
	}
	// Where each turn ends, the last thing the agent said before the person
	// spoke again, and how long it took; the last turn too once it is over.
	function turnEnds(messages, over) {
		const ends = new Map();
		let asked = -1, said = -1;
		const close = end => { const timed = asked >= 0 && said > asked ? turnTime(messages, asked, end) : null; if (timed) ends.set(said, timed); };
		messages.forEach((message, i) => {
			if (message?.role === 'user') { close(i); asked = i; said = -1; }
			else if (message?.role === 'assistant' || message?.role === 'toolResult') said = i;
		});
		if (over) close(messages.length);
		return ends;
	}
	// A turn's line, kept with the answer it is under, so the one shown as
	// the turn ends is the one that stays when the person asks again.
	function turnLine(kept, message, timed) {
		const key = `${timed.startedAt}:${timed.endedAt}`, held = kept.lines.get(message);
		if (held?.key === key) return held.node;
		const node = turnTimeNode(timed);
		kept.lines.set(message, { key, node });
		return node;
	}
	// Below the turn under way, as T3 Code shows it: compacting, the context
	// being compacted; at work, how long so far, counting up. One node, made
	// again only when what it says changes.
	let below = { key: '', node: null };
	const tick = line => { line.textContent = `Working for ${formatWorking(Date.now() - Number(line.dataset.since))}`; };
	function workingLine(state, messages, from) {
		const since = Number(from >= 0 ? messages[from]?.timestamp : NaN);
		const key = state.operation === 'compacting' ? 'compacting' : state.streaming && Number.isFinite(since) ? `working:${since}` : '';
		if (!key) return null;
		if (below.key !== key) {
			const node = key === 'compacting' ? compactionNode(null, true) : el('p', null, 'gui-turn-time working');
			if (key !== 'compacting') node.dataset.since = String(since);
			below = { key, node };
		}
		if (key !== 'compacting') tick(below.node);
		return below.node;
	}
	setInterval(() => { if (below.node?.isConnected && below.node.classList.contains('working') && !document.hidden) tick(below.node); }, 1000);

	// Keep the animation running across snapshots; replace only on harness/work changes.
	function paintWork() {
		const working = Boolean(state?.busy || state?.operation === 'compacting');
		modelName.classList.toggle('working', working);
		const mark = modelName.firstElementChild;
		if (mark.dataset.agent !== state.agent || mark.classList.contains('mark-working') !== working) {
			mark.replaceWith(harnessMark(state.agent, { working }));
		}
	}

	// The status line: the model and how hard it thinks.
	function renderStatus() {
		document.body.dataset.thinking = state.level || 'off';
		// Until the model is known the label names the tab's own harness.
		modelCaption.textContent = modelText(state.model) || harnessLabel(state.agent);
		modelName.title = `${harnessName(state.agent)} · ${modelCaption.textContent}`;
		modelName.setAttribute('aria-label', modelName.title);
		// How hard it thinks.
		const level = state.level;
		thinking.textContent = level && level !== 'off' ? `· ${level}` : '';
		modelStatus.textContent = state.failed ? 'failed'
			: !socket || socket.readyState !== WebSocket.OPEN ? 'reconnecting'
			: ''; // a background task working says nothing (Noah, 14 Oct)
	}

	const queueDrafts = new Map();
	let carriedDraft = null;
	const takingQueues = new Set();
	let queueTaking = false;
	// A fresh tab belongs to a host lifetime, not just a recyclable tab id.
	// Aliases migrate every draft/completion, including background attachments,
	// when an owner (possibly watched in another window) gives it its first SID.
	const draftAliases = new Map();
	function draftTargetKey(owner, { sessionId, tabId, instanceId }) {
		return canonicalEditorKey(ownerSessionKey(owner, sessionId ?? `tab:${JSON.stringify([instanceId, tabId])}`));
	}
	function editorKey(data) {
		return data ? draftTargetKey(data.executionOwner || ownerKey(selectedOwner), {
			sessionId: data.sessionId, tabId: data.tabs?.find(tab => tab.focused)?.id, instanceId: data.instanceId,
		}) : null;
	}
	function canonicalEditorKey(key) {
		if (!key) return key;
		const [owner, session] = JSON.parse(key);
		const canonical = ownerSessionKey(ownerKey(owner), session);
		return draftAliases.get(canonical) ?? canonical;
	}
	function migrateDraftIdentities(owner, data) {
		if (!data?.instanceId || !Array.isArray(data.tabs)) return;
		for (const tab of data.tabs) {
			if (tab.sessionId == null) continue;
			const from = ownerSessionKey(ownerKey(owner), `tab:${JSON.stringify([data.instanceId, tab.id])}`);
			if (draftAliases.has(from)) continue;
			const to = draftTargetKey(owner, { sessionId: tab.sessionId });
			const active = from === editorKey(state);
			const draft = active ? captureQueueDraft() : queueDrafts.get(from) ?? storedDraft(from);
			draftAliases.set(from, to);
			if (!draft.text && !draft.attachments.length) continue;
			const kept = queueDrafts.get(to) ?? storedDraft(to);
			// A destination can already contain recovered text. Do not discard it.
			const prefix = draft.text && kept.text ? draft.text + '\n\n' : draft.text;
			const merged = !kept.text && !kept.attachments.length ? draft : { ...kept,
				text: prefix + kept.text, attachments: [...new Set([...draft.attachments, ...kept.attachments])],
				start: prefix.length + kept.start, end: prefix.length + kept.end };
			queueDrafts.set(to, merged); queueDrafts.delete(from);
			if (active) displayQueueDraft(merged);
			try { localStorage.setItem(draftKey(to), merged.text); localStorage.removeItem(draftKey(from)); } catch {}
		}
	}
	function captureQueueDraft() {
		return { text: input.value, attachments, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
	}
	function displayQueueDraft(draft) {
		input.value = draft.text;
		attachments = draft.attachments;
		input.setSelectionRange(draft.start, draft.end, draft.direction);
		saveDraft(); paintPending(); paintCaret(); hooks.onDraftChange?.();
	}
	async function takeQueue(fields) {
		const origin = editorKey(state);
		if ([...takingQueues].some(key => canonicalEditorKey(key) === origin)) return;
		takingQueues.add(origin);
		queueTaking = true;
		paintQueue();
		try {
			const { item } = await command('queue-take', { ...fields, expectedSessionId: state.sessionId, expectedTabId: focusedTabId() });
			if (!item) return;
			const destination = canonicalEditorKey(origin);
			const current = destination === editorKey(state);
			const draft = current ? captureQueueDraft() : (queueDrafts.get(destination) ?? { text: '', attachments: [], start: 0, end: 0 });
			const recovered = restoreQueueItem(draft, item);
			queueDrafts.set(destination, recovered);
			if (current) { displayQueueDraft(recovered); input.focus(); }
		} catch (error) { fail(error); }
		finally { takingQueues.delete(origin); queueTaking = takingQueues.size > 0; paintQueue(); }
	}
	function paintQueue() {
		const items = state?.queue?.items ?? [];
		queueBox.hidden = !items.length;
		queueBox.replaceChildren();
		if (!items.length) return;
		for (const item of items) {
			const row = el('button', `Steering: ${item.text}`, 'entry-queue-line');
			row.type = 'button';
			row.disabled = [...takingQueues].some(key => canonicalEditorKey(key) === editorKey(state)) || !item.id;
			row.dataset.queueId = item.id ?? '';
			row.onmousedown = event => event.preventDefault(); // keep composer focus/selection
			row.onclick = () => takeQueue({ queueId: item.id });
			queueBox.append(row);
		}
		queueBox.append(el('div', '↳ click a line, or ↑ in an empty input bar, to edit latest', 'entry-queue-hint'));
	}

	function applyQueue(q, origin = editorKey(state)) {
		const key = canonicalEditorKey(origin), current = key === editorKey(state);
		const before = current ? captureQueueDraft() : (queueDrafts.get(key) ?? storedDraft(key));
		const items = q?.items ?? (q?.steering ?? []).map(text => ({ text }));
		const draft = restoreQueueItem(before, { text: items.map(item => item.text).filter(Boolean).join('\n\n'), images: items.flatMap(item => item.images ?? []) });
		queueDrafts.set(key, draft);
		if (current) displayQueueDraft(draft);
	}

	let viewed;
	function render() {
		usageView?.sync();
		if (!state) return;
		// While the new tab is asking its question it has no composer and no
		// status: there is no session yet for either of them to describe.
		terminal.classList.toggle('choosing', Boolean(choosing));
		// On a phone, another session chosen comes into view in its panel; the
		// windows beside it stay as they are.
		const viewing = focusedTabId();
		if (viewing !== viewed) { if (viewed !== undefined && phone()) wm.home(); viewed = viewing; }
		setFileBase(state.cwd);
		renderTranscript();
		renderStatus();
		paintCaret();
		paintWork();
		paintQueue();
		// An extension asking a question outranks a picker we opened ourselves.
		const ask = choosing?.launch ? null : state.ui?.dialogs?.[0];
		if (!switching) for (const key of heldDialogs.keys()) {
			const [session, id] = JSON.parse(key);
			if (session === editorKey(state) && !(state.ui?.dialogs ?? []).some(item => item.id === id)) heldDialogs.delete(key);
		}
		if (ask && !switching) showExtensionDialog(ask);
		else if (overlay?.kind === 'extension') closeDialog();
		currentAuth().render(state.auth);
		paintSessionRail();
	}

	/* -------------------------------------------------------------- dialogs */
	const heldDialogs = new Map();
	const dialogKey = ask => JSON.stringify([editorKey(state), ask.id]);
	function suspendDialog() {
		if (overlay?.kind === 'extension') {
			heldDialogs.set(shownDialogId, { overlay, nodes: [...dialog.childNodes], keys: dialog.onkeydown, className: dialog.className });
		}
		closeDialog(); // Navigation is not cancellation; the agent keeps waiting.
	}
	let modelPickerRequest = 0;
	function closeDialog(restore = false) {
		if (overlay) modelPickerRequest++; // Dismissal invalidates awaits; a carried draft's new tab does not.
		const cancel = overlay?.onCancel, caret = overlay?.caret;
		if (overlay) hooks.onSheet?.(false);
		overlay = null; dialog.hidden = true; dialog.replaceChildren(); dialog.onkeydown = null;
		if (restore) Promise.resolve(cancel?.()).catch(fail);
		if (hooks.canFocus?.() && wm.focused().kind === 'conversation') {
			input.focus({ preventScroll: true });
			if (caret?.origin === editorKey(state)) input.setSelectionRange(caret.start, caret.end, caret.direction);
		}
	}
	// Only our local pickers dismiss on an outside tap, never an SDK question
	// or permission. Consume that tap so it cannot also submit or navigate.
	let dismissedPickerPointer = null;
	document.addEventListener('pointerdown', event => {
		if (dismissedPickerPointer === event.pointerId) dismissedPickerPointer = null;
		if (!overlay || overlay.kind === 'extension' || dialog.contains(event.target)) return;
		dismissedPickerPointer = event.pointerId;
		event.preventDefault(); event.stopImmediatePropagation();
		dismissDialog(overlay, true);
	}, true);
	// Cancelling pointerdown does not cancel its later click. Swallow that
	// same gesture too, without swallowing keyboard activation or a new tap.
	document.addEventListener('click', event => {
		if (dismissedPickerPointer == null || event.detail === 0 || (event.pointerId != null && event.pointerId !== dismissedPickerPointer)) return;
		dismissedPickerPointer = null;
		event.preventDefault(); event.stopImmediatePropagation();
	}, true);
	document.addEventListener('pointercancel', event => {
		if (dismissedPickerPointer === event.pointerId) dismissedPickerPointer = null;
	}, true);

	function dismissDialog(sheet, restore = false) {
		if (overlay === sheet) closeDialog(restore);
		else if (restore) Promise.resolve(sheet.onCancel?.()).catch(fail);
	}

	function showDialog({ kind, title, hint, detail, footer, className = '', rows, onPick, onMove, onCancel, selected, search = rows.length > 8 }) {
		// A dialog is a sheet over the canvas; the window counts it so a new
		// build never reloads out from under it.
		if (!overlay) hooks.onSheet?.(true);
		const local = kind !== 'extension';
		overlay = { kind, title, onCancel, ...(local ? { caret: { origin: editorKey(state), start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } } : {}) };
		const sheet = overlay;
		const pick = row => {
			if (local && overlay !== sheet) return;
			dismissDialog(sheet);
			Promise.resolve(row.pick ? row.pick() : onPick?.(row)).catch(fail);
		};
		dialog.hidden = false;
		dialog.className = [search ? 'compact-select' : '', className].filter(Boolean).join(' ');
		let filter = '', active = Math.max(0, rows.findIndex(row => row === selected || row.label === selected));
		const paint = () => {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			active = Math.max(0, Math.min(active, matches.length - 1));
			const frame = document.createDocumentFragment();
			const heading = el('div', null, 'entry-dialog-heading');
			heading.append(el('p', title, 'entry-dialog-title'));
			if (local) {
				const close = el('button', '×', 'entry-dialog-close');
				close.type = 'button'; close.setAttribute('aria-label', 'Close picker');
				close.onclick = () => dismissDialog(sheet, true);
				heading.append(close);
			}
			frame.append(local ? heading : heading.firstChild);
			if (detail) frame.append(el('div', detail, 'entry-dialog-detail'));
			if (search) {
				const box = el('input', null, 'compact-search');
				box.value = filter; box.placeholder = 'filter';
				box.oninput = () => { filter = box.value; active = 0; paint(); box.focus(); };
				frame.append(box);
				frame.append(el('span', `${matches.length}/${rows.length}`, 'compact-count'));
			}
			const options = local ? el('div', null, 'entry-dialog-options') : frame;
			matches.slice(0, 60).forEach((row, index) => {
				const option = el('button', null, `entry-dialog-option${index === active ? ' active' : ''}${row.unavailable ? ' unavailable' : ''}`);
				option.type = 'button';
				if (row.agent) {
					option.append(harnessMark(row.agent));
					option.title = `${harnessName(row.agent)} / ${row.billing}`;
					option.setAttribute('aria-label', `${row.label} · ${option.title}`);
					if (footer) option.setAttribute('aria-describedby', 'entry-dialog-billing');
				}
				option.append(el('span', row.label, 'entry-dialog-option-label'));
				if (row.note) option.append(el('small', row.note));
				if (kind === 'extension') option.onfocus = () => {
					active = index;
					for (const [i, button] of [...dialog.querySelectorAll('.entry-dialog-option')].entries()) button.classList.toggle('active', i === active);
				};
				option.onclick = () => pick(row);
				options.append(option);
			});
			if (!matches.length) options.append(el('p', 'nothing matches', 'entry-dialog-hint'));
			if (local) frame.append(options);
			if (footer) {
				const billing = el('p', footer, 'entry-dialog-billing');
				billing.id = 'entry-dialog-billing'; frame.append(billing);
			}
			frame.append(el('p', hint ?? 'enter chooses · esc closes', 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			dialog.tabIndex = 0;
			if (search) dialog.querySelector('.compact-search')?.focus();
			else dialog.focus();
			dialog.querySelector('.entry-dialog-option.active')?.scrollIntoView({ block: 'nearest' });
			const row = matches[active];
			if (row && onMove) Promise.resolve(onMove(row)).catch(fail);
		};
		function keys(event) {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			if (event.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); event.preventDefault(); paint(); }
			else if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); event.preventDefault(); paint(); }
			else if (event.key === 'Enter' && !event.target.closest('button')) { event.preventDefault(); const row = matches[active]; if (row) pick(row); }
			else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
		}
		dialog.onkeydown = keys;
		paint();
	}

	let shownDialogId = null;
	function showExtensionDialog(ask) {
		const key = dialogKey(ask);
		if (overlay?.kind === 'extension' && shownDialogId === key) return;
		if (overlay?.kind === 'extension') suspendDialog();
		shownDialogId = key;
		const held = heldDialogs.get(key);
		if (held) {
			heldDialogs.delete(key);
			overlay = held.overlay; dialog.replaceChildren(...held.nodes); dialog.onkeydown = held.keys; dialog.className = held.className;
			dialog.hidden = false; hooks.onSheet?.(true);
			return;
		}
		const send = sessionCommand();
		const answer = fields => { heldDialogs.delete(key); return send('dialog', { dialogId: ask.id, ...fields }).catch(fail); };
		if (ask.method === 'questions') { showQuestionsDialog(ask, answer); return; }
		if (ask.method === 'select') {
			showDialog({ kind: 'extension', title: ask.title, className: 'input-dialog', onCancel: () => answer({ cancelled: true }), hint: '↑↓ choose · enter answers · esc cancels', ...(ask.message ? { detail: ask.message, search: false } : {}),
				rows: [...ask.options.map(option => ({ label: option, pick: () => answer({ value: option }) })), { label: 'cancel', pick: () => answer({ cancelled: true }) }] });
			return;
		}
		if (ask.method === 'confirm') {
			const permission = permissionFor(state?.agent);
			showDialog({ kind: 'extension', title: ask.title, detail: ask.message, hint: '↑↓ choose · enter answers · esc cancels', className: `input-dialog ${permission?.className ?? ''}`, search: false, onCancel: () => answer({ cancelled: true }),
				rows: [{ label: 'yes', pick: () => answer({ confirmed: true }) }, { label: 'no', pick: () => answer({ confirmed: false }) }] });
			return;
		}
		if (!overlay) hooks.onSheet?.(true);
		overlay = { kind: 'extension', onCancel: () => answer({ cancelled: true }) };
		const sheet = overlay;
		dialog.hidden = false; dialog.className = 'input-dialog';
		const box = el('textarea');
		box.value = ask.prefill ?? ''; box.placeholder = ask.placeholder ?? '';
		const ok = el('button', 'answer'); ok.type = 'button'; ok.onclick = () => { dismissDialog(sheet); answer({ value: box.value }); };
		const no = el('button', 'cancel'); no.type = 'button'; no.onclick = () => dismissDialog(sheet, true);
		const actions = el('div', null, 'entry-dialog-actions'); actions.append(ok, no);
		dialog.replaceChildren(el('p', ask.title, 'entry-dialog-title'), box, actions);
		dialog.onkeydown = event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
			else if (event.key === 'Enter' && !event.isComposing && (ask.method === 'input' || event.ctrlKey || event.metaKey)) { event.preventDefault(); ok.click(); }
		};
		box.focus();
	}

	// AskUserQuestion: one to four questions, each with its own options and an
	// 'Other' free-text fallback the tool always offers. Single-select toggles
	// one choice at a time; multiSelect keeps a set. 'answer all' stays
	// disabled until every question has something — a question skipped
	// silently would just come back as an empty string Claude has to guess at.
	function showQuestionsDialog(ask, answer) {
		if (!overlay) hooks.onSheet?.(true);
		overlay = { kind: 'extension', onCancel: () => answer({ cancelled: true }) };
		dialog.hidden = false;
		dialog.className = 'input-dialog questions-dialog';
		const sheet = overlay;
		const questions = Array.isArray(ask.questions) ? ask.questions : [];
		const picked = questions.map(() => new Set());
		const otherOn = questions.map(() => false);
		const otherText = questions.map(() => '');
		const answerFor = index => {
			const parts = [...picked[index]];
			const text = otherText[index].trim();
			if (otherOn[index] && text) parts.push(text);
			return parts.join(', ');
		};
		const complete = () => questions.every((_, index) => answerFor(index).length > 0);
		const pick = (index, label) => {
			const question = questions[index];
			if (question.multiSelect) {
				if (picked[index].has(label)) picked[index].delete(label); else picked[index].add(label);
			} else {
				picked[index] = picked[index].has(label) ? new Set() : new Set([label]);
				otherOn[index] = false;
			}
			paint();
		};
		const pickOther = index => {
			if (!questions[index].multiSelect) picked[index] = new Set();
			otherOn[index] = true;
			paint();
			dialog.querySelector(`[data-other-for="${index}"] textarea`)?.focus();
		};
		function paint() {
			const focused = dialog.contains(document.activeElement) ? document.activeElement?.dataset.choice : null;
			const scrollTop = dialog.querySelector('.entry-dialog-questions')?.scrollTop ?? 0;
			const frame = document.createDocumentFragment();
			const content = el('div', null, 'entry-dialog-questions');
			questions.forEach((question, index) => {
				const block = el('div', null, 'entry-dialog-question');
				block.setAttribute('role', 'group');
				block.setAttribute('aria-label', question.question);
				const head = el('p', null, 'entry-dialog-title');
				if (question.header) head.append(el('span', question.header, 'entry-dialog-question-header'));
				head.append(el('span', question.question));
				block.append(head);
				for (const [optionIndex, option] of (question.options ?? []).entries()) {
					const row = el('button', null, `entry-dialog-option${picked[index].has(option.label) ? ' active' : ''}`);
					row.type = 'button'; row.dataset.choice = `${index}-${optionIndex}`;
					row.setAttribute('aria-pressed', String(picked[index].has(option.label)));
					row.append(el('span', option.label, 'entry-dialog-option-label'));
					if (option.description) row.append(el('small', option.description));
					row.onclick = () => pick(index, option.label);
					block.append(row);
				}
				const other = el('button', null, `entry-dialog-option${otherOn[index] ? ' active' : ''}`);
				other.type = 'button'; other.dataset.choice = `${index}-other`;
				other.setAttribute('aria-pressed', String(otherOn[index]));
				other.append(el('span', 'Other', 'entry-dialog-option-label'));
				other.onclick = () => pickOther(index);
				block.append(other);
				if (otherOn[index]) {
					const wrap = el('div', null, 'entry-dialog-other');
					wrap.dataset.otherFor = String(index);
					const box = el('textarea');
					box.rows = 3; box.placeholder = 'say more…'; box.value = otherText[index];
					box.setAttribute('aria-label', `Other: ${question.question}`);
					box.oninput = () => { otherText[index] = box.value; ok.disabled = !complete(); };
					wrap.append(box);
					block.append(wrap);
				}
				content.append(block);
			});
			frame.append(content);
			const actions = el('div', null, 'entry-dialog-actions');
			const ok = el('button', questions.length > 1 ? 'answer all' : 'answer');
			ok.type = 'button';
			ok.disabled = !complete();
			ok.onclick = () => {
				const answers = {};
				questions.forEach((question, index) => { answers[question.question] = answerFor(index); });
				dismissDialog(sheet);
				answer({ value: answers });
			};
			const cancel = el('button', 'cancel'); cancel.type = 'button'; cancel.onclick = () => dismissDialog(sheet, true);
			actions.append(ok, cancel);
			frame.append(actions, el('p', '↑↓ choose · enter answers · esc cancels', 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			content.scrollTop = scrollTop;
			if (focused) dialog.querySelector(`[data-choice="${focused}"]`)?.focus({ preventScroll: true });
		}
		dialog.onkeydown = event => {
			if (event.isComposing || event.altKey || ((event.ctrlKey || event.metaKey) && event.key !== 'Enter')) return;
			const rows = [...dialog.querySelectorAll('.entry-dialog-option')];
			const focused = document.activeElement;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
			else if (focused.matches('textarea') && (event.key !== 'Enter' || event.shiftKey)) return;
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const other = focused.closest?.('.entry-dialog-other');
				const current = other ? dialog.querySelector(`[data-choice="${other.dataset.otherFor}-other"]`) : focused;
				const index = Math.max(0, rows.indexOf(current));
				rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
			} else if (event.key === 'Enter' && !focused.closest?.('.entry-dialog-actions')) {
				event.preventDefault();
				if (complete() && (focused.matches('textarea') || focused.getAttribute('aria-pressed') === 'true')) dialog.querySelector('.entry-dialog-actions button')?.click();
				else if (focused.getAttribute('aria-pressed') === 'true') {
					const next = questions.findIndex((_, index) => !answerFor(index));
					dialog.querySelectorAll('.entry-dialog-question')[next]?.querySelector('.entry-dialog-option')?.focus();
				} else if (focused.matches('.entry-dialog-option')) focused.click();
				else if (!focused.matches('textarea')) rows[0]?.click();
			}
		};
		paint();
		dialog.tabIndex = -1;
		if (hooks.canFocus?.() && wm.focused().kind === 'conversation' && !dialog.closest('.usage-open')) dialog.querySelector('.entry-dialog-option')?.focus({ preventScroll: true });
	}

	/* ------------------------------------------------------------ the model */
	// One box in the middle of the screen: the newest model of each line this
	// computer can run, and the one this session is on, the harness that runs
	// it shown by its original mark. Picking asks how hard it should think. A Claude
	// model runs in Claude Code, a Codex one in Codex, every other in Pi.
	async function chooseModel() {
		const send = sessionCommand(), origin = editorKey(state), generation = selectionGeneration;
		const request = ++modelPickerRequest, now = state?.model;
		const models = await send('models');
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration || origin !== editorKey(state)) return;
		const isNow = m => now?.provider === m.provider && now?.id === m.id;
		const claudeFirst = (a, b) => (b.engine === 'claude') - (a.engine === 'claude');
		const listed = newestOfEachLine([...models].sort(claudeFirst), modelText, isNow);
		// Claude's "default" is one of the others under another name.
		const rows = listed.filter(m => !(m.engine === 'claude' && m.id === 'default' && listed.some(o => o !== m && o.engine === 'claude' && modelText(o) === modelText(m))))
			.map(m => {
				const billing = m.billing || 'billing unknown';
				const subscription = /^(?:(?:Claude|ChatGPT) )?subscription(?:$|\s*·)/i.test(billing);
				const api = /^API(?:$|[ /])/i.test(billing);
				return { model: m, label: modelText(m) || m.id, agent: m.engine ?? 'pi', billing,
					note: subscription ? 'Subscription' : api ? 'API' : 'Unknown', pick: () => pickModel(m, send, generation) };
			});
		if (state?.auth) rows.push({ label: 'Sign in for more models…', note: '', pick: () => currentAuth().login() });
		const current = models.find(isNow);
		const footer = rows.some(row => row.agent === 'claude' && (row.note === 'Subscription' || /extra usage/i.test(row.billing)))
			? 'Claude extra usage, if enabled, can cost more.' : null;
		showDialog({ kind: 'model', title: 'model', className: 'centre-box model-picker', search: true, hint: 'type to find · enter chooses · esc closes', footer, rows, selected: current && rows.find(row => row.model === current) });
	}
	// A model of the other harness continues in a new tab (tabs.mjs). What is in
	// the input bar goes with it: the snapshot that brings the new tab moves the
	// draft there. The first snapshot after the answer settles it either way,
	// since by then the computer has this window on the tab it chose.
	async function pickModel(m, send = sessionCommand(), generation = selectionGeneration) {
		if (switching || generation !== selectionGeneration) return;
		const request = ++modelPickerRequest;
		const carry = carriedDraft = m.engine && m.engine !== state?.agent ? { from: editorKey(state), generation, answered: false } : null;
		try { await send('model', { provider: m.provider, modelId: m.id }); }
		catch (error) { if (carry && carriedDraft === carry) carriedDraft = null; throw error; }
		if (carry) carry.answered = true;
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration) return;
		// Choosing another harness may intentionally create/select a new tab.
		// Read its effort only if no navigation intervened, then bind the picker
		// to that resulting session rather than the old harness's tab.
		const origin = editorKey(state), readLevel = sessionCommand();
		// The model response precedes its new-tab snapshot on the wire. For a
		// cross-harness move, read this owner's resulting selection, not the old tab.
		const info = await (carry ? command('level') : readLevel('level')).catch(() => null);
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration || (!carry && origin !== editorKey(state))) return;
		const setLevel = sessionCommand();
		const levels = info?.available ?? [];
		if (!levels.length) return;
		showDialog({ kind: 'effort', title: `${modelText(m)} · effort`, className: 'centre-box', search: false, hint: `enter chooses · esc keeps ${info.current ?? 'the default'}`,
			rows: levels.map(level => ({ label: level, note: level === info.current ? 'now' : '', pick: () => setLevel('level', { level }) })), selected: info.current });
	}

	/* ---------------------------------------------------------------- input */
	// A draft is kept per conversation, as it is typed.
	const draftKey = key => `guey-draft:${key}`;
	function storedDraft(key) {
		let text = ''; try { text = localStorage.getItem(draftKey(key)) ?? ''; } catch {}
		return { text, attachments: [], start: text.length, end: text.length };
	}
	const saveDraft = () => { try { if (editorKey(state)) localStorage.setItem(draftKey(editorKey(state)), input.value); } catch {} };

	const filesInput = byId('entry-files'), attachLabel = byId('entry-plus'), pendingStrip = byId('entry-pending');
	const localFileAccept = filesInput.accept;
	const attachIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z" fill="currentColor"/></svg>';
	{
		// Every control in the input bar, the same on the desk as on the
		// phone, always in sight: the mic, usage and +.
		const dock = document.querySelector('.session-actions');
		// Usage has its own authority scope; a conversation never moves it.
		let localOnly = false;
		const usageComputer = () => usageOwner(machineRows, usageAuthority, localOnly) || (machinesKnown ? ownerKey(LOCAL) : '');
		const usageTransport = () => usageComputer() === hereOwner() || usageComputer() === LOCAL ? LOCAL : usageComputer();
		const sendUsage = async (owner, type, fields = {}) => {
			if (!owner) throw new Error('Usage computer unavailable');
			const transport = ensureTransport(owner);
			transport.connect();
			const until = Date.now() + 8000;
			while (transport.socket?.readyState === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
			return transport.command(type, fields);
		};
		// Limits belong to the account a computer signs in with, so while the
		// usage computer cannot be reached (the PC off), this computer's own
		// are still true now: they are shown, and said to be this computer's,
		// rather than the last the other one gave, hours old.
		let limitsHere = false;
		usageView = mountUsage({
			tabs: sortedTabs,
			command: async (type, fields) => {
				if (!machinesKnown) await refreshMachines();
				const owner = usageTransport();
				limitsHere = false;
				try {
					return await sendUsage(owner, type, { ...fields, ...(type === 'usage-history' && localOnly ? { thisComputerOnly: true } : {}) });
				} catch (error) {
					if (type !== 'usage' || owner === LOCAL) throw error;
					const answer = await sendUsage(LOCAL, type, fields);
					limitsHere = true;
					return answer;
				}
			},
			captureCommand: () => {
				const owner = usageTransport();
				return (type, fields) => sendUsage(owner, type, { ...fields, scope: 'computer' });
			},
			identity: () => JSON.stringify([usageComputer(), localOnly, viewKey()]),
			cacheIdentity: () => JSON.stringify([hereOwner(), usageComputer(), localOnly]),
			ownerLabel: () => machineName(usageTransport()),
			scopeLabel: () => limitsHere ? `${machineName(LOCAL)} · this computer (${machineName(usageTransport())} cannot be reached)` : `${machineName(usageTransport())} · ${localOnly || (!usageAuthority && !machineRows.some(m => m.home && !m.self)) ? 'this computer only' : 'all computers'}`,
			selectScope: value => { localOnly = value; },
		});
		const browser = document.createElement('button');
		browser.type = 'button'; browser.className = 'entry-browser';
		browser.title = 'Browser (Chromium) · PC browser'; browser.setAttribute('aria-label', 'Open PC browser (Chromium)');
		// Chromium's three blades and centre, in the dock's accent. Transparent
		// seams keep the mark legible over every theme, including the galaxy.
		browser.innerHTML = `<svg class="entry-chromium" viewBox="1 1 22 22" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z"/>
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z" transform="rotate(120 12 12)"/>
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z" transform="rotate(240 12 12)"/>
			<circle cx="12" cy="12" r="4.2"/>
		</svg>`;
		browser.onclick = () => { if (!keysHeld()) pages.portal(); };
		dock.prepend(usageView.button, browser, voice.button);
		// In focus (a Mac's window and the laptop's) the input bar is only the
		// words: + and the mic stay in this line above it, usage is the
		// sidebar's foot and the browser is its Sites (focus.css hides
		// both here).
		railFooter = el('div', null, 'session-rail-foot');
		usageView.summary.classList.add('session-rail-usage');
		usageView.summary.addEventListener('click', () => { railChosen(); if (phone()) wm.home(); });
		railFooter.append(settingsButton(), usageView.summary);
		railLook = '';
		paintSessionRail();
		dock.addEventListener('mousedown', event => { if (document.activeElement === input) event.preventDefault(); });
	}
	let attachments = [];
	// The words in the input bar that stand for a picture or a recording,
	// each numbered on its own: image 1, image 2, audio 1, audio 2.
	const standIns = () => /((?:image|audio) \d+)/g;
	// Where a stand-in is in some text: "audio 1", never inside "audio 10".
	const tokenAt = (text, token) => text.search(new RegExp(`(?<![\\w])${token}(?![\\w])`));
	function nextNumber(kind, pieces = attachments) {
		const used = new Set(pieces.map(piece => piece.token?.startsWith(`${kind} `) ? Number(piece.token.slice(kind.length + 1)) : NaN).filter(Number.isFinite));
		let number = 1;
		while (used.has(number)) number += 1;
		return number;
	}
	// Text pasted into the input bar at the cursor, as Ctrl+V would.
	function pasteText(text) {
		input.focus({ preventScroll: true });
		if (document.execCommand('insertText', false, text)) return;
		const start = input.selectionStart ?? input.value.length;
		input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}
	// Words put in the input bar at the cursor, a word of their own.
	function insertWords(words) {
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		const before = input.value.slice(0, start);
		const space = before && !/\s$/.test(before) ? ' ' : '';
		input.setRangeText(`${space}${words} `, start, end, 'end');
		saveDraft(); paintCaret(); hooks.onDraftChange?.();
	}
	function insertToken(piece, kind) {
		piece.token = `${kind} ${nextNumber(kind)}`;
		insertWords(piece.token);
	}
	function dropAttachment(piece) {
		piece.controller?.abort();
		if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
		const index = attachments.indexOf(piece);
		if (index >= 0) attachments.splice(index, 1);
		if (piece.token) input.value = input.value.replace(piece.token, '').replace(/ {2,}/g, ' ');
		saveDraft(); paintCaret(); paintPending();
	}
	function paintPending() {
		filesInput.accept = localFileAccept;
		attachLabel.title = 'Attach files or images';
		attachLabel.classList.toggle('has-files', attachments.length > 0);
		attachLabel.setAttribute('aria-label', attachments.length ? attachments.map(p => p.name).join(', ') : 'attach');
		const attachMark = attachLabel.querySelector('span');
		if (attachments.length) attachMark.textContent = String(attachments.length);
		else attachMark.innerHTML = attachIcon;
		pendingStrip.replaceChildren();
		if (!attachments.length) { pendingStrip.hidden = true; return; }
		pendingStrip.hidden = false;
		let imageNumber = 0;
		attachments.forEach(piece => {
			const chip = el('button', null, 'entry-pending-chip');
			chip.type = 'button';
			chip.setAttribute('aria-label', piece.error ? `retry ${piece.name}` : `remove ${piece.name}`);
			const audio = piece.kind === 'audio';
			if (!piece.reference && !piece.image) chip.classList.add('is-uploading');
			const image = Boolean(piece.imageUrl || piece.image);
			chip.append(el('span', audio ? `(${piece.token})` : image ? `(image ${++imageNumber})` : piece.name));
			if (!piece.reference && !piece.image && !piece.error) chip.append(el('span', uploadPercent(piece.loaded, piece.total), 'entry-pending-progress'));
			else if (audio && piece.words == null && !piece.error) chip.append(el('span', 'hearing…', 'entry-pending-progress'));
			if (piece.error) chip.append(el('span', audio ? 'not heard · retry' : 'failed · retry'));
			chip.onclick = () => piece.error ? void (audio ? piece.listen().catch(() => {}) : piece.retry()) : dropAttachment(piece);
			if (piece.error) {
				const remove = el('button', '×', 'entry-pending-chip'); remove.type = 'button';
				remove.setAttribute('aria-label', `remove ${piece.name}`); remove.onclick = () => dropAttachment(piece);
				pendingStrip.append(remove);
			}
			pendingStrip.append(chip);
		});
	}
	function isImageFile(file) {
		const name = file.name || '';
		const type = file.type || '';
		return type.startsWith('image/') || (!type && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name));
	}
	function captureUploadTarget() {
		const tab = state?.tabs?.find(tab => tab.focused);
		if (!tab || switching || choosing) throw new Error('wait for the selected session before attaching');
		return Object.freeze({ owner: ownerKey(selectedOwner), servingOwner: hereOwner() || LOCAL,
			tabId: tab.id, sessionId: tab.sessionId ?? null, instanceId: state.instanceId });
	}
	// A recording (the mic's, or an audio or video file attached) is held the
	// same way, as "audio 1": uploaded to the session's computer, then heard
	// at once in the background (piece.listen), so sending need not wait.
	async function attachPersonal(file, origin = editorKey(state), target = captureUploadTarget(), { audio = false } = {}) {
		if (!audio && attachments.filter(piece => piece.kind !== 'audio').length >= 8) { fail(new Error('attach at most 8 files')); return; }
		if (file.size > MAX_UPLOAD_BYTES) { fail(new Error(`${file.name || 'file'} is larger than 1 GB`)); return; }
		const image = !audio && isImageFile(file);
		const piece = { name: file.name || (image ? 'image' : audio ? 'recording' : 'file'),
			kind: audio ? 'audio' : image ? 'image' : 'file', loaded: 0, total: file.size || 0,
			imageUrl: image ? URL.createObjectURL(file) : null };
		const key = canonicalEditorKey(origin);
		if (key === editorKey(state)) {
			attachments.push(piece); if (piece.imageUrl) insertToken(piece, 'image'); else if (audio) insertToken(piece, 'audio');
		} else {
			const draft = queueDrafts.get(key) ?? storedDraft(key);
			// A recording's stand-in goes in that draft's words too.
			if (audio) piece.token = `audio ${nextNumber('audio', draft.attachments)}`;
			queueDrafts.set(key, { ...draft, ...(audio ? { text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? ' ' : ''}${piece.token} ` } : {}), attachments: [...draft.attachments, piece] });
		}
		// The upload; one already going is the one waited for.
		piece.retry = () => {
			if (piece.controller && !piece.controller.signal.aborted && !piece.error) return piece.uploading;
			piece.error = null; piece.loaded = 0; piece.controller = new AbortController(); paintPending();
			return piece.uploading = (async () => {
				try {
					const saved = await postUpload(file, { ...target, signal: piece.controller.signal,
						onProgress(loaded, total) { piece.loaded = loaded; piece.total = total || piece.total; paintPending(); } });
					piece.reference = saved.reference; piece.loaded = saved.size ?? piece.total;
				} catch (error) {
					if (error.name !== 'AbortError') { piece.error = error; fail(error); }
				} finally { saveDraft(); paintPending(); hooks.onDraftChange?.(); }
			})();
		};
		if (audio) {
			// Its words, heard once; a failure is kept on the piece, and the
			// next listen (its chip, or sending) tries again.
			piece.listen = () => piece.listening ??= (async () => {
				if (!piece.reference) await piece.retry();
				if (!piece.reference) throw piece.error ?? new Error('the recording was not uploaded');
				piece.error = null; paintPending();
				const answer = await useUpload('transcribe', { audio: piece.reference, tab: target.tabId,
					session: target.sessionId, instanceId: target.instanceId }, target, { signal: piece.controller.signal });
				const words = String(answer.text ?? '').trim();
				if (!words) throw new Error('no words were heard in it');
				piece.words = words;
			})().catch(error => {
				piece.listening = null;
				if (error.name !== 'AbortError') piece.error = error;
				throw error;
			}).finally(paintPending);
		}
		await piece.retry();
		if (audio) piece.listen().catch(() => {});
	}
	// The mic's recording, for the draft it was started in.
	async function holdRecording(recording, { key, upload }) {
		const ending = /ogg/.test(recording.type) ? 'ogg' : /mp4/.test(recording.type) ? 'm4a' : 'webm';
		attachmentProcessing++;
		try { await attachPersonal(new File([recording], `recording.${ending}`, { type: recording.type }), key, upload, { audio: true }); }
		finally { attachmentProcessing--; }
	}
	async function attachFile(file) {
		if (switching) { fail(new Error('Wait for owner selection before attaching files')); return; }
		attachmentProcessing++;
		try { return await attachFileCaptured(file); } finally { attachmentProcessing--; }
	}
	async function attachFileCaptured(file) {
		if (!file) return;
		return attachPersonal(file, undefined, undefined, { audio: isVoiceFile(file) });
	}
	filesInput.addEventListener('change', async () => {
		const chosen = [...(filesInput.files ?? [])];
		filesInput.value = '';
		await Promise.all(chosen.map(attachFile));
		paintPending();
	});
	const shotDraft = screenshotDraft({
		focused: () => window.imperfectDesk?.isFocused?.() ?? document.hasFocus(),
		target: () => switching || choosing || !state?.sessionId ? null : { key: editorKey(state), upload: captureUploadTarget() },
		claim: async (capture, window) => {
			const response = await fetch('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: capture, window }) });
			return response.ok && (await response.json()).claimed;
		},
		load: async name => {
			const response = await fetch(`/screenshots/${encodeURIComponent(name)}`, { cache: 'no-store' });
			if (!response.ok) throw new Error('screenshot unavailable; saved locally');
			return new File([await response.blob()], name, { type: 'image/png' });
		},
		attach: async (file, captured) => {
			await attachPersonal(file, captured.key, captured.upload);
			shotPreview.note('attached to original conversation draft · not sent', true, true);
		},
		pending: (name, reason) => { shotPreview.show(name); shotPreview.note(`pending attachment: ${reason}`, true); },
	});
	async function attachFiles(list) {
		const files = [...(list ?? [])].filter(Boolean);
		if (!files.length) return;
		await Promise.all(files.map(attachFile));
		paintPending();
		hooks.onDraftChange?.();
	}
	async function filesFromAsyncClipboard() {
		if (!navigator.clipboard?.read) return [];
		try {
			return await filesFromClipboardItems(await navigator.clipboard.read());
		} catch {
			return [];
		}
	}
	async function ingestPaste(event) {
		if (switching) return;
		attachmentProcessing++;
		try { await ingestPasteCaptured(event); } finally { attachmentProcessing--; }
	}
	async function ingestPasteCaptured(event) {
		if (wm.owns(event.target) || clipboardHasText(event.clipboardData)) return;
		const origin = editorKey(state);
		let files = filesFromClipboardData(event.clipboardData);
		if (!files.length) files = await filesFromAsyncClipboard();
		if (!files.length) return;
		event.preventDefault();
		if (canonicalEditorKey(origin) !== editorKey(state)) { fail(new Error('Session changed while reading clipboard; paste again')); return; }
		await attachFiles(files);
	}
	document.addEventListener('paste', event => { void ingestPaste(event); });

	let promptAccepting = 0;
	const acceptingPrompts = new Set();
	// A prompt that failed is kept with its request id until it goes through,
	// so sending it again cannot deliver it twice. It goes along through a
	// reload (prepareReload) rather than holding one up: a window that kept one
	// it was never sent again never took a new version.
	const PROMPT_RETRIES_KEY = 'imperfect.prompt-retries';
	const promptRetries = new Map();
	try {
		for (const [key, retry] of JSON.parse(sessionStorage.getItem(PROMPT_RETRIES_KEY) || '[]')) promptRetries.set(key, retry);
		sessionStorage.removeItem(PROMPT_RETRIES_KEY);
	} catch {}
	async function sendPrompt(fields) {
		const origin = editorKey(state), send = sessionCommand();
		acceptingPrompts.add(origin);
		const identity = { expectedSessionId: state?.sessionId, expectedTabId: focusedTabId() };
		const key = JSON.stringify({ owner: ownerKey(selectedOwner), ...fields, ...identity });
		const localKey = selectedOwner === LOCAL ? JSON.stringify({ owner: LOCAL, ...fields, ...identity }) : key;
		const retry = promptRetries.get(key) ?? promptRetries.get(localKey) ?? { requestId: crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), fields };
		promptRetries.set(key, retry);
		try {
			const result = await send('prompt', { ...retry.fields, ...identity, requestId: retry.requestId });
			if (result?.accepted === false) throw new Error(result.error || 'Prompt not accepted');
			promptRetries.delete(key); promptRetries.delete(localKey);
			return result;
		} finally { acceptingPrompts.delete(origin); promptAccepting--; }
	}
	function restoreFailedPrompt(text, sent, key) {
		key = canonicalEditorKey(key);
		if (key !== editorKey(state)) {
			const draft = queueDrafts.get(key) ?? { text: '', attachments: [], start: 0, end: 0 };
			queueDrafts.set(key, { ...draft, text: [text, draft.text].filter(Boolean).join('\n\n'), attachments: sent.concat(draft.attachments) });
			return;
		}
		input.value = [text, input.value].filter(Boolean).join('\n\n'); saveDraft(); hooks.onDraftChange?.();
		attachments = sent.concat(attachments); paintPending();
	}
	// Each recording held in the bar, as words: those not heard yet are
	// waited for (the bar is held still meanwhile), and one that cannot be
	// heard keeps everything where it is.
	let hearingForSend = false;
	async function heardRecordings() {
		const key = editorKey(state);
		hearingForSend = true; input.readOnly = true;
		try {
			for (;;) {
				const waiting = attachments.filter(piece => piece.kind === 'audio' && piece.words == null);
				if (!waiting.length) return true;
				await Promise.all(waiting.map(piece => piece.listen().catch(() => {})));
				const failed = waiting.filter(piece => piece.error && attachments.includes(piece));
				if (failed.length) {
					fail(new Error(`${failed.map(piece => piece.token).join(' and ')} could not be heard (${failed[0].error.message}); nothing was sent. Send again to try again, or delete ${failed.length > 1 ? 'them' : 'it'} from the message.`));
					return false;
				}
				if (editorKey(state) !== key || switching) { fail(new Error('the session changed while its recordings were heard; nothing was sent')); return false; }
			}
		} finally { hearingForSend = false; input.readOnly = false; }
	}
	// The message with each recording's words in place of its stand-in.
	const withWords = (text, pieces) => pieces.reduce((said, piece) => {
		const at = piece.kind === 'audio' && piece.token ? tokenAt(said, piece.token) : -1;
		return at < 0 ? said : said.slice(0, at) + piece.words + said.slice(at + piece.token.length);
	}, text);
	async function submit(extra = {}) {
		if (hearingForSend || switching || [...acceptingPrompts].some(key => canonicalEditorKey(key) === editorKey(state))) return { accepted: false, error: 'workspace unavailable' };
		transcriptScroller.latest();
		if (attachments.some(piece => piece.kind !== 'audio' && !piece.reference && !piece.image)) {
			fail(new Error('wait for the file to finish uploading'));
			return { accepted: false, error: 'uploading' };
		}
		if (!input.value.trim() && !attachments.length) return { accepted: false, error: 'empty' };
		if (!await heardRecordings()) return { accepted: false, error: 'not heard' };
		const text = input.value;
		const body = withWords(text, attachments).trim();
		if (!body && !attachments.length) return { accepted: false, error: 'empty' };
		const sent = attachments, sentKey = editorKey(state);
		promptAccepting++;
		attachments = []; paintPending();
		input.value = ''; saveDraft(); hooks.onDraftChange?.();
		unlockDoneSound(); notifications.ask();
		try {
			const files = sent.filter(piece => piece.reference && piece.kind !== 'audio');
			const data = await sendPrompt({ text: body || 'See attached.', attachments: files.map(({ reference, kind }) => ({ reference, kind })), ...(sent.some(piece => piece.image) ? { images: sent.map(piece => piece.image).filter(Boolean) } : {}), ...extra });
			for (const piece of sent) if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
			return data && typeof data === 'object' ? { accepted: data.accepted !== false, ...data } : { accepted: true };
		} catch (error) {
			restoreFailedPrompt(text, sent, sentKey); fail(error);
			return { accepted: false, error: error.message ?? String(error) };
		}
	}

	/* ---------------------------------------------------------- the cursor */
	// A block, the way the terminal draws one. A textarea cannot be told to
	// draw a block (no engine here honours caret-shape), so the text is
	// mirrored over itself with the native caret made transparent, and the
	// character the cursor is sitting on is painted in reverse. At the end of
	// the line the block sits on a space, as it does in the terminal.
	function mountCaret() {
		const wrap = el('span', null, 'entry-input-mirror');
		input.parentNode.insertBefore(wrap, input);
		wrap.append(input);
		// Shown only where the cursor is the system's own (focus.css).
		if (!input.placeholder) input.placeholder = 'Message';
		caretMirror = el('div', null, 'entry-caret-mirror');
		caretMirror.setAttribute('aria-hidden', 'true');
		wrap.append(caretMirror);
		// A long message scrolls inside the field; the drawn text scrolls with it.
		input.addEventListener('scroll', () => { if (caretMirror) caretMirror.scrollTop = input.scrollTop; });
	}
	function paintCaret() {
		if (!caretMirror) return;
		// A selection has its own highlight, so there the mirror steps aside. An
		// unfocused composer has no cursor, but its draft is still drawn here:
		// the field's own letters are transparent, so hiding the mirror made a
		// draft vanish whenever the phone's keyboard went down.
		const focused = document.activeElement === input;
		const collapsed = input.selectionStart === input.selectionEnd;
		caretMirror.hidden = focused && !collapsed;
		const value = input.value ?? '';
		const fragment = document.createDocumentFragment();
		const appendText = text => {
			for (const [i, part] of text.split(standIns()).entries()) {
				if (!part) continue;
				fragment.append(i % 2 ? el('span', part, 'entry-inline-attachment') : document.createTextNode(part));
			}
		};
		if (focused && collapsed) {
			const at = input.selectionStart ?? value.length;
			const char = value[at];
			const onNewline = char === undefined || char === '\n';
			appendText(value.slice(0, at));
			fragment.append(el('span', onNewline ? ' ' : char, 'entry-block-caret'));
			appendText(onNewline ? value.slice(at) : value.slice(at + 1));
		} else appendText(value);
		caretMirror.replaceChildren(fragment);
		caretMirror.scrollTop = input.scrollTop;
	}
	mountCaret();
	for (const name of ['input', 'keyup', 'click', 'focus', 'blur', 'scroll', 'select']) {
		input.addEventListener(name, paintCaret);
	}
	// Arrow keys and the mouse move the caret without firing `input`, and
	// `selectionchange` is the only event that covers every one of them.
	document.addEventListener('selectionchange', () => {
		if (document.activeElement === input) paintCaret();
	});
	// The composer is the terminal's standing keyboard target. Empty terminal
	// space returns the caret, and a printable key repairs drifted focus before
	// the browser dispatches that key to the newly focused input.
	// Only a click returns it, never a press: a press is also how text is
	// chosen, and taking the keys in the middle of that drag cleared what was
	// being chosen (Noah: "really difficult to select text in imperfect").
	// A click that chose nothing still brings the caret back.
	document.addEventListener('click', event => {
		if (!terminal?.contains(event.target) || wm.owns(event.target) || overlay || usageView?.isOpen || event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
		if (event.detail > 1) return; // a double or triple click chooses a word or a line
		requestAnimationFrame(() => { if (!getSelection()?.toString()) input.focus({ preventScroll: true }); });
	});
	containChoosing(document);
	document.addEventListener('keydown', event => {
		if (wm.owns(document.activeElement) || overlay || usageView?.isOpen || document.activeElement === input || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
		if (!hooks.canFocus?.() || event.target.closest?.('input, textarea, select, [contenteditable="true"], .screen-panel')) return;
		input.focus();
	}, { capture: true });
	input.addEventListener('beforeinput', event => {
		if (event.inputType !== 'deleteContentBackward' && event.inputType !== 'deleteContentForward') return;
		const start = input.selectionStart ?? 0;
		const end = input.selectionEnd ?? start;
		const probe = event.inputType === 'deleteContentBackward' ? Math.max(0, start - 1) : start;
		const tokens = [...input.value.matchAll(/\b(?:image|audio) \d+\b\s?/g)];
		const hit = tokens.find(match => {
			const from = match.index;
			const to = from + match[0].length;
			return start !== end ? start < to && end > from : probe >= from && probe < to;
		});
		if (!hit) return;
		event.preventDefault();
		const token = hit[0].trim();
		const piece = attachments.find(item => item.token === token);
		piece?.controller?.abort();
		if (piece?.imageUrl) URL.revokeObjectURL(piece.imageUrl);
		if (piece) attachments.splice(attachments.indexOf(piece), 1);
		input.setRangeText('', hit.index, hit.index + hit[0].length, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		paintPending();
	});
	input.addEventListener('input', () => {
		// If a token is removed by a selection, cut, or replacement rather than a
		// single backspace, its hidden attachment must leave with it.
		for (const piece of [...attachments]) {
			if (!piece.token || tokenAt(input.value, piece.token) >= 0) continue;
			piece.controller?.abort();
			if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
			attachments.splice(attachments.indexOf(piece), 1);
		}
		saveDraft(); paintCaret(); paintPending();
	});
	// The session chords live where the sessions live. MOD+Up and MOD+Down
	// step through the tabs, and the view follows: the conversation comes
	// into view with the keys.
	const sessionStep = step => { if (cycleTab(step)) wm.bring(); };
	registerKeyBinding({ label: `${MOD}+↑`, description: 'previous session', code: 'ArrowUp', mod: true, when: event => !event || !keysHeld(), handler: () => sessionStep(-1) });
	registerKeyBinding({ label: `${MOD}+↓`, description: 'next session', code: 'ArrowDown', mod: true, when: event => !event || !keysHeld(), handler: () => sessionStep(1) });
	for (let n = 1; n <= 5; n++) registerKeyBinding({ label: `${MOD}+${n}`, description: `session ${n} in the rail`, code: `Digit${n}`, mod: true, handler: () => enterNthTab(n) });
	registerKeyBinding({ label: `${MOD}+Space`, description: 'start a new session', code: 'Space', mod: true, handler: () => newTab().catch(fail) });
	registerKeyBinding({ label: `${MOD}+R`, description: 'record into the message (again to stop)', code: 'KeyR', mod: true, handler: () => voice.toggle() });
	// Before any reload: drafts of every conversation, the tab and the open
	// windows are kept, and come back after it.
	function prepareReload() {
		try {
			saveDraft();
			for (const [key, draft] of queueDrafts) if (key !== editorKey(state) && draft.text) localStorage.setItem(draftKey(key), draft.text);
			// The one layout's windows.
			const windows = wm.list().map(win => ({ kind: win.kind, at: win.kind === 'files' ? workbench.where() : pages.at(win) }));
			sessionStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify({ tabId: focusedTabId(), owner: ownerKey(selectedOwner), windows, order: wm.order(), layout: wm.tiling(), oneLayout: true }));
		} catch {}
		try { if (promptRetries.size) sessionStorage.setItem(PROMPT_RETRIES_KEY, JSON.stringify([...promptRetries])); } catch {}
	}
	// The desktop window's webview has no reload of its own; this is it, and
	// what was open comes back as it does after a new version.
	registerKeyBinding({ label: 'Ctrl+R', description: 'reload the window', code: 'KeyR', ctrl: true, handler: () => { prepareReload(); location.reload(); } });
	if (globalThis.imperfectDesk) {
		registerKeyBinding({ label: 'Ctrl+T', description: 'open a browser tab', code: 'KeyT', ctrl: true, handler: () => pages.newTab() });
		registerKeyBinding({ label: 'Ctrl+W', description: 'close the browser tab', code: 'KeyW', ctrl: true, when: () => ['browser', 'live'].includes(wm.focused()?.kind), handler: () => pages.closeFront() });
	}
	// The windows' keys (MOD is Super in the desktop window, Alt in a browser:
	// pi-card.js). MOD+W closes what is under the pointer, or failing
	// that what has the keys: in the browser the tab in front (the last takes
	// the browser with it); never Workbench or the conversation. MOD+Left and
	// MOD+Right bring the next window out of sight on that side into view
	// with the keys (windows.js navigate), without wrapping or reordering;
	// MOD+Up and MOD+Down are the session before and after. MOD+L tiles the
	// windows the other way (scrolling, dwindle). MOD held, a window can be
	// dragged to another's place (hold and release: the desktop window says
	// when MOD goes down and up inside a website). MOD+F
	// has the focused window fill the canvas, and back; in focus, the
	// conversation or the panel fills the whole window (Escape back too). With
	// another window full, MOD+Shift+Enter lays the agents' strip and the input
	// bar over it, and takes them away (Escape too); focus has neither it nor
	// MOD+Shift+F. MOD+Shift+Left and MOD+Shift+Right
	// move every window one slot along, bringing another into the focused
	// one. Electron hears them inside websites and pages too, and sends them here
	// (desktop/electron/main.mjs).
	const windowKeys = {
		newTab: () => pages.newTab(),
		closeTab: () => pages.closeFront(),
		browser: () => pages.launch(),
		close: () => wm.closeHovered() || wm.closeAt(document.activeElement),
		previous: () => wm.navigate(-1),
		next: () => wm.navigate(1),
		up: () => sessionStep(-1),
		down: () => sessionStep(1),
		full: () => wm.full(),
		fullWindow: () => wm.fullWindow(),
		restoreFullWindow: () => wm.restoreFullWindow(),
		over: () => wm.over(),
		back: () => wm.rotate(-1),
		along: () => wm.rotate(1),
		layout: () => wm.layout(),
		hold: () => wm.grab(true),
		release: () => wm.grab(false),
		clipboard: () => clipHistory.toggle(),
		...Object.fromEntries([1, 2, 3, 4, 5].map(n => [`session${n}`, () => enterNthTab(n)])),
	};
	globalThis.imperfectDesk?.onKey(key => { if (key === 'release' || !keysHeld()) windowKeys[key]?.(); });
	// The page listener serves projects on an isolated origin. Accept only
	// this narrow chord from the frame actually holding the keyboard, never
	// a background tab or another window's message. In the desktop window
	// Electron hears the chord before any frame does: a frame saying Alt
	// there is Alt, which imperfect leaves alone under sway.
	addEventListener('message', event => {
		const type = event.data?.type;
		const launch = type === 'imperfect-browser-launch';
		if (globalThis.imperfectDesk || (!launch && (!['imperfect-pane-step', 'imperfect-session-step'].includes(type) || ![-1, 1].includes(event.data.step))) || keysHeld()) return;
		const frame = document.activeElement;
		if (frame?.localName !== 'iframe' || frame.contentWindow !== event.source || !frame.closest('.wm-window')) return;
		if (launch) pages.launch();
		else if (type === 'imperfect-session-step') sessionStep(event.data.step);
		else wm.navigate(event.data.step);
	});
	// imperfect-open again, with this window already open (desktop/electron/main.mjs):
	// Workbench at the folder asked for, or a new session, as MOD+Space starts one.
	// A file or folder from the Mac's Finder or Dock (here) is this computer's.
	globalThis.imperfectDesk?.onOpen?.(({ face, path, here }) => face === 'files' ? openFiles(path || '', here ? { base: '' } : {}) : newTab().catch(fail));
	registerKeyBinding({ label: `${MOD}+Shift+B`, description: 'open or reveal the browser', code: 'KeyB', mod: true, shift: true, consumeRepeat: true, when: () => !keysHeld(), handler: windowKeys.browser });
	registerKeyBinding({ label: `${MOD}+${MOD === 'Super' ? 'Shift+' : ''}V`, description: 'what was copied, to copy again', code: 'KeyV', mod: true, shift: MOD === 'Super', when: event => clipHistory.available() && (!event || clipHistory.isOpen() || systemControls.isOpen() || !keysHeld()), handler: windowKeys.clipboard });
	registerKeyBinding({ label: `${MOD}+W`, description: 'close the browser tab in front, or the window under the pointer', code: 'KeyW', mod: true, handler: windowKeys.close });
	registerKeyBinding({ label: `${MOD}+←`, description: 'the next window out of sight on the left, with the keys', code: 'ArrowLeft', mod: true, consumeRepeat: true, when: event => !event || !keysHeld(), handler: windowKeys.previous });
	registerKeyBinding({ label: `${MOD}+→`, description: 'the next window out of sight on the right, with the keys', code: 'ArrowRight', mod: true, consumeRepeat: true, when: event => !event || !keysHeld(), handler: windowKeys.next });
	registerKeyBinding({ label: `${MOD}+L`, description: 'tile the windows focus, scrolling or dwindle', code: 'KeyL', mod: true, when: event => !event || !keysHeld(), handler: windowKeys.layout });
	registerKeyBinding({ label: `${MOD}+F`, description: 'focused window full screen, and back', code: 'KeyF', mod: true, handler: windowKeys.full });
	// Last, after anything nearer that wants Escape (a menu, a file open in Files).
	registerKeyBinding({ label: 'Esc', description: 'leave full screen', code: 'Escape', late: true, when: () => Boolean(wm.zoomed()) && !keysHeld(), handler: windowKeys.full });
	registerKeyBinding({ label: `${MOD}+Shift+F`, description: 'focused browser or Files covers the input bar, and back', code: 'KeyF', mod: true, shift: true, consumeRepeat: true, when: () => (phone() || wm.tiling() !== 'focus') && !keysHeld(), handler: windowKeys.fullWindow });
	registerKeyBinding({ label: 'Esc', description: 'restore the full-window pane', code: 'Escape', when: () => wm.fullWindowed() && !keysHeld(), handler: event => { event?.stopImmediatePropagation(); windowKeys.restoreFullWindow(); } });
	registerKeyBinding({ label: `${MOD}+Shift+Enter`, description: 'the agents and the input bar over a full-screen window, and away', code: 'Enter', mod: true, shift: true, when: () => wm.tiling() !== 'focus', handler: windowKeys.over });
	registerKeyBinding({ label: 'Esc', description: 'the agents and the input bar away', code: 'Escape', when: () => wm.overlaid() && !keysHeld(), handler: windowKeys.over });
	registerKeyBinding({ label: `${MOD}+Shift+←`, description: 'move the windows one place back', code: 'ArrowLeft', mod: true, shift: true, handler: windowKeys.back });
	registerKeyBinding({ label: `${MOD}+Shift+→`, description: 'move the windows one place along', code: 'ArrowRight', mod: true, shift: true, handler: windowKeys.along });
	// Up in an empty input bar takes the latest steering back to edit, as in
	// a chat; a line of it can also be clicked.
	registerKeyBinding({
		label: '↑', description: 'edit latest queued prompt (input bar empty)', code: 'ArrowUp', target: input,
		when: event => !event || (!input.value && !attachments.length && Boolean(state?.queue?.items?.length) && !overlay),
		handler: () => takeQueue({ latest: true }),
	});
	registerKeyBinding({
		label: 'Ctrl+C', description: 'interrupt a running turn', code: 'KeyC', ctrl: true, target: input,
		when: () => Boolean(state?.busy), handler: () => {
			const origin = editorKey(state);
			sessionCommand()('abort').then(q => applyQueue(q, origin)).catch(fail);
		},
	});
	registerKeyBinding({
		label: 'Esc', description: 'collapse the agents', code: 'Escape',
		// The desktop's sidebar stays; a phone's sheet goes, as choosing in it does.
		when: () => !railCollapsed && !overlay && (!railSidebar() || phone()),
		handler: () => setRailCollapsed(true),
	});
	registerKeyBinding({
		// One Escape, in the order a person means it: cancel what is being
		// chosen, close what is open, then stop the turn; with none of them,
		// it is left to whatever else wants it (leaving full screen).
		label: 'Esc', description: 'close or interrupt the agent', code: 'Escape', target: input,
		when: () => Boolean(overlay) || (railCollapsed && Boolean(choosing || state?.busy)),
		handler: () => {
			if (cancelChoosing()) return;
			if (overlay) { closeDialog(true); return; }
			if (state?.busy) {
				const origin = editorKey(state);
				sessionCommand()('abort').then(q => applyQueue(q, origin)).catch(fail); return;
			}
		},
	});
	// Every submission steers at the next step, or starts an idle agent.
	registerKeyBinding({
		label: 'Enter', description: 'send, or steer while working', code: 'Enter', target: input,
		when: event => !event?.isComposing && !overlay, handler: () => submit(),
	});
	registerKeyBinding({
		label: `${MOD}+Enter`, description: 'send, or steer while working', code: 'Enter', mod: true, target: input,
		when: event => !event?.isComposing && !overlay,
		handler: () => submit(),
	});
	// The model name in the input bar opens the model box.
	modelName.onclick = () => { chooseModel().catch(fail); };

	// Where the person is: a window they use says so, to every computer it is
	// connected to, so an agent's browser opens where they are (browser.mjs).
	// Real use only, not being connected; at most every few seconds, saying
	// how long ago, so the latest use wins. Only a window that takes
	// websites: the desktop window, and the phone app.
	const surface = globalThis.imperfectDesk ? 'desktop' : globalThis.imperfectNative ? 'phone' : '';
	let usedAt = 0, toldAt = 0, telling = 0;
	function tellHere(owner) {
		if (surface && hereOwner()) ownerCommand(owner, 'here', { machine: hereOwner(), kind: surface, ago: Date.now() - usedAt }).catch(() => {});
	}
	function used() {
		if (!surface || document.hidden) return;
		usedAt = Date.now();
		telling ||= setTimeout(() => {
			telling = 0; toldAt = Date.now();
			for (const [owner, transport] of transports) if (transport.socket?.readyState === WebSocket.OPEN) tellHere(owner);
		}, Math.max(0, toldAt + 5000 - usedAt));
	}
	for (const type of ['keydown', 'pointerdown', 'wheel']) addEventListener(type, used, { capture: true, passive: true });
	addEventListener('focus', used);
	document.addEventListener('visibilitychange', used);
	addEventListener('pointerdown', unlockDoneSound);
	addEventListener('keydown', unlockDoneSound);
	addEventListener('resize', () => { if (socket?.readyState === WebSocket.OPEN) hello(); });
	// A tab left open in the background is not somebody using a computer, but it holds the socket
	// open, and the control plane reads an open socket as "in use" and keeps the machine awake --
	// which is how a forgotten tab bills a whole night. So a hidden tab lets go after a while and
	// reconnects the moment it is looked at again. Never mid-turn: the agent is doing work
	// somebody is waiting on, and dropping the socket there would abandon its output.
	const IDLE_TAB_MS = 5 * 60 * 1000;
	let hiddenTimer;
	function releaseIfStillHidden() {
		if (!document.hidden) return;
		if (state?.busy) { hiddenTimer = setTimeout(releaseIfStillHidden, 30_000); return; }
		try { socket?.close(1000, 'tab hidden'); } catch {}
	}
	// Looked at again: the window shown, the computer awake, the network back,
	// the phone app in front. What is on screen may be old and its socket dead
	// without knowing it (a phone's network goes with its screen, and TCP takes
	// minutes to say so). So every socket is asked at once, a dead one is
	// replaced, and the view is marked stale until it is shown to be current
	// (refreshView), whichever computer it is on; nothing waits for a timeout.
	//
	// Away for longer than the computer waits for an answer to its ping
	// (server.mjs: half a minute), a socket over the network has been dropped
	// at the far end whatever it reads here: it is replaced without asking.
	// On this computer's own desk it is asked all the same; that costs nothing.
	const ASLEEP_MS = 25_000, TICK_MS = 5000;
	let resumedAt = 0, hiddenSince = document.hidden ? Date.now() : 0, tickAt = Date.now();
	// A page frozen with its app (a phone's screen off) misses its ticks.
	setInterval(() => { tickAt = Date.now(); }, TICK_MS);
	function resume({ force = false } = {}) {
		if (document.hidden) return;
		// A desk window's focus comes and goes all day: once a second is plenty.
		if (!force && Date.now() - resumedAt < 1000) return;
		const now = resumedAt = Date.now();
		const away = Math.max(hiddenSince ? now - hiddenSince : 0, now - tickAt - TICK_MS);
		hiddenSince = 0; tickAt = now;
		void refreshMachines();
		// Doubted first: an answer to a question asked from here on is
		// evidence from after the doubt began (freshness.js), even within
		// the same millisecond's tick. A session asked for and not yet come
		// is still what is wanted.
		const doubt = freshness.state;
		if (doubt.phase !== 'fresh' && (doubt.want || switching)) freshness.stale({ owner: doubt.owner, want: doubt.want, restart: true });
		else doubtOwner(selectedOwner, { restart: true });
		// Each open socket is asked, the one a switch waits on included: a dead
		// one fails what waits on it at once, rather than in half a minute.
		for (const [owner, transport] of transports) {
			if (transport.socket?.readyState === WebSocket.OPEN && away >= ASLEEP_MS && !localDesktop()) transport.close();
			if (transport.socket?.readyState === WebSocket.OPEN) void transport.check({ fields: owner === LOCAL ? helloFields() : { kind: 'viewer', visible: !launchPhone } });
			else if (owner === selectedOwner || owner === LOCAL || machineRows.some(m => m.id === owner && m.reachable)) transport.connect();
		}
	}
	document.addEventListener('visibilitychange', () => {
		clearTimeout(hiddenTimer);
		if (document.hidden) { hiddenSince ||= Date.now(); hiddenTimer = setTimeout(releaseIfStillHidden, IDLE_TAB_MS); return; }
		resume({ force: true });
	});
	addEventListener('focus', () => resume());
	addEventListener('online', () => resume({ force: true }));
	addEventListener('pageshow', () => resume({ force: true }));
	// The phone app (MainActivity.kt) and the desktop window (main.mjs) say so
	// too: a WebView's page does not always hear its app come back, nor a desk
	// window its computer wake.
	globalThis.imperfectResume = () => resume({ force: true });
	globalThis.imperfectDesk?.onResume?.(() => resume({ force: true }));
	mountAssembly({ apply: step => {
		assemblyStep = step;
		document.documentElement.dataset.assemblyStep = step;
		// This is a client-side blank page even when the computer has sessions.
		// Opening it never focuses, creates or changes a server-side tab.
		if (!choosing) choosing = { owner: hereOwner() || null, index: 0, auto: false, harnesses: null, agent: null, launch: true };
		if (!launchPhone && ASSEMBLY_STEPS.indexOf(step) >= ASSEMBLY_STEPS.indexOf('files') && !assemblyFiles) {
			assemblyFiles = true;
			void workbench.open('', { base: '', quiet: true });
			sidebarHooks.showFiles();
		}
		if (!launchPhone && ASSEMBLY_STEPS.indexOf(step) >= ASSEMBLY_STEPS.indexOf('browser') && !assemblyBrowser) {
			assemblyBrowser = true;
			void pages.assembleBrowser().catch(fail);
		}
		render();
	} });
	let assemblyFiles = false, assemblyBrowser = false;
	mountLaunchOpen({ open: url => pages.openShop(url), canOpen: () => assemblyStep === 'done', onError: fail });
	connect();

	function reloadSafe() {
		return !switching && !foregroundRequests && !attachmentProcessing && !promptAccepting && !queueTaking && !creating
			&& !voice.holding() && !workbench.unsaved()
			&& attachments.length === 0 && ![...queueDrafts.values()].some(draft => draft.attachments.length);
	}

	return {
		submit,
		ready: Promise.all([snapshotReady, refreshMachines()]),
		// Workbench, at a folder if one is named (a face=files window, or
		// a folder opened from elsewhere).
		openFiles,
		// MOD+Shift+F: Workbench focused.
		showFiles,
		// A project's page, as its preview in Workbench opens it.
		openProject: (name, base) => pages.project(name, { base }),
		guiSnapshot,
		showSession,
		composerStatus: () => ({ attachments: attachments.length }),
		// A new version reloads the window as soon as nothing is in flight. What
		// the person had open comes back (prepareSurfaceReload): drafts are kept
		// per conversation already, and the tab and the open windows are kept here.
		// Picked files hold it, since they live only here, and so does a
		// recording the mic holds (being made, being sent, or not sent), and a
		// file being edited in Files until what was typed is saved.
		surfaceReloadSafe: reloadSafe,
		prepareSurfaceReload: () => prepareReload(),
		newTab,
		closeTab: (tabId, extra = {}) => (switching || disconnectedOwners.has(selectedOwner) ? Promise.reject(new Error('Execution selection unavailable; choose a session first')) : closeSession(tabId, selectedOwner, extra)),
		// The fold the rail's chevron drives, so a key can reach it too.
		toggleRail: () => setRailCollapsed(!railCollapsed),
		attachFiles,
	};
}
