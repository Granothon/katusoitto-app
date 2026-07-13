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
    typeof OffscreenCanvas !== "undefined" && !IS_APPLE_WEBKIT,
  /*
   * iPad/iPhone Safari sometimes fails to apply pdf.js's embedded
   * @font-face fonts when painting text onto canvas, so some sheets
   * render in a wrong fallback font. Drawing glyph outlines directly
   * bypasses the browser font engine and always matches the PDF. Keep
   * the faster, crisper font-face path on other browsers.
   */
  disableFontFace: IS_APPLE_WEBKIT
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

let trainingMode = false;
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

let lastPdfTapTime = 0;

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

/*
 * Page turn settings
 */

const settingsButton =
  document.querySelector("#settingsButton");

const settingsDialog =
  document.querySelector("#settingsDialog");

const settingsSongTitle =
  document.querySelector("#settingsSongTitle");

const autoTurnEnabled =
  document.querySelector("#autoTurnEnabled");

const warningSeconds =
  document.querySelector("#warningSeconds");

const startTrainingButton =
  document.querySelector("#startTrainingButton");

const stopTrainingButton =
  document.querySelector("#stopTrainingButton");

const clearPageTurnsButton =
  document.querySelector("#clearPageTurnsButton");

const pageTurnList =
  document.querySelector("#pageTurnList");

/*
 * Page turn warning
 */

const turnWarning =
  document.querySelector("#turnWarning");

const turnWarningText =
  document.querySelector("#turnWarningText");

const turnWarningCountdown =
  document.querySelector("#turnWarningCountdown");

const warningProgress =
  document.querySelector("#warningProgress");

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

    const pageTurnInformation =
      pageCount > 1
        ? `
          <span>
            ${pageCount} pages
          </span>

          <span>
            Page turns
            ${song.pageTurns.length}
          </span>

          <span>
            ${
              song.settings.autoTurnEnabled
                ? "Auto-turn on"
                : "Auto-turn off"
            }
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

        ${pageTurnInformation}
      </span>

      <span
        class="delete-song-button"
        role="button"
        aria-label="Delete song"
        title="Delete song"
        data-delete-id="${song.id}"
      >
        ✕
      </span>
    `;

    card.addEventListener(
      "click",
      event => {
        const deleteButton =
          event.target.closest(
            "[data-delete-id]"
          );

        if (deleteButton) {
          event.stopPropagation();

          deleteSong(song);

          return;
        }

        openSong(song.id);
      }
    );

    songGrid.appendChild(
      card
    );
  }
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

  hideTurnWarning();

  trainingMode = false;

  startTrainingButton.classList.remove(
    "hidden"
  );

  stopTrainingButton.classList.add(
    "hidden"
  );
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

