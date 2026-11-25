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
    toast: document.getElementById('toast')
  };

  const keyEls = new Map();
  const voices = new Map();
  const sustained = new Set();
  const activePointers = new Map();
  const heldKeys = new Map();
  const shortcutByMidi = new Map();

  let ctx = null;
  let voiceBus = null;
  let dryGain = null;
  let wetGain = null;
  let masterGain = null;
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
    const convolver = ctx.createConvolver();
    const compressor = ctx.createDynamicsCompressor();

    convolver.buffer = buildImpulse();
    dryGain.gain.value = 0.96;
    wetGain.gain.value = el.reverbToggle.checked ? 0.13 : 0;
    masterGain.gain.value = (Number(el.volume.value) / 100) * 0.9;
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;

    voiceBus.connect(dryGain).connect(masterGain);
    voiceBus.connect(convolver).connect(wetGain).connect(masterGain);
    masterGain.connect(compressor).connect(ctx.destination);

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

  function setKeyActive(midi, active) {
    const key = keyEls.get(midi);
    if (key) key.classList.toggle('is-active', active);
  }

  function noteOn(midi, velocity = 0.82) {
    if (!ready) {
      if (!loading) showToast('Sample piano belum siap. Tunggu status "Siap".');
      return;
    }
    if (!ensureAudio()) return;
    if (voices.has(midi)) releaseVoice(midi, 0.05);

    const sample = nearestSample(midi);
    if (!sample) return;

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const peak = clamp(Math.pow(velocity, 1.25) * 0.95, 0.02, 1);

    source.buffer = sample.buffer;
    source.playbackRate.value = Math.pow(2, (midi - sample.midi) / 12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    source.connect(gain).connect(voiceBus);
    source.start(now);

    const voice = { source, gain };
    voices.set(midi, voice);
    sustained.delete(midi);
    source.onended = () => { if (voices.get(midi) === voice) voices.delete(midi); };
    setKeyActive(midi, true);
  }

  function releaseVoice(midi, forcedDuration = 0) {
    const voice = voices.get(midi);
    if (!voice) return;
    voices.delete(midi);
    sustained.delete(midi);

    const now = ctx.currentTime;
    const duration = forcedDuration || (sustainOn ? 1.8 : 0.24);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    try { voice.source.stop(now + duration + 0.03); } catch (_) { /* sudah berhenti */ }
    setKeyActive(midi, false);
  }

  function noteOff(midi) {
    if (!voices.has(midi)) return;
    if (sustainOn) {
      sustained.add(midi);
      setKeyActive(midi, false);
      return;
    }
    releaseVoice(midi);
  }

  function releaseAll(forcedDuration = 0.1) {
    for (const midi of [...voices.keys()]) releaseVoice(midi, forcedDuration);
    sustained.clear();
    activePointers.clear();
    heldKeys.clear();
    enterMidi = null;
  }

  function setSustain(active) {
    sustainOn = active;
    el.pedalBtn.setAttribute('aria-pressed', String(active));
    if (!active) {
      for (const midi of [...sustained]) releaseVoice(midi);
    }
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
    releaseAll();
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
      demoTimers.push(setTimeout(() => noteOn(midi, 0.84), start * 1000));
      demoTimers.push(setTimeout(() => noteOff(midi), (start + duration) * 1000));
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
      noteOn(midi, velocityFromEvent(event, key));
    });

    el.keys.addEventListener('pointermove', event => {
      if (!activePointers.has(event.pointerId)) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const key = hit && hit.closest('.key');
      if (!key || !el.keys.contains(key)) return;
      const midi = Number(key.dataset.midi);
      if (activePointers.get(event.pointerId) === midi) return;
      noteOff(activePointers.get(event.pointerId));
      activePointers.set(event.pointerId, midi);
      setKeyFocus(midi);
      noteOn(midi, velocityFromEvent(event, key));
    });

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
      el.keys.addEventListener(type, event => {
        if (!activePointers.has(event.pointerId)) return;
        noteOff(activePointers.get(event.pointerId));
        activePointers.delete(event.pointerId);
      });
    });

    el.keys.addEventListener('click', event => {
      if (event.detail !== 0) return;
      const key = event.target.closest('.key');
      if (!key) return;
      const midi = Number(key.dataset.midi);
      noteOn(midi, 0.82);
      setTimeout(() => noteOff(midi), 320);
    });

    document.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (event.code === 'Space') {
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && active !== el.pedalBtn) return;
        event.preventDefault();
        if (!sustainOn) setSustain(true);
        return;
      }
      if (typing) return;

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
            noteOn(enterMidi, 0.82);
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
        noteOn(midi, 0.82);
      }
    });

    document.addEventListener('keyup', event => {
      if (event.code === 'Space') {
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && active !== el.pedalBtn) return;
        event.preventDefault();
        setSustain(false);
        return;
      }
      if (event.key === 'Enter' && enterMidi !== null) {
        noteOff(enterMidi);
        enterMidi = null;
        return;
      }
      const character = event.key.toLowerCase();
      if (heldKeys.has(character)) {
        const midi = heldKeys.get(character);
        heldKeys.delete(character);
        noteOff(midi);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseAll();
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
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    loadSamples().catch(() => setStatus('Gagal menyiapkan audio', 'error'));
  }

  init();
})();
