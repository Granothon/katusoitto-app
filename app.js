import * as pdfjsLib from "./vendor/pdf.js";
import SignalsmithStretch from "./vendor/SignalsmithStretch.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "./vendor/pdf.worker.js";

/*
 * Apple WebKit (iPad/iPhone Safari, and iPadOS reporting as Mac):
 * the WebCodecs ImageDecoder API is absent and OffscreenCanvas is
 * unreliable on older iPads, which broke pdf.js rasterisation there.
 * Modern Chrome/Firefox handle both well, so gate the fast image
 * paths off only on WebKit and keep full-speed rendering elsewhere.
 */
const IS_APPLE_WEBKIT =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" &&
    navigator.maxTouchPoints > 1) ||
  (/Safari/.test(navigator.userAgent) &&
    !/Chrome|Chromium|Android|CriOS|FxiOS|Edg/.test(
      navigator.userAgent
    ));

const PDF_COMPAT_OPTIONS = {
  isImageDecoderSupported:
    typeof ImageDecoder !== "undefined" && !IS_APPLE_WEBKIT,
  isOffscreenCanvasSupported:
    typeof OffscreenCanvas !== "undefined" && !IS_APPLE_WEBKIT
};

const DB_NAME = "katusoitto-db";
const DB_VERSION = 1;
const SONG_STORE = "songs";

const MIN_PDF_ZOOM = 1;
const MAX_PDF_ZOOM = 4;

const MIN_TEMPO = 0.5;
const MAX_TEMPO = 1.5;

/*
 * Baroque tuning: A = 415 Hz is one semitone below concert A = 440 Hz.
 * Signalsmith shifts pitch without touching tempo, so playing the
 * backing track down this many semitones lets 415-tuned instruments
 * play along. 12 * log2(415/440) ≈ -1.017 semitones (lands on 415 Hz).
 */
const CONCERT_PITCH_HZ = 440;
const BAROQUE_PITCH_HZ = 415;
const BAROQUE_SEMITONES =
  12 * Math.log2(BAROQUE_PITCH_HZ / CONCERT_PITCH_HZ);

let db;
let songs = [];

let currentSong = null;
let currentPdf = null;
let currentPage = 1;

/*
 * Web Audio playback engine (Signalsmith Stretch).
 * Replaces the <audio> element so tempo can change with
 * high quality and no pitch shift.
 */
let audioContext = null;
let stretchNode = null;
let audioDuration = 0;
let isPlaying = false;
let audioLoading = false;
let audioWarmupPromise = null;

let currentTempo = 1;

/*
 * Pitch shift in semitones (0 = A440, BAROQUE_SEMITONES = A415).
 * Non-zero forces the stretch engine, since the direct path cannot
 * shift pitch.
 */
let pitchSemitones = 0;

/*
 * At 100 % tempo we skip the CPU-heavy time-stretch engine and
 * play the decoded buffer straight through a plain source node.
 * Default playback then stays smooth even on weak hardware (e.g.
 * an older iPad) where the real-time stretcher underruns and
 * stutters or stalls. The stretch engine is only engaged when the
 * tempo is actually changed. `playbackPosition` is the canonical
 * play head (seconds) whenever nothing is actively playing.
 */
let audioBuffer = null;
let directSource = null;
let directStartContextTime = 0;
let directStartOffset = 0;
let playbackPosition = 0;
let directTimer = null;

/*
 * Which engine is actually playing right now: "direct", "stretch" or
 * null. Tracked separately from isDirectMode() (which reflects the
 * desired engine for the current tempo/pitch) so that changing tempo
 * or pitch mid-playback stops the engine that is really running, not
 * the one the new settings would use.
 */
let activeEngine = null;

let rendering = false;
let pendingRenderPage = null;

/*
 * Two-page spread: show two pages side by side when the
 * viewport is wide enough. Set by renderPage().
 */
let twoPageMode = false;

/*
 * PDF zoom.
 *
 * A value of 1 means Fit page mode.
 */
let pdfZoom = 1;

let pinchStartDistance = 0;
let pinchStartZoom = 1;
let pinchPreviewZoom = 1;
let pinchInProgress = false;

let swipeTracking = false;
let swipeStartX = 0;
let swipeStartY = 0;

let lastPdfTapTime = 0;

let renamingSongId = null;

/*
 * Drag-reorder state. Library cards lift on a still half-second hold
 * (touch) or on drag movement (mouse); setlist rows lift instantly
 * from their ≡ handle. Move/up events are handled at window level and
 * pointer capture is taken on documentElement: capturing the dragged
 * element itself would break mid-drag, because a DOM re-insertion
 * (the reorder) makes the browser release its capture.
 * suppressNextClick swallows the click a finished drag produces.
 */
let cardDrag = null;
let setlistDrag = null;
let suppressNextClick = false;

/*
 * Setlist & gig state. setlist holds song ids in play order;
 * gigIndex is the current position of an active gig (null = no gig);
 * gigSongOpen marks that the open player song was opened via the gig,
 * so the next-song button advances the setlist.
 */
const SETLIST_STORAGE_KEY = "katusoitto-setlist";

let setlist = [];
let gigIndex = null;
let gigSongOpen = false;

let pendingImport = {
  pdf: null,
  mp3: null
};

/*
 * Library elements
 */

const libraryView =
  document.querySelector("#libraryView");

const playerView =
  document.querySelector("#playerView");

const songGrid =
  document.querySelector("#songGrid");

const emptyState =
  document.querySelector("#emptyState");

const songCount =
  document.querySelector("#songCount");

const exportButton =
  document.querySelector("#exportButton");

const importButton =
  document.querySelector("#importButton");

const importInput =
  document.querySelector("#importInput");

/*
 * Adding files
 */

const dropZone =
  document.querySelector("#dropZone");

const dropZoneTitle =
  document.querySelector("#dropZoneTitle");

const dropZoneStatus =
  document.querySelector("#dropZoneStatus");

const pendingFiles =
  document.querySelector("#pendingFiles");

const pendingPdf =
  document.querySelector("#pendingPdf");

const pendingMp3 =
  document.querySelector("#pendingMp3");

const fileInput =
  document.querySelector("#fileInput");

const chooseFilesButton =
  document.querySelector("#chooseFilesButton");

/*
 * Player elements
 */

const backButton =
  document.querySelector("#backButton");

const currentSongTitle =
  document.querySelector("#currentSongTitle");

const pageIndicator =
  document.querySelector("#pageIndicator");

const pdfArea =
  document.querySelector("#pdfArea");

const pdfCanvas =
  document.querySelector("#pdfCanvas");

const previousPageButton =
  document.querySelector("#previousPageButton");

const nextPageButton =
  document.querySelector("#nextPageButton");

/*
 * Backing track
 */

const playPauseButton =
  document.querySelector("#playPauseButton");

const restartButton =
  document.querySelector("#restartButton");

const nextSongButton =
  document.querySelector("#nextSongButton");

const audioSeek =
  document.querySelector("#audioSeek");

const currentTimeElement =
  document.querySelector("#currentTime");

const durationElement =
  document.querySelector("#duration");

const tempoValue =
  document.querySelector("#tempoValue");

const pitchToggle =
  document.querySelector("#pitchToggle");

const renameDialog =
  document.querySelector("#renameDialog");

const renameInput =
  document.querySelector("#renameInput");

const renameCancelButton =
  document.querySelector("#renameCancelButton");

/*
 * Setlist & gig
 */

const setlistView =
  document.querySelector("#setlistView");

const setlistButton =
  document.querySelector("#setlistButton");

const setlistBackButton =
  document.querySelector("#setlistBackButton");

const setlistSummary =
  document.querySelector("#setlistSummary");

const startGigButton =
  document.querySelector("#startGigButton");

const resumeGigButton =
  document.querySelector("#resumeGigButton");

const endGigButton =
  document.querySelector("#endGigButton");

const setlistItems =
  document.querySelector("#setlistItems");

const setlistCandidates =
  document.querySelector("#setlistCandidates");

const gigIndicator =
  document.querySelector("#gigIndicator");

const toast =
  document.querySelector("#toast");

