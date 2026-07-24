const CACHE_NAME =
  "katusoitto-app-v46";

const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./vendor/pdf.js",
  "./vendor/pdf.worker.js",
  "./vendor/SignalsmithStretch.js"
];

self.addEventListener(
  "install",
  event => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then(cache => {
          return cache.addAll(
            APP_FILES
          );
        })
        .then(() => {
          return self.skipWaiting();
        })
    );
  }
);

self.addEventListener(
  "activate",
  event => {
    event.waitUntil(
      caches
        .keys()
        .then(keys => {
          return Promise.all(
            keys
              .filter(key => {
                return (
                  key !==
                  CACHE_NAME
                );
              })
              .map(key => {
                return caches.delete(
                  key
                );
              })
          );
        })
        .then(() => {
          return self.clients.claim();
        })
    );
  }
);

self.addEventListener(
  "fetch",
  event => {
    if (
      event.request.method !==
      "GET"
    ) {
      return;
    }

    /*
     * Only handle same-origin GET requests. Others
     * (e.g. any possible external resources) go straight
     * to the network and are not cached.
     */
    const requestUrl =
      new URL(event.request.url);

    if (
      requestUrl.origin !==
      self.location.origin
    ) {
      return;
    }

    event.respondWith(
      caches
        .match(event.request)
        .then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }

          return fetch(
            event.request
          ).then(networkResponse => {
            if (
              !networkResponse ||
              networkResponse.status !== 200 ||
              networkResponse.type !== "basic"
            ) {
              return networkResponse;
            }

            const responseCopy =
              networkResponse.clone();

            caches
              .open(CACHE_NAME)
              .then(cache => {
                cache.put(
                  event.request,
                  responseCopy
                );
              });

            return networkResponse;
          });
        })
    );
  }
);