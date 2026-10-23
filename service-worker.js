/* Service worker d'Antan Nou : mode hors ligne (étape 1).

   Principe général : quand il y a du réseau, on prend toujours la dernière
   version en ligne (on ne reste jamais bloqué sur une ancienne version après
   une mise à jour) ; sans réseau, on sert ce qui a déjà été consulté.

   Ce qui reste disponible hors connexion :
   - l'appli elle-même (page, icônes, manifeste) ;
   - les bibliothèques (carte Leaflet, Firebase, polices) ;
   - les tuiles de carte déjà affichées, et les zones téléchargées sur demande ;
   - les photos déjà vues et les listes de photos déjà chargées pour une fiche.

   Ce qui n'est JAMAIS mis en cache : tout ce qui n'est pas une requête GET
   (écritures) et tout ce qui touche au compte et à la base (Firebase Auth,
   Firestore, Storage) : ces données doivent toujours être fraîches. */

const VERSION = "v5";
const CACHE_APP = "antan-nou-app-" + VERSION;   // appli (même origine)
const CACHE_LIBS = "antan-nou-libs-" + VERSION; // Leaflet, Firebase SDK, polices
const CACHE_TILES = "antan-nou-tiles-" + VERSION; // tuiles de carte
const CACHE_IMG = "antan-nou-img-" + VERSION;   // photos
const CACHE_API = "antan-nou-api-" + VERSION;   // listes de photos (Wikimedia, Openverse)
// Zones de carte téléchargées à la demande de l'utilisateur (bouton « Télécharger la
// zone » d'une fiche). Cache géré par la page : jamais purgé par le plafond des
// tuiles, et son nom ne porte pas de version pour survivre aux mises à jour.
const CACHE_ZONES = "antan-nou-zones-v1";
const ALL_CACHES = [CACHE_APP, CACHE_LIBS, CACHE_TILES, CACHE_IMG, CACHE_API, CACHE_ZONES];

// Plafonds : évitent de saturer le stockage du téléphone.
const MAX_TILES = 400;
const MAX_IMAGES = 250;
const MAX_API = 120;
const NETWORK_TIMEOUT_MS = 4000; // au-delà, on bascule sur le cache (réseau très lent)

const APP_SHELL = [
  "./antan-nou.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./assets/papillon.svg",
];

// Bibliothèques chargées depuis des CDN : préchargées à l'installation pour que
// la carte et le compte fonctionnent dès le premier passage hors connexion.
const LIBS_TO_PRECACHE = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  "https://unpkg.com/leaflet@1.9.4/dist/images/layers.png",
  "https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js",
];

// Hôtes à ne jamais intercepter (compte, base de données, stockage).
const NEVER_CACHE_HOSTS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebasestorage.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "www.googleapis.com",
  "apis.google.com",
];

const LIB_HOSTS = ["unpkg.com", "www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const API_HOSTS = ["commons.wikimedia.org", "api.openverse.org"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(CACHE_APP);
    await app.addAll(APP_SHELL);
    // Les bibliothèques sont ajoutées une par une : un CDN indisponible ne doit
    // pas empêcher l'installation (l'appli reste utilisable, juste sans cache).
    const libs = await caches.open(CACHE_LIBS);
    await Promise.all(LIBS_TO_PRECACHE.map((url) => libs.add(url).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Une réponse est mémorisable si elle est réussie ou « opaque » (image/script
// d'un autre domaine chargé sans CORS : on ne peut pas lire son statut).
function cacheable(response) {
  return !!response && (response.ok || response.type === "opaque");
}

// Garde au plus `max` entrées dans le cache (les plus anciennes sont supprimées).
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function store(cacheName, request, response, max) {
  if (!cacheable(response)) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (max) await trim(cacheName, max);
}

// Réseau d'abord (avec délai maximum), cache en secours.
function networkFirst(event, cacheName, max, fallbackShell) {
  const request = event.request;
  return (async () => {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS));
      const fresh = await Promise.race([fetch(request), timeout]);
      event.waitUntil(store(cacheName, request, fresh.clone(), max));
      return fresh;
    } catch (e) {
      const cached = await caches.match(request, { ignoreVary: true });
      if (cached) return cached;
      if (fallbackShell) {
        const shell = await caches.match("./antan-nou.html", { ignoreSearch: true });
        if (shell) return shell;
      }
      return Response.error();
    }
  })();
}

// Cache d'abord (tuiles, bibliothèques) : rapide et fonctionne sans réseau.
function cacheFirst(event, cacheName, max) {
  const request = event.request;
  return (async () => {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) return cached;
    const fresh = await fetch(request);
    event.waitUntil(store(cacheName, request, fresh.clone(), max));
    return fresh;
  })();
}

// Cache d'abord, mais rafraîchi en arrière-plan (photos).
function staleWhileRevalidate(event, cacheName, max) {
  const request = event.request;
  return (async () => {
    const cached = await caches.match(request, { ignoreVary: true });
    const refresh = fetch(request)
      .then((fresh) => { event.waitUntil(store(cacheName, request, fresh.clone(), max)); return fresh; })
      .catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const fresh = await refresh;
    return fresh || Response.error();
  })();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // On n'intercepte que les lectures : jamais une écriture.
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== "https:" && url.hostname !== "localhost") return;

  // Compte et base de données : toujours le réseau, jamais le cache.
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Même origine : l'appli.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event, CACHE_APP, 0, request.mode === "navigate"));
    return;
  }

  // Tuiles de carte OpenStreetMap.
  // Seules les images affichées par la carte passent ici : le téléchargement d'une zone
  // (fetch depuis la page) n'est pas intercepté, la page range elle-même les tuiles
  // dans CACHE_ZONES. Les tuiles d'une zone téléchargée sont retrouvées par
  // caches.match, qui cherche dans tous les caches.
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    if (request.destination !== "image") return;
    event.respondWith(cacheFirst(event, CACHE_TILES, MAX_TILES));
    return;
  }

  // Bibliothèques et polices.
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(event, CACHE_LIBS, 0));
    return;
  }

  // Listes de photos par fiche.
  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(event, CACHE_API, MAX_API, false));
    return;
  }

  // Photos (tout autre domaine, requêtes d'image).
  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(event, CACHE_IMG, MAX_IMAGES));
    return;
  }
  // Le reste (liens externes, etc.) : comportement normal du navigateur.
});