/*
 * IndexedDB
 */

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request =
      indexedDB.open(
        DB_NAME,
        DB_VERSION
      );

    request.onupgradeneeded = () => {
      const database =
        request.result;

      if (
        !database.objectStoreNames.contains(
          SONG_STORE
        )
      ) {
        const store =
          database.createObjectStore(
            SONG_STORE,
            {
              keyPath: "id"
            }
          );

        store.createIndex(
          "createdAt",
          "createdAt"
        );
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function getAllSongs() {
  return new Promise((resolve, reject) => {
    const transaction =
      db.transaction(
        SONG_STORE,
        "readonly"
      );

    const store =
      transaction.objectStore(
        SONG_STORE
      );

    const request =
      store.getAll();

    request.onsuccess = () => {
      const result =
        request.result.sort(
          (a, b) => {
            /*
             * Manual library order when present; songs from before
             * the order field fall back to creation time.
             */
            const orderA =
              Number.isFinite(a.order)
                ? a.order
                : Number.MAX_SAFE_INTEGER;

            const orderB =
              Number.isFinite(b.order)
                ? b.order
                : Number.MAX_SAFE_INTEGER;

            if (orderA !== orderB) {
              return orderA - orderB;
            }

            return a.createdAt.localeCompare(
              b.createdAt
            );
          }
        );

      resolve(result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/*
 * Normalise library order to 0..n-1. Migrates songs from before the
 * order field (assigned by their creation-time position) and heals
 * any gaps left by deletions.
 */
async function ensureSongOrder() {
  for (let i = 0; i < songs.length; i++) {
    if (songs[i].order !== i) {
      songs[i].order = i;
      await saveSong(songs[i]);
    }
  }
}

async function saveSong(song) {
  return new Promise((resolve, reject) => {
    const transaction =
      db.transaction(
        SONG_STORE,
        "readwrite"
      );

    transaction
      .objectStore(SONG_STORE)
      .put(song);

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error);
    };
  });
}

async function removeSong(id) {
  return new Promise((resolve, reject) => {
    const transaction =
      db.transaction(
        SONG_STORE,
        "readwrite"
      );

    transaction
      .objectStore(SONG_STORE)
      .delete(id);

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error);
    };
  });
}

/*
 * PDF page count
 */

async function readPdfPageCount(file) {
  let pdfDocument = null;

  try {
    const data =
      await file.arrayBuffer();

    pdfDocument =
      await pdfjsLib
        .getDocument({
          data,
          isEvalSupported: false,
          enableScripting: false,
          enableXfa: false,
          ...PDF_COMPAT_OPTIONS
        })
        .promise;

    return pdfDocument.numPages;
  } catch (error) {
    console.error(
      "Could not read PDF page count:",
      error
    );

    return 1;
  } finally {
    if (pdfDocument) {
      try {
        await pdfDocument.destroy();
      } catch (error) {
        console.warn(
          "Could not release PDF document:",
          error
        );
      }
    }
  }
}

async function ensurePdfPageCounts() {
  let songsUpdated = false;

  for (const song of songs) {
    const savedPageCount =
      Number(
        song.pdf?.pageCount
      );

    if (
      Number.isInteger(savedPageCount) &&
      savedPageCount > 0
    ) {
      continue;
    }

    if (!song.pdf?.file) {
      song.pdf.pageCount = 1;

      await saveSong(song);

      songsUpdated = true;
      continue;
    }

    try {
      song.pdf.pageCount =
        await readPdfPageCount(
          song.pdf.file
        );

      await saveSong(song);

      songsUpdated = true;
    } catch (error) {
      console.error(
        `Could not read page count for song "${song.title}":`,
        error
      );
    }
  }

  if (songsUpdated) {
    songs =
      await getAllSongs();
  }
}

/*
 * Adding files
 */

async function addFiles(fileList) {
  const files =
    [...fileList];

  let recognizedFileFound =
    false;

  for (const file of files) {
    const lowerName =
      file.name.toLowerCase();

    const isPdf =
      file.type === "application/pdf" ||
      lowerName.endsWith(".pdf");

    const isMp3 =
      file.type === "audio/mpeg" ||
      lowerName.endsWith(".mp3");

    if (isPdf) {
      pendingImport.pdf = file;
      recognizedFileFound = true;
    }

    if (isMp3) {
      pendingImport.mp3 = file;
      recognizedFileFound = true;
    }
  }

  if (!recognizedFileFound) {
    showToast(
      "The file must be a PDF or MP3."
    );

    return;
  }

  updatePendingImportDisplay();

  if (
    !pendingImport.pdf ||
    !pendingImport.mp3
  ) {
    if (pendingImport.pdf) {
      showToast(
        "PDF ready. Add an MP3 too."
      );
    } else {
      showToast(
        "MP3 ready. Add a PDF too."
      );
    }

    return;
  }

  await createSongFromPendingFiles();
}

async function createSongFromPendingFiles() {
  const pdfFile =
    pendingImport.pdf;

  const mp3File =
    pendingImport.mp3;

  if (!pdfFile || !mp3File) {
    return;
  }

  dropZoneTitle.textContent =
    "Saving song";

  dropZoneStatus.textContent =
    "";

  try {
    const title =
      findCommonTitle(
        pdfFile.name,
        mp3File.name
      );

    const [
      metadata,
      pageCount
    ] = await Promise.all([
      readAudioMetadata(mp3File),
      readPdfPageCount(pdfFile)
    ]);

    const song = {
      id: crypto.randomUUID(),

      title,

      createdAt:
        new Date().toISOString(),

      /* New songs go to the end of the library. */
      order: songs.length,

      pdf: {
        name: pdfFile.name,
        file: pdfFile,
        pageCount
      },

      audio: {
        name: mp3File.name,
        file: mp3File,
        duration: metadata.duration
      },

      settings: {
        autoTurnEnabled: true,
        warningSeconds: 5,
        playbackRate: 1,
        baroquePitch: false
      },

      pageTurns: []
    };

    await saveSong(song);

    pendingImport = {
      pdf: null,
      mp3: null
    };

    fileInput.value = "";

    songs =
      await getAllSongs();

    updatePendingImportDisplay();
    renderLibrary();

    showToast(
      `Song "${title}" added to the library.`
    );
  } catch (error) {
    console.error(error);

    showToast(
      "Could not save the song."
    );

    updatePendingImportDisplay();
  }
}

function updatePendingImportDisplay() {
  const hasPdf =
    Boolean(
      pendingImport.pdf
    );

  const hasMp3 =
    Boolean(
      pendingImport.mp3
    );

  const hasPendingFile =
    hasPdf || hasMp3;

  pendingFiles.classList.toggle(
    "hidden",
    !hasPendingFile
  );

  pendingPdf.className = [
    "pending-file",
    hasPdf
      ? "ready"
      : "waiting"
  ].join(" ");

  pendingMp3.className = [
    "pending-file",
    hasMp3
      ? "ready"
      : "waiting"
  ].join(" ");

  pendingPdf.textContent =
    hasPdf
      ? `PDF: ${pendingImport.pdf.name}`
      : "PDF missing";

  pendingMp3.textContent =
    hasMp3
      ? `MP3: ${pendingImport.mp3.name}`
      : "MP3 missing";

  if (hasPdf && !hasMp3) {
    dropZoneTitle.textContent =
      "Add an MP3 backing track";

    dropZoneStatus.textContent =
      "PDF selected";
  } else if (!hasPdf && hasMp3) {
    dropZoneTitle.textContent =
      "Add a PDF score";

    dropZoneStatus.textContent =
      "MP3 selected";
  } else if (hasPdf && hasMp3) {
    dropZoneTitle.textContent =
      "Saving song";

    dropZoneStatus.textContent =
      "";
  } else {
    dropZoneTitle.textContent =
      "Add a new song";

    dropZoneStatus.textContent =
      "Drop a PDF and MP3 here";
  }
}

function cleanFileName(name) {
  return name
    .replace(
      /\.(pdf|mp3)$/i,
      ""
    )
    .replace(
      /[-_]*(backing|track|tausta|nuotti|score|instrumental)[-_]*/gi,
      " "
    )
    .replace(
      /[_-]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function findCommonTitle(
  pdfName,
  mp3Name
) {
  const pdfTitle =
    cleanFileName(pdfName);

  const mp3Title =
    cleanFileName(mp3Name);

  if (
    pdfTitle.toLowerCase() ===
    mp3Title.toLowerCase()
  ) {
    return pdfTitle;
  }

  return (
    pdfTitle ||
    mp3Title ||
    "Untitled song"
  );
}

function readAudioMetadata(file) {
  return new Promise(resolve => {
    const audio =
      new Audio();

    const url =
      URL.createObjectURL(file);

    audio.preload = "metadata";
    audio.src = url;

    audio.onloadedmetadata = () => {
      const duration =
        Number.isFinite(
          audio.duration
        )
          ? audio.duration
          : 0;

      URL.revokeObjectURL(url);

      resolve({
        duration
      });
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);

      resolve({
        duration: 0
      });
    };
  });
}

/*
 * Library
 */

/*
 * Persistent storage + library backup (export / import as JSON)
 */

async function requestPersistentStorage() {
  try {
    if (
      navigator.storage &&
      navigator.storage.persist
    ) {
      await navigator.storage.persist();
    }
  } catch (error) {
    console.warn(
      "Persistent storage request failed:",
      error
    );
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(reader.result);
    };

    reader.onerror = () => {
      reject(reader.error);
    };

    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  /*
   * Only fetch inline data: URLs. A backup file is untrusted input,
   * so this stops a crafted entry from making the app request an
   * arbitrary (external or same-origin) URL on import.
   */
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:")
  ) {
    throw new Error("Unsupported data URL in backup");
  }

  const response = await fetch(dataUrl);
  return response.blob();
}

async function exportLibrary() {
  if (songs.length === 0) {
    showToast("Library is empty.");
    return;
  }

  showToast("Preparing backup…");

  try {
    const exportedSongs = [];

    for (const song of songs) {
      exportedSongs.push({
        id: song.id,
        title: song.title,
        createdAt: song.createdAt,
        order: song.order,
        pdf: {
          name: song.pdf.name,
          pageCount: song.pdf.pageCount,
          data: await blobToDataUrl(song.pdf.file)
        },
        audio: {
          name: song.audio.name,
          duration: song.audio.duration,
          data: await blobToDataUrl(song.audio.file)
        },
        settings: song.settings,
        pageTurns: song.pageTurns
      });
    }

    const payload = JSON.stringify({
      app: "katusoitto",
      version: 1,
      exportedAt: new Date().toISOString(),
      songs: exportedSongs
    });

    const blob = new Blob([payload], {
      type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
      `katusoitto-library-${
        new Date().toISOString().slice(0, 10)
      }.json`;

    link.click();

    URL.revokeObjectURL(url);

    showToast(
      `Exported ${songs.length} ${
        songs.length === 1 ? "song" : "songs"
      }.`
    );
  } catch (error) {
    console.error(error);
    showToast("Could not export the library.");
  }
}

async function importLibrary(file) {
  showToast("Importing…");

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (
      !parsed ||
      !Array.isArray(parsed.songs)
    ) {
      showToast(
        "Not a valid Katusoitto backup."
      );
      return;
    }

    let imported = 0;

    for (const entry of parsed.songs) {
      if (
        !entry.pdf?.data ||
        !entry.audio?.data
      ) {
        continue;
      }

      const pdfBlob =
        await dataUrlToBlob(entry.pdf.data);

      const audioBlob =
        await dataUrlToBlob(entry.audio.data);

      const song = {
        id:
          entry.id ||
          crypto.randomUUID(),
        title:
          entry.title ||
          "Untitled song",
        createdAt:
          entry.createdAt ||
          new Date().toISOString(),
        /*
         * Imported songs append to the end of the library in backup
         * order (entry.order could collide with existing songs).
         */
        order: songs.length + imported,
        pdf: {
          name:
            entry.pdf.name || "score.pdf",
          file: new File(
            [pdfBlob],
            entry.pdf.name || "score.pdf",
            { type: "application/pdf" }
          ),
          pageCount:
            entry.pdf.pageCount || 1
        },
        audio: {
          name:
            entry.audio.name || "track.mp3",
          file: new File(
            [audioBlob],
            entry.audio.name || "track.mp3",
            { type: "audio/mpeg" }
          ),
          duration:
            entry.audio.duration || 0
        },
        settings:
          entry.settings || {
            autoTurnEnabled: true,
            warningSeconds: 5,
            playbackRate: 1,
            baroquePitch: false
          },
        pageTurns:
          Array.isArray(entry.pageTurns)
            ? entry.pageTurns
            : []
      };

      await saveSong(song);
      imported++;
    }

    songs = await getAllSongs();
    renderLibrary();

    showToast(
      `Imported ${imported} ${
        imported === 1 ? "song" : "songs"
      }.`
    );
  } catch (error) {
    console.error(error);
    showToast("Could not import the backup.");
  }
}

function renderLibrary() {
  songGrid.innerHTML = "";

  songCount.textContent =
    `${songs.length} ${
      songs.length === 1
        ? "song"
        : "songs"
    }`;

  emptyState.classList.toggle(
    "hidden",
    songs.length > 0
  );

  for (const song of songs) {
    const card =
      document.createElement(
        "button"
      );

    card.className =
      "song-card";

    card.type =
      "button";

    const pageCount =
      Number(
        song.pdf?.pageCount
      ) || 1;

    const pageInformation =
      pageCount > 1
        ? `
          <span>
            ${pageCount} pages
          </span>
        `
        : "";

    card.innerHTML = `
      <strong class="song-card-title">
        ${escapeHtml(song.title)}
      </strong>

      <span class="song-card-details">
        <span>
          Backing track
          ${formatTime(
            song.audio.duration
          )}
        </span>

        ${pageInformation}
      </span>

      <span
        class="rename-song-button"
        role="button"
        aria-label="Rename song"
        title="Rename song"
      >
        ✎
      </span>

      <span
        class="delete-song-button"
        role="button"
        aria-label="Delete song"
        title="Delete song"
      >
        ✕
      </span>
    `;

    card.dataset.songId = song.id;

    card.addEventListener(
      "click",
      event => {
        if (
          event.target.closest(
            ".delete-song-button"
          )
        ) {
          event.stopPropagation();

          deleteSong(song);

          return;
        }

        if (
          event.target.closest(
            ".rename-song-button"
          )
        ) {
          event.stopPropagation();

          openRename(song.id);

          return;
        }

        openSong(song.id);
      }
    );

    /* Right-click rename stays as a desktop shortcut. */
    card.addEventListener(
      "contextmenu",
      event => {
        if (
          event.target.closest(".delete-song-button") ||
          event.target.closest(".rename-song-button")
        ) {
          return;
        }

        event.preventDefault();
        openRename(song.id);
      }
    );

    attachCardDrag(card);

    songGrid.appendChild(
      card
    );
  }

  /* The setlist view mirrors the library (titles, candidates). */
  renderSetlist();
}

/*
 * Drag-reorder: library grid
 *
 * Touch: a still ~half-second hold lifts the card, then dragging
 * moves it (moving early is a scroll and cancels the hold). Mouse:
 * dragging past a small threshold lifts it, so a plain click still
 * opens the song.
 */

function attachCardDrag(card) {
  card.addEventListener(
    "pointerdown",
    event => {
      if (
        cardDrag ||
        setlistDrag ||
        event.button !== 0 ||
        event.target.closest(".delete-song-button") ||
        event.target.closest(".rename-song-button")
      ) {
        return;
      }

      cardDrag = {
        el: card,
        container: songGrid,
        selector: ".song-card",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lifted: false,
        holdTimer: null,
        lockX: false,
        /*
         * Tidal-style: the card stays highlighted in its slot and
         * only the drop line follows the finger.
         */
        float: false
      };

      if (event.pointerType !== "mouse") {
        cardDrag.holdTimer =
          setTimeout(() => {
            liftCard(
              cardDrag.startX,
              cardDrag.startY
            );
          }, 450);
      }
    }
  );
}

function liftCard(x, y) {
  if (!cardDrag || cardDrag.lifted) {
    return;
  }

  clearTimeout(cardDrag.holdTimer);

  cardDrag.lifted = true;

  beginDragVisual(cardDrag, x, y);
}

/*
 * Drag visuals: the lifted element floats with the pointer via a
 * transform (a small pick-up "pop" eases it up from the pressed
 * state), displaced siblings glide to their new slots with a FLIP
 * animation, and on release the element settles into its slot.
 */

/*
 * With the drop-indicator model nothing reflows during a drag, so
 * all geometry (container area, every sibling's box, the gap) can
 * be measured once at lift time. The pointermove path then performs
 * no DOM reads at all — only transform writes — which keeps the
 * float perfectly smooth on slower hardware.
 */
function snapshotDragGeometry(drag) {
  const areaRect =
    drag.container.getBoundingClientRect();

  drag.areaRect = areaRect;

  drag.baseX =
    areaRect.left + drag.el.offsetLeft;

  drag.baseY =
    areaRect.top + drag.el.offsetTop;

  drag.width = drag.el.offsetWidth;
  drag.height = drag.el.offsetHeight;

  drag.items = [
    ...drag.container.querySelectorAll(
      drag.selector
    )
  ]
    .filter(el => el !== drag.el)
    .map(el => {
      return {
        el,
        left: areaRect.left + el.offsetLeft,
        top: areaRect.top + el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
        offsetLeft: el.offsetLeft,
        offsetTop: el.offsetTop
      };
    });

  const containerStyle =
    getComputedStyle(drag.container);

  drag.gap =
    parseFloat(containerStyle.gap) || 12;

  /*
   * A one-column grid reads like a list: use horizontal drop lines
   * between rows there instead of vertical ones beside the cards.
   */
  const columnCount =
    containerStyle.gridTemplateColumns
      .split(" ")
      .length;

  drag.horizontal =
    drag.lockX || columnCount === 1;
}

function beginDragVisual(drag, x, y) {
  snapshotDragGeometry(drag);

  drag.grabX = x - drag.baseX;
  drag.grabY = y - drag.baseY;

  /* Where the item would land if released; none yet. */
  drag.dropNode = null;
  drag.dropBefore = false;
  drag.dropSpot = null;

  drag.el.classList.add("dragging");

  if (drag.float) {
    drag.el.style.willChange =
      "transform";

    /* Pick-up pop, then raw pointer-following. */
    drag.el.style.transition =
      "transform 130ms ease";

    drag.popTimer =
      setTimeout(() => {
        if (drag === cardDrag || drag === setlistDrag) {
          drag.el.style.transition = "none";
        }
      }, 150);
  }

  updateDragPosition(drag, x, y);

  capturePointerForDrag(drag.pointerId);
}

function clampValue(value, low, high) {
  if (high < low) {
    return low;
  }

  return Math.min(
    Math.max(value, low),
    high
  );
}

/*
 * Track the drag position, confined to the item's own container:
 * the drop point cannot leave the grid/list area. Uses only cached
 * geometry — no DOM reads on this path.
 *
 * Grid: the card stays put and only the pointer (→ the drop line)
 * moves. Setlist: the full-size row also floats with the finger on
 * the vertical axis.
 */
function updateDragPosition(drag, x, y) {
  const area = drag.areaRect;

  let centerX;
  let centerY;

  if (drag.float) {
    const top =
      clampValue(
        y - drag.grabY,
        area.top,
        area.bottom - drag.height
      );

    centerX =
      drag.baseX + drag.width / 2;

    centerY =
      top + drag.height / 2;

    const dy =
      centerY -
      (drag.baseY + drag.height / 2);

    drag.el.style.transform =
      `translate(0px, ${dy}px) scale(${drag.scale})`;
  } else {
    /* No float: the pointer itself picks the drop point. */
    centerX =
      clampValue(x, area.left, area.right);

    centerY =
      clampValue(y, area.top, area.bottom);
  }

  drag.centerX = centerX;
  drag.centerY = centerY;
}

function settleDrag(drag) {
  clearTimeout(drag.popTimer);

  const el = drag.el;

  el.classList.remove("dragging");
  el.classList.add("drag-settle");

  el.style.transition = "";

  requestAnimationFrame(() => {
    el.style.transform = "";
  });

  setTimeout(() => {
    el.classList.remove("drag-settle");
    el.style.willChange = "";
  }, 150);
}

/*
 * Drop indicator: while dragging, the other items stay put and a
 * thin accent line marks where the item would land if released —
 * a vertical line between cards in the grid, a horizontal one
 * between rows in the setlist. The one reorder happens on release.
 */

const dropIndicator =
  document.createElement("div");

dropIndicator.className =
  "drop-indicator";

function hideDropIndicator() {
  dropIndicator.classList.remove("visible");
  dropIndicator.remove();
}

function updateDropIndicator(drag) {
  /*
   * Back over the item's own (now empty) slot: releasing here means
   * "no move", so clear the line.
   */
  if (
    drag.centerX >= drag.baseX &&
    drag.centerX <= drag.baseX + drag.width &&
    drag.centerY >= drag.baseY &&
    drag.centerY <= drag.baseY + drag.height
  ) {
    drag.dropNode = null;
    drag.dropSpot = null;
    hideDropIndicator();
    return;
  }

  /* Hit-test against the cached geometry: no DOM reads. */
  const spot =
    drag.items.find(item => {
      return (
        drag.centerX >= item.left &&
        drag.centerX <= item.left + item.width &&
        drag.centerY >= item.top &&
        drag.centerY <= item.top + item.height
      );
    });

  if (!spot) {
    /* Over a gap: keep the previous drop point. */
    return;
  }

  const before =
    drag.horizontal
      ? drag.centerY < spot.top + spot.height / 2
      : drag.centerX < spot.left + spot.width / 2;

  if (
    drag.dropNode === spot.el &&
    drag.dropBefore === before
  ) {
    return;
  }

  drag.dropNode = spot.el;
  drag.dropBefore = before;
  drag.dropSpot = spot;

  positionDropIndicator(drag);
}

function positionDropIndicator(drag) {
  const spot = drag.dropSpot;
  const gap = drag.gap;

  const style = dropIndicator.style;

  if (drag.horizontal) {
    /* Horizontal line between rows. */
    const y =
      drag.dropBefore
        ? spot.offsetTop - gap / 2
        : spot.offsetTop +
          spot.height +
          gap / 2;

    style.left = "6px";
    style.right = "6px";
    style.width = "auto";
    style.top = `${y - 1.5}px`;
    style.height = "3px";
  } else {
    /* Vertical line beside a card. */
    const x =
      drag.dropBefore
        ? spot.offsetLeft - gap / 2
        : spot.offsetLeft +
          spot.width +
          gap / 2;

    style.top =
      `${spot.offsetTop + 6}px`;

    style.height =
      `${spot.height - 12}px`;

    style.left = `${x - 1.5}px`;
    style.right = "auto";
    style.width = "3px";
  }

  if (
    dropIndicator.parentElement !==
    drag.container
  ) {
    drag.container.appendChild(
      dropIndicator
    );
  }

  dropIndicator.classList.add("visible");
}

/*
 * Wheel-scrolling with a mouse mid-drag shifts the cached viewport
 * geometry; re-measure so the line and hit-tests stay honest.
 */
window.addEventListener(
  "scroll",
  () => {
    if (cardDrag?.lifted) {
      snapshotDragGeometry(cardDrag);
    }

    if (setlistDrag) {
      snapshotDragGeometry(setlistDrag);
    }
  },
  {
    passive: true
  }
);

/*
 * Release: perform the one reorder, and everything glides. Displaced
 * items FLIP to their new slots. A floating item (setlist) settles
 * from where it hovers; a non-floating one (grid card) FLIPs from
 * its old slot to the new one, riding on top while it travels.
 */
function completeDrop(drag) {
  hideDropIndicator();

  const el = drag.el;
  const moving = Boolean(drag.dropNode);

  let items = [];
  const before = new Map();

  if (moving) {
    items = [
      ...drag.container.querySelectorAll(
        drag.selector
      )
    ];

    for (const item of items) {
      before.set(
        item,
        item.getBoundingClientRect()
      );
    }

    const reference =
      drag.dropBefore
        ? drag.dropNode
        : drag.dropNode.nextSibling;

    drag.container.insertBefore(
      el,
      reference
    );
  }

  if (drag.float) {
    reanchorDrag(drag);
    settleDrag(drag);
  } else {
    clearTimeout(drag.popTimer);

    el.classList.remove("dragging");
    el.style.willChange = "";

    if (moving) {
      /* Ride on top while gliding to the new slot. */
      el.classList.add("drag-settle");

      setTimeout(() => {
        el.classList.remove("drag-settle");
      }, 150);
    }
  }

  if (moving) {
    for (const item of items) {
      if (drag.float && item === el) {
        continue;
      }

      const prev = before.get(item);
      const next =
        item.getBoundingClientRect();

      const dx = prev.left - next.left;
      const dy = prev.top - next.top;

      if (dx || dy) {
        animateFlip(item, dx, dy);
      }
    }
  }
}

/*
 * Recompute the float transform against the element's (possibly
 * new) layout slot, so the visual position stays put while the
 * settle animation gets the right starting point.
 */
function reanchorDrag(drag) {
  const el = drag.el;

  el.style.transition = "none";
  el.style.transform = "none";

  const rect =
    el.getBoundingClientRect();

  const dx =
    drag.centerX -
    (rect.left + rect.width / 2);

  const dy =
    drag.centerY -
    (rect.top + rect.height / 2);

  el.style.transform =
    `translate(${dx}px, ${dy}px) scale(${drag.scale})`;
}

function animateFlip(el, dx, dy) {
  el.classList.add("flip-anim");

  el.style.transition = "none";
  el.style.transform =
    `translate(${dx}px, ${dy}px)`;

  /* Force the offset to take, then glide back to place. */
  void el.offsetWidth;

  el.style.transition = "";
  el.style.transform = "";

  const done = event => {
    if (
      event &&
      event.propertyName !== "transform"
    ) {
      return;
    }

    el.classList.remove("flip-anim");
    el.removeEventListener(
      "transitionend",
      done
    );
  };

  el.addEventListener(
    "transitionend",
    done
  );

  setTimeout(done, 150);
}

/*
 * Capture on documentElement, never on the dragged element: the
 * reorder re-inserts the element in the DOM, and that would make the
 * browser drop a capture held by the element itself (the drag would
 * die after the first swap). documentElement is never moved, so the
 * capture — and the drag — survive, even outside the window.
 */
function capturePointerForDrag(pointerId) {
  try {
    document.documentElement.setPointerCapture(
      pointerId
    );
  } catch (error) {
    /* capture unsupported; window-level listeners still work */
  }
}

function finishCardDrag() {
  if (!cardDrag) {
    return;
  }

  clearTimeout(cardDrag.holdTimer);

  if (cardDrag.lifted) {
    completeDrop(cardDrag);
    suppressNextClick = true;
    persistLibraryOrder();
  }

  cardDrag = null;
}

/*
 * Window-level drag plumbing, shared by the library grid and the
 * setlist. Listening here (instead of on the dragged element) keeps
 * the stream of move/up events alive across the DOM re-insertions
 * that the live reorder performs.
 */

window.addEventListener(
  "pointermove",
  event => {
    if (
      cardDrag &&
      event.pointerId === cardDrag.pointerId
    ) {
      if (!cardDrag.lifted) {
        const moved =
          Math.hypot(
            event.clientX - cardDrag.startX,
            event.clientY - cardDrag.startY
          );

        if (event.pointerType === "mouse") {
          if (moved > 6) {
            liftCard(
              event.clientX,
              event.clientY
            );
          }
        } else if (moved > 10) {
          /* The finger slid before the hold finished: a scroll. */
          finishCardDrag();
        }

        if (!cardDrag || !cardDrag.lifted) {
          return;
        }
      }

      updateDragPosition(
        cardDrag,
        event.clientX,
        event.clientY
      );

      updateDropIndicator(cardDrag);

      return;
    }

    if (
      setlistDrag &&
      event.pointerId === setlistDrag.pointerId
    ) {
      updateDragPosition(
        setlistDrag,
        event.clientX,
        event.clientY
      );

      updateDropIndicator(setlistDrag);
    }
  }
);

window.addEventListener(
  "pointerup",
  event => {
    if (
      cardDrag &&
      event.pointerId === cardDrag.pointerId
    ) {
      finishCardDrag();
    }

    if (
      setlistDrag &&
      event.pointerId === setlistDrag.pointerId
    ) {
      finishSetlistDrag();
    }
  }
);

window.addEventListener(
  "pointercancel",
  event => {
    if (
      cardDrag &&
      event.pointerId === cardDrag.pointerId
    ) {
      finishCardDrag();
    }

    if (
      setlistDrag &&
      event.pointerId === setlistDrag.pointerId
    ) {
      finishSetlistDrag();
    }
  }
);

/* Safety net: drop any drag if the app loses focus mid-drag. */
window.addEventListener(
  "blur",
  () => {
    finishCardDrag();
    finishSetlistDrag();
  }
);

/* Keep the page from scrolling while something is lifted. */
window.addEventListener(
  "touchmove",
  event => {
    if (cardDrag?.lifted || setlistDrag) {
      event.preventDefault();
    }
  },
  {
    passive: false
  }
);

/*
 * A finished drag produces a click (wherever the pointer was
 * released); swallow exactly that one so it cannot open a song or
 * press a button. Capture phase runs before any other handler. A
 * touch drag may produce no click at all, so any stale suppression
 * is cleared when the next interaction starts.
 */
window.addEventListener(
  "pointerdown",
  () => {
    suppressNextClick = false;
  }
);

window.addEventListener(
  "click",
  event => {
    if (suppressNextClick) {
      suppressNextClick = false;

      event.stopPropagation();
      event.preventDefault();
    }
  },
  {
    capture: true
  }
);



async function persistLibraryOrder() {
  const orderedIds = [
    ...songGrid.querySelectorAll(".song-card")
  ].map(card => card.dataset.songId);

  const reordered =
    orderedIds
      .map(id => {
        return songs.find(song => song.id === id);
      })
      .filter(Boolean);

  if (reordered.length !== songs.length) {
    return;
  }

  songs = reordered;

  for (let i = 0; i < songs.length; i++) {
    if (songs[i].order !== i) {
      songs[i].order = i;
      await saveSong(songs[i]);
    }
  }

  /* Candidate order in the setlist view follows the library. */
  renderSetlist();
}

async function deleteSong(song) {
  const accepted =
    confirm(
      `Delete song "${song.title}" from the library?`
    );

  if (!accepted) {
    return;
  }

  if (
    currentSong?.id ===
    song.id
  ) {
    resetCurrentPlayback();
  }

  await removeSong(song.id);

  songs =
    await getAllSongs();

  renderLibrary();

  showToast(
    "Song deleted from the library."
  );
}

/*
 * Setlist
 *
 * One ordered list of song ids, kept in localStorage together with
 * the gig position so a gig survives closing the app.
 */

function saveSetlistState() {
  try {
    localStorage.setItem(
      SETLIST_STORAGE_KEY,
      JSON.stringify({
        songIds: setlist,
        gigIndex
      })
    );
  } catch (error) {
    console.warn(
      "Could not save the setlist:",
      error
    );
  }

  updateSetlistButton();
}

function loadSetlistState() {
  try {
    const raw =
      localStorage.getItem(
        SETLIST_STORAGE_KEY
      );

    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed?.songIds)) {
      setlist =
        parsed.songIds.filter(id => {
          return typeof id === "string";
        });
    }

    gigIndex =
      Number.isInteger(parsed?.gigIndex)
        ? parsed.gigIndex
        : null;
  } catch (error) {
    console.warn(
      "Could not load the setlist:",
      error
    );
  }
}

/*
 * Drop songs that no longer exist and keep the gig position on the
 * same song (or clamped) after changes.
 */
function pruneSetlist() {
  const gigSongId =
    gigIndex !== null
      ? setlist[gigIndex]
      : null;

  setlist =
    setlist.filter(id => {
      return songs.some(song => song.id === id);
    });

  if (gigIndex !== null) {
    if (setlist.length === 0) {
      gigIndex = null;
    } else {
      const restored =
        gigSongId
          ? setlist.indexOf(gigSongId)
          : -1;

      gigIndex =
        restored !== -1
          ? restored
          : Math.min(gigIndex, setlist.length - 1);
    }
  }

  saveSetlistState();
}

function updateSetlistButton() {
  setlistButton.textContent =
    gigIndex !== null
      ? `Setlist · ${gigIndex + 1}/${setlist.length}`
      : "Setlist";
}

function renderSetlist() {
  if (
    setlist.some(id => {
      return !songs.some(song => song.id === id);
    })
  ) {
    pruneSetlist();
  }

  updateSetlistButton();

  setlistSummary.textContent =
    `${setlist.length} ${
      setlist.length === 1
        ? "song"
        : "songs"
    }`;

  const gigActive = gigIndex !== null;

  startGigButton.classList.toggle(
    "hidden",
    gigActive
  );

  startGigButton.disabled =
    setlist.length === 0;

  resumeGigButton.classList.toggle(
    "hidden",
    !gigActive
  );

  endGigButton.classList.toggle(
    "hidden",
    !gigActive
  );

  if (gigActive) {
    resumeGigButton.textContent =
      `Resume gig — ${gigIndex + 1} / ${setlist.length}`;
  }

  /* Ordered rows */

  setlistItems.innerHTML = "";

  if (setlist.length === 0) {
    const empty =
      document.createElement("p");

    empty.className = "setlist-empty";
    empty.textContent =
      "No songs yet — add songs below.";

    setlistItems.appendChild(empty);
  }

  setlist.forEach((id, index) => {
    const song =
      songs.find(item => item.id === id);

    if (!song) {
      return;
    }

    const row =
      document.createElement("div");

    row.className = "setlist-item";
    row.dataset.songId = id;

    if (gigIndex === index) {
      row.classList.add("current");
    }

    const handle =
      document.createElement("span");

    handle.className = "setlist-handle";
    handle.title = "Drag to reorder";
    handle.setAttribute(
      "aria-label",
      "Drag to reorder"
    );
    handle.textContent = "≡";

    const number =
      document.createElement("span");

    number.className = "setlist-index";
    number.textContent = `${index + 1}.`;

    const title =
      document.createElement("span");

    title.className = "setlist-title";
    title.textContent = song.title;

    const remove =
      document.createElement("button");

    remove.className = "setlist-remove";
    remove.type = "button";
    remove.title = "Remove from setlist";
    remove.setAttribute(
      "aria-label",
      "Remove from setlist"
    );
    remove.textContent = "✕";

    remove.addEventListener(
      "click",
      () => {
        removeFromSetlist(index);
      }
    );

    attachSetlistDrag(row, handle);

    row.append(
      handle,
      number,
      title,
      remove
    );

    setlistItems.appendChild(row);
  });

  /* Songs not yet on the list */

  setlistCandidates.innerHTML = "";

  const remaining =
    songs.filter(song => {
      return !setlist.includes(song.id);
    });

  if (remaining.length === 0) {
    const empty =
      document.createElement("p");

    empty.className = "setlist-empty";
    empty.textContent =
      songs.length === 0
        ? "The library is empty."
        : "All library songs are on the setlist.";

    setlistCandidates.appendChild(empty);

    return;
  }

  for (const song of remaining) {
    const button =
      document.createElement("button");

    button.className = "setlist-candidate";
    button.type = "button";

    const plus =
      document.createElement("span");

    plus.className = "setlist-candidate-plus";
    plus.textContent = "+";

    const label =
      document.createElement("span");

    label.className = "setlist-candidate-title";
    label.textContent = song.title;

    button.append(plus, label);

    button.addEventListener(
      "click",
      () => {
        setlist.push(song.id);
        saveSetlistState();
        renderSetlist();
      }
    );

    setlistCandidates.appendChild(button);
  }
}

function removeFromSetlist(index) {
  const gigSongId =
    gigIndex !== null
      ? setlist[gigIndex]
      : null;

  const removingCurrent =
    gigIndex === index;

  setlist.splice(index, 1);

  if (gigIndex !== null) {
    if (setlist.length === 0) {
      gigIndex = null;
    } else if (removingCurrent) {
      gigIndex =
        Math.min(index, setlist.length - 1);
    } else {
      gigIndex =
        setlist.indexOf(gigSongId);
    }
  }

  saveSetlistState();
  renderSetlist();
}

/*
 * Drag-reorder: setlist rows lift instantly from their ≡ handle.
 * The handle has touch-action: none, so no scroll wrangling needed.
 */
function attachSetlistDrag(row, handle) {
  handle.addEventListener(
    "pointerdown",
    event => {
      if (
        setlistDrag ||
        cardDrag ||
        event.button !== 0
      ) {
        return;
      }

      event.preventDefault();

      setlistDrag = {
        el: row,
        container: setlistItems,
        selector: ".setlist-item",
        pointerId: event.pointerId,
        /* A vertical list: full-size row floats on its own axis. */
        lockX: true,
        float: true,
        scale: 1.03
      };

      beginDragVisual(
        setlistDrag,
        event.clientX,
        event.clientY
      );
    }
  );
}

function finishSetlistDrag() {
  if (!setlistDrag) {
    return;
  }

  completeDrop(setlistDrag);
  setlistDrag = null;

  renumberSetlistRows();

  suppressNextClick = true;
  persistSetlistOrder();
}

function renumberSetlistRows() {
  const rows =
    setlistItems.querySelectorAll(
      ".setlist-item"
    );

  rows.forEach((row, index) => {
    row.querySelector(
      ".setlist-index"
    ).textContent = `${index + 1}.`;
  });
}

function persistSetlistOrder() {
  const gigSongId =
    gigIndex !== null
      ? setlist[gigIndex]
      : null;

  setlist = [
    ...setlistItems.querySelectorAll(
      ".setlist-item"
    )
  ].map(row => row.dataset.songId);

  if (gigSongId) {
    const restored =
      setlist.indexOf(gigSongId);

    gigIndex =
      restored !== -1
        ? restored
        : null;
  }

  saveSetlistState();

  /*
   * The rows already sit in the right DOM order and numbering is
   * kept live during the drag; a rebuild here would cut the drop
   * animation short. Refresh the labels only.
   */
  if (gigIndex !== null) {
    resumeGigButton.textContent =
      `Resume gig — ${gigIndex + 1} / ${setlist.length}`;
  }
}

/*
 * Setlist view switching
 */

function openSetlistView() {
  renderSetlist();

  libraryView.classList.add("hidden");
  setlistView.classList.remove("hidden");
}

function closeSetlistView() {
  setlistView.classList.add("hidden");
  libraryView.classList.remove("hidden");
}

/*
 * Gig mode
 */

async function startGig() {
  if (setlist.length === 0) {
    return;
  }

  gigIndex = 0;
  saveSetlistState();

  await openGigSong();
}

async function resumeGig() {
  if (gigIndex === null) {
    return;
  }

  await openGigSong();
}

function endGig() {
  if (gigIndex === null) {
    return;
  }

  const accepted =
    confirm(
      "End the gig? The setlist keeps its songs."
    );

  if (!accepted) {
    return;
  }

  gigIndex = null;
  gigSongOpen = false;

  saveSetlistState();
  renderSetlist();
}

async function openGigSong() {
  const id = setlist[gigIndex];

  if (!id) {
    return;
  }

  await openSong(id, true);
}

async function gigNextSong() {
  if (
    gigIndex === null ||
    gigIndex >= setlist.length - 1
  ) {
    return;
  }

  gigIndex++;
  saveSetlistState();

  await openGigSong();
}

/*
 * The gig position indicator in the player header; also gates the
 * next-song button at the end of the setlist.
 */
function updateGigIndicator() {
  if (!gigSongOpen || gigIndex === null) {
    gigIndicator.classList.add("hidden");

    nextSongButton.disabled = false;
    nextSongButton.title = "Next song";

    return;
  }

  const last =
    gigIndex >= setlist.length - 1;

  gigIndicator.textContent =
    `Gig ${gigIndex + 1} / ${setlist.length}` +
    (last ? " · last song" : "");

  gigIndicator.classList.remove("hidden");

  nextSongButton.disabled = last;

  nextSongButton.title =
    last
      ? "Last song of the gig"
      : "Next song in the setlist";
}

/*
 * Rename a song
 */

function openRename(songId) {
  if (renameDialog.open) {
    return;
  }

  const song =
    songs.find(item => item.id === songId);

  if (!song) {
    return;
  }

  renamingSongId = songId;
  renameInput.value = song.title;

  renameDialog.showModal();

  renameInput.focus();
  renameInput.select();
}

renameCancelButton.addEventListener(
  "click",
  () => {
    renameDialog.close("cancel");
  }
);

renameDialog.addEventListener(
  "close",
  async () => {
    const songId = renamingSongId;
    renamingSongId = null;

    if (
      renameDialog.returnValue !== "save" ||
      !songId
    ) {
      return;
    }

    const song =
      songs.find(item => item.id === songId);

    if (!song) {
      return;
    }

    const newTitle =
      renameInput.value.trim();

    if (!newTitle || newTitle === song.title) {
      return;
    }

    song.title = newTitle;

    await saveSong(song);

    if (currentSong?.id === songId) {
      currentSong.title = newTitle;
      currentSongTitle.textContent = newTitle;
    }

    renderLibrary();

    showToast("Song renamed.");
  }
);

/*
 * Play button state
 */

function updatePlayPauseButton(
  isPlaying
) {
  if (isPlaying) {
    playPauseButton.textContent =
      "⏸";

    playPauseButton.setAttribute(
      "aria-label",
      "Pause"
    );

    playPauseButton.title =
      "Pause";
  } else {
    playPauseButton.textContent =
      "▶";

    playPauseButton.setAttribute(
      "aria-label",
      "Play"
    );

    playPauseButton.title =
      "Play";
  }
}

/*
 * Reset playback
 */

function resetCurrentPlayback() {
  stopDirectSource();
  stopDirectTimer();

  if (stretchNode) {
    try {
      stretchNode.schedule({ active: false });
    } catch (error) {
      console.warn(
        "Could not stop playback:",
        error
      );
    }

    try {
      stretchNode.disconnect();
    } catch (error) {
      console.warn(
        "Could not disconnect audio node:",
        error
      );
    }

    stretchNode = null;
  }

  audioBuffer = null;
  activeEngine = null;
  isPlaying = false;
  playbackPosition = 0;
  audioDuration = 0;

  updatePlayPauseButton(false);

  currentTimeElement.textContent =
    "00:00";

  durationElement.textContent =
    "00:00";

  audioSeek.value = 0;
  audioSeek.max = 0;
}

/*
 * Reset PDF zoom
 */

function resetPdfZoomState() {
  pdfZoom = 1;

  pinchStartDistance = 0;
  pinchStartZoom = 1;
  pinchPreviewZoom = 1;
  pinchInProgress = false;

  pdfCanvas.style.transform =
    "none";

  pdfArea.classList.remove(
    "zoomed"
  );

  pdfArea.classList.add(
    "fit-page"
  );

  pdfArea.scrollTop = 0;
  pdfArea.scrollLeft = 0;
}

/*
 * Opening a song
 */

async function openSong(id, viaGig = false) {
  const nextSong =
    songs.find(song => {
      return song.id === id;
    });

  if (!nextSong) {
    return;
  }

  gigSongOpen = viaGig;

  resetCurrentPlayback();
  resetPdfZoomState();

  currentSong =
    nextSong;

  currentPdf = null;
  currentPage = 1;
  pendingRenderPage = null;

  pdfCanvas.width = 0;
  pdfCanvas.height = 0;

  pdfCanvas.style.width =
    "0px";

  pdfCanvas.style.height =
    "0px";

  currentSongTitle.textContent =
    currentSong.title;

  pageIndicator.textContent =
    "Loading sheet music...";

  pageIndicator.classList.add(
    "hidden"
  );

  previousPageButton.classList.add(
    "hidden"
  );

  nextPageButton.classList.add(
    "hidden"
  );

  libraryView.classList.add(
    "hidden"
  );

  setlistView.classList.add(
    "hidden"
  );

  playerView.classList.remove(
    "hidden"
  );

  updateGigIndicator();

  currentTempo =
    clampTempo(
      Number(
        currentSong.settings?.playbackRate
      ) || 1
    );

  pitchSemitones =
    currentSong.settings?.baroquePitch
      ? BAROQUE_SEMITONES
      : 0;

  updateTempoDisplay();
  updatePitchDisplay();

  try {
    await loadAudio(
      currentSong.audio.file
    );
  } catch (error) {
    console.error(
      "Could not load the backing track:",
      error
    );

    showToast(
      "Could not load the backing track."
    );
  }

  try {
    await loadPdf(
      currentSong.pdf.file
    );

    if (
      currentSong.pdf.pageCount !==
      currentPdf.numPages
    ) {
      currentSong.pdf.pageCount =
        currentPdf.numPages;

      await saveSong(
        currentSong
      );

      updateSongInMemory();
    }

    updatePageIndicator();
  } catch (error) {
    console.error(error);

    showToast(
      "Could not open the sheet music."
    );
  }
}

async function loadPdf(file) {
  const data =
    await file.arrayBuffer();

  currentPdf =
    await pdfjsLib
      .getDocument({
        data,
        isEvalSupported: false,
        enableScripting: false,
        enableXfa: false,
        ...PDF_COMPAT_OPTIONS
      })
      .promise;

  await renderPage(1);
}

/*
 * Rendering the PDF
 */

function getSpreadStart(page) {
  return page % 2 === 1
    ? page
    : page - 1;
}

async function renderPage(pageNumber) {
  if (!currentPdf) {
    return;
  }

  if (rendering) {
    pendingRenderPage =
      pageNumber;

    return;
  }

  rendering = true;

  try {
    const pageCount = currentPdf.numPages;

    currentPage =
      Math.max(
        1,
        Math.min(pageNumber, pageCount)
      );

    const probePage =
      await currentPdf.getPage(currentPage);

    const baseViewport =
      probePage.getViewport({ scale: 1 });

    const availableWidth =
      Math.max(100, pdfArea.clientWidth - 20);

    const availableHeight =
      Math.max(100, pdfArea.clientHeight - 20);

    const gap = 14;

    /*
     * Show two pages side by side when the area is wide
     * enough to fit both at full height.
     */
    const heightFitScale =
      availableHeight / baseViewport.height;

    const twoUp =
      pageCount >= 2 &&
      2 * baseViewport.width * heightFitScale + gap <=
        availableWidth;

    twoPageMode = twoUp;

    const spreadStart =
      twoUp ? getSpreadStart(currentPage) : currentPage;

    const leftPage =
      spreadStart === currentPage
        ? probePage
        : await currentPdf.getPage(spreadStart);

    const rightPage =
      twoUp && spreadStart + 1 <= pageCount
        ? await currentPdf.getPage(spreadStart + 1)
        : null;

    const fitScale =
      twoUp
        ? Math.min(
            (availableWidth - gap) /
              (2 * baseViewport.width),
            availableHeight / baseViewport.height
          )
        : Math.min(
            availableWidth / baseViewport.width,
            availableHeight / baseViewport.height
          );

    const displayScale = fitScale * pdfZoom;

    /*
     * Browsers cap the size of a canvas backing store. iPad
     * Safari is the strictest: a canvas may not exceed
     * 16,777,216 total pixels (nor a per-side limit), and when
     * it does getContext() yields a blank/null context so the
     * page fails to render. That is easy to hit on a zoomed
     * two-page spread. Keep the backing store within a safe
     * budget by trimming the pixel ratio; the CSS display size
     * divides by the same ratio, so the page keeps its size and
     * zoom level and only loses some sharpness at extreme zoom.
     */
    const MAX_CANVAS_AREA = 16777216;
    const MAX_CANVAS_SIDE = 8192;

    const basePixelRatio =
      Math.min(window.devicePixelRatio || 1, 2);

    const estWidth =
      baseViewport.width *
        displayScale *
        (twoUp ? 2 : 1) *
        basePixelRatio +
      (twoUp ? gap * basePixelRatio : 0);

    const estHeight =
      baseViewport.height * displayScale * basePixelRatio;

    const budgetScale = Math.min(
      1,
      MAX_CANVAS_SIDE / Math.max(estWidth, estHeight),
      Math.sqrt(MAX_CANVAS_AREA / (estWidth * estHeight))
    );

    const pixelRatio = basePixelRatio * budgetScale;

    const renderScale = displayScale * pixelRatio;

    const gapRender =
      rightPage ? Math.round(gap * pixelRatio) : 0;

    const leftViewport =
      leftPage.getViewport({ scale: renderScale });

    const rightViewport =
      rightPage
        ? rightPage.getViewport({ scale: renderScale })
        : null;

    const leftWidth = Math.floor(leftViewport.width);
    const leftHeight = Math.floor(leftViewport.height);

    const rightWidth =
      rightViewport ? Math.floor(rightViewport.width) : 0;

    const rightHeight =
      rightViewport ? Math.floor(rightViewport.height) : 0;

    const totalWidth =
      leftWidth +
      (rightPage ? gapRender + rightWidth : 0);

    const totalHeight =
      Math.max(leftHeight, rightHeight);

    const context =
      pdfCanvas.getContext("2d", { alpha: false });

    pdfCanvas.width = totalWidth;
    pdfCanvas.height = totalHeight;

    pdfCanvas.style.width =
      `${Math.floor(totalWidth / pixelRatio)}px`;

    pdfCanvas.style.height =
      `${Math.floor(totalHeight / pixelRatio)}px`;

    pdfCanvas.style.transform = "none";

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, totalWidth, totalHeight);

    /*
     * Render each page to its own offscreen canvas, then
     * composite. Rendering two pages into one context is
     * not reliable in pdf.js, so keep them separate.
     */
    const leftCanvas =
      document.createElement("canvas");

    leftCanvas.width = leftWidth;
    leftCanvas.height = leftHeight;

    const leftContext =
      leftCanvas.getContext("2d", { alpha: false });

    leftContext.fillStyle = "#ffffff";
    leftContext.fillRect(0, 0, leftWidth, leftHeight);

    await leftPage.render({
      canvasContext: leftContext,
      viewport: leftViewport
    }).promise;

    context.drawImage(leftCanvas, 0, 0);

    if (rightPage) {
      const rightCanvas =
        document.createElement("canvas");

      rightCanvas.width = rightWidth;
      rightCanvas.height = rightHeight;

      const rightContext =
        rightCanvas.getContext("2d", { alpha: false });

      rightContext.fillStyle = "#ffffff";
      rightContext.fillRect(0, 0, rightWidth, rightHeight);

      await rightPage.render({
        canvasContext: rightContext,
        viewport: rightViewport
      }).promise;

      context.drawImage(
        rightCanvas,
        leftWidth + gapRender,
        0
      );
    }

    updatePdfZoomLayout();
    updatePageIndicator();
  } catch (error) {
    console.error(
      "Could not render PDF page:",
      error
    );

    showToast(
      "Could not display the sheet page: " +
        (error?.message || error),
      6000
    );
  } finally {
    rendering = false;

    if (
      pendingRenderPage !== null
    ) {
      const nextPage =
        pendingRenderPage;

      pendingRenderPage = null;

      renderPage(nextPage);
    }
  }
}

/*
 * PDF zoom
 */

function clampPdfZoom(value) {
  return Math.min(
    MAX_PDF_ZOOM,
    Math.max(
      MIN_PDF_ZOOM,
      value
    )
  );
}

function updatePdfZoomLayout() {
  const isZoomed =
    pdfZoom > 1.01;

  pdfArea.classList.toggle(
    "zoomed",
    isZoomed
  );

  pdfArea.classList.toggle(
    "fit-page",
    !isZoomed
  );

  if (!isZoomed) {
    pdfArea.scrollTop = 0;
    pdfArea.scrollLeft = 0;
  }
}

async function setPdfZoom(
  newZoom,
  showMessage = false
) {
  if (!currentPdf) {
    return;
  }

  const clampedZoom =
    clampPdfZoom(newZoom);

  if (
    Math.abs(
      clampedZoom -
      pdfZoom
    ) < 0.01
  ) {
    pdfCanvas.style.transform =
      "none";

    return;
  }

  const oldScrollableWidth =
    Math.max(
      1,
      pdfArea.scrollWidth -
        pdfArea.clientWidth
    );

  const oldScrollableHeight =
    Math.max(
      1,
      pdfArea.scrollHeight -
        pdfArea.clientHeight
    );

  const horizontalPosition =
    pdfArea.scrollLeft /
    oldScrollableWidth;

  const verticalPosition =
    pdfArea.scrollTop /
    oldScrollableHeight;

  pdfZoom =
    clampedZoom;

  await renderPage(
    currentPage
  );

  requestAnimationFrame(() => {
    const newScrollableWidth =
      Math.max(
        0,
        pdfArea.scrollWidth -
          pdfArea.clientWidth
      );

    const newScrollableHeight =
      Math.max(
        0,
        pdfArea.scrollHeight -
          pdfArea.clientHeight
      );

    pdfArea.scrollLeft =
      newScrollableWidth *
      horizontalPosition;

    pdfArea.scrollTop =
      newScrollableHeight *
      verticalPosition;
  });

  if (showMessage) {
    if (pdfZoom <= 1.01) {
      showToast(
        "Fit page"
      );
    } else {
      showToast(
        `Zoom ${Math.round(
          pdfZoom * 100
        )} %`
      );
    }
  }
}

async function resetPdfZoom(
  showMessage = false
) {
  if (!currentPdf) {
    return;
  }

  pdfZoom = 1;

  await renderPage(
    currentPage
  );

  if (showMessage) {
    showToast(
      "Fit page"
    );
  }
}

function getTouchDistance(
  firstTouch,
  secondTouch
) {
  const horizontalDistance =
    secondTouch.clientX -
    firstTouch.clientX;

  const verticalDistance =
    secondTouch.clientY -
    firstTouch.clientY;

  return Math.hypot(
    horizontalDistance,
    verticalDistance
  );
}

/*
 * Page controls
 */

function updatePageControls() {
  const pageCount =
    currentPdf?.numPages ??
    Number(
      currentSong?.pdf?.pageCount
    ) ??
    1;

  const hasMultiplePages =
    pageCount > 1;

  pageIndicator.classList.toggle(
    "hidden",
    !hasMultiplePages
  );

  previousPageButton.classList.toggle(
    "hidden",
    !hasMultiplePages
  );

  nextPageButton.classList.toggle(
    "hidden",
    !hasMultiplePages
  );

  previousPageButton.disabled =
    twoPageMode
      ? getSpreadStart(currentPage) <= 1
      : currentPage <= 1;

  nextPageButton.disabled =
    twoPageMode
      ? getSpreadStart(currentPage) + 2 > pageCount
      : currentPage >= pageCount;
}

function updatePageIndicator() {
  const pageCount =
    currentPdf?.numPages ??
    Number(
      currentSong?.pdf?.pageCount
    ) ??
    1;

  if (twoPageMode) {
    const start =
      getSpreadStart(currentPage);

    const end =
      Math.min(start + 1, pageCount);

    pageIndicator.textContent =
      end > start
        ? `Pages ${start}–${end} / ${pageCount}`
        : `Page ${start} / ${pageCount}`;
  } else {
    pageIndicator.textContent =
      `Page ${currentPage} / ${pageCount}`;
  }

  updatePageControls();
}

/*
 * Manual page turn
 */

async function nextPage() {
  if (!currentPdf) {
    return;
  }

  if (twoPageMode) {
    const nextStart =
      getSpreadStart(currentPage) + 2;

    if (nextStart > currentPdf.numPages) {
      return;
    }

    await renderPage(nextStart);

    return;
  }

  if (currentPage >= currentPdf.numPages) {
    return;
  }

  await renderPage(
    currentPage + 1
  );
}

async function previousPage() {
  if (!currentPdf) {
    return;
  }

  if (twoPageMode) {
    const prevStart =
      getSpreadStart(currentPage) - 2;

    if (prevStart < 1) {
      return;
    }

    await renderPage(prevStart);

    return;
  }

  if (currentPage <= 1) {
    return;
  }

  await renderPage(
    currentPage - 1
  );
}

/*
 * Backing track
 */

function isDirectMode() {
  return (
    Math.abs(currentTempo - 1) < 0.001 &&
    Math.abs(pitchSemitones) < 0.001
  );
}

/*
 * Safari exposes little about the hardware, so treat Apple mobile
 * and low-core touch tablets as constrained: they cannot run the
 * full-quality real-time stretch smoothly, so use the engine's
 * lighter preset there. Desktops keep the full-quality engine.
 */
function prefersLightStretchEngine() {
  const ua = navigator.userAgent || "";

  const isAppleMobile =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1);

  const cores = navigator.hardwareConcurrency || 0;
  const isTouch = navigator.maxTouchPoints > 0;

  return isAppleMobile || (isTouch && cores > 0 && cores <= 4);
}

