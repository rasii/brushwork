// Turns the helper's analysis file into what the viewer shows: a category for every
// half second (painting, palette, idle, other view, not yet analysed), who's talking,
// and the lists of time ranges each viewing mode keeps.
(function(root){
  "use strict";

  var CAT = { PAINT: 0, PALETTE: 1, IDLE: 2, OFFVIEW: 3, PENDING: 4 };

  var DEFAULTS = {
    strict: 0.25,      // 0 = keep every canvas stretch, 1 = only big visible changes
    lead: 1.0,         // seconds kept before and after each painting stretch
    talk: 0,           // talking sensitivity, dB added to the detected threshold (− = more counts as talking)
    fastRate: 8,
    speed: 1,          // playback speed for everything that plays at "normal" speed
    holdRate: 2        // speed while the video is touched and held
  };

  // strictness slider → least share of the canvas that must change for a stretch to count
  function changeThreshold(strict){
    if(strict <= 0.001) return -0.5;                        // everything, even unjudged stretches
    return 0.00002 * Math.pow(10, strict * 2.5);           // 0.00002 … 0.0063
  }

  function fillGaps(mask, maxGap){                         // true runs separated by ≤ maxGap samples merge
    var n = mask.length, last = -1;
    for(var i = 0; i < n; i++){
      if(mask[i]){
        if(last >= 0 && i - last - 1 <= maxGap){ for(var j = last + 1; j < i; j++) mask[j] = 1; }
        last = i;
      }
    }
    return mask;
  }

  function dropShort(mask, minLen){
    var n = mask.length, s = -1;
    for(var i = 0; i <= n; i++){
      if(i < n && mask[i]){ if(s < 0) s = i; }
      else if(s >= 0){ if(i - s < minLen){ for(var j = s; j < i; j++) mask[j] = 0; } s = -1; }
    }
    return mask;
  }

  function dilate(mask, k){
    if(k <= 0) return mask;
    var n = mask.length, out = new Uint8Array(n);
    for(var i = 0; i < n; i++) if(mask[i]){
      for(var j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) out[j] = 1;
    }
    return out;
  }

  function maskToRanges(mask, step){
    var out = [], s = -1;
    for(var i = 0; i <= mask.length; i++){
      if(i < mask.length && mask[i]){ if(s < 0) s = i; }
      else if(s >= 0){ out.push([s * step, i * step]); s = -1; }
    }
    return out;
  }

  function mergeRanges(list, gap){
    list = list.slice().sort(function(a, b){ return a[0] - b[0]; });
    var out = [];
    list.forEach(function(r){
      if(r[1] <= r[0]) return;
      var last = out[out.length - 1];
      if(last && r[0] - last[1] <= gap) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    });
    return out;
  }

  function total(ranges){ return ranges.reduce(function(s, r){ return s + r[1] - r[0]; }, 0); }

  // talking threshold from the recording itself: well below the typical loudness of
  // speech (Zoom recordings are near-silent between phrases, then loud)
  function speechThreshold(A){
    if(A._sthr != null) return A._sthr;
    var db = (A.audio && A.audio.db) || [];
    if(!db.length) return (A._sthr = 0);
    var s = db.slice().sort(function(a, b){ return a - b; });
    var floor = s[Math.floor(s.length * 0.1)];
    var loud = s.filter(function(v){ return v > floor + 20; });
    var med = loud.length ? loud[Math.floor(loud.length / 2)] : -30;
    return (A._sthr = Math.max(-55, Math.min(-25, med - 16)));
  }

  function derive(A, settings){
    var o = {};
    for(var k in DEFAULTS) o[k] = (settings && settings[k] != null) ? settings[k] : DEFAULTS[k];
    var step = A.step || 0.5;
    var dur = A.video.duration;
    var n = Math.ceil(dur / step);
    var S = A.samples || { canvas: [], palette: [], layout: [] };
    var have = Math.min(S.canvas.length, n);
    var until = A.complete ? dur : Math.min(A.analyzedUntil || 0, have * step);
    var nA = Math.min(n, Math.floor(until / step));        // samples we can trust

    // layout: brief losses of the palette border (a hand over it) don't count
    var valid = new Uint8Array(n);
    for(var i = 0; i < nA; i++) valid[i] = S.layout[i] ? 1 : 0;
    fillGaps(valid, 6);

    var pal = new Uint8Array(n);
    for(i = 0; i < nA; i++) pal[i] = (valid[i] && S.palette[i] > 100) ? 1 : 0;   // > 1% of the palette moving
    pal = dilate(fillGaps(pal, 6), 2);

    // painting: canvas stretches whose before/after differ enough
    var thr = changeThreshold(o.strict);
    var paintRanges = [];
    (A.stretches || []).forEach(function(s){
      if(s[1] > until) return;
      var unknown = s[2] < 0;
      if(unknown ? o.strict < 0.5 : s[2] >= thr) paintRanges.push([Math.max(0, s[0] - o.lead), Math.min(until, s[1] + o.lead)]);
    });
    paintRanges = mergeRanges(paintRanges, 1.5);
    var paint = new Uint8Array(n);
    paintRanges.forEach(function(r){
      for(var j = Math.floor(r[0] / step); j < Math.min(n, Math.ceil(r[1] / step)); j++) paint[j] = 1;
    });

    // talking: louder than the threshold, with short pauses bridged
    var db = (A.audio && A.audio.db) || [];
    var sthr = speechThreshold(A) + o.talk;
    var speech = new Uint8Array(n);
    for(i = 0; i < Math.min(n, db.length); i++) speech[i] = db[i] > sthr ? 1 : 0;
    speech = dropShort(fillGaps(speech, 2), 2);
    var speechRanges = maskToRanges(speech, step);

    var cat = new Uint8Array(n);
    for(i = 0; i < n; i++){
      cat[i] = i >= nA ? CAT.PENDING : !valid[i] ? CAT.OFFVIEW : paint[i] ? CAT.PAINT : pal[i] ? CAT.PALETTE : CAT.IDLE;
    }

    var rest = until < dur - 0.01 ? [[until, dur]] : [];
    var keep = {
      all: [[0, dur]],
      paint: mergeRanges(paintRanges.concat(rest), 0.6),
      talk: mergeRanges(paintRanges.concat(speechRanges.filter(function(r){ return r[0] < until; })
                                           .map(function(r){ return [r[0], Math.min(r[1], until)]; }), rest), 0.6)
    };
    keep.fast = keep.paint;

    var secs = [0, 0, 0, 0, 0], talkSecs = 0;
    for(i = 0; i < n; i++){ secs[cat[i]] += step; if(i < nA && speech[i]) talkSecs += step; }
    var stats = {
      painting: secs[0], palette: secs[1], idle: secs[2], offview: secs[3], pending: secs[4],
      talking: talkSecs, duration: dur, analyzedUntil: until,
      kept: { all: dur, paint: total(keep.paint), talk: total(keep.talk) }
    };
    stats.kept.fast = stats.kept.paint + (dur - stats.kept.paint) / o.fastRate;

    return { step: step, n: n, until: until, cat: cat, speech: speech, keep: keep, stats: stats,
             paintRanges: paintRanges, settings: o };
  }

  // index of the range containing t, or −(insertion point) − 1
  function findRange(ranges, t){
    var lo = 0, hi = ranges.length - 1;
    while(lo <= hi){
      var mid = (lo + hi) >> 1;
      if(t < ranges[mid][0]) hi = mid - 1;
      else if(t >= ranges[mid][1]) lo = mid + 1;
      else return mid;
    }
    return -lo - 1;
  }

  root.BW = { CAT: CAT, DEFAULTS: DEFAULTS, derive: derive, findRange: findRange, total: total,
              changeThreshold: changeThreshold };
})(typeof self !== "undefined" ? self : this);
