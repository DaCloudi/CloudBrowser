// ==Discord Lite plugin==
// @version 6
// Call Enhancer
//  - Sends your voice at a higher bitrate (clearer, less "compressed" sound)
//  - Optional stereo sending, and stereo receiving from people who send it
//  - Asks for a clean 48 kHz mic stream
//  - Global push-to-talk (the key itself is handled by the app)
//  - Volume levelling: evens out loud and quiet people (Settings > Calls)
//  - Raw microphone: turns off the browser's echo/noise/volume processing, for people
//    who already process their mic (SteelSeries GG / Sonar, NVIDIA Broadcast, etc.)
//  - Live mic meter in the user panel during calls (green = people can hear you)
//
// Options are in Settings (tray icon > Settings > Calls / Push-to-talk).
// Rename this file to _call-enhancer.js to turn it off.

(() => {
    "use strict";

    const TAG = "[Call Enhancer]";
    const DEFAULTS = { maxBitrateKbps: 128, stereo: false, receiveStereo: true, fec: true, dtx: false, levelling: "off", rawMic: true, micMeter: true };
    const PTT_DEFAULTS = { enabled: false, releaseDelayMs: 150 };
    // Live views of Settings (updated in place when you change them).
    const cfg = () => Object.assign({}, DEFAULTS, (window.__DL_SETTINGS || {}).call);
    const ptt = () => Object.assign({}, PTT_DEFAULTS, (window.__DL_SETTINGS || {}).ptt);

    // ---- 1. Opus settings in the call's SDP ----

    function setParam(params, key, value) {
        const i = params.findIndex(p => p.split("=")[0].trim() === key);
        const kv = `${key}=${value}`;
        if (i >= 0) params[i] = kv; else params.push(kv);
    }

    function mungeSdp(sdp, local) {
        if (typeof sdp !== "string") return sdp;
        const m = sdp.match(/a=rtpmap:(\d+) opus\/48000(\/2)?/i);
        if (!m) return sdp;
        const c = cfg();
        const pt = m[1];
        const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
        const build = existing => {
            const params = existing ? existing.split(";").map(s => s.trim()).filter(Boolean) : [];
            if (local) {
                // What we're willing to *receive*
                if (c.receiveStereo) setParam(params, "stereo", 1);
            } else {
                // Limits for our encoder (read from the remote description)
                setParam(params, "maxaveragebitrate", Math.round(c.maxBitrateKbps * 1000));
                if (c.stereo) { setParam(params, "stereo", 1); setParam(params, "sprop-stereo", 1); }
            }
            setParam(params, "useinbandfec", c.fec ? 1 : 0);
            setParam(params, "usedtx", c.dtx ? 1 : 0);
            return params.join(";");
        };
        if (re.test(sdp)) return sdp.replace(re, (_, p) => `a=fmtp:${pt} ${build(p)}`);
        return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${build("")}`);
    }

    function patchDescriptions(proto) {
        for (const [method, local] of [["setLocalDescription", true], ["setRemoteDescription", false]]) {
            const orig = proto[method];
            if (!orig || orig.__dlPatched) continue;
            const patched = function (desc, ...rest) {
                try {
                    if (desc && desc.sdp) desc = { type: desc.type, sdp: mungeSdp(desc.sdp, local) };
                } catch (e) { console.warn(TAG, e); }
                return orig.call(this, desc, ...rest);
            };
            patched.__dlPatched = true;
            proto[method] = patched;
        }
    }

    // ---- 2. Sender bitrate cap ----

    // Only raise Discord's *normal* cap (64 kbps or the channel's bitrate). When Discord
    // lowers it below that, it's backing off because the connection is struggling, so
    // leave it alone. Overriding that causes packet loss: choppy audio and a buzzy "ring".
    const NORMAL_MIN_BPS = 64000;

    function patchSender(proto) {
        const orig = proto && proto.setParameters;
        if (!orig || orig.__dlPatched) return;
        const patched = function (params, ...rest) {
            try {
                const bps = Math.round(cfg().maxBitrateKbps * 1000);
                if (this.track && this.track.kind === "audio" && params && params.encodings) {
                    for (const enc of params.encodings) {
                        if (!enc.maxBitrate) continue; // no cap set: the SDP limit applies
                        if (enc.maxBitrate >= NORMAL_MIN_BPS && enc.maxBitrate < bps) enc.maxBitrate = bps;
                    }
                }
            } catch (e) { console.warn(TAG, e); }
            return orig.call(this, params, ...rest);
        };
        patched.__dlPatched = true;
        proto.setParameters = patched;
    }

    // ---- 3. Push-to-talk: open/close the mic itself ----

    const tracks = new Set();     // live mic tracks
    const gated = new WeakSet();  // tracks we switched off (so we only undo our own changes)
    let held = false;
    let releaseTimer = null;

    function discordMuted() {
        try {
            const store = window.Vencord?.Webpack?.findStore?.("MediaEngineStore");
            return !!(store && (store.isSelfMute?.() || store.isSelfDeaf?.()));
        } catch { return false; }
    }

    function applyPtt() {
        const on = ptt().enabled;
        for (const t of tracks) {
            if (t.readyState === "ended") { tracks.delete(t); continue; }
            if (on) {
                const open = held && !discordMuted();
                t.enabled = open;
                if (open) gated.delete(t); else gated.add(t);
            } else if (gated.has(t)) {
                // PTT switched off: give back the mic we were holding closed.
                gated.delete(t);
                if (!discordMuted()) t.enabled = true;
            }
        }
    }

    // Called by the app when the global key goes down / up.
    window.__dlPTT = pressed => {
        clearTimeout(releaseTimer);
        if (pressed) {
            held = true;
            applyPtt();
        } else {
            releaseTimer = setTimeout(() => { held = false; applyPtt(); }, ptt().releaseDelayMs);
        }
    };

    function trackMic(stream) {
        try {
            for (const t of stream.getAudioTracks()) {
                tracks.add(t);
                startMeter(t);
                if (ptt().enabled && !held) { t.enabled = false; gated.add(t); }
            }
        } catch (e) { console.warn(TAG, e); }
        return stream;
    }

    // ---- 3b. Raw microphone: no browser echo / noise / volume processing ----

    function rawAudio(a) {
        a.echoCancellation = false;
        a.noiseSuppression = false;
        a.autoGainControl = false;
        a.voiceIsolation = false;
        // Older Chromium spellings, in case Discord passes them
        for (const k of Object.keys(a)) {
            if (/^goog(EchoCancellation|NoiseSuppression|AutoGainControl|HighpassFilter|TypingNoiseDetection)/.test(k)) a[k] = false;
        }
        if (Array.isArray(a.advanced)) {
            a.advanced = a.advanced.map(o => {
                const c = { ...o };
                for (const k of Object.keys(c)) if (/^goog|echoCancellation|noiseSuppression|autoGainControl/.test(k)) c[k] = false;
                return c;
            });
        }
        return a;
    }

    // Discord can switch processing back on later via applyConstraints; keep it off.
    function patchApplyConstraints() {
        const proto = window.MediaStreamTrack && MediaStreamTrack.prototype;
        if (!proto || !proto.applyConstraints || proto.applyConstraints.__dlPatched) return;
        const orig = proto.applyConstraints;
        const patched = function (c, ...rest) {
            try {
                if (this.kind === "audio" && tracks.has(this) && cfg().rawMic) c = rawAudio({ ...(c || {}) });
            } catch (e) { console.warn(TAG, e); }
            return orig.call(this, c, ...rest);
        };
        patched.__dlPatched = true;
        proto.applyConstraints = patched;
    }

    // ---- 4. Clean 48 kHz mic + remember mic tracks for push-to-talk ----

    function patchGetUserMedia() {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia || md.getUserMedia.__dlPatched) return;
        const orig = md.getUserMedia.bind(md);
        const patched = function (constraints) {
            try {
                if (constraints && constraints.audio) {
                    const a = constraints.audio === true ? {} : { ...constraints.audio };
                    // A preference, not a demand: mics that can't do 48 kHz still work.
                    if (a.sampleRate === undefined) a.sampleRate = { ideal: 48000 };
                    if (cfg().stereo) a.channelCount = { ideal: 2 };
                    if (cfg().rawMic) rawAudio(a);
                    constraints = { ...constraints, audio: a };
                }
            } catch (e) { console.warn(TAG, e); }
            const p = orig(constraints);
            return constraints && constraints.audio ? p.then(trackMic) : p;
        };
        patched.__dlPatched = true;
        md.getUserMedia = patched;
    }

    // ---- 5. Volume levelling for incoming voices ----
    //
    // Each remote voice goes through: compressor (turns loud peaks down) -> make-up gain
    // (brings quiet voices up). Discord's own element still plays it, so per-person volume,
    // output device and deafen keep working. Only voices from the call are touched, never
    // your own mic.

    const PRESETS = {
        light:  { threshold: -22, knee: 12, ratio: 2.5, attack: 0.008, release: 0.30, makeup: 1.25 },
        medium: { threshold: -28, knee: 16, ratio: 4,   attack: 0.005, release: 0.25, makeup: 1.6 },
        strong: { threshold: -34, knee: 20, ratio: 7,   attack: 0.003, release: 0.20, makeup: 2.1 },
    };
    const remoteTracks = new WeakSet();
    const chains = new Set();          // live levelling chains (to update when you change strength)
    const levelled = new WeakMap();    // original stream -> levelled stream
    let ctx = null;

    const levelling = () => cfg().levelling || "off";
    const isRemoteAudio = v => {
        try {
            return v instanceof MediaStream && v.getAudioTracks().some(t => remoteTracks.has(t));
        } catch { return false; }
    };

    function audioCtx() {
        if (!ctx) {
            ctx = new AudioContext({ latencyHint: "interactive" });
            const wake = () => { if (ctx.state === "suspended") ctx.resume().catch(() => {}); };
            ["pointerdown", "keydown"].forEach(ev => window.addEventListener(ev, wake, true));
        }
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        return ctx;
    }

    function applyPreset(chain) {
        const p = PRESETS[levelling()];
        const t = chain.ctx.currentTime;
        if (!p) { // "off" mid-call: make the chain transparent
            chain.comp.ratio.setValueAtTime(1, t);
            chain.comp.threshold.setValueAtTime(0, t);
            chain.gain.gain.setValueAtTime(1, t);
            return;
        }
        chain.comp.threshold.setValueAtTime(p.threshold, t);
        chain.comp.knee.setValueAtTime(p.knee, t);
        chain.comp.ratio.setValueAtTime(p.ratio, t);
        chain.comp.attack.setValueAtTime(p.attack, t);
        chain.comp.release.setValueAtTime(p.release, t);
        chain.gain.gain.setValueAtTime(p.makeup, t);
    }

    function makeChain(c) {
        const comp = c.createDynamicsCompressor();
        const gain = c.createGain();
        comp.connect(gain);
        const chain = { ctx: c, comp, gain, input: comp, output: gain };
        applyPreset(chain);
        chains.add(chain);
        return chain;
    }

    // Chromium only lets a call's audio flow into Web Audio while it's also attached to a
    // media element, so keep a silent one alongside.
    const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    function keepFlowing(stream) {
        try {
            const a = new Audio();
            a.muted = true;
            mediaSrc.set.call(a, stream);
            a.play().catch(() => {});
        } catch { /* ignore */ }
    }

    function levelledStream(stream) {
        if (levelled.has(stream)) return levelled.get(stream);
        const c = audioCtx();
        keepFlowing(stream);
        const src = c.createMediaStreamSource(stream);
        const chain = makeChain(c);
        const dest = c.createMediaStreamDestination();
        src.connect(chain.input);
        chain.output.connect(dest);
        levelled.set(stream, dest.stream);
        return dest.stream;
    }

    // Remember which tracks come from the call (not your mic).
    function watchRemoteTracks() {
        const PC = window.RTCPeerConnection;
        if (!PC || PC.__dlTrackWatch) return;
        const Wrapped = function (...args) {
            const pc = new PC(...args);
            pc.addEventListener("track", e => { if (e.track && e.track.kind === "audio") remoteTracks.add(e.track); });
            return pc;
        };
        Wrapped.prototype = PC.prototype;
        Object.setPrototypeOf(Wrapped, PC);
        Wrapped.__dlTrackWatch = true;
        window.RTCPeerConnection = Wrapped;
    }

    // Path A: Discord plays a voice through an <audio> element.
    function patchMediaElements() {
        if (!mediaSrc || !mediaSrc.set || HTMLMediaElement.prototype.__dlLevelPatched) return;
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
            configurable: true,
            enumerable: mediaSrc.enumerable,
            get() {
                return this.__dlOriginal !== undefined ? this.__dlOriginal : mediaSrc.get.call(this);
            },
            set(v) {
                let out = v;
                try {
                    if (levelling() !== "off" && isRemoteAudio(v)) {
                        out = levelledStream(v);
                        this.__dlOriginal = v;
                    } else {
                        this.__dlOriginal = undefined;
                    }
                } catch (e) {
                    console.warn(TAG, "levelling skipped", e);
                    out = v;
                    this.__dlOriginal = undefined;
                }
                mediaSrc.set.call(this, out);
            },
        });
        HTMLMediaElement.prototype.__dlLevelPatched = true;
    }

    // Path B: Discord plays a voice through Web Audio itself.
    function patchWebAudio() {
        const proto = window.AudioContext && AudioContext.prototype;
        if (!proto || proto.__dlLevelPatched) return;
        const orig = proto.createMediaStreamSource;
        proto.createMediaStreamSource = function (stream) {
            const node = orig.call(this, stream);
            try {
                if (this !== ctx && levelling() !== "off" && isRemoteAudio(stream)) {
                    keepFlowing(stream);
                    const chain = makeChain(this);
                    const connect = node.connect.bind(node);
                    connect(chain.input);
                    node.connect = (dest, ...rest) => chain.output.connect(dest, ...rest);
                    node.disconnect = (...a) => { try { chain.output.disconnect(...a); } catch { /* ignore */ } };
                }
            } catch (e) { console.warn(TAG, "levelling skipped", e); }
            return node;
        };
        proto.__dlLevelPatched = true;
    }

    try {
        watchRemoteTracks();
        patchMediaElements();
        patchWebAudio();
        // Changing Light/Medium/Strong applies straight away to voices already playing.
        if (window.__dlOnSettings) window.__dlOnSettings.push(() => chains.forEach(applyPreset));
    } catch (e) {
        console.warn(TAG, "volume levelling unavailable", e);
    }

    // ---- 6. Live mic meter (user panel, during calls) ----
    //
    // Measures a *copy* of the mic track, so it never affects what people hear, and it
    // still shows your level while you're muted / not holding push-to-talk (in grey).

    let meter = null; // { track, clone, ctx, analyser, buf, level, timer }

    function stopMeter() {
        if (!meter) return;
        clearInterval(meter.timer);
        try { meter.clone.stop(); } catch { /* ignore */ }
        try { meter.ctx.close(); } catch { /* ignore */ }
        meter = null;
        document.getElementById("dl-mic-meter")?.remove();
    }

    function startMeter(track) {
        try {
            if (!cfg().micMeter) return;
            stopMeter();
            const clone = track.clone();
            clone.enabled = true;
            const ctx = new AudioContext();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            ctx.createMediaStreamSource(new MediaStream([clone])).connect(analyser);
            meter = { track, clone, ctx, analyser, buf: new Float32Array(analyser.fftSize), level: 0 };
            meter.timer = setInterval(tickMeter, 50);
            track.addEventListener("ended", () => { if (meter && meter.track === track) stopMeter(); });
        } catch (e) {
            console.warn(TAG, "mic meter unavailable", e);
        }
    }

    function meterEl() {
        let el = document.getElementById("dl-mic-meter");
        if (el && el.isConnected) return el;
        const panel = document.querySelector('section[class*="panels_"]') || document.querySelector('[class*="panels_"]');
        if (!panel) return null;
        el = document.createElement("div");
        el.id = "dl-mic-meter";
        el.title = "Mic level: green = people can hear you, grey = muted / push-to-talk not held";
        el.innerHTML = '<div class="dl-mic-fill"></div>';
        panel.appendChild(el);
        return el;
    }

    function tickMeter() {
        if (!meter) return;
        if (meter.track.readyState === "ended" || !cfg().micMeter) { stopMeter(); return; }
        if (meter.ctx.state === "suspended") meter.ctx.resume().catch(() => {});
        meter.analyser.getFloatTimeDomainData(meter.buf);
        let sum = 0;
        for (const x of meter.buf) sum += x * x;
        const rms = Math.sqrt(sum / meter.buf.length);
        // -60 dB .. 0 dB  ->  0 .. 1
        const target = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 60) / 60));
        // fast rise, slower fall (like a real meter)
        meter.level = target > meter.level ? target : meter.level * 0.85 + target * 0.15;
        const el = meterEl();
        if (!el) return;
        const open = meter.track.enabled && !discordMuted();
        el.classList.toggle("dl-live", open);
        el.firstChild.style.width = (meter.level * 100).toFixed(1) + "%";
    }

    const meterStyle = document.createElement("style");
    meterStyle.textContent = `
      #dl-mic-meter {
        position: relative; height: 4px; margin: 6px 6px 2px; border-radius: 9999px;
        background: var(--cl-hover, rgba(255,255,255,.06)); overflow: hidden; flex: 0 0 auto;
      }
      #dl-mic-meter .dl-mic-fill {
        height: 100%; width: 0; border-radius: 9999px;
        background: var(--cl-text-faint, #6d6f78);
        transition: width 50ms linear;
      }
      #dl-mic-meter.dl-live .dl-mic-fill {
        background: linear-gradient(90deg, #3ba55d 0%, #3ba55d 70%, #f0b232 85%, #f2555a 100%);
        background-size: 100vw 100%;
      }`;
    const addMeterStyle = () => (document.head || document.documentElement).appendChild(meterStyle);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addMeterStyle); else addMeterStyle();

    try {
        if (window.RTCPeerConnection) patchDescriptions(RTCPeerConnection.prototype);
        if (window.RTCRtpSender) patchSender(RTCRtpSender.prototype);
        patchGetUserMedia();
        patchApplyConstraints();
        // Settings changed (e.g. PTT switched on/off): re-apply to the current mic.
        if (window.__dlOnSettings) window.__dlOnSettings.push(applyPtt);
        if (window.__dlOnSettings) window.__dlOnSettings.push(() => {
            if (!cfg().micMeter) { stopMeter(); return; }
            if (!meter) for (const t of tracks) if (t.readyState === "live") { startMeter(t); break; }
        });
        console.log(TAG, "ready");
    } catch (e) {
        console.warn(TAG, "failed to start", e);
    }
})();