function getAudioTime() {
  if (!isPlaying) {
    return playbackPosition;
  }

  if (activeEngine === "direct") {
    return Math.min(
      audioDuration || 0,
      directStartOffset +
        (audioContext.currentTime - directStartContextTime)
    );
  }

  if (activeEngine === "stretch" && stretchNode) {
    return stretchNode.inputTime || 0;
  }

  return playbackPosition;
}

/*
 * Direct (non-stretched) playback via a plain AudioBufferSource.
 * A source node cannot be paused/resumed, so pausing stops it and
 * playing recreates it at the stored offset.
 */
function startDirectSource(offset) {
  stopDirectSource();

  const source =
    audioContext.createBufferSource();

  source.buffer = audioBuffer;

  source.connect(
    audioContext.destination
  );

  source.onended = () => {
    if (directSource === source && isPlaying) {
      finishPlayback();
    }
  };

  source.start(0, offset);

  directSource = source;
  directStartContextTime = audioContext.currentTime;
  directStartOffset = offset;
}

function stopDirectSource() {
  if (!directSource) {
    return;
  }

  directSource.onended = null;

  try {
    directSource.stop();
  } catch (error) {
    /* already stopped */
  }

  try {
    directSource.disconnect();
  } catch (error) {
    /* already disconnected */
  }

  directSource = null;
}

