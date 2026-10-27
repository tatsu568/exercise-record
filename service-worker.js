"use strict";

const CACHE_NAME = "exercise-record-v21";
const APP_FILES = [
  "./", "./index.html", "./style.css?v=0.4-gear-optical-20261024-up2",
  "./record-save.js", "./record-transfer.js", "./numbers-csv.js", "./script.js",
  "./record-history.js?v=0.3-history-separators-20261021", "./body-graph.js",
  "./measurement-attention.js", "./attention-acknowledgements.js", "./app-navigation.js",
  "./history-view.js?v=0.3-history-separators-20261021", "./app-settings.js", "./settings-view.js",
  "./graph-view.js", "./exercise-summary.js", "./exercise-summary-view.js",
  "./manifest.json", "./icons/icon.svg", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("exercise-record-") && key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  })));
});
