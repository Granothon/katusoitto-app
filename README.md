# Katusoitto

An offline PWA for buskers: each song is a **PDF score + MP3 backing track**.
In player mode the score is shown on screen, the backing track plays, and the
pages can turn **automatically** based on timestamps in the backing track.

- **Fully local** – no server, no account, no network requests. All data
  (scores, backing tracks, page turns) is stored only in your own browser
  (IndexedDB).
- **Works offline** – a service worker caches the app.
- **Two themes** – dark (for evening gigs) and bright high-contrast (outdoors
  in sunlight), toggled with the ☀️/🌙 button.
- **Tempo control** – change the playback speed without changing pitch;
  remembered per song.
- **Installable** to the home screen (PWA).

## Folder structure

```
index.html              App shell
styles.css              Styles (dark + light theme)
app.js                  App logic (ES module)
sw.js                   Service worker (offline cache)
manifest.webmanifest    PWA manifest
icon.svg                App icon
vendor/                 Vendored pdf.js (pdf.js + pdf.worker.js)
```

The files in `vendor/` are copies from the `pdfjs-dist` package (see
`package.json`). `node_modules/` is not part of the repo and is not used at
runtime – only `vendor/` is served.

## Running locally

The app needs an HTTP(S) server (service workers and ES modules do not work over
the `file://` protocol). A lightweight local server, e.g.:

```bash
npx serve .
# or
python -m http.server 8000
```

Then open the shown address in a browser (e.g. http://localhost:8000).

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`,
   folder `/ (root)`.
3. The app will be available at `https://<user>.github.io/<repo>/`.

All paths are relative, so the app works under the project subpath as-is. Pages
provides HTTPS, which the PWA and service worker require.

> **Note:** don't commit copyrighted scores or backing tracks – the repo is
> public. `.gitignore` prevents `*.pdf` and `*.mp3` files from being committed
> by accident.

## Updating pdf.js

The `vendor/` files do not update automatically. When the `pdfjs-dist` version
changes:

```bash
npm install pdfjs-dist@latest
cp node_modules/pdfjs-dist/build/pdf.mjs        vendor/pdf.js
cp node_modules/pdfjs-dist/build/pdf.worker.mjs vendor/pdf.worker.js
```

After that, bump the `CACHE_NAME` version in `sw.js` so the new version is used.

## Security

The app opens arbitrary PDF files, so pdf.js is hardened (`isEvalSupported`,
`enableScripting`, `enableXfa` disabled) and `index.html` has a strict Content
Security Policy. All data stays on the device; nothing is sent out.

## License

This project is licensed under the **MIT** license – see [LICENSE](LICENSE).

The app bundles Mozilla's **pdf.js** library (`vendor/`), which is licensed
under the Apache License 2.0 – see [vendor/LICENSE](vendor/LICENSE).

It also bundles **Signalsmith Stretch** (`vendor/SignalsmithStretch.js`, from
the [`signalsmith-stretch`](https://www.npmjs.com/package/signalsmith-stretch)
package by Signalsmith Audio), used for high-quality tempo changes, which is
licensed under the MIT license.
