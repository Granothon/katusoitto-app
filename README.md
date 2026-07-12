# Katusoitto

Offline-PWA katusoittajalle: jokainen kappale = **PDF-nuotti + MP3-taustanauha**.
Soittotilassa nuotti näkyy näytöllä, taustanauha soi, ja sivut voivat kääntyä
**automaattisesti** taustanauhan aikaleimojen mukaan.

- **Täysin paikallinen** – ei palvelinta, ei tiliä, ei verkkokutsuja. Kaikki data
  (nuotit, taustanauhat, sivunvaihdot) tallentuu vain omaan selaimeesi (IndexedDB).
- **Toimii offline** – service worker tallentaa sovelluksen välimuistiin.
- **Kaksi teemaa** – tumma (illalle) ja kirkas korkeakontrastinen (ulos auringossa),
  ☀️/🌙-napilla.
- **Asennettavissa** kotinäytölle (PWA).

## Kansiorakenne

```
index.html              Sovelluksen runko
styles.css              Ulkoasu (tumma + kirkas teema)
app.js                  Sovelluslogiikka (ES-moduuli)
sw.js                   Service worker (offline-välimuisti)
manifest.webmanifest    PWA-manifesti
icon.svg                Sovelluskuvake
vendor/                 Vendoroitu pdf.js (pdf.js + pdf.worker.js)
```

`vendor/`-tiedostot ovat kopioita `pdfjs-dist`-paketista (ks. `package.json`).
`node_modules/` ei kuulu repoon eikä ajoon – vain `vendor/` palvellaan.

## Ajaminen paikallisesti

Sovellus tarvitsee HTTP(S)-palvelimen (service worker ja ES-moduulit eivät toimi
`file://`-protokollalla). Kevyt paikallinen palvelin, esim:

```bash
npx serve .
# tai
python -m http.server 8000
```

Avaa sitten selaimessa annettu osoite (esim. http://localhost:8000).

## Julkaisu GitHub Pagesiin

1. Push tämä repo GitHubiin.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, kansio `/ (root)`.
3. Sovellus löytyy osoitteesta `https://<käyttäjä>.github.io/<repo>/`.

Kaikki polut ovat suhteellisia, joten sovellus toimii project-sivun alipolussa
sellaisenaan. Pages tarjoaa HTTPS:n, jota PWA ja service worker vaativat.

> **Huom:** älä committaa tekijänoikeudellisia nuotteja tai taustanauhoja – repo on
> julkinen. `.gitignore` estää `*.pdf`- ja `*.mp3`-tiedostojen tallentumisen vahingossa.

## pdf.js:n päivitys

`vendor/`-tiedostot eivät päivity automaattisesti. Kun `pdfjs-dist`-versio vaihtuu:

```bash
npm install pdfjs-dist@uusin
cp node_modules/pdfjs-dist/build/pdf.mjs        vendor/pdf.js
cp node_modules/pdfjs-dist/build/pdf.worker.mjs vendor/pdf.worker.js
```

Nosta tämän jälkeen `sw.js`:n `CACHE_NAME`-versiota, jotta uusi versio otetaan käyttöön.

## Tietoturva

Sovellus avaa mielivaltaisia PDF-tiedostoja, joten pdf.js on kovennettu
(`isEvalSupported`, `enableScripting`, `enableXfa` pois) ja `index.html`:ssä on tiukka
Content Security Policy. Kaikki data pysyy laitteella; mitään ei lähetetä ulos.
