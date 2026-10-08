/* Service worker : garde l'appli utilisable hors-ligne, tout en allant
   toujours chercher la dernière version en ligne quand une connexion est
   disponible (stratégie "réseau d'abord, cache en secours" — évite de
   rester bloqué sur une ancienne version après une mise à jour). */
const CACHE_NAME = "antan-nou-v3";
const FILES_TO_CACHE = [
  "./antan-nou.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./assets/papillon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((fresh) => {
        const copy = fresh.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return fresh;
      })
      .catch(() => caches.match(event.request))
  );
});