async function openSong(id) {
  const nextSong =
    songs.find(song => {
      return song.id === id;
    });

  if (!nextSong) {
    return;
  }

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

  settingsSongTitle.textContent =
    currentSong.title;

  pageIndicator.textContent =
    "Loading sheet music...";

  settingsButton.classList.add(
    "hidden"
  );

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

  playerView.classList.remove(
    "hidden"
  );

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
    renderPageTurnList();
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

function getVisibleEnd() {
  if (!twoPageMode || !currentPdf) {
    return currentPage;
  }

  return Math.min(
    getSpreadStart(currentPage) + 1,
    currentPdf.numPages
  );
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

  settingsButton.classList.toggle(
    "hidden",
    !hasMultiplePages
  );

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

    if (trainingMode) {
      await recordPageTurn(nextStart);
    }

    await renderPage(nextStart);

    return;
  }

  if (currentPage >= currentPdf.numPages) {
    return;
  }

  const nextPageNumber =
    currentPage + 1;

  if (trainingMode) {
    await recordPageTurn(
      nextPageNumber
    );
  }

  await renderPage(
    nextPageNumber
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

async function recordPageTurn(
  targetPage
) {
  const time =
    Number(
      getAudioTime().toFixed(2)
    );

  currentSong.pageTurns =
    currentSong.pageTurns.filter(
      turn => {
        return (
          turn.toPage !==
          targetPage
        );
      }
    );

  currentSong.pageTurns.push({
    fromPage:
      targetPage - 1,

    toPage:
      targetPage,

    time
  });

  currentSong.pageTurns.sort(
    (a, b) => {
      return a.time - b.time;
    }
  );

  await saveSong(
    currentSong
  );

  updateSongInMemory();
  renderPageTurnList();

  showToast(
    `Page ${targetPage} turn saved at ${formatTime(time)}.`
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
  hideTurnWarning();
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

  processAutomaticPageTurns();

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
      hideTurnWarning();
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
  hideTurnWarning();
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
 * Automatic page turns
 */

function processAutomaticPageTurns() {
  if (
    !currentSong ||
    !currentSong.settings
      .autoTurnEnabled ||
    trainingMode ||
    !isPlaying
  ) {
    hideTurnWarning();
    return;
  }

  if (
    !currentSong.pageTurns ||
    currentSong.pageTurns.length === 0
  ) {
    hideTurnWarning();
    return;
  }

  const currentAudioTime =
    getAudioTime();

  const visibleEnd =
    getVisibleEnd();

  const nextTurn =
    currentSong.pageTurns.find(
      turn => {
        return (
          turn.toPage >
          visibleEnd
        );
      }
    );

  if (!nextTurn) {
    hideTurnWarning();
    return;
  }

  const mediaSecondsUntilTurn =
    nextTurn.time -
    currentAudioTime;

  /*
   * The turn point is in the audio's own timeline, so it
   * lands at the right musical spot regardless of the
   * tempo – no correction needed here.
   */
  if (mediaSecondsUntilTurn <= 0) {
    hideTurnWarning();

    renderPage(
      nextTurn.toPage
    );

    return;
  }

  /*
   * The warning lead time is computed in real-world
   * seconds: faster tempo -> less real time until the
   * turn, so the warning appears at the right moment.
   */
  const playbackRate =
    currentTempo || 1;

  const secondsUntilTurn =
    mediaSecondsUntilTurn /
    playbackRate;

  const warningTime =
    Number(
      currentSong.settings
        .warningSeconds
    ) || 5;

  if (
    secondsUntilTurn <=
    warningTime
  ) {
    showTurnWarning(
      nextTurn,
      secondsUntilTurn,
      warningTime
    );
  } else {
    hideTurnWarning();
  }
}

function showTurnWarning(
  turn,
  secondsUntilTurn,
  totalWarningTime
) {
  const elapsed =
    totalWarningTime -
    secondsUntilTurn;

  const progress =
    Math.min(
      100,
      Math.max(
        0,
        (
          elapsed /
          totalWarningTime
        ) * 100
      )
    );

  turnWarning.classList.remove(
    "hidden"
  );

  turnWarningText.textContent =
    `Page ${turn.toPage} turning`;

  turnWarningCountdown.textContent =
    `${Math.max(
      1,
      Math.ceil(
        secondsUntilTurn
      )
    )} s`;

  warningProgress.style.width =
    `${progress}%`;
}

function hideTurnWarning() {
  turnWarning.classList.add(
    "hidden"
  );

  warningProgress.style.width =
    "0%";
}

/*
 * Page turn settings
 */

function openSettings() {
  if (!currentSong) {
    return;
  }

  const pageCount =
    Number(
      currentSong.pdf?.pageCount
    ) || 1;

  if (pageCount <= 1) {
    return;
  }

  autoTurnEnabled.checked =
    currentSong.settings
      .autoTurnEnabled;

  warningSeconds.value =
    String(
      currentSong.settings
        .warningSeconds
    );

  renderPageTurnList();

  settingsDialog.showModal();
}

async function updateSettings() {
  if (!currentSong) {
    return;
  }

  currentSong.settings
    .autoTurnEnabled =
      autoTurnEnabled.checked;

  currentSong.settings
    .warningSeconds =
      Number(
        warningSeconds.value
      );

  await saveSong(
    currentSong
  );

  updateSongInMemory();
}

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
 * Page turn teaching mode
 */

async function startTraining() {
  if (!currentSong) {
    return;
  }

  const pageCount =
    Number(
      currentSong.pdf?.pageCount
    ) || 1;

  if (pageCount <= 1) {
    return;
  }

  const accepted =
    currentSong.pageTurns.length === 0 ||
    confirm(
      "Replace previously saved page turns?"
    );

  if (!accepted) {
    return;
  }

  currentSong.pageTurns = [];

  await saveSong(
    currentSong
  );

  updateSongInMemory();

  trainingMode = true;

  startTrainingButton.classList.add(
    "hidden"
  );

  stopTrainingButton.classList.remove(
    "hidden"
  );

  settingsDialog.close();

  await restartSong();

  showToast(
    "Teaching mode active."
  );
}

async function stopTraining() {
  trainingMode = false;

  startTrainingButton.classList.remove(
    "hidden"
  );

  stopTrainingButton.classList.add(
    "hidden"
  );

  await saveSong(
    currentSong
  );

  updateSongInMemory();
  renderPageTurnList();

  showToast(
    "Page turns saved."
  );
}

function renderPageTurnList() {
  pageTurnList.innerHTML = "";

  if (
    !currentSong ||
    currentSong.pageTurns.length === 0
  ) {
    pageTurnList.innerHTML = `
      <p style="color: var(--muted)">
        No saved page turns.
      </p>
    `;

    return;
  }

  for (
    const turn of
    currentSong.pageTurns
  ) {
    const item =
      document.createElement(
        "div"
      );

    item.className =
      "page-turn-item";

    item.innerHTML = `
      <strong>
        Page
        ${turn.fromPage}
        →
        ${turn.toPage}
      </strong>

      <input
        type="number"
        min="0"
        step="0.1"
        value="${turn.time}"
        aria-label="Page turn time in seconds"
      >

      <button
        type="button"
        class="text-button"
      >
        Delete
      </button>
    `;

    const timeInput =
      item.querySelector(
        "input"
      );

    const deleteButton =
      item.querySelector(
        "button"
      );

    timeInput.addEventListener(
      "change",
      async () => {
        turn.time =
          Math.max(
            0,
            Number(
              timeInput.value
            ) || 0
          );

        currentSong.pageTurns.sort(
          (a, b) => {
            return (
              a.time -
              b.time
            );
          }
        );

        await saveSong(
          currentSong
        );

        updateSongInMemory();
        renderPageTurnList();
      }
    );

    deleteButton.addEventListener(
      "click",
      async () => {
        currentSong.pageTurns =
          currentSong.pageTurns.filter(
            savedTurn => {
              return (
                savedTurn !==
                turn
              );
            }
          );

        await saveSong(
          currentSong
        );

        updateSongInMemory();
        renderPageTurnList();
      }
    );

    pageTurnList.appendChild(
      item
    );
  }
}

async function clearPageTurns() {
  if (
    !currentSong ||
    currentSong.pageTurns.length === 0
  ) {
    return;
  }

  const accepted =
    confirm(
      "Delete all saved page turns?"
    );

  if (!accepted) {
    return;
  }

  currentSong.pageTurns = [];

  await saveSong(
    currentSong
  );

  updateSongInMemory();
  renderPageTurnList();
}

/*
 * Back to the library
 */

function closePlayer() {
  resetCurrentPlayback();
  resetPdfZoomState();

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

  settingsButton.classList.add(
    "hidden"
  );

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
  openNextSong
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
 * Page turn settings
 */

settingsButton.addEventListener(
  "click",
  openSettings
);

autoTurnEnabled.addEventListener(
  "change",
  updateSettings
);

warningSeconds.addEventListener(
  "change",
  updateSettings
);

startTrainingButton.addEventListener(
  "click",
  startTraining
);

stopTrainingButton.addEventListener(
  "click",
  stopTraining
);

clearPageTurnsButton.addEventListener(
  "click",
  clearPageTurns
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

    if (
      currentSong &&
      currentSong.pageTurns.length > 0
    ) {
      let correctPage = 1;

      for (
        const turn of
        currentSong.pageTurns
      ) {
        if (turn.time <= time) {
          correctPage =
            turn.toPage;
        }
      }

      if (
        correctPage !==
        currentPage
      ) {
        renderPage(
          correctPage
        );
      }
    }
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

    pdfCanvas.style.transform =
      "none";
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
 * Keyboard page turn
 */

window.addEventListener(
  "keydown",
  event => {
    if (
      playerView.classList.contains("hidden") ||
      settingsDialog.open
    ) {
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

    if (
      event.key === "ArrowRight" ||
      event.key === "PageDown"
    ) {
      event.preventDefault();
      nextPage();
    } else if (
      event.key === "ArrowLeft" ||
      event.key === "PageUp"
    ) {
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