// Service worker: keeps a copy of the app so it opens at once, and offline (e.g. in the
// studio without wifi). Videos never go through here — they're local files (or come
// from the PC helper). A new version (a new version.js) is fetched whole and takes over.
importScripts("version.js");
var CACHE = "brushwork-" + self.APP_VERSION;
var SHELL = ["./", "index.html", "app.css", "app.js", "analysis.js", "store.js", "images.js", "version.js",
             "manifest.webmanifest", "apple-touch-icon.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return c.addAll(SHELL.map(function(u){ return new Request(u, { cache: "reload" }); }));
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  var isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if(url.origin !== self.location.origin && !isFont) return;      // the PC helper, blobs: straight through
  if(req.headers.get("range")) return;
  e.respondWith(caches.open(CACHE).then(function(c){
    return c.match(req, { ignoreSearch: !isFont }).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(res){
        if(res.ok && (isFont || SHELL.indexOf(url.pathname.split("/").pop() || "./") >= 0)) c.put(req, res.clone());
        return res;
      });
    });
  }));
});
