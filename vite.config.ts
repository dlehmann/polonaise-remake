/*
 * vite.config.ts - build and development server configuration.
 *
 * `vite` serves the game with live reload; `vite build` bundles all TypeScript
 * (and the CSS, inlined) into the single file dist/polonaise.js. The files in
 * public/ (sounds, font, language files) are copied to dist/ unchanged and are
 * loaded at runtime relative to polonaise.js, so the game works from any folder.
 *
 * The mode "pages" (`--mode pages`) builds the GitHub Pages version: the same
 * game, with the link "Datenschutz/Impressum" and its dialog from
 * pages/legal-notice.html added to index.html, and kept out of search engines
 * (robots "noindex, follow": the site points to the C64 version instead).
 */
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Injects the legal notice (link and dialog) before the end of the body of index.html, and the
 * robots meta tag "noindex, follow" into its head. */
function legalNotice(): Plugin {
    const file = new URL('./pages/legal-notice.html', import.meta.url);
    return {
        name: 'polonaise-legal-notice',
        configureServer(server) {
            // reload the page in the development server when the notice is edited
            server.watcher.add(file.pathname);
            server.watcher.on('change', path => {
                if (path === file.pathname)
                    server.ws.send({ type: 'full-reload' });
            });
        },
        transformIndexHtml(html) {
            return html
                .replace('</head>', '<meta name="robots" content="noindex, follow">\n</head>')
                .replace('</body>', `${readFileSync(file, 'utf8')}</body>`);
        },
    };
}

export default defineConfig(({ mode }) => ({
    // relative URLs in index.html: the build works in any folder (e.g. /polonaise/ on GitHub Pages)
    base: './',
    plugins: mode === 'pages' ? [legalNotice()] : [],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        // no polyfill chunk for <link rel="modulepreload">: there is only one module
        modulePreload: { polyfill: false },
        rollupOptions: {
            output: {
                // a fixed name without a hash, so other pages can embed the game by a stable URL
                entryFileNames: 'polonaise.js',
            },
        },
    },
}));
