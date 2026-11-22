// Small IndexedDB wrapper: sessions (analysis + where you were) and settings stay on
// the device. Falls back to memory if IndexedDB isn't available (private browsing).
(function(root){
  "use strict";
  var DB = "brushwork", VER = 1, mem = { sessions: {}, kv: {} }, dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise(function(resolve){
      try{
        var req = indexedDB.open(DB, VER);
        req.onupgradeneeded = function(){
          var db = req.result;
          if(!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "key" });
          if(!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        req.onsuccess = function(){ resolve(req.result); };
        req.onerror = function(){ resolve(null); };
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
