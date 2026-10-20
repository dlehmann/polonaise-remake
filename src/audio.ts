/*
 * audio.ts - Polonaise sound effects and music with the Web Audio API.
 *
 * The files are those of the arcade cabinet (<base>/<name>.ogg, with .mp3 copies
 * for browsers without Ogg Vorbis). The music loops sample-exactly as an
 * AudioBufferSourceNode. Browsers allow sound only after a user gesture, so the
 * audio context is created (and the files are loaded) on the first key press,
 * click or touch: see unlock().
 *
 * The signal path: effect sources -> effects gain -> master gain -> output, and
 * the music source -> music gain -> master gain. Muting sets the master gain to 0.
 */

/** The names of the effect files (without extension). */
const NAMES = ['turn', 'go', 'deny', 'catch-1', 'catch-2', 'catch-3', 'catch-4', 'catch-5', 'catch-star',
               'flee', 'star', 'star-gone', 'crash', 'extra-life', 'song-start', 'cleared', 'game-over', 'pause'];

/* Levels relative to full scale; the effects as calibrated on the cabinet (gains 86 and 51
 * at the default volumes 5 and 10). */
const MUSIC_LEVEL = 0.43;
const EFFECTS_LEVEL = 0.51;
/** The length of the music loop in seconds: 16 bars at 120 bpm. */
const MUSIC_LENGTH = 32;
/** The key of the mute setting in the local storage. */
const MUTED_KEY = 'polonaise.muted';

/** Safari before 14.1 only knows the prefixed constructor. */
type AudioContextClass = typeof AudioContext;
declare global {
    interface Window {
        webkitAudioContext?: AudioContextClass;
    }
}

/** The sounds of the game. All methods are safe to call before unlock(): they do nothing then. */
export class Sound {
    private ctx: AudioContext | null = null;
    private master!: GainNode;
    private effects!: GainNode;
    private musicGain!: GainNode;
    private readonly buffers = new Map<string, AudioBuffer>();
    private music: AudioBuffer | null = null;
    private musicSource: AudioBufferSourceNode | null = null;
    /** The music should play as soon as it is loaded. */
    private wantMusic = false;
    /** Sound switched off by the player (remembered in the local storage). */
    muted = false;

    /** @param base the URL of the folder with the sound files (ending in "/") */
    constructor(private readonly base: string) {
        try {
            this.muted = localStorage.getItem(MUTED_KEY) === '1';
        } catch { /* no storage: sound on */ }
    }

    /** Creates the audio context and loads the files; called on every user input. */
    unlock(): void {
        if (this.ctx) {
            if (this.ctx.state === 'suspended')
                void this.ctx.resume();
            return;
        }
        const Ctx = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctx)
            return;
        const ctx = new Ctx();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 1;
        this.master.connect(ctx.destination);
        this.effects = ctx.createGain();
        this.effects.gain.value = EFFECTS_LEVEL;
        this.effects.connect(this.master);
        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = MUSIC_LEVEL;
        this.musicGain.connect(this.master);

        const ext = new Audio().canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3';
        // a sound that fails to load stays silent; the callback form of decodeAudioData
        // also works in old Safari versions
        const load = (name: string): Promise<AudioBuffer | null> => fetch(`${this.base}${name}.${ext}`)
            .then(r => r.arrayBuffer())
            .then(data => new Promise<AudioBuffer>((ok, fail) => ctx.decodeAudioData(data, ok, fail)))
            .catch(() => null);
        for (const name of NAMES)
            void load(name).then(b => {
                if (b)
                    this.buffers.set(name, b);
            });
        void load('music').then(b => {
            this.music = b;
            if (this.wantMusic)
                this.startMusic();
        });
    }

    /** Plays an effect once. */
    play(name: string): void {
        const b = this.buffers.get(name);
        if (!this.ctx || !b)
            return;
        const src = this.ctx.createBufferSource();
        src.buffer = b;
        src.connect(this.effects);
        src.start();
    }

    /** Starts the looped music at full level (if it is not playing already). */
    startMusic(): void {
        this.wantMusic = true;
        if (!this.ctx || !this.music || this.musicSource)
            return;
        const src = this.ctx.createBufferSource();
        src.buffer = this.music;
        src.loop = true;
        src.loopStart = 0;
        src.loopEnd = Math.min(MUSIC_LENGTH, this.music.duration);
        this.musicGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.musicGain.gain.setValueAtTime(MUSIC_LEVEL, this.ctx.currentTime);
        src.connect(this.musicGain);
        src.start();
        this.musicSource = src;
    }

    /** Fades the music out and stops it. */
    fadeMusic(seconds: number): void {
        this.wantMusic = false;
        if (!this.ctx || !this.musicSource)
            return;
        const t = this.ctx.currentTime, src = this.musicSource;
        this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
        this.musicGain.gain.linearRampToValueAtTime(0, t + seconds);
        src.stop(t + seconds);
        this.musicSource = null;
    }

    /** Pause: the whole context stops (music and effects) and continues where it was. */
    pause(paused: boolean): void {
        if (!this.ctx)
            return;
        void (paused ? this.ctx.suspend() : this.ctx.resume());
    }

    /** Switches the sound off or on; returns whether it is off now. */
    toggleMute(): boolean {
        this.muted = !this.muted;
        try {
            localStorage.setItem(MUTED_KEY, this.muted ? '1' : '0');
        } catch { /* no storage: only for this visit */ }
        if (this.ctx)
            this.master.gain.value = this.muted ? 0 : 1;
        return this.muted;
    }
}
