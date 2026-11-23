// Brushwork: watch painting-demo videos with the palette mixing and quiet stretches
// skipped (or fast-forwarded), and dip into any skipped part from the timeline.
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var CAT = BW.CAT;
  var HELPER_PORT = 8777;
  var MODES = ["all", "paint", "talk", "fast"];
  var MODE_NAMES = { all: "Everything", paint: "Painting", talk: "Painting + talking", fast: "Fast-forward the rest" };

  var state = {
    helper: null,          // base URL of the PC helper, "" when it serves this page, null if none
    settings: Object.assign({}, BW.DEFAULTS),
    mode: "paint",
    // the open video
    session: null,         // { key, name, source: "helper"|"file", id?, ... }
    A: null,               // analysis file contents
    D: null,               // derived timeline
    peek: null,            // [start, end] of a skipped part being watched
    seeking: false,
    userMuted: false,
    rateCap: null,         // highest playback rate the browser accepted
    ffCap: null,           // fast-forward speed lowered for this video after a stall
    poll: null,
    lastSave: 0,
    prepped: false
  };

  var video = $("video");

  // ------------------------------------------------------------------ utilities
  function fmt(s){
    if(!isFinite(s)) return "0:00";
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  }
  function fmtLong(s){
    if(s < 60) return Math.round(s) + " s";
    var m = Math.round(s / 60);
    if(m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
  }
  function stemOf(name){ return name.replace(/\.[^.]+$/, "").replace(/\s*\(prepped\)$/i, "").replace(/\.brushwork$/i, ""); }
  function sessionKey(name, duration){ return stemOf(name).toLowerCase() + "|" + Math.floor(duration / 5); }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var toastTimer = 0;
  function toast(msg, ms){
    // over the video when it's showing, otherwise at the top of the page
    var onVideo = !$("player").hidden && $("imgFull").hidden;
    var t = $(onVideo ? "toast" : "toastPage");
    $(onVideo ? "toastPage" : "toast").hidden = true;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.hidden = true; }, ms || 1800);
  }

  function fetchJSON(url, opts){
    return fetch(url, Object.assign({ cache: "no-store" }, opts || {})).then(function(r){
      if(!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function withTimeout(p, ms){
    return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error("timeout")); }, ms); })]);
  }

  // ------------------------------------------------------------------ helper (PC)
  function findHelper(){
    // served by the helper itself: on the PC (127.0.0.1) or from another device at home (the PC's address)
    var local = location.protocol === "http:" && location.port == String(HELPER_PORT);
    var candidates = local ? [""] : ["http://127.0.0.1:" + HELPER_PORT];
    // an iPad has no helper: only try when this could be the PC
    if(!local && /iPad|iPhone|iPod/.test(navigator.userAgent)) return Promise.resolve(null);
    if(!local && navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) return Promise.resolve(null);
    return withTimeout(fetchJSON(candidates[0] + "/api/hello"), 1500).then(function(j){
      return j && j.app === "brushwork-helper" ? candidates[0] : null;
    }).catch(function(){ return null; });
  }

  function helperURL(path){ return state.helper + path; }
  function run(s){ return s && (s.state === "running" || s.state === "elsewhere"); }

  // ------------------------------------------------------------------ library
  function showLibrary(){
    stopPoll();
    saveSession(true);
    video.pause();
    if(video.src){ var old = video.src; video.removeAttribute("src"); video.load(); if(old.indexOf("blob:") === 0) URL.revokeObjectURL(old); }
    BWImages.close();
    state.session = null; state.A = null; state.D = null; state.peek = null;
    $("player").hidden = true; $("library").hidden = false;
    $("backBtn").hidden = true; $("statsBtn").hidden = true; $("settingsBtn").hidden = true; $("pictureBtn").hidden = true;
    $("pictureModal").classList.remove("show");
    $("title").textContent = "Brushwork"; $("subtitle").textContent = "";
    document.body.classList.remove("fs");
    renderLibrary();
  }

  function renderLibrary(){
    $("version").textContent = self.APP_VERSION;
    $("helperPill").hidden = state.helper === null;
    $("helperPill").classList.toggle("on", state.helper !== null);
    $("noHelperHint").hidden = state.helper !== null || /iPad|iPhone/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
    renderRecent();
    if(state.helper === null){ $("helperSection").hidden = true; return; }
    fetchJSON(helperURL("/api/library")).then(function(lib){
      $("helperSection").hidden = false;
      var box = $("helperList"); box.innerHTML = "";
      if(!lib.folders.length){
        box.innerHTML = '<p class="hint">No video folders set yet — add them to <b>helper/config.json</b>.</p>';
        return;
      }
      var lastFolder = null;
      lib.videos.forEach(function(v){
        if(v.folder !== lastFolder){
          lastFolder = v.folder;
          var f = document.createElement("div"); f.className = "folder"; f.textContent = v.folder.replace(/\\/g, "/").split("/").slice(-2).join(" / ");
          box.appendChild(f);
        }
        var row = document.createElement("div"); row.className = "item";
        row.innerHTML = '<span class="name"></span><span class="meta"></span>';
        row.querySelector(".name").textContent = v.name;
        row.querySelector(".meta").innerHTML = badges(v);
        row.addEventListener("click", function(){ openHelperVideo(v); });
        box.appendChild(row);
      });
      // keep refreshing while anything is being processed
      if(lib.videos.some(function(v){ return v.job && (run(v.job.analyze) || run(v.job.prep) || v.job.queued); })){
        clearTimeout(renderLibrary.t);
        renderLibrary.t = setTimeout(function(){ if(!$("library").hidden) renderLibrary(); }, 4000);
      }
    }).catch(function(){ $("helperSection").hidden = true; });
  }

  function badges(v){
    var out = [];
    var j = v.job;
    if(j && run(j.analyze)) out.push('<span class="badge run">Analysing ' + Math.round(j.analyze.progress * 100) + '%</span>');
    else if(v.analysis === "done") out.push('<span class="badge ok">Analysed</span>');
    else if(j && j.queued) out.push('<span class="badge run">Queued</span>');
    else if(v.analysis === "partial") out.push('<span class="badge">Partly analysed</span>');
    else out.push('<span class="badge">Not analysed</span>');
    if(j && run(j.prep)) out.push('<span class="badge run">Prepping' + (j.prep.progress ? " " + Math.round(j.prep.progress * 100) + "%" : "…") + '</span>');
    else if(v.prepped) out.push('<span class="badge ok">Prepped</span>');
    return out.join("");
  }

  function renderRecent(){
    Store.listSessions().then(function(list){
      list = list.filter(function(s){ return s.source === "file"; }).slice(0, 12);
      $("recentSection").hidden = !list.length;
      var box = $("recentList"); box.innerHTML = "";
      list.forEach(function(s){
        var row = document.createElement("div"); row.className = "item";
        row.innerHTML = '<span class="name"></span><span class="meta"><span class="pos"></span>' +
          '<button class="icon-btn del" title="Forget" aria-label="Forget"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></span>';
        row.querySelector(".name").textContent = stemOf(s.name);
        row.querySelector(".pos").textContent = s.position ? "at " + fmt(s.position) : "";
        row.addEventListener("click", function(e){
          if(e.target.closest(".del")){ Store.deleteSession(s.key).then(renderRecent); return; }
          state.pendingName = stemOf(s.name);
          $("openHint").innerHTML = "Pick the video for <b>" + esc(stemOf(s.name)) + "</b> (its analysis is already saved here).";
          $("fileInput").click();
        });
        box.appendChild(row);
      });
    });
  }

  // ------------------------------------------------------------------ opening
  // A video that isn't ready asks first, so a mistaken tap doesn't start half an hour of work.
  function openHelperVideo(v, choice){
    var needs = v.analysis !== "done" || !v.prepped;
    var busy = v.job && (run(v.job.analyze) || run(v.job.prep) || v.job.queued);
    if(needs && !busy && !choice){
      $("processTitle").textContent = v.name;
      $("processWhat").textContent = v.analysis === "done" ? "It's analysed but has no prepped copy yet." :
        v.analysis === "partial" ? "Its analysis isn't finished (or was made by an older version)." :
        "It hasn't been analysed or prepped yet.";
      $("processGo").onclick = function(){ $("processModal").classList.remove("show"); openHelperVideo(v, "process"); };
      $("processWatch").onclick = function(){ $("processModal").classList.remove("show"); openHelperVideo(v, "watch"); };
      showModal("processModal");
      return;
    }
    if(choice === "watch") needs = false;
    var start = needs && !busy
      ? fetchJSON(helperURL("/api/process?id=" + v.id), { method: "POST" }).catch(function(){}) : Promise.resolve();
    start.then(function(){
      return fetchJSON(helperURL("/api/analysis?id=" + v.id)).catch(function(){ return null; });
    }).then(function(A){
      state.prepped = v.prepped;
      openPlayer({ source: "helper", id: v.id, name: v.name }, helperURL("/video?id=" + v.id + "&v=best"), A);
      if(needs) startPoll();
    });
  }

  $("openBtn").addEventListener("click", function(){ state.pendingName = null; $("fileInput").click(); });
  $("fileInput").addEventListener("change", function(){
    var files = Array.prototype.slice.call(this.files || []);
    this.value = "";
    if(!files.length) return;
    var vids = files.filter(function(f){ return /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name); });
    var jsons = files.filter(function(f){ return /\.json$/i.test(f.name); });
    var imgs = files.filter(function(f){ return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name); });
    Promise.all(jsons.map(function(f){ return f.text().then(function(t){ try{ return JSON.parse(t); }catch(e){ return null; } }); }))
      .then(function(list){
        list = list.filter(function(a){ return a && a.app === "brushwork" && a.video; });
        // save every analysis picked, so next time only the video is needed
        return Promise.all(list.map(function(A){
          var key = sessionKey(A.video.name, A.video.duration);
          return Store.getSession(key).then(function(s){
            s = s || { key: key, name: A.video.name, source: "file" };
            s.analysis = A; s.source = "file";
            return Store.putSession(s);
          });
        })).then(function(){ return list; });
      })
      .then(function(list){
        if(!vids.length){
          if(imgs.length){ toast("Pick the video together with its images", 2600); return; }
          if(list.length){ toast("Analysis saved — now pick the video", 2600); renderRecent(); }
          else toast("That isn't a video or a Brushwork analysis", 2600);
          return;
        }
        var f = vids[0];
        var A = list.filter(function(a){ return stemOf(a.video.name).toLowerCase() === stemOf(f.name).toLowerCase(); })[0] || list[0] || null;
        state.prepped = /\(prepped\)/i.test(f.name);
        state.pendingImages = imgs;
        openPlayer({ source: "file", name: A ? A.video.name : f.name, fileName: f.name }, URL.createObjectURL(f), A);
      });
  });

  function openPlayer(sess, src, A){
    state.session = sess; state.A = A; state.peek = null; state.rateCap = null; state.ffCap = null;
    $("library").hidden = true; $("player").hidden = false;
    $("backBtn").hidden = false; $("statsBtn").hidden = false; $("settingsBtn").hidden = false; $("pictureBtn").hidden = false;
    $("title").textContent = stemOf(sess.name);
    $("subtitle").textContent = sess.source === "helper" ? "" : "";
    video.src = src;
    video.muted = state.userMuted;
    video.addEventListener("loadedmetadata", function once(){
      video.removeEventListener("loadedmetadata", once);
      var dur = A ? A.video.duration : video.duration;
      sess.key = sessionKey(sess.name, dur);
      Store.getSession(sess.key).then(function(saved){
        if(!state.A && saved && saved.analysis){ state.A = saved.analysis; }
        if(!state.A){
          state.A = { app: "brushwork", video: { name: sess.name, duration: video.duration }, step: 0.5,
                      samples: { canvas: [], palette: [], layout: [] }, stretches: [], analyzedUntil: 0, complete: false };
          if(sess.source === "file") toast("No analysis for this video — it plays in full", 3500);
        }
        rederive();
        BWImages.open(sess, state.pendingImages); state.pendingImages = null;
        if(saved && saved.position && saved.position < dur - 5) video.currentTime = saved.position;
        Store.putSession(Object.assign(saved || {}, { key: sess.key, name: sess.name, source: sess.source,
                                                      analysis: sess.source === "file" ? state.A : undefined,
                                                      position: saved && saved.position || 0 }));
      });
    });
    updateModeButtons();
    resize();
  }

  function rederive(){
    if(!state.A) return;
    state.D = BW.derive(state.A, state.settings);
    drawBase();
    updateKept();
    if(!$("statsModal").classList.contains("show")) return;
    renderStats();
  }

  // ------------------------------------------------------------------ helper progress
  function startPoll(){
    stopPoll();
    state.poll = setInterval(pollOnce, 4000);
    pollOnce();
  }
  function stopPoll(){ if(state.poll){ clearInterval(state.poll); state.poll = null; } $("statusBar").hidden = true; }
  function pollOnce(){
    var s = state.session;
    if(!s || s.source !== "helper") return stopPoll();
    fetchJSON(helperURL("/api/status?id=" + s.id)).then(function(st){
      var j = st.job, parts = [];
      if(j && run(j.analyze)) parts.push("Analysing " + Math.round(j.analyze.progress * 100) + "%" +
        (state.D && state.D.until > 0 ? " — skipping works up to " + fmt(state.D.until) : ""));
      if(j && run(j.prep)) parts.push("Preparing smooth-skip copy" + (j.prep.progress ? " " + Math.round(j.prep.progress * 100) + "%" : "…"));
      if(j && j.queued && j.analyze.state === "waiting") parts.push("Waiting for another video to finish");
      $("statusBar").textContent = parts.join(" · ");
      $("statusBar").hidden = !parts.length;
      var refresh = j && (run(j.analyze) || st.analysis === "done") &&
                    (!state.A || !state.A.complete);
      var p = refresh ? fetchJSON(helperURL("/api/analysis?id=" + s.id)).then(function(A){
        if(state.session !== s) return;
        state.A = A; rederive();
      }).catch(function(){}) : Promise.resolve();
      p.then(function(){
        if(st.prepped && !state.prepped) swapToPrepped();
        if(st.analysis === "done" && st.prepped && state.A && state.A.complete) stopPoll();
      });
    }).catch(function(){});
  }
  function swapToPrepped(){
    state.prepped = true;
    var t = video.currentTime, playing = !video.paused;
    video.src = helperURL("/video?id=" + state.session.id + "&v=prepped&t=" + Date.now());
    video.addEventListener("loadedmetadata", function once(){
      video.removeEventListener("loadedmetadata", once);
      video.currentTime = t;
      if(playing) video.play().catch(function(){});
      toast("Switched to the smooth-skip copy");
    });
  }

  // ------------------------------------------------------------------ playback & skipping
  function keepList(){ return state.D ? state.D.keep[state.mode] : null; }

  // gapMute: silence a fast-forwarded gap; speech above 4x is noise (and Chrome drops it anyway)
  function setRate(r, gapMute){
    diag.want = r;
    if(state.rateCap && r > state.rateCap) r = state.rateCap;
    if(video.playbackRate !== r){
      try{ video.playbackRate = r; }catch(e){}
      if(r > 1 && video.playbackRate < r){ state.rateCap = video.playbackRate; }
    }
    var want = state.userMuted || !!gapMute || r > 4.01;
    if(video.muted !== want) video.muted = want;
  }
  video.preservesPitch = true; video.webkitPreservesPitch = true;
  function baseRate(){ return state.hold ? state.settings.holdRate : state.settings.speed; }

  function seekTo(t){
    if(!isFinite(t)) return;
    state.seeking = true;
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.05));
  }
  video.addEventListener("seeked", function(){ state.seeking = false; });

  function gapAround(t){
    var K = keepList(); if(!K) return null;
    var i = BW.findRange(K, t);
    if(i >= 0) return null;
    var ins = -i - 1;
    return [ins > 0 ? K[ins - 1][1] : 0, ins < K.length ? K[ins][0] : video.duration];
  }

  function tick(){
    var D = state.D, t = video.currentTime;
    if(!video.paused && !state.seeking && D){
      var K = keepList(), inGap = false;
      if(state.mode === "all") setRate(baseRate());
      else if(state.peek){
        if(t >= state.peek[1] - 0.05 || t < state.peek[0] - 1){ state.peek = null; $("peekBar").hidden = true; }
        else{ setRate(baseRate()); $("peekText").textContent = "Watching a part that's normally skipped · " + fmt(state.peek[1] - t) + " left"; }
      }
      if(state.mode !== "all" && !state.peek){
        var i = BW.findRange(K, t);
        if(i >= 0) setRate(baseRate());
        else if(state.mode === "fast"){
          if(state.hold) setRate(baseRate());
          else{ setRate(Math.min(state.settings.fastRate, state.ffCap || 99), true); inGap = true; }
        }
        else{
          var ins = -i - 1;
          if(ins < K.length) seekTo(K[ins][0]);
          else{ video.pause(); toast("That's the last of the painting"); }
        }
      }
      stallWatch(t, inGap);
    }
    else ff.t = -1;     // paused or seeking: start the stall watch afresh
    if(video.paused && !state.hold) setRate(state.settings.speed);
    updateTime();
  }

  // Some browsers' players get stuck: during a fast-forward, or (Brave) a couple of seconds
  // after one ends, the clock stops for several seconds although the video is already loaded.
  // If the clock hasn't moved for a moment while playing, restart playback from the same
  // spot (a seek clears the stuck player); in a fast-forwarded gap also lower the speed for
  // this video. When the video simply hasn't loaded yet, wait for it.
  var ff = { t: -1, since: 0 };
  function stallWatch(t, inGap){
    var now = performance.now();
    if(Math.abs(t - ff.t) > 0.02){ ff.t = t; ff.since = now; }
    if(now - ff.since < 600) return;
    var r = video.playbackRate, ahead = 0;
    for(var i = 0; i < video.buffered.length; i++)
      if(video.buffered.start(i) <= t + 0.1 && video.buffered.end(i) > t) ahead = video.buffered.end(i) - t;
    ff.since = now;
    if(inGap && r > 2){
      state.ffCap = r > 4 ? 4 : 2;
      toast("Fast-forward stalled at " + r + "× (the browser " + (ahead > 2 ? "couldn't decode fast enough" :
            "was waiting for the video to load") + "). Using " + state.ffCap + "× for this video.", 6000);
    }
    else if(ahead < 2) return;
    diag.log.push(new Date().toISOString().slice(11, 23) + " nudge " + t.toFixed(2) + (inGap ? " (stuck in gap)" : " (stuck)"));
    seekTo(t + 0.05);
  }

  // diagnostics (D key): what the video is really doing, with a log to copy and send
  var diag = { on: false, want: 1, log: [], hist: [], next: 0 };
  ["waiting", "stalled", "playing", "pause", "play", "seeking", "seeked", "ratechange", "volumechange", "emptied", "error"]
    .forEach(function(ev){ video.addEventListener(ev, function(){
      diag.log.push([new Date().toISOString().slice(11, 23), ev, video.currentTime.toFixed(2), video.playbackRate,
                     video.muted ? "muted" : "sound", "rs" + video.readyState].join(" "));
      if(diag.log.length > 80) diag.log.shift();
      if(ev === "seeking") diag.hist = [];
    }); });
  function diagTick(){
    var now = performance.now();
    diag.hist.push([now, video.currentTime]);
    while(diag.hist.length > 2 && now - diag.hist[0][0] > 1000) diag.hist.shift();
    if(!diag.on || now < diag.next) return;
    diag.next = now + 250;
    var h = diag.hist[0], speed = now > h[0] ? (video.currentTime - h[1]) / ((now - h[0]) / 1000) : 0, ahead = 0, t = video.currentTime;
    for(var i = 0; i < video.buffered.length; i++)
      if(video.buffered.start(i) <= t + 0.1 && video.buffered.end(i) > t) ahead = video.buffered.end(i) - t;
    var q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    $("diagText").textContent = [
      "Brushwork " + self.APP_VERSION + "  " + navigator.userAgent.replace(/^.*?\) /, ""),
      "mode " + state.mode + (state.peek ? " (peek)" : "") + "   time " + fmt(t) + " (" + t.toFixed(2) + ")",
      "speed asked " + diag.want + "x, set " + video.playbackRate + "x, measured " + speed.toFixed(2) + "x",
      "caps: browser " + (state.rateCap || "-") + ", stall " + (state.ffCap || "-") + "   settings fast " + state.settings.fastRate + "x",
      (video.paused ? "paused" : "playing") + (state.seeking ? " seeking" : "") + "  " + (video.muted ? "muted" : "sound") +
        "  ready " + video.readyState + "  buffered ahead " + ahead.toFixed(1) + " s",
      q ? "frames " + q.totalVideoFrames + ", dropped " + q.droppedVideoFrames : "",
      "src " + (video.currentSrc || "").replace(/^.*\/video\?/, "").replace(/&t=\d+/, ""),
      "", "events:"
    ].concat(diag.log.slice(-25)).join("\n");
  }
  function toggleDiag(){ diag.on = !diag.on; $("diag").hidden = !diag.on; diag.next = 0; }
  $("diagCopy").addEventListener("click", function(){
    var text = $("diagText").textContent.replace(/events:[\s\S]*$/, "events:\n" + diag.log.join("\n"));
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ toast("Copied"); },
      function(){ toast("Couldn't copy — take a screenshot instead"); });
  });

  function loop(){
    if(!$("player").hidden){
      tick();
      drawFrame();
      diagTick();
      if(Date.now() - state.lastSave > 5000) saveSession();
    }
    requestAnimationFrame(loop);
  }
  video.addEventListener("timeupdate", function(){ if(document.hidden) tick(); });   // rAF pauses in the background

  function saveSession(now){
    var s = state.session;
    if(!s || !s.key) return;
    state.lastSave = Date.now();
    Store.getSession(s.key).then(function(saved){
      saved = saved || { key: s.key, name: s.name, source: s.source };
      saved.position = video.currentTime;
      if(s.source === "file" && state.A && state.A.samples.canvas.length) saved.analysis = state.A;
      Store.putSession(saved);
    });
  }

  function togglePlay(){
    if(video.paused){
      // starting inside a skipped part: jump to the next kept part first (unless peeking)
      var g = state.mode !== "all" && state.mode !== "fast" && !state.peek ? gapAround(video.currentTime) : null;
      if(g && g[1] < video.duration) seekTo(g[1]);
      video.play().catch(function(){});
    } else video.pause();
  }
  video.addEventListener("play", updatePlayIcon);
  video.addEventListener("pause", updatePlayIcon);
  function updatePlayIcon(){
    $("playIcon").innerHTML = video.paused ? '<path d="M7 4v16l13-8z"/>' : '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>';
    $("playBtn").setAttribute("aria-label", video.paused ? "Play" : "Pause");
  }

  function jumpPainting(dir){
    var K = state.D ? (state.mode === "all" ? state.D.keep.paint : keepList()) : null;
    if(!K || !K.length) return;
    var t = video.currentTime, i = BW.findRange(K, t), target = null;
    if(dir > 0){
      var n = i >= 0 ? i + 1 : -i - 1;
      if(n < K.length) target = K[n][0];
    } else {
      var c = i >= 0 ? i : -i - 1;
      if(i >= 0 && t - K[i][0] > 3) target = K[i][0];
      else if(c - 1 >= 0) target = K[c - 1][0];
    }
    if(target != null){ state.peek = null; $("peekBar").hidden = true; seekTo(target); }
  }

  function startPeek(t){
    var g = gapAround(t);
    if(!g) return false;
    state.peek = g;
    $("peekBar").hidden = false;
    $("peekText").textContent = "Watching a part that's normally skipped";
    seekTo(t);     // stays paused if it was: only the play button or the video starts playback
    return true;
  }
  function stopPeek(){
    if(!state.peek) return;
    var end = state.peek[1];
    state.peek = null; $("peekBar").hidden = true;
    if(end < video.duration) seekTo(end);
  }
  $("peekStop").addEventListener("click", stopPeek);

  // the skipped part just before the current kept stretch
  function peekPrevious(){
    var K = keepList(); if(!K || state.mode === "all") return;
    var t = video.currentTime, i = BW.findRange(K, t);
    var g = i >= 0 ? (i > 0 ? [K[i - 1][1], K[i][0]] : (K[0][0] > 0.5 ? [0, K[0][0]] : null)) : gapAround(t);
    if(!g || g[1] - g[0] < 0.5) return toast("Nothing skipped just before this");
    state.peek = g; $("peekBar").hidden = false;
    seekTo(g[0]);
  }

  function setMode(m){
    state.mode = m;
    Store.set("mode", m);
    state.peek = null; $("peekBar").hidden = true;
    setRate(1);
    updateModeButtons();
    drawBase(); updateKept();
    toast(MODE_NAMES[m]);
  }
  function updateModeButtons(){
    document.querySelectorAll(".modes button").forEach(function(b){
      b.setAttribute("aria-checked", b.dataset.mode === state.mode ? "true" : "false");
    });
    $("skippedBtn").hidden = state.mode === "all";
    var fb = document.querySelector('.modes button[data-mode="fast"]');
    fb.textContent = "Fast-forward the rest (" + state.settings.fastRate + "×)";
  }
  document.querySelectorAll(".modes button").forEach(function(b){
    b.addEventListener("click", function(){ setMode(b.dataset.mode); });
  });

  function updateTime(){
    $("timeText").textContent = fmt(video.currentTime) + " / " + fmt(video.duration);
  }
  function updateKept(){
    var D = state.D; if(!D) return;
    var k = D.stats.kept[state.mode];
    var txt = state.mode === "all" ? "Full length " + fmtLong(D.stats.duration)
      : "Watching " + fmtLong(k) + " of " + fmtLong(D.stats.duration);
    var sp = state.settings.speed;
    if(sp !== 1) txt += " \u00B7 " + fmtLong((state.mode === "all" ? D.stats.duration : k) / sp) + " at " + sp + "\u00D7";
    if(D.until < D.stats.duration - 1) txt += " · analysed up to " + fmt(D.until);
    $("keptText").textContent = txt;
  }

  // ------------------------------------------------------------------ timelines
  var COLORS = {};
  function readColors(){
    var cs = getComputedStyle(document.documentElement);
    ["paint", "palette", "idle", "off", "pending", "talk"].forEach(function(k){ COLORS[k] = cs.getPropertyValue("--c-" + k).trim(); });
  }
  var CAT_COLOR = function(c){ return [COLORS.paint, COLORS.palette, COLORS.idle, COLORS.off, COLORS.pending][c]; };
  var baseCanvas = document.createElement("canvas");
  var hatch = null;

  function makeHatch(ctx){
    var p = document.createElement("canvas"); p.width = p.height = 8;
    var g = p.getContext("2d");
    g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(0, 0, 8, 8);
    g.strokeStyle = "rgba(255,255,255,0.10)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.stroke();
    return ctx.createPattern(p, "repeat");
  }

  function sizeCanvas(c){
    var r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if(c.width !== w || c.height !== h){ c.width = w; c.height = h; }
    return dpr;
  }

  // draw categories, talking and skipped overlay for [t0,t1] across the canvas
  function paintRange(ctx, w, h, t0, t1, dpr){
    var D = state.D;
    ctx.fillStyle = COLORS.pending; ctx.fillRect(0, 0, w, h);
    if(!D) return;
    var step = D.step, n = D.n, K = keepList();
    var talkH = Math.max(3, Math.round(3 * dpr)), barH = h - talkH - Math.round(2 * dpr);
    var spp = (t1 - t0) / w;                       // seconds per pixel
    var cnt = [0, 0, 0, 0, 0];
    var runStart = 0, runColor = null;
    function flush(x){ if(runColor !== null){ ctx.fillStyle = runColor; ctx.fillRect(runStart, 0, x - runStart, barH); } }
    for(var x = 0; x < w; x++){
      var a = t0 + x * spp, b = a + spp;
      var i0 = Math.max(0, Math.floor(a / step)), i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(b / step)));
      cnt[0] = cnt[1] = cnt[2] = cnt[3] = cnt[4] = 0;
      var talk = 0;
      for(var i = i0; i < i1; i++){ cnt[D.cat[i]]++; talk += D.speech[i]; }
      var tot = i1 - i0, c;
      if(cnt[0] * 3 >= tot && cnt[0] > 0) c = 0;
      else { c = 0; for(var k = 1; k < 5; k++) if(cnt[k] > cnt[c]) c = k; }
      var col = CAT_COLOR(c);
      if(col !== runColor){ flush(x); runStart = x; runColor = col; }
      if(talk * 2 > tot){ ctx.fillStyle = COLORS.talk; ctx.fillRect(x, h - talkH, 1, talkH); }
    }
    flush(w);
    // skipped parts in this mode
    if(state.mode !== "all" && K){
      ctx.fillStyle = hatch || (hatch = makeHatch(ctx));
      var prevEnd = 0;
      for(var r = 0; r <= K.length; r++){
        var gs = r === 0 ? 0 : K[r - 1][1], ge = r < K.length ? K[r][0] : D.stats.duration;
        if(ge <= t0 || gs >= t1 || ge - gs <= 0) continue;
        var x0 = (gs - t0) / spp, x1 = (ge - t0) / spp;
        if(x1 - x0 < 0.6 && spp > 1) continue;
        ctx.fillRect(Math.floor(x0), 0, Math.max(1, Math.ceil(x1 - x0)), barH);
      }
    }
  }

  function drawBase(){
    var c = $("timeline");
    if($("player").hidden) return;
    readColors();
    var dpr = sizeCanvas(c);
    baseCanvas.width = c.width; baseCanvas.height = c.height;
    var dur = state.D ? state.D.stats.duration : (video.duration || 1);
    paintRange(baseCanvas.getContext("2d"), c.width, c.height, 0, dur, dpr);
  }

  function drawFrame(){
    var c = $("timeline"), ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
    var dur = state.D ? state.D.stats.duration : (video.duration || 1);
    var t = video.currentTime;
    ctx.drawImage(baseCanvas, 0, 0);
    // zoom window marker
    var zw = zoomWindow(), x0 = zw[0] / dur * c.width, x1 = zw[1] / dur * c.width;
    ctx.strokeStyle = "rgba(237,230,217,0.55)"; ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, c.height - 1);
    var x = t / dur * c.width;
    ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(x - dpr), 0, Math.max(2, Math.round(2 * dpr)), c.height);

    // zoomed strip around the playhead
    var z = $("zoomline"), zd = sizeCanvas(z), zc = z.getContext("2d");
    paintRange(zc, z.width, z.height, zw[0], zw[1], zd);
    var spp = (zw[1] - zw[0]) / z.width;
    zc.fillStyle = "rgba(237,230,217,0.75)"; zc.font = Math.round(10 * zd) + "px -apple-system, Segoe UI, sans-serif";
    zc.textBaseline = "top";
    for(var m = Math.ceil(zw[0] / 60) * 60; m < zw[1]; m += 60){
      var mx = (m - zw[0]) / spp;
      zc.fillRect(Math.round(mx), 0, Math.max(1, zd), Math.round(5 * zd));
      zc.fillText(fmt(m), Math.round(mx + 3 * zd), Math.round(2 * zd));
    }
    var px = (t - zw[0]) / spp;
    zc.fillStyle = "#fff"; zc.fillRect(Math.round(px - zd), 0, Math.max(2, Math.round(2 * zd)), z.height);
  }

  var ZOOM_SPAN = 360;   // seconds shown in the zoomed strip
  function zoomWindow(){
    var dur = state.D ? state.D.stats.duration : (video.duration || ZOOM_SPAN);
    var span = Math.min(ZOOM_SPAN, dur), t = video.currentTime;
    var a = Math.max(0, Math.min(dur - span, t - span / 2));
    return [a, a + span];
  }

  function bindTimeline(c, toTime){
    var down = false;
    function at(e){ var r = c.getBoundingClientRect(); return toTime(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }
    c.addEventListener("pointerdown", function(e){
      down = true; c.setPointerCapture(e.pointerId);
      state.peek = null; $("peekBar").hidden = true;
      seekTo(at(e));
    });
    c.addEventListener("pointermove", function(e){ if(down) seekTo(at(e)); });
    function up(e){
      if(!down) return; down = false;
      var t = at(e);
      // landing in a skipped part means "show me this bit"
      if(state.mode !== "all" && gapAround(t)){ startPeek(t); }
      else seekTo(t);
    }
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", function(){ down = false; });
  }
  bindTimeline($("timeline"), function(f){ return f * (state.D ? state.D.stats.duration : video.duration || 0); });
  // The zoom strip is dragged like a tape: it moves with the finger and the playhead stays
  // put, so dragging left goes forward. A tap without dragging jumps to (or peeks at) that spot.
  (function(){
    var z = $("zoomline"), drag = null;
    z.addEventListener("pointerdown", function(e){
      try{ z.setPointerCapture(e.pointerId); }catch(err){}
      var w = zoomWindow(), r = z.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, t0: video.currentTime, span: w[1] - w[0], width: r.width || 1,
               tap: w[0] + Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * (w[1] - w[0]), moved: false };
    });
    z.addEventListener("pointermove", function(e){
      if(!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      if(!drag.moved){
        if(Math.abs(dx) < 6) return;
        drag.moved = true; state.peek = null; $("peekBar").hidden = true;
      }
      var dur = state.D ? state.D.stats.duration : (video.duration || 0);
      drag.t = Math.max(0, Math.min(dur, drag.t0 - dx / drag.width * drag.span));
      seekTo(drag.t);
    });
    function end(e){
      if(!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      if(e.type === "pointercancel") return;
      var t = d.moved ? d.t : d.tap;
      if(t == null) return;
      // ending up in a skipped part means "show me this bit"
      if(state.mode !== "all" && gapAround(t)) startPeek(t);
      else { if(!d.moved){ state.peek = null; $("peekBar").hidden = true; } seekTo(t); }
    }
    z.addEventListener("pointerup", end);
    z.addEventListener("pointercancel", end);
  })();

  function resize(){ drawBase(); }
  window.addEventListener("resize", function(){ clearTimeout(resize.t); resize.t = setTimeout(resize, 100); });

  // ------------------------------------------------------------------ stats
  function renderStats(){
    var D = state.D; if(!D) return;
    var s = D.stats, work = s.painting + s.palette + s.idle;
    var rows = [
      ["Painting", s.painting, COLORS.paint], ["Palette", s.palette, COLORS.palette],
      ["Other", s.idle, COLORS.idle], ["Talking", s.talking, COLORS.talk],
      ["Other views", s.offview, "#5a5248"]
    ];
    var html = rows.map(function(r){
      var all = work + s.offview;
      var pct = all ? Math.round(r[1] / all * 100) : 0;
      return '<div class="stat-row"><span>' + r[0] + '</span><span class="stat-bar"><i style="width:' +
        Math.min(100, pct) + '%;background:' + r[2] + '"></i></span><span class="v">' + fmtLong(r[1]) + '</span></div>';
    }).join("");
    html += '<p class="hint">Studio time (painting + palette + other): ' + fmtLong(work) +
      '. Painting is ' + (s.palette ? Math.round(s.painting / s.palette * 100) : 0) + '% of the palette time.' +
      (s.pending > 1 ? ' Not analysed yet: ' + fmtLong(s.pending) + '.' : '') +
      (s.offview > 1 ? ' "Other views" is time without the painting layout, like the Zoom gallery at the start.' : '') + '</p>';
    html += '<p class="hint">Length in each mode — Painting: ' + fmtLong(s.kept.paint) + ' · Painting + talking: ' +
      fmtLong(s.kept.talk) + ' · Fast-forward: ' + fmtLong(s.kept.fast) + '</p>';
    $("statsBody").innerHTML = html;
  }

  // ------------------------------------------------------------------ settings
  function showModal(id){ $(id).classList.add("show"); }
  document.querySelectorAll(".modal").forEach(function(m){
    m.addEventListener("click", function(e){ if(e.target === m || e.target.hasAttribute("data-close")) m.classList.remove("show"); });
  });
  $("statsBtn").addEventListener("click", function(){ syncSettingsUI(); renderStats(); showModal("statsModal"); });
  $("settingsBtn").addEventListener("click", function(){ syncSettingsUI(); showModal("settingsModal"); });

  function syncSettingsUI(){
    var s = state.settings;
    $("strictRange").value = $("strictRange2").value = s.strict; $("leadRange").value = s.lead; $("talkRange").value = s.talk;
    $("strictVal").textContent = $("strictVal2").textContent = s.strict <= 0.001 ? "everything" : Math.round(s.strict * 100) + "%";
    $("leadVal").textContent = s.lead + " s";
    $("talkVal").textContent = s.talk === 0 ? "auto" : (s.talk > 0 ? "+" : "−") + Math.abs(s.talk) + " dB";
    document.querySelectorAll("#rateSeg button").forEach(function(b){ b.classList.toggle("on", +b.dataset.rate === s.fastRate); });
    syncSpeedUI();
    $("rateHint").textContent = state.rateCap ? "This browser plays at most " + state.rateCap + "× — faster settings are capped." : "";
  }
  function settingChanged(){
    Store.set("settings", state.settings);
    syncSettingsUI(); rederive(); updateModeButtons();
  }
  ["strictRange", "strictRange2"].forEach(function(id){
    $(id).addEventListener("input", function(){ state.settings.strict = +this.value; settingChanged(); });
  });
  $("leadRange").addEventListener("input", function(){ state.settings.lead = +this.value; settingChanged(); });
  // slider right = stricter = higher threshold
  $("talkRange").addEventListener("input", function(){ state.settings.talk = +this.value; settingChanged(); });
  document.querySelectorAll("#rateSeg button").forEach(function(b){
    b.addEventListener("click", function(){ state.settings.fastRate = +b.dataset.rate; settingChanged(); });
  });
  $("resetSettings").addEventListener("click", function(){
    var s = state.settings;    // speed and the picture have their own sheets
    var keep = { speed: s.speed, holdRate: s.holdRate, saturation: s.saturation, contrast: s.contrast, brightness: s.brightness,
                 warmth: s.warmth, tint: s.tint };
    state.settings = Object.assign({}, BW.DEFAULTS, keep); settingChanged();
  });

  // ------------------------------------------------------------------ picture
  // [slider, label, setting, value meaning "as recorded"]
  var PIC = [["satRange", "satVal", "saturation", 1], ["conRange", "conVal", "contrast", 1], ["briRange", "briVal", "brightness", 1],
             ["warmRange", "warmVal", "warmth", 0], ["tintRange", "tintVal", "tint", 0]];
  var WARM = 0.2, TINT = 0.2;      // how far the warmth and tint sliders move each colour at their ends
  function toneGains(w, t){ return [1 + WARM * w, 1 - TINT * t, 1 - WARM * w]; }
  function applyPicture(){
    var s = state.settings, f = [], w = s.warmth || 0, t = s.tint || 0;
    if(w || t){
      var g = toneGains(w, t);
      $("bwToneMatrix").setAttribute("values", g[0] + " 0 0 0 0  0 " + g[1] + " 0 0 0  0 0 " + g[2] + " 0 0  0 0 0 1 0");
      f.push("url(#bwTone)");
    }
    if(s.saturation !== 1) f.push("saturate(" + s.saturation + ")");
    if(s.contrast !== 1) f.push("contrast(" + s.contrast + ")");
    if(s.brightness !== 1) f.push("brightness(" + s.brightness + ")");
    video.style.filter = f.join(" ");
    PIC.forEach(function(p){
      var v = s[p[2]] == null ? p[3] : s[p[2]];
      $(p[0]).value = v;
      $(p[1]).textContent = p[3] === 1 ? Math.round(v * 100) + "%" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v * 100));
    });
    $("pictureBtn").classList.toggle("on", f.length > 0);
  }
  PIC.forEach(function(p){
    $(p[0]).addEventListener("input", function(){
      var v = +this.value;
      if(Math.abs(v - p[3]) < 0.025) v = p[3];     // snaps to "as recorded"
      state.settings[p[2]] = v; Store.set("settings", state.settings); applyPicture();
    });
  });
  $("resetPicture").addEventListener("click", function(){
    PIC.forEach(function(p){ state.settings[p[2]] = p[3]; });
    Store.set("settings", state.settings); applyPicture();
  });

  // Match: compare the painting in the video (a box the user drags) with the image in the
  // picture window (the part of it in view) and set all five sliders so their colours agree.
  // Each step is fitted on the video's colours as the previous steps leave them, in the
  // order the filter applies them: warmth and tint (average colour), then saturation
  // (how far colours stand from grey), then contrast and brightness (spread and average of
  // lightness).
  var match = null;
  $("matchPicture").addEventListener("click", function(){
    var ref = BWImages.shown();
    if(!ref){ toast("Open the finished painting or a progress photo in the picture window first (the picture button or I), then tap Match.", 6000); return; }
    if(!video.videoWidth){ toast("Open a video first"); return; }
    $("pictureModal").classList.remove("show");
    match = { ref: ref, x0: 0, y0: 0 };
    $("matchRect").style.display = "none";
    $("matchBox").hidden = false;
  });
  function endMatch(){ match = null; $("matchBox").hidden = true; }
  $("matchBox").addEventListener("pointerdown", function(e){
    if(!match) return;
    e.preventDefault(); e.stopPropagation();
    try{ this.setPointerCapture(e.pointerId); }catch(err){}
    var r = this.getBoundingClientRect();
    match.x0 = e.clientX - r.left; match.y0 = e.clientY - r.top; match.drag = true;
    drawMatchRect(match.x0, match.y0);
  });
  $("matchBox").addEventListener("pointermove", function(e){
    if(!match || !match.drag) return;
    var r = this.getBoundingClientRect();
    drawMatchRect(e.clientX - r.left, e.clientY - r.top);
  });
  $("matchBox").addEventListener("pointerup", function(e){
    if(!match || !match.drag) return;
    var r = this.getBoundingClientRect(), x1 = e.clientX - r.left, y1 = e.clientY - r.top;
    var box = [Math.min(match.x0, x1), Math.min(match.y0, y1), Math.abs(x1 - match.x0), Math.abs(y1 - match.y0)];
    var ref = match.ref; endMatch();
    if(box[2] < 30 || box[3] < 30){ toast("Drag a bigger box around the painting"); return; }
    runMatch(box, r, ref);
  });
  function drawMatchRect(x, y){
    var el = $("matchRect").style;
    el.display = "block";
    el.left = Math.min(match.x0, x) + "px"; el.top = Math.min(match.y0, y) + "px";
    el.width = Math.abs(x - match.x0) + "px"; el.height = Math.abs(y - match.y0) + "px";
  }

  function pixels(src, sx, sy, sw, sh){
    var k = Math.min(1, 200 / Math.max(sw, sh)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    var g = c.getContext("2d");
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    var d = g.getImageData(0, 0, c.width, c.height).data, out = [];
    for(var i = 0; i < d.length; i += 4) out.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
    return out;
  }
  function stats(P){
    var n = P.length, m = [0, 0, 0], C = 0, ys = [];
    P.forEach(function(p){
      var y = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; ys.push(y);
      C += Math.sqrt((p[0] - y) * (p[0] - y) + (p[1] - y) * (p[1] - y) + (p[2] - y) * (p[2] - y));
    });
    return { m: [m[0] / n, m[1] / n, m[2] / n], ys: ys, C: C / n };
  }
  function quantiles(ys){
    var s = ys.slice().sort(function(a, b){ return a - b; }), out = [];
    for(var p = 5; p <= 95; p += 5) out.push(s[Math.min(s.length - 1, Math.floor(s.length * p / 100))]);
    return out;
  }
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function runMatch(box, stageRect, ref){
    var V, R;
    try{
      // the box on screen -> video pixels (the video is fitted inside the stage)
      var vw = video.videoWidth, vh = video.videoHeight, k = Math.min(stageRect.width / vw, stageRect.height / vh);
      var ox = (stageRect.width - vw * k) / 2, oy = (stageRect.height - vh * k) / 2;
      var sx = clamp((box[0] - ox) / k, 0, vw), sy = clamp((box[1] - oy) / k, 0, vh);
      var sw = clamp((box[0] + box[2] - ox) / k, 0, vw) - sx, sh = clamp((box[1] + box[3] - oy) / k, 0, vh) - sy;
      if(sw < 20 || sh < 20){ toast("Drag the box over the video picture"); return; }
      V = pixels(video, sx, sy, sw, sh);
      // the part of the reference image in view in the picture window
      var img = ref.img, ir = img.getBoundingClientRect(), br = ref.box.getBoundingClientRect();
      var ks = img.naturalWidth / ir.width;
      var x0 = Math.max(ir.left, br.left), y0 = Math.max(ir.top, br.top), x1 = Math.min(ir.right, br.right), y1 = Math.min(ir.bottom, br.bottom);
      if(x1 - x0 < 10 || y1 - y0 < 10){ toast("The picture window isn't showing the image"); return; }
      R = pixels(img, (x0 - ir.left) * ks, (y0 - ir.top) * ks, (x1 - x0) * ks, (y1 - y0) * ks);
    }catch(err){
      toast("Couldn't read the video or the image here (" + err.name + ")"); return;
    }
    var sR = stats(R), sV = stats(V);
    // 1. warmth and tint from the average colour (each channel's ratio, overall level aside)
    var q = [sR.m[0] / sV.m[0], sR.m[1] / sV.m[1], sR.m[2] / sV.m[2]];
    var x = q[0] / q[2], w = clamp((x - 1) / (WARM * (x + 1)), -1, 1);
    var gw = toneGains(w, 0), wantG = q[1] / ((q[0] + q[2]) / 2) * ((gw[0] + gw[2]) / 2);
    var t = clamp((1 - wantG) / TINT, -1, 1);
    w = Math.round(w * 100) / 100; t = Math.round(t * 100) / 100;
    var g = toneGains(w, t);
    var V1 = V.map(function(p){ return [Math.min(1, p[0] * g[0]), Math.min(1, p[1] * g[1]), Math.min(1, p[2] * g[2])]; });
    var s1 = stats(V1);
    // 2. saturation; 3. contrast and brightness (saturation leaves lightness alone)
    var sat = clamp(sR.C / Math.max(0.005, s1.C), 0.3, 1.5);
    // Line up lightness from dark to light (5% to 95%) with a straight line y' = a y + b, which
    // is what contrast c and brightness B do together: a = cB, b = B(1 - c)/2.
    var qv = quantiles(s1.ys), qr = quantiles(sR.ys), n = qv.length, mx = 0, my = 0, sxy = 0, sxx = 0;
    for(var i = 0; i < n; i++){ mx += qv[i] / n; my += qr[i] / n; }
    for(i = 0; i < n; i++){ sxy += (qv[i] - mx) * (qr[i] - my); sxx += (qv[i] - mx) * (qv[i] - mx); }
    var a = sxx > 1e-6 ? sxy / sxx : 1, b = my - a * mx;
    var bri = clamp(a + 2 * b, 0.6, 1.5), con = clamp(a / bri, 0.6, 1.5);
    var S = state.settings;
    S.warmth = w; S.tint = t;
    S.saturation = Math.round(sat * 100) / 100; S.contrast = Math.round(con * 100) / 100; S.brightness = Math.round(bri * 100) / 100;
    Store.set("settings", S); applyPicture();
    $("pictureModal").classList.add("show");
    toast("Matched to " + stemOf(ref.name) + ". Fine-tune by eye, or Reset to go back to the recording.", 5000);
  }
  $("pictureBtn").addEventListener("click", function(){
    applyPicture(); $("pictureModal").classList.toggle("show");
  });

  // ------------------------------------------------------------------ speed
  var SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  function syncSpeedUI(){
    var s = state.settings;
    document.querySelectorAll("#speedSeg button").forEach(function(b){ b.classList.toggle("on", +b.dataset.speed === s.speed); });
    document.querySelectorAll("#holdSeg button").forEach(function(b){ b.classList.toggle("on", +b.dataset.hold === s.holdRate); });
    $("speedBtn").textContent = s.speed + "\u00D7";
    $("speedBtn").classList.toggle("on", s.speed !== 1);
    $("slowerBtn").disabled = s.speed <= SPEEDS[0];
    $("fasterBtn").disabled = s.speed >= SPEEDS[SPEEDS.length - 1];
    $("speedHint").textContent = state.rateCap ? "This browser plays at most " + state.rateCap + "\u00D7." : "";
  }
  function speedChanged(){
    Store.set("settings", state.settings);
    syncSpeedUI(); updateKept();
    if(video.paused) setRate(state.settings.speed);
  }
  function setSpeed(v){ state.settings.speed = v; speedChanged(); }
  function stepSpeed(dir, quiet){
    var i = SPEEDS.indexOf(state.settings.speed);
    if(i < 0) i = SPEEDS.indexOf(1);
    i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
    setSpeed(SPEEDS[i]);
    if(!quiet || document.body.classList.contains("ui-hidden")) toast("Speed " + SPEEDS[i] + "×", 1200);
  }
  $("speedBtn").addEventListener("click", function(){ syncSpeedUI(); showModal("speedModal"); });
  $("slowerBtn").addEventListener("click", function(){ stepSpeed(-1, true); });
  $("fasterBtn").addEventListener("click", function(){ stepSpeed(1, true); });

  // ------------------------------------------------------------------ hiding the controls
  // The video takes the whole window; the controls float over its bottom edge and fade out
  // after a few seconds. Moving the mouse to, or tapping, the bottom edge (or a key) brings them back.
  var ui = { timer: null, overDock: false, waitLeave: false };
  function immersive(){ return document.body.classList.contains("immersive"); }
  function setImmersive(on){
    document.body.classList.toggle("immersive", on);
    $("hideBtn").classList.toggle("on", on);
    $("hideBtn").title = on ? "Show the controls normally (C)" : "Hide the controls (C)";
    $("hideBtn").setAttribute("aria-label", $("hideBtn").title);
    $("hideIcon").innerHTML = on ? '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 15 4-4 4 4"/>'
                                 : '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 11 4 4 4-4"/>';
    Store.set("immersive", on);
    if(on){
      // hide straight away; the pointer is still on the hide button at the bottom edge, so
      // don't bring the controls back until it has left that area and returned
      clearTimeout(ui.timer);
      ui.overDock = false; ui.waitLeave = true;
      document.body.classList.add("ui-hidden");
    } else showUI();
    setTimeout(resize, 50);
  }
  function showUI(){
    document.body.classList.remove("ui-hidden");
    document.documentElement.style.setProperty("--dock-h", $("dock").offsetHeight + "px");
    clearTimeout(ui.timer);
    if(immersive()) ui.timer = setTimeout(hideUI, 2500);
  }
  function hideUI(){
    if(!immersive()) return;
    if(ui.overDock || document.querySelector(".modal.show")){
      ui.timer = setTimeout(hideUI, 1000); return;
    }
    document.body.classList.add("ui-hidden");
  }
  $("hideBtn").addEventListener("click", function(){ setImmersive(!immersive()); });
  // with a mouse, only moving near the bottom edge brings the controls back, so holding or
  // moving over the picture doesn't; the pointer itself hides after a moment of stillness
  var cursorTimer = null;
  $("player").addEventListener("pointermove", function(e){
    if(e.pointerType !== "mouse" || !immersive()) return;
    document.body.classList.remove("no-cursor");
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function(){ if(document.body.classList.contains("ui-hidden")) document.body.classList.add("no-cursor"); }, 2000);
    if(!nearBottom(e.clientY)) ui.waitLeave = false;
    else if(!ui.waitLeave) showUI();
  });
  $("dock").addEventListener("pointerenter", function(e){ if(e.pointerType === "mouse") ui.overDock = true; });
  $("dock").addEventListener("pointerleave", function(){ ui.overDock = false; });
  $("dock").addEventListener("pointerdown", showUI);
  document.querySelectorAll("#speedSeg button").forEach(function(b){
    b.addEventListener("click", function(){ setSpeed(+b.dataset.speed); });
  });
  document.querySelectorAll("#holdSeg button").forEach(function(b){
    b.addEventListener("click", function(){ state.settings.holdRate = +b.dataset.hold; speedChanged(); });
  });

  // touch-and-hold the video (or hold H) to play at the hold speed, like YouTube's 2x but adjustable
  var hold = { timer: null, active: false, wasPaused: false, eatClick: false, x: 0, y: 0, key: false };
  function startHold(){
    hold.timer = null;
    if(hold.active) return;
    hold.active = true; hold.eatClick = true; state.hold = true;
    hold.wasPaused = video.paused;
    setRate(state.settings.holdRate);
    if(video.paused) video.play().catch(function(){});
    var b = $("holdBadge");
    b.textContent = state.settings.holdRate + "\u00D7  " + (state.settings.holdRate < 1 ? "\u25B8" : "\u25B8\u25B8");
    b.hidden = false;
  }
  function endHold(){
    if(hold.timer){ clearTimeout(hold.timer); hold.timer = null; }
    if(!hold.active) return;
    hold.active = false; hold.key = false; state.hold = false;
    $("holdBadge").hidden = true;
    if(hold.wasPaused) video.pause();
    setRate(state.settings.speed);   // tick() puts a fast-forward gap back to its own speed
  }
  video.addEventListener("pointerdown", function(e){
    if(e.button !== 0) return;
    hold.eatClick = false; hold.x = e.clientX; hold.y = e.clientY; hold.touch = e.pointerType !== "mouse";
    try{ video.setPointerCapture(e.pointerId); }catch(err){}
    clearTimeout(hold.timer);
    hold.timer = setTimeout(startHold, 350);
  });
  video.addEventListener("pointermove", function(e){
    if(hold.timer && Math.abs(e.clientX - hold.x) + Math.abs(e.clientY - hold.y) > 24){ clearTimeout(hold.timer); hold.timer = null; }
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function(ev){ video.addEventListener(ev, endHold); });
  video.addEventListener("contextmenu", function(e){ e.preventDefault(); });
  window.addEventListener("blur", endHold);

  // ------------------------------------------------------------------ controls
  $("playBtn").addEventListener("click", togglePlay);
  // Taps on the video: a single tap plays / pauses. A double tap on the left or right side
  // jumps back / forward 10 s, and each further quick tap on that side adds another 10 s.
  // Taps on the sides wait a moment to see whether a second tap follows; the middle doesn't.
  var tap = { timer: null, last: 0, side: null, streak: false, total: 0, flashTimer: null };
  function singleTap(){ togglePlay(); }
  function nearBottom(y){
    var r = $("player").getBoundingClientRect();
    return y > r.bottom - ($("dock").offsetHeight + 40);
  }
  // step through watched time only: in the skipping modes, skipped parts don't count, so a jump
  // back from early in a stretch lands in the previous stretch instead of being skipped forward again
  function stepKept(K, t, d){
    var i = BW.findRange(K, t), rem = Math.abs(d), j, avail;
    if(d < 0){
      j = i >= 0 ? i : -i - 2;
      if(j < 0) return t;
      if(i < 0) t = K[j][1];
      for(;;){
        avail = t - K[j][0];
        if(rem <= avail) return t - rem;
        rem -= avail; j--;
        if(j < 0) return K[0][0];
        t = K[j][1];
      }
    }
    j = i >= 0 ? i : -i - 1;
    if(j >= K.length) return t;
    if(i < 0) t = K[j][0];
    for(;;){
      avail = K[j][1] - t;
      if(rem < avail) return t + rem;
      rem -= avail; j++;
      if(j >= K.length) return Math.max(K[j - 1][0], K[j - 1][1] - 0.5);
      t = K[j][0];
    }
  }
  function tapSeek(side){
    var d = side === "left" ? -10 : 10, t = video.currentTime;
    var K = state.mode === "all" || state.mode === "fast" ? null : keepList();
    if(!K || !K.length) seekTo(t + d);
    else if(state.peek && t + d >= state.peek[0] && t + d <= state.peek[1]) seekTo(t + d);   // within the part being watched
    else{
      if(state.peek){   // leave the skipped part, counting the time spent in it
        var edge = d < 0 ? state.peek[0] : state.peek[1];
        d = d < 0 ? Math.min(0, d + (t - edge)) : Math.max(0, d - (edge - t));
        t = edge; state.peek = null; $("peekBar").hidden = true;
      }
      seekTo(stepKept(K, t, d));
    }
    tap.total += 10;
    var f = $("seekFlash");
    f.className = "seekflash " + side;
    f.textContent = side === "left" ? "« " + tap.total + " s" : tap.total + " s »";
    f.hidden = false;
    clearTimeout(tap.flashTimer);
    tap.flashTimer = setTimeout(function(){ f.hidden = true; }, 700);
  }
  video.addEventListener("click", function(e){
    if(hold.eatClick){ hold.eatClick = false; return; }
    // controls hidden: a tap or click near the bottom edge brings them back, anywhere else is a normal tap
    if(immersive() && document.body.classList.contains("ui-hidden") && nearBottom(e.clientY)){
      clearTimeout(tap.timer); tap.timer = null; tap.streak = false; showUI(); return;
    }
    var r = video.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    var side = x < 0.35 ? "left" : x > 0.65 ? "right" : "mid";
    var now = Date.now(), quick = now - tap.last < (tap.streak ? 650 : 300) && side === tap.side;
    tap.last = now;
    if(side !== "mid" && quick && (tap.streak || tap.timer)){
      clearTimeout(tap.timer); tap.timer = null;
      if(!tap.streak){ tap.streak = true; tap.total = 0; }
      tapSeek(side);
      return;
    }
    clearTimeout(tap.timer); tap.timer = null;
    tap.side = side; tap.streak = false;
    if(side === "mid") singleTap();
    else tap.timer = setTimeout(function(){ tap.timer = null; singleTap(); }, 300);
  });
  $("backSecBtn").addEventListener("click", function(){ state.peek = null; $("peekBar").hidden = true; seekTo(video.currentTime - 10); });
  $("fwdSecBtn").addEventListener("click", function(){ seekTo(video.currentTime + 10); });
  $("prevBtn").addEventListener("click", function(){ jumpPainting(-1); });
  $("nextBtn").addEventListener("click", function(){ jumpPainting(1); });
  $("skippedBtn") && $("skippedBtn").addEventListener("click", peekPrevious);
  $("muteBtn").addEventListener("click", toggleMute);
  function toggleMute(){
    state.userMuted = !state.userMuted;
    video.muted = state.userMuted;   // tick() re-mutes fast-forwarded gaps
    $("muteIcon").innerHTML = state.userMuted ? '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 4 6M21 9l-4 6"/>'
                                              : '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/>';
  }
  $("fullBtn").addEventListener("click", toggleFull);
  function toggleFull(){
    var on = !document.body.classList.contains("fs");
    document.body.classList.toggle("fs", on);
    var el = document.documentElement;
    try{
      if(on){ (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el); }
      else if(document.fullscreenElement || document.webkitFullscreenElement){ (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    }catch(e){}
    setTimeout(resize, 200);
  }
  document.addEventListener("fullscreenchange", function(){ if(!document.fullscreenElement) document.body.classList.remove("fs"); setTimeout(resize, 200); });
  $("backBtn").addEventListener("click", showLibrary);

  document.addEventListener("keydown", function(e){
    if($("player").hidden || e.target.tagName === "INPUT") return;
    if(BWImages.key(e)) return;
    if(match){ if(e.key === "Escape"){ endMatch(); $("pictureModal").classList.add("show"); } return; }
    if(document.querySelector(".modal.show")){ if(e.key === "Escape") document.querySelector(".modal.show").classList.remove("show"); return; }
    var k = e.key;
    if(immersive() && k !== " " && k !== "h" && k !== "H") showUI();
    if(k === " "){ e.preventDefault(); togglePlay(); }
    else if(k === "ArrowLeft"){ e.preventDefault(); if(e.shiftKey) jumpPainting(-1); else { state.peek = null; $("peekBar").hidden = true; seekTo(video.currentTime - 10); } }
    else if(k === "ArrowRight"){ e.preventDefault(); if(e.shiftKey) jumpPainting(1); else seekTo(video.currentTime + 10); }
    else if(k >= "1" && k <= "4") setMode(MODES[+k - 1]);
    else if(k === "m" || k === "M") toggleMute();
    else if(k === "f" || k === "F") toggleFull();
    else if(k === "w" || k === "W") peekPrevious();
    else if(k === "d" || k === "D") toggleDiag();
    else if(k === "Escape"){ if(state.peek) stopPeek(); else if(document.body.classList.contains("fs")) toggleFull(); }
    else if(k === "c" || k === "C") setImmersive(!immersive());
    else if(k === "i" || k === "I") BWImages.toggleWindow();
    else if(k === "o" || k === "O") BWImages.openFull();
    else if(k === "g" || k === "G") BWImages.grab();
    else if(k === "<" || (k === "," && e.shiftKey)) stepSpeed(-1);
    else if(k === ">" || (k === "." && e.shiftKey)) stepSpeed(1);
    else if((k === "h" || k === "H") && !e.repeat && !hold.active){ hold.key = true; startHold(); }
    else if(k === "?") showModal("keysModal");
  });
  document.addEventListener("keyup", function(e){ if((e.key === "h" || e.key === "H") && hold.key) endHold(); });

  window.addEventListener("pagehide", function(){ saveSession(true); });
  document.addEventListener("visibilitychange", function(){ if(document.hidden) saveSession(true); });

  // ------------------------------------------------------------------ start
  BWImages.init({ video: video, toast: toast, fmt: fmt, stemOf: stemOf, helperURL: helperURL, fetchJSON: fetchJSON });
  Store.get("immersive").then(function(on){ if(on) setImmersive(true); });
  Store.onblocked = function(){
    toast("Another Brushwork tab has an older version open. Close the other Brushwork tabs, then reload this one.", 9000);
  };
  Promise.all([Store.get("settings"), Store.get("mode"), findHelper()]).then(function(r){
    if(r[0]) state.settings = Object.assign({}, BW.DEFAULTS, r[0]);
    syncSpeedUI(); applyPicture();
    if(r[1] && MODES.indexOf(r[1]) >= 0) state.mode = r[1];
    state.helper = r[2];
    renderLibrary();
  });
  requestAnimationFrame(loop);

  // offline copy of the app (not when the PC helper serves it — it's always current there)
  if("serviceWorker" in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.protocol === "https:"){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function(reg){
        document.addEventListener("visibilitychange", function(){ if(!document.hidden) reg.update().catch(function(){}); });
      }).catch(function(){});
      var had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", function(){
        // a new version took over: reload when it won't interrupt anything
        if(had && $("player").hidden) location.reload();
        had = true;
      });
    });
  }
})();
