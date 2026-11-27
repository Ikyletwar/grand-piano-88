(() => {
  'use strict';

  // Konstanta instrumen: A0 = MIDI 21, C8 = MIDI 108.
  const MIDI_MIN = 21;
  const MIDI_MAX = 108;
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SAMPLE_NAMES = [
    ...Array.from({ length: 8 }, (_, i) => `A${i}`),
    ...Array.from({ length: 8 }, (_, i) => `C${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `Ds${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `Fs${i + 1}`)
  ];
  const SOURCES = [
    { name: 'mirror lokal', base: './samples/', local: true },
    { name: 'tonejs.github.io', base: 'https://tonejs.github.io/audio/salamander/' },
    { name: 'jsdelivr', base: 'https://cdn.jsdelivr.net/gh/Tonejs/audio@master/salamander/' }
  ];
  // Urutan huruf mengikuti posisi fisik keyboard: q paling kiri, m paling kanan.
  const LETTER_SEQUENCE = [
    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
    'z', 'x', 'c', 'v', 'b', 'n', 'm'
  ];
  const LETTER_SET = new Set(LETTER_SEQUENCE);
  const DEFAULT_SOURCE = 'local';

  const el = {
    status: document.getElementById('status'),
    statusText: document.getElementById('statusText'),
    loadBar: document.getElementById('loadBar'),
    retryBtn: document.getElementById('retryBtn'),
    helpBtn: document.getElementById('helpBtn'),
    helpPanel: document.getElementById('helpPanel'),
    labelToggle: document.getElementById('labelToggle'),
    reverbToggle: document.getElementById('reverbToggle'),
    volume: document.getElementById('volume'),
    demoBtn: document.getElementById('demoBtn'),
    pedalBtn: document.getElementById('pedalBtn'),
    octDown: document.getElementById('octDown'),
    octUp: document.getElementById('octUp'),
    octLabel: document.getElementById('octLabel'),
    keysScroll: document.getElementById('keysScroll'),
    keys: document.getElementById('keys'),
    scrollControl: document.getElementById('scrollControl'),
    scrollRange: document.getElementById('scrollRange'),
    toast: document.getElementById('toast'),
    midiChip: document.getElementById('midiChip'),
    midiChipText: document.getElementById('midiChipText'),
    midiBtn: document.getElementById('midiBtn'),
    midiControls: document.getElementById('midiControls'),
    midiInput: document.getElementById('midiInput'),
    midiChannel: document.getElementById('midiChannel'),
    midiPanicBtn: document.getElementById('midiPanicBtn'),
    midiNote: document.getElementById('midiNote')
  };

  const keyEls = new Map();
  const voices = new Map();
  const sustained = new Map();
  const activePointers = new Map();
  const heldKeys = new Map();
  const shortcutByMidi = new Map();
  const heldNotes = new Set();
  const noteOwners = new Map();
  const ownersByMidi = new Map();
  const keyHeldBy = new Map();
  const clickTimers = new Map();

  const midi = {
    access: null,
    enabled: false,
    pending: false,
    inputId: 'all',
    channel: 'omni',
    inputs: new Map(),
    channelSustain: new Map(),
    bend: new Map(),
    volume: 1,
    expression: 1,
    noteTimer: null
  };

  let ctx = null;
  let voiceBus = null;
  let dryGain = null;
  let wetGain = null;
  let masterGain = null;
  let midiVolumeGain = null;
  let buffers = new Map();
  let sampleList = [];
  let ready = false;
  let loading = false;
  let sustainOn = false;
  let view = '88';
  let baseMidi = 48;
  let focusedMidi = 60;
  let enterMidi = null;
  let demoTimers = [];
  let demoPlaying = false;
  let pedalBeforeDemo = false;
  let toastTimer = null;
  let lastNotReadyToast = 0;
  let letterMaps = { whiteMap: new Map(), blackMap: new Map() };

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function midiToName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function noteToMidi(name) {
    const match = /^([A-G])(#?)(-?\d+)$/.exec(name);
    if (!match) return null;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
    return base + (match[2] ? 1 : 0) + (Number(match[3]) + 1) * 12;
  }

  function midiFromSample(name) {
    const match = /^([A-G])(s?)(-?\d+)$/.exec(name);
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
    return base + (match[2] ? 1 : 0) + (Number(match[3]) + 1) * 12;
  }

  function isWhite(midi) {
    return ![1, 3, 6, 8, 10].includes(midi % 12);
  }

  function buildLetterMaps() {
    const whiteMap = new Map();
    const blackMap = new Map();
    let midi = baseMidi;
    for (const letter of LETTER_SEQUENCE) {
      while (midi <= MIDI_MAX && !isWhite(midi)) midi += 1;
      if (midi > MIDI_MAX) break;
      whiteMap.set(letter, midi);

      const right = midi + 1;
      const left = midi - 1;
      let black = null;
      if (right <= MIDI_MAX && !isWhite(right)) black = right;
      else if (left >= MIDI_MIN && !isWhite(left)) black = left;
      blackMap.set(letter, black);
      midi += 1;
    }
    return { whiteMap, blackMap };
  }

  function setStatus(text, state, progress = 0) {
    el.statusText.textContent = text;
    el.status.classList.toggle('is-ready', state === 'ready');
    el.status.classList.toggle('is-error', state === 'error');
    el.loadBar.style.width = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
    el.retryBtn.hidden = state !== 'error';
  }

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3600);
  }

  function buildImpulse(seconds = 1.7, decay = 2.8) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function ensureAudio() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setStatus('Web Audio API tidak tersedia', 'error');
      return false;
    }
    ctx = new AudioContextClass();

    voiceBus = ctx.createGain();
    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    masterGain = ctx.createGain();
    midiVolumeGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    const compressor = ctx.createDynamicsCompressor();

    convolver.buffer = buildImpulse();
    dryGain.gain.value = 0.96;
    wetGain.gain.value = el.reverbToggle.checked ? 0.13 : 0;
    masterGain.gain.value = (Number(el.volume.value) / 100) * 0.9;
    midiVolumeGain.gain.value = midi.volume * midi.expression;
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;

    voiceBus.connect(dryGain).connect(masterGain);
    voiceBus.connect(convolver).connect(wetGain).connect(masterGain);
    masterGain.connect(midiVolumeGain).connect(compressor).connect(ctx.destination);

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  function availableSources() {
    const sources = SOURCES.filter(source => !(source.local && location.protocol === 'file:'));
    return sources.length ? sources : SOURCES.filter(source => !source.local);
  }

  async function loadSamples() {
    if (loading) return;
    loading = true;
    ready = false;
    setStatus('Menyiapkan audio…', 'loading', 0);
    if (!ensureAudio()) { loading = false; return; }

    // Coba mirror lokal lebih dulu; setiap file otomatis jatuh ke CDN bila gagal.
    const preferred = availableSources();
    const queue = [...SAMPLE_NAMES];
    const failed = [];
    let done = 0;

    async function worker() {
      while (queue.length) {
        const name = queue.shift();
        let loaded = false;
        for (const source of preferred) {
          try {
            const response = await fetch(`${source.base}${name}.mp3`, { cache: 'force-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            const buffer = await ctx.decodeAudioData(bytes);
            buffers.set(midiFromSample(name), buffer);
            loaded = true;
            break;
          } catch (_) { /* c sumber cadangan */ }
        }
        if (!loaded) failed.push(name);
        done += 1;
        setStatus(`Memuat sample ${done}/${SAMPLE_NAMES.length}…`, 'loading', done / SAMPLE_NAMES.length);
      }
    }

    await Promise.all(Array.from({ length: 6 }, worker));
    if (failed.length) {
      setStatus(`Gagal memuat ${failed.length} sample`, 'error');
      loading = false;
      return;
    }

    sampleList = [...buffers.entries()]
      .map(([midi, buffer]) => ({ midi, buffer }))
      .sort((a, b) => a.midi - b.midi);
    ready = true;
    loading = false;
    setStatus(`Siap · ${sampleList.length} sample${navigator.onLine ? '' : ' · offline'}`, 'ready');
  }

  function nearestSample(midi) {
    let best = null;
    let distance = Infinity;
    for (const sample of sampleList) {
      const current = Math.abs(sample.midi - midi);
      if (current < distance) { distance = current; best = sample; }
    }
    return best;
  }

  function showNotReadyToast() {
    const now = performance.now();
    if (now - lastNotReadyToast < 2500) return;
    lastNotReadyToast = now;
    showToast('Sample piano belum siap. Tunggu status "Siap".');
  }

  function refreshKeyVisual(note) {
    const key = keyEls.get(note);
    if (key) key.classList.toggle('is-active', heldNotes.has(note));
  }

  function refreshAllKeyVisuals() {
    for (const note of keyEls.keys()) refreshKeyVisual(note);
  }

  function effectiveSustain(channel) {
    return sustainOn || (channel != null && midi.channelSustain.get(channel) === true);
  }

  function clearOwner(note, ownerKey = ownersByMidi.get(note)) {
    if (!ownerKey) return;
    if (ownersByMidi.get(note) === ownerKey) ownersByMidi.delete(note);
    const owner = noteOwners.get(ownerKey);
    if (owner && owner.midi === note) noteOwners.delete(ownerKey);
  }

  function noteOn(note, velocity = 0.82, origin = DEFAULT_SOURCE, options = {}) {
    if (!Number.isFinite(note) || note < MIDI_MIN || note > MIDI_MAX) return false;
    if (!ready) {
      if (!loading) showNotReadyToast();
      return false;
    }
    if (!ensureAudio()) return false;

    const ownerKey = `${origin}|${note}|${options.channel ?? 'local'}|${options.portId ?? ''}`;
    const currentKey = ownersByMidi.get(note);
    const currentOwner = currentKey ? noteOwners.get(currentKey) : null;
    if (currentOwner && currentOwner.origin !== origin) return false;
    if (voices.has(note)) releaseVoice(note, 0.05);

    const sample = nearestSample(note);
    if (!sample) return false;

    const when = Number.isFinite(options.when) ? Math.max(options.when, ctx.currentTime) : ctx.currentTime;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const peak = clamp(Math.pow(velocity, 1.25) * 0.95, 0.02, 1);
    const bend = midi.bend.get(options.channel) || 0;
    const baseRate = Math.pow(2, (note - sample.midi) / 12);

    source.buffer = sample.buffer;
    source.playbackRate.value = baseRate * Math.pow(2, bend / 12);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.006);
    source.connect(gain).connect(voiceBus);
    source.start(when);

    const voice = {
      source, gain, baseRate, origin,
      channel: options.channel ?? null,
      portId: options.portId || null
    };
    voices.set(note, voice);
    sustained.delete(note);
    heldNotes.add(note);
    noteOwners.set(ownerKey, { midi: note, origin, channel: voice.channel, portId: voice.portId });
    ownersByMidi.set(note, ownerKey);
    source.onended = () => {
      if (voices.get(note) === voice) {
        voices.delete(note);
        sustained.delete(note);
        clearOwner(note);
      }
    };
    refreshKeyVisual(note);
    return true;
  }

  function releaseVoice(note, forcedDuration = 0) {
    const voice = voices.get(note);
    if (!voice) {
      sustained.delete(note);
      clearOwner(note);
      refreshKeyVisual(note);
      return;
    }
    voices.delete(note);
    sustained.delete(note);

    const now = ctx.currentTime;
    const duration = forcedDuration || (effectiveSustain(voice.channel) ? 1.8 : 0.24);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    try { voice.source.stop(now + duration + 0.03); } catch (_) { /* sudah berhenti */ }
    clearOwner(note);
    refreshKeyVisual(note);
  }

  function noteOff(note, origin = DEFAULT_SOURCE, options = {}) {
    const ownerKey = ownersByMidi.get(note);
    if (!ownerKey) return;
    const owner = noteOwners.get(ownerKey);
    if (!owner || owner.origin !== origin) return;
    if (options.channel != null && owner.channel !== options.channel) return;
    if (options.portId && owner.portId !== options.portId) return;

    heldNotes.delete(note);
    if (effectiveSustain(owner.channel)) {
      sustained.set(note, { origin, channel: owner.channel, portId: owner.portId });
    } else {
      releaseVoice(note);
    }
    clearOwner(note, ownerKey);
    refreshKeyVisual(note);
  }

  function matchesVoice(entry, options) {
    return (!options.origin || entry.origin === options.origin) &&
      (options.channel == null || entry.channel === options.channel) &&
      (!options.portId || entry.portId === options.portId);
  }

  function releaseAll(forcedDuration = 0.1, options = {}) {
    const released = [];
    for (const [note, voice] of [...voices]) {
      if (!matchesVoice(voice, options)) continue;
      released.push(note);
      releaseVoice(note, forcedDuration);
    }
    for (const note of released) heldNotes.delete(note);
    for (const [note, entry] of [...sustained]) {
      if (matchesVoice(entry, options)) { sustained.delete(note); heldNotes.delete(note); }
    }
    const global = !options.origin && options.channel == null && !options.portId;
    for (const note of [...heldNotes]) {
      const ownerKey = ownersByMidi.get(note);
      const owner = ownerKey ? noteOwners.get(ownerKey) : null;
      if (global || (owner && matchesVoice(owner, options))) heldNotes.delete(note);
    }
    if (global) {
      activePointers.clear();
      heldKeys.clear();
      keyHeldBy.clear();
      clickTimers.forEach(timer => clearTimeout(timer));
      clickTimers.clear();
      enterMidi = null;
    }
    refreshAllKeyVisuals();
  }

  function setSustain(active) {
    sustainOn = active;
    el.pedalBtn.setAttribute('aria-pressed', String(active));
    if (!active) {
      for (const note of [...sustained]) releaseVoice(note);
    }
  }

  function midiIsSupported() {
    return typeof navigator !== 'undefined' &&
      typeof navigator.requestMIDIAccess === 'function' &&
      window.isSecureContext !== false;
  }

  function setMidiChip(text, state = 'idle') {
    el.midiChipText.textContent = text;
    el.midiChip.classList.toggle('is-active', state === 'active');
    el.midiChip.classList.toggle('is-error', state === 'error');
  }

  function updateMidiButton() {
    const supported = midiIsSupported();
    el.midiBtn.disabled = !supported && !midi.enabled;
    el.midiBtn.classList.toggle('is-connected', midi.enabled);
    el.midiBtn.textContent = midi.enabled ? 'Putuskan MIDI' : 'Hubungkan MIDI';
    if (!supported && !midi.enabled) {
      el.midiBtn.title = window.isSecureContext === false
        ? 'Web MIDI memerlukan HTTPS atau localhost.'
        : 'Browser ini tidak mendukung Web MIDI (mis. Safari / iOS).';
    } else {
      el.midiBtn.removeAttribute('title');
    }
  }

  function midiTimeToAudioTime(timestamp) {
    if (!ctx) return null;
    let ms = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : performance.now();
    if (Math.abs(ms - performance.now()) > 60000) ms = performance.now();
    return ctx.currentTime + clamp((ms - performance.now()) / 1000, 0, 0.05);
  }

  function applyMidiVolume() {
    if (!midiVolumeGain || !ctx) return;
    midiVolumeGain.gain.setTargetAtTime(clamp(midi.volume * midi.expression, 0, 1), ctx.currentTime, 0.02);
  }

  function applyPitchBend(channel) {
    if (!ctx) return;
    const semitones = midi.bend.get(channel) || 0;
    for (const voice of voices.values()) {
      if (voice.channel !== channel) continue;
      voice.source.playbackRate.setTargetAtTime(voice.baseRate * Math.pow(2, semitones / 12), ctx.currentTime, 0.015);
    }
  }

  function showMidiNote(label) {
    el.midiNote.textContent = label;
    el.midiNote.hidden = false;
    clearTimeout(midi.noteTimer);
    midi.noteTimer = setTimeout(() => { el.midiNote.hidden = true; }, 900);
  }

  function releaseSustainedChannel(channel) {
    for (const [note, entry] of [...sustained]) {
      if (entry.channel === channel) releaseVoice(note);
    }
  }

  function midiPanic(options = {}) {
    releaseAll(options.immediate ? 0.01 : 0.05, { origin: 'midi', ...options });
    if (options.channel != null) {
      midi.channelSustain.delete(options.channel);
      midi.bend.delete(options.channel);
    } else if (!options.portId) {
      midi.channelSustain.clear();
      midi.bend.clear();
    }
    for (const voice of voices.values()) {
      voice.source.playbackRate.setTargetAtTime(voice.baseRate, ctx ? ctx.currentTime : 0, 0.01);
    }
  }

  function handleMidiCC(channel, cc, value, portId) {
    if (cc === 64) {
      midi.channelSustain.set(channel, value >= 64);
      if (value < 64) releaseSustainedChannel(channel);
      return;
    }
    if (cc === 7) { midi.volume = clamp(value / 127, 0, 1); applyMidiVolume(); return; }
    if (cc === 11) { midi.expression = clamp(value / 127, 0, 1); applyMidiVolume(); return; }
    if (cc === 120) { midiPanic({ channel, portId, immediate: true }); return; }
    if (cc === 121) {
      midi.bend.delete(channel);
      midi.channelSustain.delete(channel);
      releaseSustainedChannel(channel);
      applyPitchBend(channel);
      return;
    }
    if (cc === 123 || cc === 126 || cc === 127) midiPanic({ channel, portId });
  }

  function handleMidiMessage(event) {
    const data = event.data;
    if (!(data instanceof Uint8Array) || data.length < 2) return;
    const portId = event.target && event.target.id ? event.target.id : null;
    if (midi.inputId !== 'all' && portId !== midi.inputId) return;

    const command = data[0] & 0xf0;
    const channel = (data[0] & 0x0f) + 1;
    if (midi.channel !== 'omni' && channel !== Number(midi.channel)) return;
    if (command < 0x80 || command === 0xf0) return;

    if (command === 0x90) {
      const note = data[1];
      if (note < MIDI_MIN || note > MIDI_MAX) return;
      if (data[2] === 0) { noteOff(note, 'midi', { channel, portId }); return; }
      if (noteOn(note, data[2] / 127, 'midi', { channel, portId, when: midiTimeToAudioTime(event.timeStamp) })) {
        showMidiNote(`MIDI · ${midiToName(note)} · vel ${data[2]}`);
      }
      return;
    }
    if (command === 0x80) {
      noteOff(data[1], 'midi', { channel, portId });
      return;
    }
    if (command === 0xb0) {
      handleMidiCC(channel, data[1], data[2], portId);
      return;
    }
    if (command === 0xe0) {
      const value14 = (data[2] << 7) | data[1];
      midi.bend.set(channel, ((value14 - 8192) / 8192) * 2);
      applyPitchBend(channel);
    }
  }

  function attachMidiInputs() {
    if (!midi.access) return;
    for (const port of midi.access.inputs.values()) {
      const selected = midi.inputId === 'all' || port.id === midi.inputId;
      port.onmidimessage = selected && port.state === 'connected' ? handleMidiMessage : null;
    }
  }

  function refreshMidiPorts() {
    if (!midi.access) return;
    midi.inputs = new Map([...midi.access.inputs.values()]
      .filter(port => port.type === 'input' && port.state === 'connected')
      .map(port => [port.id, port]));
    const select = el.midiInput;
    select.innerHTML = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = midi.inputs.size ? 'Semua perangkat' : 'Belum ada perangkat';
    select.append(all);
    for (const port of midi.inputs.values()) {
      const option = document.createElement('option');
      option.value = port.id;
      option.textContent = [port.name || 'Keyboard MIDI', port.manufacturer].filter(Boolean).join(' · ');
      select.append(option);
    }
    if (midi.inputId !== 'all' && !midi.inputs.has(midi.inputId)) midi.inputId = 'all';
    select.value = midi.inputId;
    attachMidiInputs();
    setMidiChip(
      midi.inputs.size ? `MIDI aktif · ${midi.inputs.size} input` : 'MIDI aktif · belum ada perangkat',
      'active'
    );
  }

  function handleMidiStateChange(event) {
    const port = event.port;
    if (port && port.type === 'input' && port.state !== 'connected') {
      midiPanic({ portId: port.id, immediate: true });
    }
    refreshMidiPorts();
  }

  async function enableMidi() {
    if (!midiIsSupported() || midi.pending) return;
    midi.pending = true;
    el.midiBtn.disabled = true;
    ensureAudio();
    setMidiChip('MIDI: meminta izin…', 'idle');
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      midi.access = access;
      midi.enabled = true;
      access.onstatechange = handleMidiStateChange;
      refreshMidiPorts();
      el.midiControls.hidden = false;
      updateMidiButton();
      if (!midi.inputs.size) showToast('MIDI aktif. Hubungkan keyboard lalu tekan sebuah note.');
    } catch (error) {
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setMidiChip(denied ? 'MIDI: izin ditolak' : 'MIDI: gagal tersambung', 'error');
      showToast(denied
        ? 'Izin MIDI ditolak. Aktifkan lagi lewat pengaturan browser lalu klik Hubungkan MIDI.'
        : 'Gagal membuka akses MIDI. Periksa izin browser dan koneksi perangkat.');
    } finally {
      midi.pending = false;
      el.midiBtn.disabled = false;
      updateMidiButton();
    }
  }

  function disableMidi() {
    midiPanic({ immediate: true });
    for (const port of midi.inputs.values()) port.onmidimessage = null;
    if (midi.access) midi.access.onstatechange = null;
    midi.access = null;
    midi.enabled = false;
    midi.inputId = 'all';
    midi.channel = 'omni';
    midi.channelSustain.clear();
    midi.bend.clear();
    midi.volume = 1;
    midi.expression = 1;
    applyMidiVolume();
    clearTimeout(midi.noteTimer);
    el.midiNote.hidden = true;
    el.midiControls.hidden = true;
    el.midiChannel.value = 'omni';
    midi.inputs.clear();
    setMidiChip('MIDI: tidak tersedia', 'idle');
    updateMidiButton();
  }

  function initMidi() {
    updateMidiButton();
    if (!midiIsSupported()) {
      setMidiChip('MIDI: tidak didukung browser ini', 'idle');
      return;
    }
    setMidiChip('MIDI: belum tersambung', 'idle');
  }

  function setKeyFocus(midi) {
    const previous = el.keys.querySelector('.key.is-focused');
    if (previous) previous.classList.remove('is-focused');
    const key = keyEls.get(midi);
    if (key) {
      key.classList.add('is-focused');
      key.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function getViewRange() {
    if (view === '88') return { from: MIDI_MIN, to: MIDI_MAX };
    if (view === '24') return { from: baseMidi, to: baseMidi + 23 };
    return { from: baseMidi, to: baseMidi + 11 };
  }

  function updateOctaveLabel() {
    const { whiteMap } = buildLetterMaps();
    const values = [...whiteMap.values()];
    const last = values.length ? values[values.length - 1] : baseMidi;
    el.octLabel.textContent = `${midiToName(baseMidi)}–${midiToName(last)}`;
  }

  function updateScrollControl() {
    const maxScroll = el.keysScroll.scrollWidth - el.keysScroll.clientWidth;
    el.scrollControl.hidden = maxScroll <= 4;
    el.scrollRange.max = String(Math.max(maxScroll, 1));
    el.scrollRange.value = String(el.keysScroll.scrollLeft);
  }

  function renderKeys() {
    const { from, to } = getViewRange();
    const notes = [];
    for (let midi = from; midi <= to; midi += 1) notes.push(midi);
    const whiteCount = notes.filter(isWhite).length;

    keyEls.clear();
    shortcutByMidi.clear();
    letterMaps = buildLetterMaps();
    const { whiteMap, blackMap } = letterMaps;
    for (const [letter, midi] of whiteMap) shortcutByMidi.set(midi, { letter, shift: false });
    for (const [letter, midi] of blackMap) {
      if (midi !== null) shortcutByMidi.set(midi, { letter, shift: true });
    }

    el.keys.innerHTML = '';
    el.keys.style.setProperty('--white-count', String(whiteCount));
    el.keys.style.setProperty('--white-min', view === '88' ? '26px' : view === '24' ? '44px' : '64px');

    let whiteIndex = 0;
    for (const midi of notes) {
      const black = !isWhite(midi);
      const key = document.createElement('button');
      const label = document.createElement('span');
      const shortcut = document.createElement('kbd');
      const shortcutInfo = shortcutByMidi.get(midi);
      const shortcutText = shortcutInfo
        ? (shortcutInfo.shift ? `Shift+${shortcutInfo.letter.toUpperCase()}` : shortcutInfo.letter.toUpperCase())
        : '';

      key.type = 'button';
      key.className = `key ${black ? 'black' : 'white'}`;
      key.dataset.midi = String(midi);
      key.tabIndex = -1;
      if (shortcutText) key.setAttribute('aria-keyshortcuts', shortcutText);

      if (black) {
        key.style.left = `${((whiteIndex - 0.31) / whiteCount) * 100}%`;
        key.style.width = `${(0.62 / whiteCount) * 100}%`;
      } else {
        whiteIndex += 1;
      }

      label.className = 'key-label';
      label.textContent = midiToName(midi);
      shortcut.className = 'key-shortcut';
      shortcut.textContent = shortcutText;
      key.append(label, shortcut);
      el.keys.appendChild(key);
      keyEls.set(midi, key);
    }

    focusedMidi = clamp(focusedMidi, from, to);
    setKeyFocus(focusedMidi);
    refreshAllKeyVisuals();
    updateScrollControl();
  }

  function setView(nextView) {
    view = nextView;
    document.querySelectorAll('[data-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    });
    el.keysScroll.scrollLeft = 0;
    renderKeys();
  }

  function setOctave(delta) {
    baseMidi = clamp(baseMidi + delta * 12, 24, 60);
    updateOctaveLabel();
    renderKeys();
    const firstMapped = buildLetterMaps().whiteMap.get('q');
    if (firstMapped !== undefined) setKeyFocus(firstMapped);
  }

  function moveFocus(delta) {
    const { from, to } = getViewRange();
    focusedMidi = clamp(focusedMidi + delta, from, to);
    setKeyFocus(focusedMidi);
  }

  function velocityFromEvent(event, key) {
    const rect = key.getBoundingClientRect();
    const position = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
    return 0.48 + 0.52 * position;
  }

  function toggleHelp() {
    const willOpen = el.helpPanel.hidden;
    el.helpPanel.hidden = !willOpen;
    el.helpBtn.setAttribute('aria-expanded', String(willOpen));
  }

  function stopDemo() {
    demoTimers.forEach(clearTimeout);
    demoTimers = [];
    demoPlaying = false;
    el.demoBtn.textContent = 'Putar demo';
    releaseAll(0.1, { origin: 'demo' });
    setSustain(pedalBeforeDemo);
  }

  function playDemo() {
    if (demoPlaying) { stopDemo(); return; }
    if (!ready) { showToast('Tunggu sample selesai dimuat sebelum memutar demo.'); return; }

    demoPlaying = true;
    pedalBeforeDemo = sustainOn;
    setSustain(true);
    el.demoBtn.textContent = 'Hentikan demo';

    const phrase = [
      ['E5', 0.00, 0.28], ['D#5', 0.28, 0.28], ['E5', 0.56, 0.28], ['D#5', 0.84, 0.28],
      ['E5', 1.12, 0.28], ['B4', 1.40, 0.28], ['D5', 1.68, 0.28], ['C5', 1.96, 0.32],
      ['A4', 2.28, 0.72], ['C4', 3.00, 0.95], ['E4', 3.12, 0.95], ['A4', 3.24, 1.15]
    ];

    phrase.forEach(([name, start, duration]) => {
      const midi = noteToMidi(name);
      demoTimers.push(setTimeout(() => noteOn(midi, 0.84, 'demo'), start * 1000));
      demoTimers.push(setTimeout(() => noteOff(midi, 'demo'), (start + duration) * 1000));
    });
    demoTimers.push(setTimeout(stopDemo, 5200));
  }

  function bindEvents() {
    el.pedalBtn.addEventListener('click', () => setSustain(!sustainOn));
    el.retryBtn.addEventListener('click', () => { setStatus('Memuat ulang sample…', 'loading', 0); buffers = new Map(); loadSamples(); });
    el.helpBtn.addEventListener('click', toggleHelp);
    el.demoBtn.addEventListener('click', playDemo);
    el.octDown.addEventListener('click', () => setOctave(-1));
    el.octUp.addEventListener('click', () => setOctave(1));

    el.labelToggle.addEventListener('change', () => {
      document.body.classList.toggle('no-labels', !el.labelToggle.checked);
    });
    el.reverbToggle.addEventListener('change', () => {
      if (wetGain && ctx) {
        wetGain.gain.setTargetAtTime(el.reverbToggle.checked ? 0.13 : 0, ctx.currentTime, 0.05);
      }
    });
    el.volume.addEventListener('input', () => {
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime((Number(el.volume.value) / 100) * 0.9, ctx.currentTime, 0.03);
      }
    });

    el.midiBtn.addEventListener('click', () => {
      if (midi.enabled) disableMidi();
      else enableMidi();
    });
    el.midiInput.addEventListener('change', () => {
      midi.inputId = el.midiInput.value;
      midiPanic();
      attachMidiInputs();
    });
    el.midiChannel.addEventListener('change', () => {
      midi.channel = el.midiChannel.value;
      midiPanic();
    });
    el.midiPanicBtn.addEventListener('click', () => midiPanic());

    document.querySelectorAll('[data-view]').forEach(button => {
      button.addEventListener('click', () => setView(button.dataset.view));
    });

    el.keysScroll.addEventListener('scroll', () => {
      el.scrollRange.value = String(el.keysScroll.scrollLeft);
    }, { passive: true });
    el.scrollRange.addEventListener('input', () => {
      el.keysScroll.scrollLeft = Number(el.scrollRange.value);
    });

    el.keys.addEventListener('pointerdown', event => {
      const key = event.target.closest('.key');
      if (!key) return;
      event.preventDefault();
      el.keys.setPointerCapture(event.pointerId);
      const midi = Number(key.dataset.midi);
      activePointers.set(event.pointerId, midi);
      setKeyFocus(midi);
      noteOn(midi, velocityFromEvent(event, key), 'pointer');
    });

    el.keys.addEventListener('pointermove', event => {
      if (!activePointers.has(event.pointerId)) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const key = hit && hit.closest('.key');
      if (!key || !el.keys.contains(key)) return;
      const midi = Number(key.dataset.midi);
      if (activePointers.get(event.pointerId) === midi) return;
      noteOff(activePointers.get(event.pointerId), 'pointer');
      activePointers.set(event.pointerId, midi);
      setKeyFocus(midi);
      noteOn(midi, velocityFromEvent(event, key), 'pointer');
    });

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
      el.keys.addEventListener(type, event => {
        if (!activePointers.has(event.pointerId)) return;
        noteOff(activePointers.get(event.pointerId), 'pointer');
        activePointers.delete(event.pointerId);
      });
    });

    el.keys.addEventListener('click', event => {
      if (event.detail !== 0) return;
      const key = event.target.closest('.key');
      if (!key) return;
      const midi = Number(key.dataset.midi);
      const previousTimer = clickTimers.get(midi);
      if (previousTimer) clearTimeout(previousTimer);
      noteOn(midi, 0.82, 'click');
      clickTimers.set(midi, setTimeout(() => {
        clickTimers.delete(midi);
        noteOff(midi, 'click');
      }, 320));
    });

    document.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;

      if (event.code === 'Space') {
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && active !== el.pedalBtn) return;
        event.preventDefault();
        if (!sustainOn) setSustain(true);
        return;
      }

      if (event.code === 'Backquote') {
        event.preventDefault();
        el.labelToggle.checked = !el.labelToggle.checked;
        document.body.classList.toggle('no-labels', !el.labelToggle.checked);
        return;
      }
      if (event.code === 'Minus' || event.key === '-') { event.preventDefault(); setOctave(-1); return; }
      if (event.code === 'Equal' || event.key === '=') { event.preventDefault(); setOctave(1); return; }
      if (event.key === '?') { toggleHelp(); return; }

      if (document.activeElement === el.keysScroll) {
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(-1); return; }
        if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(1); return; }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (enterMidi === null) {
            enterMidi = focusedMidi;
            noteOn(enterMidi, 0.82, 'enter');
          }
          return;
        }
      }

      const character = event.key.toLowerCase();
      if (LETTER_SET.has(character)) {
        event.preventDefault();
        if (heldKeys.has(character)) return;
        const midi = event.shiftKey
          ? letterMaps.blackMap.get(character)
          : letterMaps.whiteMap.get(character);
        if (midi === null || midi === undefined) return;
        heldKeys.set(character, midi);
        setKeyFocus(midi);
        const aliases = keyHeldBy.get(midi);
        if (aliases) { aliases.add(character); return; }
        keyHeldBy.set(midi, new Set([character]));
        noteOn(midi, 0.82, 'keyboard');
      }
    });

    document.addEventListener('keyup', event => {
      const target = event.target;
      const typing = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.code === 'Space') {
        if (typing) return;
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && active !== el.pedalBtn) return;
        event.preventDefault();
        setSustain(false);
        return;
      }
      if (event.key === 'Enter' && enterMidi !== null) {
        noteOff(enterMidi, 'enter');
        enterMidi = null;
        return;
      }
      const character = event.key.toLowerCase();
      if (!heldKeys.has(character)) return;
      const midi = heldKeys.get(character);
      heldKeys.delete(character);
      const aliases = keyHeldBy.get(midi);
      if (aliases) {
        aliases.delete(character);
        if (aliases.size) return;
        keyHeldBy.delete(midi);
      }
      noteOff(midi, 'keyboard');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseAll();
        midiPanic();
        setSustain(false);
      }
    });

    window.addEventListener('resize', updateScrollControl);
  }

  function init() {
    if (window.innerWidth < 720) setView('24');
    else setView('88');
    updateOctaveLabel();
    bindEvents();
    initMidi();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    loadSamples().catch(() => setStatus('Gagal menyiapkan audio', 'error'));
  }

  init();
})();