/*
 * A source node has no progress callback, so drive the UI and
 * page turns from a timer while playing directly.
 */
function startDirectTimer() {
  stopDirectTimer();

  directTimer =
    setInterval(handleAudioProgress, 100);
}

function stopDirectTimer() {
  if (directTimer) {
    clearInterval(directTimer);
    directTimer = null;
  }
}

function startPlaybackFrom(offset) {
  playbackPosition = offset;

  if (isDirectMode()) {
    startDirectSource(offset);
    startDirectTimer();
    activeEngine = "direct";
    isPlaying = true;
  } else if (stretchNode) {
    try {
      stretchNode.disconnect();
    } catch (error) {
      /* was not connected */
    }

    stretchNode.connect(
      audioContext.destination
    );

    stretchNode.schedule({ input: offset });

    stretchNode.schedule({
      active: true,
      rate: currentTempo,
      semitones: pitchSemitones
    });

    activeEngine = "stretch";
    isPlaying = true;
  }
}

function pausePlayback() {
  playbackPosition = getAudioTime();

  if (activeEngine === "direct") {
    stopDirectSource();
    stopDirectTimer();
  } else if (activeEngine === "stretch" && stretchNode) {
    try {
      stretchNode.schedule({ active: false });
      stretchNode.disconnect();
    } catch (error) {
      /* already stopped */
    }
  }

  activeEngine = null;
  isPlaying = false;
}

