// Small IndexedDB wrapper: sessions (analysis + where you were), images and settings stay
// on the device. Falls back to memory if IndexedDB isn't available (private browsing).
(function(root){
  "use strict";
  var DB = "brushwork", VER = 2, mem = { sessions: {}, kv: {}, images: {} }, dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise(function(resolve){
      try{
        var req = indexedDB.open(DB, VER);
        req.onupgradeneeded = function(){
          var db = req.result;
          if(!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "key" });
          if(!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          // images picked on this device or grabbed from a video: { id, name, blob }, shared by
          // every session that lists the id (a course's sessions share its images)
          if(!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "id" });
        };
        req.onsuccess = function(){
          var db = req.result;
          // let a newer version of the app (in another tab) upgrade the database
          db.onversionchange = function(){ db.close(); dbp = null; };
          resolve(db);
        };
        req.onerror = function(){ resolve(null); };
        // another tab still has the old version open: say so, and don't hang meanwhile
        req.onblocked = function(){
          if(root.Store && root.Store.onblocked) root.Store.onblocked();
          setTimeout(function(){ resolve(null); }, 1500);
        };
      }catch(e){ resolve(null); }
    });
    return dbp;
  }

  function tx(store, mode, fn){
    return open().then(function(db){
      if(!db) return fn(null);
      return new Promise(function(resolve, reject){
        var t = db.transaction(store, mode), s = t.objectStore(store), out;
        var r = fn(s);
        if(r && "onsuccess" in r) r.onsuccess = function(){ out = r.result; };
        t.oncomplete = function(){ resolve(out); };
        t.onerror = function(){ reject(t.error); };
      });
    });
  }

  var Store = {
    getSession: function(key){
      return tx("sessions", "readonly", function(s){ return s ? s.get(key) : null; })
        .then(function(v){ return v || mem.sessions[key] || null; });
    },
    putSession: function(obj){
      obj.updated = Date.now();
      mem.sessions[obj.key] = obj;
      return tx("sessions", "readwrite", function(s){ return s ? s.put(obj) : null; }).catch(function(){});
    },
    deleteSession: function(key){
      delete mem.sessions[key];
      return tx("sessions", "readwrite", function(s){ return s ? s.delete(key) : null; }).catch(function(){});
    },
    listSessions: function(){
      return tx("sessions", "readonly", function(s){ return s ? s.getAll() : null; })
        .then(function(v){ return (v || Object.keys(mem.sessions).map(function(k){ return mem.sessions[k]; }))
          .sort(function(a, b){ return (b.updated || 0) - (a.updated || 0); }); });
    },
    getImage: function(id){
      return tx("images", "readonly", function(s){ return s ? s.get(id) : null; })
        .then(function(v){ return v || mem.images[id] || null; });
    },
    putImage: function(obj){
      mem.images[obj.id] = obj;
      return tx("images", "readwrite", function(s){ return s ? s.put(obj) : null; }).catch(function(){});
    },
    deleteImage: function(id){
      delete mem.images[id];
      return tx("images", "readwrite", function(s){ return s ? s.delete(id) : null; }).catch(function(){});
    },
    get: function(k){
      return tx("kv", "readonly", function(s){ return s ? s.get(k) : null; })
        .then(function(v){ return v != null ? v : mem.kv[k]; });
    },
    set: function(k, v){
      mem.kv[k] = v;
      return tx("kv", "readwrite", function(s){ return s ? s.put(v, k) : null; }).catch(function(){});
    }
  };
  root.Store = Store;
})(self);
