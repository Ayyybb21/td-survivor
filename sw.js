// TD Survivor V10 retirement service worker.
// V10 no longer relies on offline asset caching; the app uses a version manifest
// so installed Home Screen copies can fetch new builds without reinstalling.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k.startsWith("td-survivor-")).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener("fetch",()=>{});
