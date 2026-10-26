/*
 * view.ts - the HTML around the canvas: the buttons above it and the form for the
 * name of a high score entry over it. The game element (the container given by
 * the page) gets this structure:
 *
 *   <div class="polonaise">
 *     <div class="polonaise-buttons"> PAUSE, SOUND, FULLSCREEN </div>
 *     <div class="polonaise-stage">
 *       <canvas width="640" height="480">
 *       <form class="polonaise-entry"> <input> <button>OK</button> </form>
 *     </div>
 *   </div>
 *
 * In portrait the element also has the class polonaise-portrait, the canvas is
 * 384x704, the buttons are hidden (the status bar pauses, see App), and a note asks
 * to turn a phone held sideways back upright.
 */
import { ENTRY_FORM, SCREEN_H, SCREEN_W } from './draw';
import { t } from './i18n';
import { MAX_NAME } from './scores';

/** Adds the styles of the game to the page once. */
export function injectStyle(css: string): void {
    if (document.getElementById('polonaise-style'))
        return;
    const style = document.createElement('style');
    style.id = 'polonaise-style';
    style.textContent = css;
    document.head.append(style);
}

/** Creates an element with a class and children. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Node[]): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className)
        e.className = className;
    e.append(...children);
    return e;
}

/** A position in canvas pixels as a percentage of the stage. */
const percent = (v: number, of: number) => `${v / of * 100}%`;

/** The DOM of the game. */
export class View {
    readonly canvas: HTMLCanvasElement;
    readonly pauseButton: HTMLButtonElement;
    readonly soundButton: HTMLButtonElement;
    readonly fullButton: HTMLButtonElement;
    readonly entryForm: HTMLFormElement;
    readonly entryInput: HTMLInputElement;
    /** The last button texts set, to touch the DOM only on a change. */
    private soundText = '';
    private pauseShown: boolean | null = null;

    /**
     * Builds the game inside root (whose former content is replaced).
     * @param portrait the portrait screen of the phone version
     */
    constructor(readonly root: HTMLElement, portrait: boolean) {
        root.classList.add('polonaise');
        root.classList.toggle('polonaise-portrait', portrait);
        if (!root.hasAttribute('tabindex'))
            root.tabIndex = 0;          // focusable: keys reach the game when it has the focus

        this.pauseButton = element('button');
        this.soundButton = element('button');
        this.fullButton = element('button');
        for (const b of [this.pauseButton, this.soundButton, this.fullButton])
            b.type = 'button';
        this.pauseButton.textContent = t('button.pause');
        this.fullButton.textContent = t('button.fullscreen');
        // e.g. iPhones cannot show an element in fullscreen
        this.fullButton.hidden = !document.fullscreenEnabled;

        this.canvas = element('canvas');
        this.canvas.width = SCREEN_W;
        this.canvas.height = SCREEN_H;
        this.canvas.setAttribute('aria-label', t('canvas.label'));

        this.entryInput = element('input');
        Object.assign(this.entryInput, {
            name: 'name', maxLength: MAX_NAME, autocomplete: 'nickname', spellcheck: false,
            enterKeyHint: 'done',
        });
        this.entryInput.setAttribute('aria-label', t('entry.label'));
        const ok = element('button');
        ok.type = 'submit';
        ok.textContent = t('entry.ok');
        this.entryForm = element('form', 'polonaise-entry', this.entryInput, ok);
        this.entryForm.hidden = true;
        Object.assign(this.entryForm.style, {
            left: percent(ENTRY_FORM.x, SCREEN_W), top: percent(ENTRY_FORM.y, SCREEN_H),
            width: percent(ENTRY_FORM.w, SCREEN_W), height: percent(ENTRY_FORM.h, SCREEN_H),
        });

        root.replaceChildren(
            element('div', 'polonaise-buttons', this.pauseButton, this.soundButton, this.fullButton),
            element('div', 'polonaise-stage', this.canvas, this.entryForm),
        );
        if (portrait) {
            const note = element('div', 'polonaise-turn');
            note.textContent = t('portrait.turn');
            root.append(note);
        }
    }

    /** Updates the buttons: the pause button only shows during a game. */
    update(playing: boolean, muted: boolean): void {
        const sound = t(muted ? 'button.soundOff' : 'button.soundOn');
        if (sound !== this.soundText)
            this.soundButton.textContent = this.soundText = sound;
        if (playing !== this.pauseShown) {
            this.pauseButton.style.visibility = playing ? 'visible' : 'hidden';
            this.pauseShown = playing;
        }
    }

    /** Shows the name entry with a suggested name, selected so that typing replaces it. */
    showEntry(name: string): void {
        this.entryInput.value = name;
        this.entryForm.hidden = false;
        this.entryInput.focus();
        this.entryInput.select();
    }

    hideEntry(): void {
        this.entryForm.hidden = true;
        this.entryInput.blur();
    }
}