function finishPlayback() {
  pausePlayback();

  playbackPosition = audioDuration || 0;

  updatePlayPauseButton(false);
}

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    audioContext =
      new AudioContextClass();
  }

  return audioContext;
}

/*
 * Compile the AudioWorklet + WASM once, ahead of time, so the
 * first song does not stall on a dead play button. Memoised;
 * triggered on the first user interaction.
 */
function warmUpAudioEngine() {
  if (audioWarmupPromise) {
    return audioWarmupPromise;
  }

  audioWarmupPromise = (async () => {
    ensureAudioContext();

    const warmNode =
      await SignalsmithStretch(audioContext);

    try {
      warmNode.disconnect();
    } catch (error) {
      /* nothing to disconnect */
    }
  })().catch(error => {
    console.warn(
      "Audio engine warm-up failed:",
      error
    );
  });

  return audioWarmupPromise;
}

function setAudioLoading(loading) {
  audioLoading = loading;

  playPauseButton.disabled = loading;

  playPauseButton.classList.toggle(
    "loading",
    loading
  );

  if (loading) {
    playPauseButton.setAttribute(
      "aria-busy",
      "true"
    );
  } else {
    playPauseButton.removeAttribute(
      "aria-busy"
    );
  }
}

async function loadAudio(file) {
  setAudioLoading(true);

  try {
    stopDirectSource();
    stopDirectTimer();

    if (stretchNode) {
      try {
        stretchNode.disconnect();
      } catch (error) {
        /* already disconnected */
      }

      stretchNode = null;
    }

    isPlaying = false;
    activeEngine = null;
    playbackPosition = 0;
    audioBuffer = null;

    ensureAudioContext();

    await warmUpAudioEngine();

    const data =
      await file.arrayBuffer();

    audioBuffer =
      await audioContext.decodeAudioData(data);

    audioDuration =
      audioBuffer.duration;

    const channels = [];

    for (
      let channel = 0;
      channel < audioBuffer.numberOfChannels;
      channel++
    ) {
      channels.push(
        audioBuffer.getChannelData(channel)
      );
    }

    stretchNode =
      await SignalsmithStretch(
        audioContext,
        {
          outputChannelCount: [
            audioBuffer.numberOfChannels
          ]
        }
      );

    /*
     * Lighter preset on constrained devices so a tempo change
     * does not overwhelm the audio thread. Set before the audio
     * is loaded, since it resets the engine.
     */
    if (prefersLightStretchEngine()) {
      stretchNode.configure({ preset: "cheaper" });
    }

    await stretchNode.addBuffers(channels);

    stretchNode.setUpdateInterval(
      0.1,
      handleAudioProgress
    );

    /*
     * The stretch node stays disconnected (and therefore idle,
     * consuming no CPU) until a non-100 % tempo is played.
     */

    currentTimeElement.textContent =
      "00:00";

    audioSeek.value = 0;
    audioSeek.max = audioDuration || 0;

    durationElement.textContent =
      formatTime(audioDuration);
  } finally {
    setAudioLoading(false);
    updatePlayPauseButton(false);
  }
}

