// This computer's controls (system/controls.mjs): at a glance at the top
// centre of the screen, beside the clock, its Wi-Fi and battery; pressed, one
// small panel under the band, centred under them, with Wi-Fi, Bluetooth,
// sound, the screen's brightness, the battery and power. Always this window's
// own computer, the one whose screen this is: the request is never routed to
// another computer, and the computer refuses it from anywhere but its own
// screen, so on the phone, a hosted computer or a computer without these
// tools nothing here is drawn at all.

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};
const button = (text, className, onclick, label) => {
	const node = el('button', text, className);
	node.type = 'button';
	if (label) node.setAttribute('aria-label', label);
	node.onclick = onclick;
	return node;
};
export const signalBars = signal => (signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : signal > 0 ? 1 : 0);
// Wi-Fi and the battery as a Mac's menu bar draws them (Noah: in the new
// style), drawn in the ink: what is not there yet is the ink, faint.
function drawn(width, height, parts, className) {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('system-icon', className);
	for (const [tag, attributes, faint] of parts) {
		const node = document.createElementNS(SVG, tag);
		for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
		if (faint) node.setAttribute('opacity', '0.3');
		svg.append(node);
	}
	return svg;
}
// A fan of three arcs over a dot, lit from the dot out as the signal is.
const ARC = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' };
const wifiIcon = (bars, className = 'system-wifi-icon') => drawn(16, 12, [
	['circle', { cx: 8, cy: 10.4, r: 1.35, fill: 'currentColor' }, bars < 1],
	['path', { ...ARC, d: 'M5.4 7.8a3.7 3.7 0 0 1 5.2 0' }, bars < 2],
	['path', { ...ARC, d: 'M3.25 5.65a6.7 6.7 0 0 1 9.5 0' }, bars < 3],
	['path', { ...ARC, d: 'M1.1 3.5a9.75 9.75 0 0 1 13.8 0' }, bars < 4],
], className);
// A rounded cell, its outline and cap faint, filled as it is charged, and a
// bolt across it on the mains.
function batteryIcon(percent, plugged) {
	const fill = Math.max(1.5, 17 * Math.min(100, Math.max(0, percent)) / 100);
	return drawn(24, 12, [
		['rect', { x: 0.75, y: 0.75, width: 20.5, height: 10.5, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.4 }],
		['path', { d: 'M22.4 4.2c.8.2 1.3.9 1.3 1.8s-.5 1.6-1.3 1.8z', fill: 'currentColor', opacity: 0.4 }],
		['rect', { x: 2.5, y: 2.5, width: fill.toFixed(1), height: 7, rx: 1.6, fill: 'currentColor' }],
		...(plugged ? [['path', { d: 'M12.4 1.2 7.6 6.6h3l-1 4.2 4.8-5.4h-3z', fill: 'currentColor', stroke: 'var(--surface, #000)', 'stroke-width': 0.9, 'paint-order': 'stroke' }]] : []),
	], 'system-battery-icon');
}
export const minutesText = minutes => (!Number.isFinite(minutes) || minutes <= 0 ? '' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`);
export function batteryText(battery) {
	if (!battery) return '';
	const words = [`${battery.percent}%`];
	if (battery.charging) words.push('charging', minutesText(battery.timeToFull) && `${minutesText(battery.timeToFull)} to full`);
	else if (battery.plugged) words.push('plugged in');
	else words.push(minutesText(battery.timeToEmpty) && `${minutesText(battery.timeToEmpty)} left`);
	return words.filter(Boolean).join(' · ');
}
export const applies = state => Boolean(state && ['wifi', 'bluetooth', 'sound', 'brightness', 'battery', 'power'].some(key => state[key]));

// A panel of the screen's status group hangs from the band's lower edge,
// centred under the group, no gap, down to the input bar at most; a window
// too narrow for it gets one the whole width.
export function hang(panel, { anchor, band, width = 380 }) {
	const group = anchor.getBoundingClientRect();
	const heading = band.querySelector('.session-rail-heading')?.getBoundingClientRect();
	const top = Math.round(heading?.bottom || group.bottom + 44);
	const bottom = document.querySelector('#entry-terminal > .entry-status')?.getBoundingClientRect().top || innerHeight;
	const full = innerWidth < width + 100;
	const w = full ? innerWidth : width;
	const left = full ? 0 : Math.max(0, Math.min(innerWidth - w, Math.round((group.left + group.right) / 2 - w / 2)));
	panel.classList.toggle('full', full);
	Object.assign(panel.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, maxHeight: `${Math.max(160, Math.round(bottom - top))}px` });
}

export function mountSystem({ anchor, band, fetcher = (...args) => fetch(...args) }) {
	// The whole group is the way in, the time as much as the glance.
	const status = button(null, 'system-status', null, 'This computer');
	status.hidden = true;
	status.setAttribute('aria-expanded', 'false');
	status.setAttribute('aria-haspopup', 'dialog');
	const panel = el('div', null, 'screen-panel system-panel');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-label', 'This computer');
	panel.hidden = true;
	document.body.append(panel);

	// refused: this page is not on the computer's own screen (the phone, a
	// hosted computer, another computer's window) or it has none of the tools;
	// that does not change while the page is open, so it stops asking.
	let state = null, open = false, timer = null, generation = 0, refused = false;
	let asking = '', confirming = '', busy = '', error = '', pressing = false, powerOnly = false;

	async function ask(full = open) {
		const mine = ++generation;
		try {
			const res = await fetcher(full ? '/system?panel=1' : '/system', { cache: 'no-store' });
			if (mine !== generation) return;
			if (res.status === 403 || res.status === 404) refused = true;
			// The screen locked (423) keeps what was last seen; the lock going asks again.
			if (res.status === 423) return;
			state = res.ok ? await res.json() : null;
			if (res.ok && !applies(state)) refused = true;
		} catch { if (mine === generation) state = null; }
		paintStatus();
		if (open) paintPanel();
	}
	async function act(body, label) {
		busy = label; error = ''; paintPanel(true);
		try {
			const res = await fetcher('/system', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const answer = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(answer.error || 'it did not work');
			if (!answer.done) state = answer;
		} catch (failure) { error = `${label}: ${failure.message}`; }
		busy = '';
		paintStatus();
		paintPanel(true);
	}
	const schedule = () => {
		clearTimeout(timer);
		if (document.hidden || refused) return;
		timer = setTimeout(async () => { await ask(); schedule(); }, open ? 4000 : 30_000);
	};

	function paintStatus() {
		const shown = applies(state);
		status.hidden = !shown;
		if (!shown) { if (open) close(); return; }
		const parts = [];
		const { wifi, battery } = state;
		if (wifi) {
			const on = wifi.enabled && wifi.hardware;
			// the icon alone (Noah): the network's name is in its title
			parts.push(wifiIcon(on && wifi.connected ? signalBars(wifi.signal ?? 100) : 0));
		}
		if (battery) {
			const holder = el('span', null, 'system-battery');
			holder.classList.toggle('low', Boolean(battery.low));
			holder.append(batteryIcon(battery.percent, battery.plugged), el('span', `${battery.percent}%`));
			parts.push(holder);
		}
		// Only sound or Bluetooth here: still a way in.
		if (!parts.length) parts.push(el('span', 'system', 'system-word'));
		const look = JSON.stringify([wifi && [wifi.enabled, wifi.connected, wifi.network, signalBars(wifi.signal ?? 100)], battery && [battery.percent, battery.plugged, battery.low]]);
		if (status.dataset.look !== look) { status.dataset.look = look; status.replaceChildren(...parts); }
		status.title = [wifi && (wifi.connected ? `Wi-Fi: ${wifi.network}` : 'Wi-Fi: not connected'), battery && `Battery: ${batteryText(battery)}`].filter(Boolean).join('\n');
	}

	/* ------------------------------------------------------------ panel */
	const section = (name, ...controls) => {
		const node = el('section', null, `system-section system-${name.replace(/\W/g, '')}`);
		const head = el('header', null, 'system-head');
		head.append(el('h2', name), ...controls.filter(Boolean));
		node.append(head);
		return node;
	};
	const toggle = (on, label, flip, text = on ? 'on' : 'off') => {
		const node = button(text, 'system-toggle', flip, label);
		node.setAttribute('aria-pressed', String(Boolean(on)));
		return node;
	};
	const row = (...children) => { const node = el('div', null, 'system-row'); node.append(...children.filter(Boolean)); return node; };
	const slider = (value, label, send, min = 0) => {
		const input = el('input', null, 'system-slider');
		Object.assign(input, { type: 'range', min: String(min), max: '100', step: '1', value: String(Math.round(value)) });
		input.setAttribute('aria-label', label);
		const shown = el('span', `${Math.round(value)}`, 'system-value');
		input.oninput = () => { shown.textContent = input.value; };
		input.onchange = () => send(Number(input.value));
		return [input, shown];
	};
	const chooser = (rows, label, pick) => {
		const select = el('select', null, 'system-select');
		select.setAttribute('aria-label', label);
		for (const item of rows) {
			const option = el('option', item.name);
			option.value = String(item.id);
			option.selected = item.default;
			select.append(option);
		}
		select.onchange = () => pick(Number(select.value));
		return select;
	};

	function wifiSection(wifi) {
		const on = wifi.enabled && wifi.hardware;
		const node = section('wi-fi', toggle(on, on ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on', () => act({ do: 'wifi-radio', on: !on }, on ? 'wi-fi off' : 'wi-fi on')));
		if (!wifi.hardware) node.append(row(el('span', 'switched off by the hardware switch', 'system-note')));
		if (!on) return node;
		const list = el('div', null, 'system-list');
		for (const network of wifi.networks ?? []) {
			const line = el('div', null, `system-item${network.active ? ' active' : ''}`);
			const name = button(null, 'system-name', () => {
				if (network.active) return;
				if (network.enterprise) { error = `${network.ssid}: needs a work or school login, not supported here`; paintPanel(true); return; }
				if (network.secured && !network.known) { asking = asking === network.ssid ? '' : network.ssid; paintPanel(true); panel.querySelector('.system-password')?.focus(); return; }
				act({ do: 'wifi-connect', ssid: network.ssid }, `joining ${network.ssid}`);
			}, network.active ? `${network.ssid}, connected` : `Join ${network.ssid}`);
			name.append(wifiIcon(signalBars(network.signal)), el('span', network.ssid, 'system-label'), el('span', network.active ? 'connected' : network.secured ? (network.known ? 'saved' : 'locked') : 'open', 'system-note'));
			line.append(name);
			if (network.active) line.append(button('disconnect', 'system-action', () => act({ do: 'wifi-disconnect' }, 'disconnecting')));
			if (network.known) line.append(button('forget', 'system-action', () => act({ do: 'wifi-forget', ssid: network.ssid }, `forgetting ${network.ssid}`)));
			list.append(line);
			if (asking === network.ssid) list.append(passwordRow(network.ssid));
		}
		if (!(wifi.networks ?? []).length) list.append(row(el('span', 'no networks found yet', 'system-note')));
		node.append(list, row(button('scan', 'system-action', () => act({ do: 'wifi-scan' }, 'scanning'))));
		return node;
	}
	// The password goes from this field to the computer and nowhere else: not
	// the input bar, not a draft, not a log. The field is emptied as it is sent.
	function passwordRow(ssid) {
		const form = el('form', null, 'system-row system-join');
		const field = el('input', null, 'system-password');
		Object.assign(field, { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'password' });
		field.setAttribute('autocapitalize', 'off');
		field.setAttribute('aria-label', `Password for ${ssid}`);
		const join = el('button', 'join', 'system-action');
		join.type = 'submit';
		form.append(field, join);
		// Pasted here, it is taken out of the clipboard's history (clipboard.mjs).
		field.addEventListener('paste', event => {
			const text = event.clipboardData?.getData('text/plain');
			if (text) fetcher('/clipboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'forget', text }) }).catch(() => {});
		});
		form.onsubmit = event => {
			event.preventDefault();
			const password = field.value;
			field.value = '';
			if (!password) return;
			asking = '';
			act({ do: 'wifi-connect', ssid, password }, `joining ${ssid}`);
		};
		return form;
	}

	function bluetoothSection(bt) {
		const node = section('bluetooth', toggle(bt.powered, bt.powered ? 'Turn Bluetooth off' : 'Turn Bluetooth on', () => act({ do: 'bluetooth-power', on: !bt.powered }, bt.powered ? 'bluetooth off' : 'bluetooth on')));
		if (!bt.powered) return node;
		const list = el('div', null, 'system-list');
		for (const device of bt.devices ?? []) {
			const line = el('div', null, `system-item${device.connected ? ' active' : ''}`);
			const name = el('span', null, 'system-name');
			name.append(el('span', device.name, 'system-label'), el('span', device.connected ? 'connected' : device.paired ? 'paired' : 'nearby', 'system-note'));
			line.append(name);
			const doing = (verb, label) => button(verb, 'system-action', () => act({ do: `bluetooth-${verb}`, address: device.address }, `${label} ${device.name}`));
			if (!device.paired) line.append(doing('pair', 'pairing'));
			else if (device.connected) line.append(doing('disconnect', 'disconnecting'));
			else line.append(doing('connect', 'connecting'));
			if (device.paired) line.append(doing('remove', 'removing'));
			list.append(line);
		}
		if (!(bt.devices ?? []).length) list.append(row(el('span', 'no devices yet', 'system-note')));
		node.append(list, row(button(bt.discovering || busy === 'looking for devices' ? 'scanning…' : 'scan', 'system-action', () => act({ do: 'bluetooth-scan' }, 'looking for devices'))));
		return node;
	}

	function soundSection(sound) {
		const node = section('sound');
		if (sound.output) {
			const mute = toggle(sound.output.muted, sound.output.muted ? 'Unmute output' : 'Mute output', () => act({ do: 'sound-mute', target: 'output', on: !sound.output.muted }, 'sound'), 'mute');
			node.append(row(el('span', 'out', 'system-key'), ...slider(sound.output.volume * 100, 'Output volume', value => act({ do: 'sound-volume', target: 'output', value: value / 100 }, 'volume')), mute));
		}
		if ((sound.outputs ?? []).length > 1) node.append(row(el('span', '', 'system-key'), chooser(sound.outputs, 'Output device', id => act({ do: 'sound-default', target: 'output', id }, 'output'))));
		if (sound.input) node.append(row(el('span', 'mic', 'system-key'), (sound.inputs ?? []).length ? chooser(sound.inputs, 'Input device', id => act({ do: 'sound-default', target: 'input', id }, 'mic')) : el('span', '', 'system-label'),
			toggle(sound.input.muted, sound.input.muted ? 'Unmute microphone' : 'Mute microphone', () => act({ do: 'sound-mute', target: 'input', on: !sound.input.muted }, 'mic'), 'mute')));
		return node;
	}

	function powerSection() {
		const node = section('power');
		const words = { suspend: 'sleep', reboot: 'restart', poweroff: 'shut down' };
		if (confirming) {
			node.append(row(el('span', `${words[confirming]} now?`, 'system-label'),
				button(words[confirming], 'system-action system-danger', () => { const what = confirming; confirming = ''; act({ do: what }, words[what]); }),
				button('cancel', 'system-action', () => { confirming = ''; paintPanel(true); })));
			return node;
		}
		node.append(row(
			button('lock', 'system-action', () => act({ do: 'lock' }, 'lock')),
			button('sleep', 'system-action', () => { confirming = 'suspend'; paintPanel(true); }),
			button('restart', 'system-action', () => { confirming = 'reboot'; paintPanel(true); }),
			button('shut down', 'system-action', () => { confirming = 'poweroff'; paintPanel(true); })));
		return node;
	}

	function paintPanel(force = false) {
		if (!open || !state) return;
		// Not under a hand: a slider being dragged, a password being typed.
		const active = document.activeElement;
		if (!force && (pressing || (panel.contains(active) && active.matches('input, select')))) return;
		const parts = [];
		if (!powerOnly && state.wifi) parts.push(wifiSection(state.wifi));
		if (!powerOnly && state.bluetooth) parts.push(bluetoothSection(state.bluetooth));
		if (!powerOnly && state.sound) parts.push(soundSection(state.sound));
		if (!powerOnly && state.brightness) {
			const node = section('screen');
			node.append(row(el('span', 'light', 'system-key'), ...slider(state.brightness.percent, 'Screen brightness', percent => act({ do: 'brightness', percent }, 'brightness'), 1)));
			parts.push(node);
		}
		if (!powerOnly && state.battery) {
			const node = section('battery', el('span', batteryText(state.battery), `system-note${state.battery.low ? ' low' : ''}`));
			parts.push(node);
		}
		if (state.power) parts.push(powerSection());
		const line = el('p', busy ? `${busy}…` : error, `system-line${error && !busy ? ' error' : ''}`);
		line.hidden = !busy && !error;
		line.setAttribute('aria-live', 'polite');
		parts.push(line);
		panel.replaceChildren(...parts);
		place();
	}
	function place() {
		if (open) hang(panel, { anchor, band });
	}
	function show() {
		powerOnly = false;
		open = true; error = ''; confirming = ''; asking = '';
		panel.hidden = false;
		status.setAttribute('aria-expanded', 'true');
		paintPanel(true);
		ask(true).then(() => { if (open && state?.wifi?.enabled) fetcher('/system', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'wifi-scan' }) }).then(res => res.ok && res.json()).then(next => { if (next && open) { state = next; paintPanel(); } }).catch(() => {}); });
		schedule();
	}
	function close() {
		open = false; asking = ''; confirming = '';
		panel.hidden = true;
		panel.replaceChildren();
		status.setAttribute('aria-expanded', 'false');
		schedule();
	}
	panel.addEventListener('pointerdown', () => { pressing = true; });
	addEventListener('pointerup', () => { pressing = false; }, true);
	addEventListener('pointercancel', () => { pressing = false; }, true);
	anchor.addEventListener('click', () => { if (!status.hidden) (open ? close() : show()); });
	addEventListener('pointerdown', event => { if (open && !panel.contains(event.target) && !anchor.contains(event.target)) close(); }, true);
	// Escape steps back: out of a password or a question, then the panel shut.
	addEventListener('keydown', event => {
		if (!open || event.key !== 'Escape') return;
		event.stopPropagation(); event.preventDefault();
		if (asking || confirming) { asking = ''; confirming = ''; paintPanel(true); return; }
		close();
		if (!status.hidden) status.focus({ preventScroll: true });
	}, true);
	addEventListener('resize', place);
	document.addEventListener('visibilitychange', () => { if (document.hidden || refused) clearTimeout(timer); else ask().then(schedule); });

	ask(false).then(schedule);
	// imperfect OS's screen lock (preload.cjs onLock): the moment it goes, Wi-Fi and battery are asked for again.
	let wasLocked = false;
	globalThis.imperfectDesk?.onLock?.(lock => {
		if (wasLocked && !lock && !refused) ask().then(schedule);
		wasLocked = Boolean(lock);
	});
	return { status, panel, refresh: () => ask(), isOpen: () => open, close,
		showPower: () => {
			powerOnly = true; open = true; error = ''; confirming = ''; asking = '';
			panel.hidden = false; status.setAttribute('aria-expanded', 'true');
			paintPanel(true); ask(true).then(() => paintPanel(true)); schedule();
		},
	};
}
