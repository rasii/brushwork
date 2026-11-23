// Reference / finished-painting images for the open video: a floating, zoomable window over
// the video, and a full-screen view that pauses the video.
//
// Where the images come from:
//   - the PC helper lists every image in the video's folder (this session's own first);
//   - on the iPad, images picked along with the video (or added later) are kept on the
//     device, once each, and listed against the session;
//   - "Grab this frame" saves the current video frame as an image.
(function(root){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };

  // ------------------------------------------------------------------ zoomable image
  // Wheel / pinch to zoom, drag to move, double-click / double-tap to zoom in or back out.
  function ZoomView(box){
    var self = this;
    this.box = box;
    this.img = document.createElement("img");
    this.img.alt = ""; this.img.draggable = false;
    box.appendChild(this.img);
    this.s = 1; this.tx = 0; this.ty = 0; this.nw = 0; this.nh = 0;
    this.view = null;        // { z: zoom relative to "fit", cx, cy: image point at the centre (0..1) }
    this.onchange = null;
    this.pts = {};
    this.lastTap = 0;

    box.addEventListener("wheel", function(e){
      if(!self.nw) return;
      e.preventDefault();
      var r = box.getBoundingClientRect();
      var k = e.deltaMode === 1 ? 0.05 : 0.0015;
      self.zoomAt(Math.exp(-e.deltaY * k * (e.ctrlKey ? 4 : 1)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    box.addEventListener("pointerdown", function(e){
      e.stopPropagation();
      try{ box.setPointerCapture(e.pointerId); }catch(err){}
      self.pts[e.pointerId] = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
      self.startPinch();
      box.classList.add("grabbing");
    });
    box.addEventListener("pointermove", function(e){
      var p = self.pts[e.pointerId]; if(!p || !self.nw) return;
      var ids = Object.keys(self.pts);
      if(ids.length === 1){
        self.tx += e.clientX - p.x; self.ty += e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        self.apply();
      } else {
        p.x = e.clientX; p.y = e.clientY;
        self.movePinch();
      }
    });
    function up(e){
      var p = self.pts[e.pointerId]; if(!p) return;
      delete self.pts[e.pointerId];
      if(!Object.keys(self.pts).length) box.classList.remove("grabbing");
      self.startPinch();
      // a tap that didn't move: two in quick succession toggle the zoom
      if(e.type === "pointerup" && Math.abs(e.clientX - p.x0) + Math.abs(e.clientY - p.y0) < 10){
        var now = Date.now();
        if(now - self.lastTap < 320){ self.lastTap = 0; self.toggleZoom(e); }
        else self.lastTap = now;
      }
    }
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
    if(root.ResizeObserver) new ResizeObserver(function(){ self.relayout(); }).observe(box);
  }
  ZoomView.prototype.size = function(){ return { w: this.box.clientWidth, h: this.box.clientHeight }; };
  ZoomView.prototype.fitScale = function(){
    var b = this.size();
    return this.nw ? Math.min(b.w / this.nw, b.h / this.nh) : 1;
  };
  ZoomView.prototype.apply = function(){
    var b = this.size();
    if(this.nw && b.w){
      var f = this.fitScale();
      // keep at least part of the picture on screen
      var iw = this.nw * this.s, ih = this.nh * this.s, m = 60;
      this.tx = Math.min(b.w - m, Math.max(m - iw, this.tx));
      this.ty = Math.min(b.h - m, Math.max(m - ih, this.ty));
      this.view = { z: this.s / f, cx: (b.w / 2 - this.tx) / iw, cy: (b.h / 2 - this.ty) / ih };
    }
    this.img.style.transform = "translate(" + this.tx + "px," + this.ty + "px) scale(" + this.s + ")";
    if(this.onchange) this.onchange(this.view);
  };
  ZoomView.prototype.fit = function(){
    var b = this.size(), f = this.fitScale();
    this.s = f; this.tx = (b.w - this.nw * f) / 2; this.ty = (b.h - this.nh * f) / 2;
    this.apply();
  };
  ZoomView.prototype.setView = function(v){
    if(!v || !this.nw) return this.fit();
    var b = this.size();
    this.s = this.fitScale() * v.z;
    this.tx = b.w / 2 - v.cx * this.nw * this.s;
    this.ty = b.h / 2 - v.cy * this.nh * this.s;
    this.apply();
  };
  ZoomView.prototype.relayout = function(){ if(this.nw && this.box.clientWidth) this.setView(this.view); };
  ZoomView.prototype.zoomAt = function(k, cx, cy){
    var f = this.fitScale();
    var ns = Math.max(f * 0.5, Math.min(Math.max(f * 16, 3), this.s * k));
    this.tx = cx - (cx - this.tx) * ns / this.s;
    this.ty = cy - (cy - this.ty) * ns / this.s;
    this.s = ns;
    this.apply();
  };
  ZoomView.prototype.toggleZoom = function(e){
    var r = this.box.getBoundingClientRect();
    if(this.s > this.fitScale() * 1.05) this.fit();
    else this.zoomAt(3, e.clientX - r.left, e.clientY - r.top);
  };
  ZoomView.prototype.startPinch = function(){
    var ids = Object.keys(this.pts);
    if(ids.length < 2){ this.pinch = null; return; }
    var a = this.pts[ids[0]], b = this.pts[ids[1]], r = this.box.getBoundingClientRect();
    this.pinch = { ids: ids.slice(0, 2), d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                   mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, s: this.s, tx: this.tx, ty: this.ty };
  };
  ZoomView.prototype.movePinch = function(){
    var P = this.pinch; if(!P) return;
    var a = this.pts[P.ids[0]], b = this.pts[P.ids[1]]; if(!a || !b) return;
    var r = this.box.getBoundingClientRect(), f = this.fitScale();
    var mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    var ns = Math.max(f * 0.5, Math.min(Math.max(f * 16, 3), P.s * Math.hypot(a.x - b.x, a.y - b.y) / P.d));
    this.s = ns;
    this.tx = mx - (P.mx - P.tx) * ns / P.s;
    this.ty = my - (P.my - P.ty) * ns / P.s;
    this.apply();
  };
  ZoomView.prototype.load = function(url, view){
    var self = this, img = this.img;
    this.nw = 0;
    img.style.visibility = "hidden";
    return new Promise(function(resolve){
      img.onload = function(){
        self.nw = img.naturalWidth; self.nh = img.naturalHeight;
        img.style.width = self.nw + "px"; img.style.height = self.nh + "px";
        self.setView(view);
        img.style.visibility = "";
        resolve(true);
      };
      img.onerror = function(){ resolve(false); };
      img.src = url;
    });
  };
  ZoomView.prototype.clear = function(){ this.img.removeAttribute("src"); this.nw = 0; };

  // ------------------------------------------------------------------ images for the open video
  var H = null;            // hooks from app.js
  var items = [];          // { name, url, session, saved, id?, grab? }
  var urls = [];           // object URLs to revoke
  var sess = null;
  var ui = null;           // { open, geo: {x, y, w, h} (fractions of the stage), cur, views: {name: view} }
  var cur = -1, fullCur = -1, fullWasPlaying = false;
  var winView, fullView, saveTimer = null;
  var IMG_RE = /\.(jpe?g|png|webp|gif|heic)$/i;

  function defaultUI(){ return { open: false, geo: { x: 0.66, y: 0.05, w: 0.32, h: 0.45 }, cur: null, views: {} }; }

  function init(hooks){
    H = hooks;
    winView = new ZoomView($("imgWinView"));
    fullView = new ZoomView($("imgFullView"));
    winView.onchange = function(v){
      if(v && items[cur]){ ui.views[items[cur].name] = v; saveUI(); }
    };
    $("imgBtn").addEventListener("click", toggleWindow);
    $("imgClose").addEventListener("click", function(){ setOpen(false); });
    $("imgPrev").addEventListener("click", function(){ step(-1); });
    $("imgNext").addEventListener("click", function(){ step(1); });
    $("imgExpand").addEventListener("click", function(){ openFull(cur); });
    $("imgFit").addEventListener("click", function(){ winView.fit(); });
    $("imgAdd").addEventListener("click", pickImages);
    $("imgGrab").addEventListener("click", grab);
    $("imgEmptyAdd").addEventListener("click", pickImages);
    $("imgEmptyGrab").addEventListener("click", grab);
    $("imgInput").addEventListener("change", function(){
      var files = Array.prototype.slice.call(this.files || []); this.value = "";
      if(files.length) addFiles(files).then(function(n){ if(n){ showLast(n); } });
    });
    $("imgFullClose").addEventListener("click", closeFull);
    $("imgFullPrev").addEventListener("click", function(){ fullStep(-1); });
    $("imgFullNext").addEventListener("click", function(){ fullStep(1); });
    $("imgFullWindow").addEventListener("click", function(){
      var i = fullCur; closeFull(); if(!ui.open) setOpen(true); show(i);
    });
    $("imgFullRemove").addEventListener("click", removeCurrentFull);
    bindWindowDrag();
    window.addEventListener("resize", function(){ if(ui && ui.open) place(); });
  }

  // a session was opened; extra = image files picked along with the video (iPad)
  function open(s, extra){
    close();
    sess = s;
    var listP = s.source === "helper"
      ? H.fetchJSON(H.helperURL("/api/images?id=" + s.id)).catch(function(){ return []; }) : Promise.resolve([]);
    return (extra && extra.length ? addFiles(extra, true) : Promise.resolve(0)).then(function(){
      return Promise.all([listP, Store.getSession(s.key)]);
    }).then(function(r){
      if(sess !== s) return;
      var rec = r[1] || {};
      ui = Object.assign(defaultUI(), rec.imgUI || {});
      items = r[0].map(function(im){
        return { name: im.name, session: im.session, saved: false,
                 url: H.helperURL("/image?id=" + s.id + "&n=" + encodeURIComponent(im.name)) };
      });
      return loadSaved(rec.imgs || []);
    }).then(function(){
      if(sess !== s) return;
      sortItems();
      var i = ui.cur ? indexOf(ui.cur) : -1;
      cur = i >= 0 ? i : (items.length ? 0 : -1);
      updateButton();
      if(ui.open) setOpen(true, true);
    });
  }

  function loadSaved(list){
    var have = {};
    items.forEach(function(it){ have[it.name] = 1; });
    return Promise.all(list.map(function(ref){
      if(have[ref.name]) return null;
      return Store.getImage(ref.id).then(function(rec){
        if(!rec || !rec.blob) return null;
        var u = URL.createObjectURL(rec.blob); urls.push(u);
        have[ref.name] = 1;
        items.push({ name: ref.name, url: u, saved: true, id: ref.id, grab: !!ref.grab, t: ref.t });
      });
    }));
  }

  function sortItems(){
    var st = sess ? H.stemOf(sess.name).toLowerCase() : "";
    items.forEach(function(it){
      if(it.saved && !it.grab){
        var n = it.name.toLowerCase();
        it.session = n.indexOf(st + " ") === 0 || n.replace(/\.[^.]+$/, "") === st;
      }
    });
    items.sort(function(a, b){
      var ka = a.grab ? 2 : a.session ? 0 : 1, kb = b.grab ? 2 : b.session ? 0 : 1;
      if(ka !== kb) return ka - kb;
      if(a.grab) return (a.t || 0) - (b.t || 0);
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
  }
  function indexOf(name){ for(var i = 0; i < items.length; i++) if(items[i].name === name) return i; return -1; }

  function close(){
    if(isFullOpen()) closeFull(true);
    $("imgWin").hidden = true;
    winView && winView.clear(); fullView && fullView.clear();
    urls.forEach(function(u){ URL.revokeObjectURL(u); }); urls = [];
    items = []; sess = null; cur = -1; ui = defaultUI();
    clearTimeout(saveTimer);
    if($("imgBtn")) $("imgBtn").classList.remove("on");
  }

  // save picked image files on the device and list them against this session
  function addFiles(files, quiet){
    files = files.filter(function(f){ return /^image\//.test(f.type) || IMG_RE.test(f.name); });
    if(!files.length || !sess || !sess.key) return Promise.resolve(0);
    var s = sess;
    return Store.getSession(s.key).then(function(rec){
      rec = rec || { key: s.key, name: s.name, source: s.source };
      rec.imgs = rec.imgs || [];
      return Promise.all(files.map(function(f){
        var id = f.name + "|" + f.size;
        return Store.putImage({ id: id, name: f.name, blob: f }).then(function(){
          rec.imgs = rec.imgs.filter(function(r){ return r.name !== f.name; });
          rec.imgs.push({ id: id, name: f.name });
          return f;
        });
      })).then(function(){ return Store.putSession(rec); }).then(function(){
        if(quiet || sess !== s) return files.length;
        // add them to what's shown now
        items = items.filter(function(it){ return !files.some(function(f){ return f.name === it.name; }); });
        files.forEach(function(f){
          var u = URL.createObjectURL(f); urls.push(u);
          items.push({ name: f.name, url: u, saved: true, id: f.name + "|" + f.size });
        });
        sortItems(); updateButton();
        H.toast(files.length === 1 ? "Image added" : files.length + " images added");
        return files.length;
      });
    });
  }
  function pickImages(){ $("imgInput").click(); }
  function showLast(){ if(!ui.open) setOpen(true); else if(cur < 0) show(0); else show(cur); }

  function grab(){
    var v = H.video;
    if(!sess || !v.videoWidth){ H.toast("Nothing to grab yet"); return; }
    var c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    try{
      c.getContext("2d").drawImage(v, 0, 0);
      c.toBlob(function(blob){
        if(!blob){ H.toast("Couldn't grab this frame"); return; }
        var t = v.currentTime, s = sess;
        var name = "Frame at " + H.fmt(t), id = "grab|" + s.key + "|" + Math.round(t * 10);
        Store.putImage({ id: id, name: name, blob: blob }).then(function(){ return Store.getSession(s.key); }).then(function(rec){
          rec = rec || { key: s.key, name: s.name, source: s.source };
          rec.imgs = (rec.imgs || []).filter(function(r){ return r.id !== id; });
          rec.imgs.push({ id: id, name: name, grab: true, t: t });
          return Store.putSession(rec);
        }).then(function(){
          if(sess !== s) return;
          var u = URL.createObjectURL(blob); urls.push(u);
          items = items.filter(function(it){ return it.id !== id; });
          items.push({ name: name, url: u, saved: true, id: id, grab: true, t: t });
          sortItems(); updateButton();
          if(!ui.open) setOpen(true);
          show(indexOf(name));
          H.toast("Saved this frame");
        });
      }, "image/jpeg", 0.92);
    }catch(e){
      H.toast("This browser won't let the app copy this video's frames", 3000);
    }
  }

  function removeItem(i){
    var it = items[i]; if(!it || !it.saved || !sess) return Promise.resolve();
    var s = sess;
    return Store.getSession(s.key).then(function(rec){
      if(rec && rec.imgs){ rec.imgs = rec.imgs.filter(function(r){ return r.id !== it.id; }); return Store.putSession(rec); }
    }).then(function(){
      if(it.grab) Store.deleteImage(it.id);
      if(sess !== s) return;
      items.splice(i, 1);
      if(ui.views) delete ui.views[it.name];
      updateButton();
    });
  }

  // ------------------------------------------------------------------ floating window
  function updateButton(){
    $("imgBtn").title = (items.length ? items.length + " image" + (items.length > 1 ? "s" : "") : "Images") + " (I)";
  }
  function toggleWindow(){ setOpen(!ui.open); }
  function setOpen(on, restoring){
    ui.open = on;
    $("imgWin").hidden = !on;
    $("imgBtn").classList.toggle("on", on);
    if(on){ place(); show(cur >= 0 ? cur : 0); }
    if(!restoring) saveUI();
  }
  function show(i){
    var has = items.length > 0;
    $("imgWinEmpty").hidden = has;
    $("imgWinView").hidden = !has;
    $("imgExpand").disabled = $("imgFit").disabled = !has;
    $("imgPrev").disabled = $("imgNext").disabled = items.length < 2;
    if(!has){ cur = -1; $("imgName").textContent = "Images"; return; }
    cur = (i + items.length) % items.length;
    var it = items[cur];
    ui.cur = it.name;
    $("imgName").textContent = it.name.replace(/\.[^.]+$/, "");
    $("imgName").title = it.name;
    winView.load(it.url, ui.views[it.name]);
    saveUI();
  }
  function step(d){ if(items.length) show(cur + d); }

  function stageRect(){ return $("stage").getBoundingClientRect(); }
  function place(){
    var r = stageRect(), g = ui.geo, w = $("imgWin");
    var W = Math.max(220, Math.min(r.width, g.w * r.width)), Hh = Math.max(160, Math.min(r.height, g.h * r.height));
    var x = Math.max(0, Math.min(r.width - W, g.x * r.width)), y = Math.max(0, Math.min(r.height - Hh, g.y * r.height));
    w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = W + "px"; w.style.height = Hh + "px";
  }
  function bindWindowDrag(){
    var drag = null;
    function start(e, mode){
      if(e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var w = $("imgWin");
      drag = { mode: mode, id: e.pointerId, x: e.clientX, y: e.clientY,
               l: w.offsetLeft, t: w.offsetTop, w: w.offsetWidth, h: w.offsetHeight };
      try{ e.currentTarget.setPointerCapture(e.pointerId); }catch(err){}
    }
    function move(e){
      if(!drag || e.pointerId !== drag.id) return;
      var r = stageRect(), dx = e.clientX - drag.x, dy = e.clientY - drag.y, g = ui.geo;
      if(drag.mode === "move"){
        g.x = Math.max(0, Math.min(r.width - drag.w, drag.l + dx)) / r.width;
        g.y = Math.max(0, Math.min(r.height - drag.h, drag.t + dy)) / r.height;
      } else {
        g.w = Math.max(220, Math.min(r.width - drag.l, drag.w + dx)) / r.width;
        g.h = Math.max(160, Math.min(r.height - drag.t, drag.h + dy)) / r.height;
      }
      place();
    }
    function end(e){ if(drag && e.pointerId === drag.id){ drag = null; saveUI(); } }
    var bar = $("imgWinBar"), rs = $("imgWinResize");
    bar.addEventListener("pointerdown", function(e){ if(!e.target.closest("button")) start(e, "move"); });
    rs.addEventListener("pointerdown", function(e){ start(e, "size"); });
    [bar, rs].forEach(function(el){
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
    // keep taps on the window from reaching the video underneath
    $("imgWin").addEventListener("pointerdown", function(e){ e.stopPropagation(); });
    $("imgWin").addEventListener("click", function(e){ e.stopPropagation(); });
  }

  function saveUI(){
    if(!sess || !sess.key) return;
    var s = sess, snapshot = JSON.parse(JSON.stringify(ui));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      Store.getSession(s.key).then(function(rec){
        rec = rec || { key: s.key, name: s.name, source: s.source };
        rec.imgUI = snapshot;
        Store.putSession(rec);
      });
    }, 600);
  }

  // ------------------------------------------------------------------ full screen
  function isFullOpen(){ return !$("imgFull").hidden; }
  function openFull(i){
    if(!sess) return;
    if(!items.length){ if(!ui.open) setOpen(true); return; }
    fullWasPlaying = !H.video.paused;
    H.video.pause();
    $("imgFull").hidden = false;
    var box = $("imgFullChips"); box.innerHTML = "";
    items.forEach(function(it, k){
      var b = document.createElement("button");
      b.className = "chip"; b.textContent = it.name.replace(/\.[^.]+$/, "");
      b.addEventListener("click", function(){ fullShow(k); });
      box.appendChild(b);
    });
    fullShow(i >= 0 ? i : 0);
  }
  function fullShow(i){
    fullCur = (i + items.length) % items.length;
    var it = items[fullCur];
    $("imgFullName").textContent = it.name.replace(/\.[^.]+$/, "");
    $("imgFullRemove").hidden = !it.saved;
    $("imgFullPrev").hidden = $("imgFullNext").hidden = items.length < 2;
    Array.prototype.forEach.call($("imgFullChips").children, function(c, k){ c.classList.toggle("on", k === fullCur); });
    var chip = $("imgFullChips").children[fullCur];
    if(chip && chip.scrollIntoView) chip.scrollIntoView({ block: "nearest", inline: "center" });
    fullView.load(it.url, null);
  }
  function fullStep(d){ if(items.length) fullShow(fullCur + d); }
  function closeFull(noResume){
    $("imgFull").hidden = true;
    fullView.clear();
    if(fullWasPlaying && noResume !== true) H.video.play().catch(function(){});
    fullWasPlaying = false;
  }
  function removeCurrentFull(){
    var it = items[fullCur]; if(!it || !it.saved) return;
    if(!confirm('Remove "' + it.name + '" from this video?' + (it.grab ? "" : " The file in Files isn't touched."))) return;
    var wasCur = items[cur] === it;
    removeItem(fullCur).then(function(){
      if(!items.length){ closeFull(); show(0); return; }
      openFull(Math.min(fullCur, items.length - 1));
      if(wasCur && ui.open) show(Math.min(cur, items.length - 1));
    });
  }

  // keys while the full-screen view is open; returns true if handled
  function key(e){
    if(!isFullOpen()) return false;
    if(e.key === "Escape" || e.key === "o" || e.key === "O"){ closeFull(); }
    else if(e.key === "ArrowLeft"){ fullStep(-1); }
    else if(e.key === "ArrowRight"){ fullStep(1); }
    else if(e.key === "0"){ fullView.fit(); }
    e.preventDefault();
    return true;
  }

  root.BWImages = { init: init, open: open, close: close, addFiles: addFiles, toggleWindow: toggleWindow,
                    openFull: function(){ openFull(cur >= 0 ? cur : 0); }, isFullOpen: isFullOpen, key: key,
                    grab: grab, ZoomView: ZoomView,
                    // the image in the floating window, if it's open: what "Match" compares the video with
                    shown: function(){ return ui && ui.open && cur >= 0 && items[cur] && winView.nw ?
                      { name: items[cur].name, img: winView.img, box: winView.box } : null; } };
})(self);
