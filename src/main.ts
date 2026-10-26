/*
 * main.ts - the entry point: finds the element for the game on the page, loads
 * the font, the texts and the high scores, and starts the game in it.
 *
 * The game goes into the first element with the attribute data-polonaise, else
 * into the element with the id "polonaise", else into a new element at the end of
 * the body. Its data attributes configure it:
 *
 *   data-assets="https://example.com/games/polonaise/"
 *       the folder with assets/ and locales/ (default: the folder of polonaise.js)
 *   data-lang="de"
 *       a language to use instead of the browser's (if available)
 *   data-keyboard="page" | "focus"
 *       "page": the keys work anywhere on the page (for a page of its own);
 *       "focus" (default): only while the game has the focus (click it first),
 *       so the keys keep working for the rest of an embedding page
 *   data-layout="portrait"
 *       the screen higher than wide, with a field of 11 x 18 cells and no
 *       buttons: a tap on the status bar pauses (the phone version in mobile/);
 *       default: the 4:3 screen of the cabinet
 */
import { Sound } from './audio';
import { App, type KeyboardScope } from './app';
import { usePortraitScreen } from './draw';
import { usePortraitFloor } from './game';
import { loadLanguage } from './i18n';
import { ScoreBoard } from './scores';
import css from './style.css?inline';
import { injectStyle, View } from './view';

/** The font of the cabinet, for the canvas texts and the buttons. */
const FONT_FAMILY = 'Press Start 2P';
const FONT_FILE = 'assets/fonts/PressStart2P-Regular.ttf';

/** The element the game goes into. */
function findRoot(): HTMLElement {
    const root = document.querySelector<HTMLElement>('[data-polonaise]') ?? document.getElementById('polonaise');
    if (root)
        return root;
    const div = document.createElement('div');
    div.id = 'polonaise';
    document.body.append(div);
    return div;
}

/**
 * The URL of the folder with the assets and the language files, ending in "/". In a
 * build it is the folder of polonaise.js itself, so the game works wherever the dist
 * folder is copied; the development server serves them from its root.
 */
function assetBase(root: HTMLElement): string {
    const given = root.dataset.assets;
    if (given)
        return new URL(given.endsWith('/') ? given : `${given}/`, location.href).href;
    if (import.meta.env.DEV)
        return new URL(import.meta.env.BASE_URL, location.href).href;
    return import.meta.url.replace(/[^/]*$/, '');
}

/** Loads the pixel font; without it the texts fall back to a monospace font. */
async function loadFont(base: string): Promise<void> {
    try {
        const font = new FontFace(FONT_FAMILY, `url("${base}${FONT_FILE}")`, { display: 'block' });
        document.fonts.add(await font.load());
    } catch { /* the fallback font */ }
}

async function boot(): Promise<void> {
    const root = findRoot();
    if (root.dataset.polonaiseStarted)
        return;
    root.dataset.polonaiseStarted = '';
    const base = assetBase(root);
    const keyboard: KeyboardScope = root.dataset.keyboard === 'page' ? 'page' : 'focus';
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const portrait = root.dataset.layout === 'portrait';
    if (portrait) {
        usePortraitFloor();
        usePortraitScreen();
    }

    injectStyle(css);
    const [language, scores] = await Promise.all([
        loadLanguage(base, root.dataset.lang),
        ScoreBoard.open(),
        loadFont(base),
    ]);
    root.lang = language;

    const view = new View(root, portrait);
    new App(view, new Sound(`${base}assets/sounds/`, !portrait), scores, keyboard, touch, portrait).start();
    if (keyboard === 'page')
        root.focus({ preventScroll: true });
}

void boot();
