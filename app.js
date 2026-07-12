import * as pdfjsLib from "./vendor/pdf.js";
import SignalsmithStretch from "./vendor/SignalsmithStretch.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "./vendor/pdf.worker.js";

const DB_NAME = "katusoitto-db";
const DB_VERSION = 1;
const SONG_STORE = "songs";

const MIN_PDF_ZOOM = 1;
const MAX_PDF_ZOOM = 4;

const MIN_TEMPO = 0.5;
const MAX_TEMPO = 1.5;

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
          enableXfa: false
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
        playbackRate: 1
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

  isPlaying = false;
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

  updateTempoDisplay();

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
        enableXfa: false
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

    const pixelRatio =
      Math.min(window.devicePixelRatio || 1, 2);

    const pageDisplayWidth =
      Math.floor(baseViewport.width * displayScale);

    const pageDisplayHeight =
      Math.floor(baseViewport.height * displayScale);

    const pageRenderWidth =
      Math.floor(
        baseViewport.width * displayScale * pixelRatio
      );

    const pageRenderHeight =
      Math.floor(
        baseViewport.height * displayScale * pixelRatio
      );

    const gapRender =
      rightPage ? Math.round(gap * pixelRatio) : 0;

    const gapDisplay = rightPage ? gap : 0;

    const context =
      pdfCanvas.getContext("2d", { alpha: false });

    pdfCanvas.width =
      rightPage
        ? pageRenderWidth * 2 + gapRender
        : pageRenderWidth;

    pdfCanvas.height = pageRenderHeight;

    pdfCanvas.style.width =
      `${
        rightPage
          ? pageDisplayWidth * 2 + gapDisplay
          : pageDisplayWidth
      }px`;

    pdfCanvas.style.height =
      `${pageDisplayHeight}px`;

    pdfCanvas.style.transform = "none";

    context.fillStyle = "#ffffff";
    context.fillRect(
      0,
      0,
      pdfCanvas.width,
      pdfCanvas.height
    );

    await leftPage.render({
      canvasContext: context,
      viewport: leftPage.getViewport({
        scale: displayScale * pixelRatio
      })
    }).promise;

    if (rightPage) {
      await rightPage.render({
        canvasContext: context,
        viewport: rightPage.getViewport({
          scale: displayScale * pixelRatio
        }),
        transform: [
          1,
          0,
          0,
          1,
          pageRenderWidth + gapRender,
          0
        ]
      }).promise;
    }

    updatePdfZoomLayout();
    updatePageIndicator();
  } catch (error) {
    console.error(
      "Could not render PDF page:",
      error
    );

    showToast(
      "Could not display the sheet page."
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

function getAudioTime() {
  return stretchNode
    ? stretchNode.inputTime || 0
    : 0;
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
    if (stretchNode) {
      try {
        stretchNode.disconnect();
      } catch (error) {
        /* already disconnected */
      }

      stretchNode = null;
    }

    ensureAudioContext();

    await warmUpAudioEngine();

    const data =
      await file.arrayBuffer();

    const audioBuffer =
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

    await stretchNode.addBuffers(channels);

    stretchNode.connect(
      audioContext.destination
    );

    stretchNode.schedule({
      input: 0,
      rate: currentTempo,
      semitones: 0,
      active: false
    });

    stretchNode.setUpdateInterval(
      0.1,
      handleAudioProgress
    );

    isPlaying = false;

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
  if (!stretchNode) {
    return;
  }

  const time = getAudioTime();

  audioSeek.value = time;

  currentTimeElement.textContent =
    formatTime(time);

  processAutomaticPageTurns();

  if (
    isPlaying &&
    audioDuration > 0 &&
    time >= audioDuration - 0.08
  ) {
    stretchNode.schedule({ active: false });

    isPlaying = false;

    updatePlayPauseButton(false);
    hideTurnWarning();
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

function applyTempo() {
  /*
   * High-quality time-stretch with pitch preserved
   * (semitones: 0). Applied live, no re-render.
   */
  if (stretchNode) {
    stretchNode.schedule({
      rate: currentTempo,
      semitones: 0
    });
  }

  updateTempoDisplay();
}

async function setTempo(
  newTempo,
  save = true
) {
  currentTempo =
    clampTempo(
      Math.round(newTempo * 100) / 100
    );

  applyTempo();

  if (save && currentSong) {
    currentSong.settings.playbackRate =
      currentTempo;

    await saveSong(currentSong);

    updateSongInMemory();
  }
}

async function togglePlayback() {
  if (!currentSong || !stretchNode || audioLoading) {
    return;
  }

  try {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    if (isPlaying) {
      stretchNode.schedule({ active: false });

      isPlaying = false;

      updatePlayPauseButton(false);
      hideTurnWarning();
    } else {
      if (
        audioDuration > 0 &&
        getAudioTime() >= audioDuration - 0.08
      ) {
        stretchNode.schedule({ input: 0 });
      }

      stretchNode.schedule({
        active: true,
        rate: currentTempo,
        semitones: 0
      });

      isPlaying = true;

      updatePlayPauseButton(true);
    }
  } catch (error) {
    console.error(error);

    showToast(
      "Could not start playback."
    );
  }
}

async function restartSong() {
  if (!currentSong || !stretchNode) {
    return;
  }

  stretchNode.schedule({
    active: false,
    input: 0
  });

  isPlaying = false;

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

function showToast(message) {
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
    }, 2400);
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
    if (!stretchNode) {
      return;
    }

    const time =
      Number(audioSeek.value);

    stretchNode.schedule({ input: time });

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
  dark: "#0d0e10",
  light: "#f4f5f7"
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