function handleAudioProgress() {
  if (!isPlaying) {
    return;
  }

  const time = getAudioTime();

  audioSeek.value = time;

  currentTimeElement.textContent =
    formatTime(time);

  if (
    audioDuration > 0 &&
    time >= audioDuration - 0.08
  ) {
    finishPlayback();
  }
}

/*
 * Tempo
 */

function clampTempo(value) {
  return Math.min(
    MAX_TEMPO,
    Math.max(
      MIN_TEMPO,
      value
    )
  );
}

function updateTempoDisplay() {
  const percent =
    Math.round(currentTempo * 100);

  tempoValue.textContent =
    `${percent} %`;

  tempoValue.classList.toggle(
    "modified",
    Math.abs(currentTempo - 1) > 0.001
  );
}

/*
 * Changing tempo or pitch may switch playback between the direct and
 * stretch engines (e.g. crossing 100 % tempo, or turning pitch shift
 * on/off). If a track is playing, restart it on the right engine from
 * the same position. Call after the tempo/pitch values are updated.
 */
function reconfigurePlayback() {
  if (!isPlaying) {
    return;
  }

  pausePlayback();
  startPlaybackFrom(playbackPosition);
  updatePlayPauseButton(isPlaying);
}

async function setTempo(
  newTempo,
  save = true
) {
  currentTempo =
    clampTempo(
      Math.round(newTempo * 100) / 100
    );

  reconfigurePlayback();
  updateTempoDisplay();

  if (save && currentSong) {
    currentSong.settings.playbackRate =
      currentTempo;

    await saveSong(currentSong);

    updateSongInMemory();
  }
}

