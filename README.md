# Polonaise

[![Polonaise](docs/screenshot.webp)](https://dlehmann.github.io/polonaise/)

A disco conga line in pixel art, steered like Snake: lead the line over the night club dance floor and touch the
guests – they join at the end. Running into a wall, the furniture or the own line costs a life and the back half of the
line. Endless songs, each with more guests to collect and a faster beat.

**Play it online: https://dlehmann.github.io/polonaise/**

The game is written in TypeScript and built with [Vite](https://vite.dev/) into a single JavaScript file. It speaks
English and German (and any language you add), keeps a high score list with the players' names in the browser and can
be put on any website.

## Development

Requirements: [Node.js](https://nodejs.org/) 20.19 or newer (22.12+ or 24 recommended) with npm.

```
npm install
npm run dev
```

`npm run dev` starts the Vite development server at http://localhost:5173/. It reloads the page whenever a source
file, a language file or `index.html` changes.

| Command               | What it does                                                                      |
|-----------------------|-----------------------------------------------------------------------------------|
| `npm run dev`         | development server with live reload                                               |
| `npm run dev:pages`   | the same with the legal notice of the GitHub Pages site (see below)               |
| `npm run typecheck`   | checks the TypeScript code (`tsc`, no output files)                               |
| `npm run build`       | type check and production build into `dist/`                                     |
| `npm run build:pages` | production build for GitHub Pages (with the legal notice)                         |
| `npm run preview`     | serves the contents of `dist/` at http://localhost:4173/ to try the build         |

## Building

```
npm run build
```

The build bundles all TypeScript and the CSS into one file and writes `dist/`:

| Path in `dist/`        | Content                                                                      |
|------------------------|------------------------------------------------------------------------------|
| `polonaise.js`         | the whole game: one ES module, about 43 kB (16 kB gzipped)                   |
| `index.html`           | a page of its own for the game, which fills the browser window               |
| `assets/sounds/`       | effects and music as Ogg Vorbis, with MP3 copies for browsers without Vorbis |
| `assets/fonts/`        | the pixel font Press Start 2P (SIL Open Font License, `OFL.txt`)             |
| `locales/`             | the language files and `languages.json`, the list of available languages     |
| `.htaccess`            | for Apache: no caching of the page, the script and the language files        |

`polonaise.js` loads the sounds, the font and the language files relative to its own URL, so the `dist/` folder works
wherever it is copied to. It has to be served over HTTP(S), though: opening `index.html` as a file does not work.

## Putting the game on your website

Copy the contents of `dist/` to a folder of your web server, e.g. `/games/polonaise/`. Then choose one of these ways.

**A page of its own.** Link to `/games/polonaise/` – the `index.html` there shows the game in the whole window.

**In an iframe.** The simplest way to put the game into an existing page:

```html
<iframe src="/games/polonaise/" title="Polonaise" style="width: 100%; max-width: 960px; aspect-ratio: 4 / 3.2; border: 0"
        allow="fullscreen; autoplay"></iframe>
```

**Directly in a page.** Add an element for the game and the script; the game takes the full width of the element (the
screen is 4:3, with a bar of buttons above it):

```html
<div id="polonaise" style="max-width: 960px"></div>
<script type="module" src="/games/polonaise/polonaise.js"></script>
```

The script looks for the first element with the attribute `data-polonaise`, else for the element with the id
`polonaise`, else it adds an element at the end of the page. Attributes of that element configure the game:

| Attribute                         | Meaning                                                                                                                                                                                       |
|-----------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `data-keyboard="focus"` (default) | the keys only reach the game while it has the focus (after a click on it), so they keep working for the rest of the page                                                                     |
| `data-keyboard="page"`            | the keys work anywhere on the page (for a page that is only the game)                                                                                                                       |
| `data-lang="de"`                  | use this language instead of the browser's, if it is available                                                                                                                               |
| `data-assets="https://…/"`        | the folder with `assets/` and `locales/`, if it is not the folder of `polonaise.js` (e.g. when the script is served from somewhere else; another origin needs CORS headers for the files) |

The page can pause the game, for instance when it opens a dialog over it:

```js
document.getElementById('polonaise').dispatchEvent(new Event('polonaise:pause'));
```

The game adds its styles itself (all scoped to the class `.polonaise`); it needs no stylesheet.

## Languages

The game is in the language of the browser: it takes the first language of the browser's preferences
(`navigator.languages`) that it has, matched exactly (`pt-BR`) or by the base language (`de` for `de-AT`). Without a
match it is English. English is also used for every text a language file lacks.

The texts are in `public/locales/` (in a build: `dist/locales/`), one JSON file per language with flat keys:

```json
{
  "hud.score": "PUNKTE",
  "intro.goal": "HOL {target} GÄSTE IN DIE POLONAISE!",
  "crash.lives.one": "NOCH {count} LEBEN",
  "crash.lives.other": "NOCH {count} LEBEN"
}
```

- `{name}` is a placeholder, filled in by the game.
- Keys ending in `.one`, `.other` (and `.zero`, `.two`, `.few`, `.many` where a language has them) are the plural forms
  of a text that depends on a number, chosen with
  [`Intl.PluralRules`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules).
- Keys ending in `.keys` and `.touch` are the variants for keyboards and touch screens.
- `help.crash` may have several lines, separated by `\n`.
- The canvas texts use the font Press Start 2P, which has the Latin letters with accents and umlauts; the texts are in
  capitals, like on an arcade cabinet. Lines in 8 pixel size should stay below about 56 characters.

To add a language:

1. Copy `public/locales/en.json` to `public/locales/<code>.json` (e.g. `fr.json`, `pt-BR.json`) and translate the texts.
2. Add the code to `public/locales/languages.json`: `["en", "de", "fr"]`.

That is all – no code changes. It works the same in an existing build: put the file into `dist/locales/` and add the
code to `dist/locales/languages.json`, no rebuild needed. To try a language whatever the browser says, set
`data-lang="fr"` on the game element in `index.html`.

## High scores

The best 10 scores are kept in the browser's IndexedDB (database `polonaise`, store `scores`) with the player's name,
the score, the song reached and the date. After a game good enough for the list the game asks for a name (up to 10
characters); the last name entered is suggested next time. The list stays in that browser; nothing is sent anywhere.
The sound setting and the last name are kept in the local storage.

## Controls

| Input                          | Action                                                     |
|--------------------------------|------------------------------------------------------------|
| Arrows / WASD, swipe           | steer the line                                             |
| Enter / Space, tap             | start, continue                                            |
| Escape / P, PAUSE button       | pause; in the pause Q (touch: long press) ends the game    |
| M, SOUND button                | sound on/off                                               |
| F, FULLSCREEN button           | fullscreen                                                 |

## GitHub Pages

The workflow `.github/workflows/pages.yml` builds the game with `npm run build:pages` on every push to `master` and
publishes `dist/` on GitHub Pages. To switch it on, choose *GitHub Actions* as the source under *Settings → Pages* of
the repository (it needs a public repository or a paid plan).

The Pages build is the normal build plus the link "Datenschutz/Impressum" at the bottom right, which opens the legal
notice and privacy policy in a dialog. They are in `pages/legal-notice.html`, which the Vite plugin in
`vite.config.ts` adds to `index.html` in the mode `pages` only – the normal build, which others put on their own
sites, does not contain them. The same plugin marks the Pages version with the robots meta tag `noindex, follow`, so
search engines leave it out (and follow its links).

## Source files

| Path                          | Content                                                                              |
|-------------------------------|--------------------------------------------------------------------------------------|
| `index.html`                  | the page: an element for the game and the script                                     |
| `src/main.ts`                 | entry point: finds the element, loads font, texts and scores, starts the game        |
| `src/app.ts`                  | title screen, game, name entry; the loop (60 ticks per second); keyboard and touch   |
| `src/game.ts`                 | game logic (port of `game.c` of the arcade cabinet, independent of the browser)      |
| `src/draw.ts`                 | graphics (port of `draw.c`): floor, furniture, sprites, status bar, screens          |
| `src/audio.ts`                | sounds and the looped music with the Web Audio API                                   |
| `src/i18n.ts`                 | language detection, loading of the language files, texts with placeholders/plurals   |
| `src/scores.ts`               | the high score list in the IndexedDB                                                 |
| `src/view.ts`                 | the HTML around the canvas: buttons and the name entry form                          |
| `src/style.css`               | the styles of the game element (bundled into `polonaise.js`)                         |
| `public/`                     | files copied into the build unchanged: sounds, font, language files, `.htaccess`     |
| `pages/legal-notice.html`     | legal notice and privacy policy of the GitHub Pages site                             |
| `vite.config.ts`              | build configuration                                                                  |