function updatePitchDisplay() {
  const baroque =
    Math.abs(pitchSemitones) > 0.001;

  pitchToggle.textContent =
    baroque ? "415 Hz" : "440 Hz";

  pitchToggle.classList.toggle("modified", baroque);

  pitchToggle.setAttribute(
    "aria-pressed",
    baroque ? "true" : "false"
  );
}

async function setBaroquePitch(
  baroque,
  save = true
) {
  pitchSemitones =
    baroque ? BAROQUE_SEMITONES : 0;

  reconfigurePlayback();
  updatePitchDisplay();

  if (save && currentSong) {
    currentSong.settings.baroquePitch = baroque;

    await saveSong(currentSong);

    updateSongInMemory();
  }
}

async function togglePlayback() {
  if (!currentSong || !audioBuffer || audioLoading) {
    return;
  }

  try {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    if (isPlaying) {
      pausePlayback();

      updatePlayPauseButton(false);
    } else {
      let offset = playbackPosition;

      if (
        audioDuration > 0 &&
        offset >= audioDuration - 0.08
      ) {
        offset = 0;
      }

      startPlaybackFrom(offset);

      updatePlayPauseButton(isPlaying);
    }
  } catch (error) {
    console.error(error);

    showToast(
      "Could not start playback."
    );
  }
}

async function restartSong() {
  if (!currentSong || !audioBuffer) {
    return;
  }

  pausePlayback();

  playbackPosition = 0;

  audioSeek.value = 0;

  currentTimeElement.textContent =
    "00:00";

  await renderPage(1);

  updatePlayPauseButton(false);
}

async function openNextSong() {
  if (
    !currentSong ||
    songs.length < 2
  ) {
    return;
  }

  const currentIndex =
    songs.findIndex(song => {
      return (
        song.id ===
        currentSong.id
      );
    });

  const nextIndex =
    (currentIndex + 1) %
    songs.length;

  await openSong(
    songs[nextIndex].id
  );
}

/*
 * Keep the in-memory songs array in sync with currentSong.
 */

function updateSongInMemory() {
  if (!currentSong) {
    return;
  }

  const index =
    songs.findIndex(song => {
      return (
        song.id ===
        currentSong.id
      );
    });

  if (index !== -1) {
    songs[index] =
      currentSong;
  }
}

/*
 * Back to the library
 */

function closePlayer() {
  resetCurrentPlayback();
  resetPdfZoomState();

  /* Leaving the player pauses the gig; its position is kept. */
  gigSongOpen = false;
  updateGigIndicator();

  libraryView.classList.remove(
    "hidden"
  );

  playerView.classList.add(
    "hidden"
  );

  currentSong = null;
  currentPdf = null;
  currentPage = 1;
  pendingRenderPage = null;

  pdfCanvas.width = 0;
  pdfCanvas.height = 0;

  pdfCanvas.style.width =
    "0px";

  pdfCanvas.style.height =
    "0px";

  pageIndicator.textContent =
    "Page 1 / 1";

  pageIndicator.classList.add(
    "hidden"
  );

  previousPageButton.classList.add(
    "hidden"
  );

  nextPageButton.classList.add(
    "hidden"
  );

  renderLibrary();
}

/*
 * Helpers
 */

function formatTime(seconds) {
  if (
    !Number.isFinite(seconds)
  ) {
    return "00:00";
  }

  const minutes =
    Math.floor(
      seconds / 60
    );

  const remainingSeconds =
    Math.floor(
      seconds % 60
    );

  return `${
    String(minutes).padStart(
      2,
      "0"
    )
  }:${
    String(
      remainingSeconds
    ).padStart(
      2,
      "0"
    )
  }`;
}

function escapeHtml(value) {
  const div =
    document.createElement(
      "div"
    );

  div.textContent = value;

  return div.innerHTML;
}

function showToast(message, duration = 2400) {
  toast.textContent =
    message;

  toast.classList.remove(
    "hidden"
  );

  clearTimeout(
    showToast.timeout
  );

  showToast.timeout =
    setTimeout(() => {
      toast.classList.add(
        "hidden"
      );
    }, duration);
}

/*
 * File selection
 */

chooseFilesButton.addEventListener(
  "click",
  () => {
    fileInput.click();
  }
);

fileInput.addEventListener(
  "change",
  async event => {
    await addFiles(
      event.target.files
    );

    fileInput.value = "";
  }
);

exportButton.addEventListener(
  "click",
  exportLibrary
);

importButton.addEventListener(
  "click",
  () => {
    importInput.click();
  }
);

importInput.addEventListener(
  "change",
  async event => {
    const file =
      event.target.files[0];

    if (file) {
      await importLibrary(file);
    }

    importInput.value = "";
  }
);

/*
 * Drag and drop
 */

dropZone.addEventListener(
  "dragover",
  event => {
    event.preventDefault();

    dropZone.classList.add(
      "dragging"
    );
  }
);

dropZone.addEventListener(
  "dragleave",
  event => {
    if (
      event.relatedTarget &&
      dropZone.contains(
        event.relatedTarget
      )
    ) {
      return;
    }

    dropZone.classList.remove(
      "dragging"
    );
  }
);

dropZone.addEventListener(
  "drop",
  async event => {
    event.preventDefault();

    dropZone.classList.remove(
      "dragging"
    );

    await addFiles(
      event.dataTransfer.files
    );
  }
);

/*
 * Player buttons
 */

backButton.addEventListener(
  "click",
  closePlayer
);

playPauseButton.addEventListener(
  "click",
  togglePlayback
);

restartButton.addEventListener(
  "click",
  restartSong
);

nextSongButton.addEventListener(
  "click",
  () => {
    if (gigSongOpen && gigIndex !== null) {
      gigNextSong();
    } else {
      openNextSong();
    }
  }
);

/*
 * Setlist & gig buttons
 */

setlistButton.addEventListener(
  "click",
  openSetlistView
);

setlistBackButton.addEventListener(
  "click",
  closeSetlistView
);

startGigButton.addEventListener(
  "click",
  startGig
);

resumeGigButton.addEventListener(
  "click",
  resumeGig
);

endGigButton.addEventListener(
  "click",
  endGig
);

previousPageButton.addEventListener(
  "click",
  previousPage
);

nextPageButton.addEventListener(
  "click",
  nextPage
);

/*
 * Tempo buttons
 */

for (const button of document.querySelectorAll(
  "[data-tempo-delta]"
)) {
  button.addEventListener(
    "click",
    () => {
      setTempo(
        currentTempo +
        Number(button.dataset.tempoDelta)
      );
    }
  );
}

tempoValue.addEventListener(
  "click",
  () => {
    setTempo(1);
  }
);

pitchToggle.addEventListener(
  "click",
  () => {
    setBaroquePitch(
      Math.abs(pitchSemitones) < 0.001
    );
  }
);

/*
 * Backing track seek
 */

audioSeek.addEventListener(
  "input",
  () => {
    if (!audioBuffer) {
      return;
    }

    const time =
      Number(audioSeek.value);

    playbackPosition = time;

    if (isPlaying) {
      if (activeEngine === "direct") {
        startDirectSource(time);
      } else if (activeEngine === "stretch" && stretchNode) {
        stretchNode.schedule({ input: time });
      }
    }

    currentTimeElement.textContent =
      formatTime(time);
  }
);

/*
 * Pinch zoom start
 */

pdfArea.addEventListener(
  "touchstart",
  event => {
    if (
      event.touches.length !== 2 ||
      !currentPdf
    ) {
      return;
    }

    event.preventDefault();

    pinchInProgress = true;

    pinchStartDistance =
      getTouchDistance(
        event.touches[0],
        event.touches[1]
      );

    pinchStartZoom =
      pdfZoom;

    pinchPreviewZoom =
      pdfZoom;

    pdfCanvas.style.transformOrigin =
      "center center";
  },
  {
    passive: false
  }
);

/*
 * Pinch zoom preview
 */

pdfArea.addEventListener(
  "touchmove",
  event => {
    if (
      !pinchInProgress ||
      event.touches.length !== 2 ||
      pinchStartDistance <= 0
    ) {
      return;
    }

    event.preventDefault();

    const currentDistance =
      getTouchDistance(
        event.touches[0],
        event.touches[1]
      );

    const pinchRatio =
      currentDistance /
      pinchStartDistance;

    pinchPreviewZoom =
      clampPdfZoom(
        pinchStartZoom *
        pinchRatio
      );

    const previewScale =
      pinchPreviewZoom /
      pdfZoom;

    pdfCanvas.style.transform =
      `scale(${previewScale})`;
  },
  {
    passive: false
  }
);

/*
 * Pinch zoom end
 */

pdfArea.addEventListener(
  "touchend",
  async event => {
    if (!pinchInProgress) {
      return;
    }

    if (
      event.touches.length >= 2
    ) {
      return;
    }

    event.preventDefault();

    pinchInProgress = false;

    pdfCanvas.style.transform =
      "none";

    await setPdfZoom(
      pinchPreviewZoom
    );
  },
  {
    passive: false
  }
);

pdfArea.addEventListener(
  "touchcancel",
  () => {
    pinchInProgress = false;
    swipeTracking = false;

    pdfCanvas.style.transform =
      "none";
  }
);

/*
 * Swipe left/right to turn pages (tablet). Only tracked when the page
 * is not zoomed in — while zoomed, a one-finger drag pans the page,
 * so we leave that to native scrolling.
 */
const SWIPE_MIN_DISTANCE = 60;

pdfArea.addEventListener(
  "touchstart",
  event => {
    if (
      event.touches.length !== 1 ||
      pinchInProgress ||
      !currentPdf ||
      pdfZoom > 1.01
    ) {
      swipeTracking = false;
      return;
    }

    swipeTracking = true;
    swipeStartX = event.touches[0].clientX;
    swipeStartY = event.touches[0].clientY;
  },
  {
    passive: true
  }
);

pdfArea.addEventListener(
  "touchend",
  event => {
    if (
      !swipeTracking ||
      pinchInProgress ||
      event.touches.length > 0
    ) {
      return;
    }

    swipeTracking = false;

    const touch =
      event.changedTouches[0];

    if (!touch) {
      return;
    }

    const dx =
      touch.clientX - swipeStartX;

    const dy =
      touch.clientY - swipeStartY;

    if (
      Math.abs(dx) < SWIPE_MIN_DISTANCE ||
      Math.abs(dx) < Math.abs(dy) * 1.5
    ) {
      return;
    }

    /*
     * Swallow the click the edge tap-zones would otherwise fire, so a
     * swipe does not also count as a tap.
     */
    event.preventDefault();

    if (dx < 0) {
      nextPage();
    } else {
      previousPage();
    }
  },
  {
    passive: false
  }
);

/*
 * Ctrl + mouse wheel
 */

pdfArea.addEventListener(
  "wheel",
  event => {
    if (
      !event.ctrlKey ||
      !currentPdf
    ) {
      return;
    }

    event.preventDefault();

    const zoomMultiplier =
      event.deltaY < 0
        ? 1.15
        : 1 / 1.15;

    setPdfZoom(
      pdfZoom *
      zoomMultiplier
    );
  },
  {
    passive: false
  }
);

/*
 * Double-click on desktop
 */

pdfCanvas.addEventListener(
  "dblclick",
  async event => {
    event.preventDefault();

    if (!currentPdf) {
      return;
    }

    if (pdfZoom > 1.01) {
      await resetPdfZoom(true);
    } else {
      await setPdfZoom(
        1.75,
        true
      );
    }
  }
);

/*
 * Double-tap on tablet
 */

pdfCanvas.addEventListener(
  "touchend",
  async event => {
    if (
      pinchInProgress ||
      event.changedTouches.length !== 1
    ) {
      return;
    }

    const currentTapTime =
      Date.now();

    const timeSincePreviousTap =
      currentTapTime -
      lastPdfTapTime;

    lastPdfTapTime =
      currentTapTime;

    if (
      timeSincePreviousTap > 0 &&
      timeSincePreviousTap < 320
    ) {
      event.preventDefault();

      lastPdfTapTime = 0;

      if (pdfZoom > 1.01) {
        await resetPdfZoom(true);
      } else {
        await setPdfZoom(
          1.75,
          true
        );
      }
    }
  },
  {
    passive: false
  }
);

/*
 * Window resize
 */

let resizeTimeout;

window.addEventListener(
  "resize",
  () => {
    clearTimeout(
      resizeTimeout
    );

    resizeTimeout =
      setTimeout(() => {
        if (currentPdf) {
          renderPage(
            currentPage
          );
        }
      }, 150);
  }
);

/*
 * Keyboard / page-turn pedal navigation.
 *
 * Bluetooth page-turn pedals (AirTurn, PageFlip, iRig BlueTurn,
 * Coda, …) act as HID keyboards. Their common defaults are covered
 * here: arrows and Page Up/Down. Down/Right/PageDown go forward,
 * Up/Left/PageUp go back. (Space is intentionally left out so it
 * cannot block the play button's keyboard activation.)
 */
const NEXT_PAGE_KEYS = new Set([
  "ArrowRight",
  "ArrowDown",
  "PageDown"
]);

const PREVIOUS_PAGE_KEYS = new Set([
  "ArrowLeft",
  "ArrowUp",
  "PageUp"
]);

window.addEventListener(
  "keydown",
  event => {
    if (
      !setlistView.classList.contains("hidden") &&
      event.key === "Escape"
    ) {
      event.preventDefault();
      closeSetlistView();
      return;
    }

    if (playerView.classList.contains("hidden")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closePlayer();
      return;
    }

    const tagName =
      event.target?.tagName;

    if (
      tagName === "INPUT" ||
      tagName === "SELECT" ||
      tagName === "TEXTAREA"
    ) {
      return;
    }

    if (NEXT_PAGE_KEYS.has(event.key)) {
      event.preventDefault();
      nextPage();
    } else if (PREVIOUS_PAGE_KEYS.has(event.key)) {
      event.preventDefault();
      previousPage();
    }
  }
);

/*
 * Warm up the audio engine (compile WASM/worklet) on the first
 * user interaction, so the first song plays without a stall.
 */
window.addEventListener(
  "pointerdown",
  warmUpAudioEngine,
  { once: true }
);

window.addEventListener(
  "beforeunload",
  () => {
    if (audioContext) {
      audioContext.close();
    }
  }
);

/*
 * Theme (dark / light)
 */

const THEME_STORAGE_KEY =
  "katusoitto-theme";

const themeColorMeta =
  document.querySelector("#themeColorMeta");

const THEME_COLORS = {
  dark: "#241a12",
  light: "#e6d9bc"
};

function getPreferredTheme() {
  let saved = null;

  try {
    saved =
      localStorage.getItem(
        THEME_STORAGE_KEY
      );
  } catch (error) {
    saved = null;
  }

  if (
    saved === "dark" ||
    saved === "light"
  ) {
    return saved;
  }

  const prefersLight =
    window.matchMedia &&
    window.matchMedia(
      "(prefers-color-scheme: light)"
    ).matches;

  return prefersLight
    ? "light"
    : "dark";
}

function applyTheme(theme) {
  const normalized =
    theme === "light"
      ? "light"
      : "dark";

  document.documentElement.setAttribute(
    "data-theme",
    normalized
  );

  if (themeColorMeta) {
    themeColorMeta.setAttribute(
      "content",
      THEME_COLORS[normalized]
    );
  }
}

function setTheme(theme) {
  applyTheme(theme);

  try {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      theme
    );
  } catch (error) {
    /*
     * localStorage may be blocked;
     * the theme still persists for the session.
     */
  }
}

function toggleTheme() {
  const current =
    document.documentElement.getAttribute(
      "data-theme"
    ) === "light"
      ? "light"
      : "dark";

  setTheme(
    current === "light"
      ? "dark"
      : "light"
  );
}

function initializeTheme() {
  applyTheme(
    getPreferredTheme()
  );

  const toggleButtons =
    document.querySelectorAll(
      "[data-theme-toggle]"
    );

  for (const button of toggleButtons) {
    button.addEventListener(
      "click",
      toggleTheme
    );
  }
}

initializeTheme();

/*
 * App startup
 */

async function initialize() {
  try {
    await requestPersistentStorage();

    db =
      await openDatabase();

    songs =
      await getAllSongs();

    await ensureSongOrder();

    loadSetlistState();
    pruneSetlist();

    await ensurePdfPageCounts();

    renderLibrary();
    updatePendingImportDisplay();
    updatePlayPauseButton(false);

    if (
      "serviceWorker" in
      navigator
    ) {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => {
          console.error(
            "Could not start offline support:",
            error
          );
        });
    }
  } catch (error) {
    console.error(error);

    showToast(
      "Could not open the local database."
    );
  }
}

initialize();