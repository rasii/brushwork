"""Brushwork helper — runs on the PC.

  py -3.8 brushwork.py serve            start the helper (the viewer finds it at http://127.0.0.1:8777)
  py -3.8 brushwork.py process <path>   analyze + prep a video, or every .mp4 in a folder

For each video it writes, in a "brushwork" folder next to the video:
  <name>.brushwork.json   the analysis the viewer reads (painting / palette / talking timeline)
  <name> (prepped).mp4    a 1080p copy with a keyframe every second, so skipping is instant

Needs ffmpeg/ffprobe on PATH and numpy.
"""
import base64, hashlib, json, math, os, re, shutil, subprocess, sys, threading, time, traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

import numpy as np

VERSION = 2                                           # 2: stretches carry 5-second pieces
PORT = 8777
HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)                       # the viewer's files, served at /
CONFIG = os.path.join(HERE, "config.json")
STEP = 0.5                                            # seconds per sample
W, H = 384, 216                                       # analysis frame size
PIECE = 10                                            # samples per piece of a stretch (5 s)
HALF = 6                                              # a clean canvas is the median of +-HALF samples
FINE = 2                                              # pieces are judged at FINE x the analysis size
SHIFT = int(os.environ.get("BW_SHIFT", 1))           # a pixel must differ from all within SHIFT px...
DIFF = int(os.environ.get("BW_DIFF", 12))            # ...by more than DIFF grey levels to count as paint
LATER = 60                                            # ...and checked again this many samples later (30 s)
                                                      # (a highlight in an eye is a pixel or two at 384x216)
NOWIN = 0x08000000 if os.name == "nt" else 0          # no console window for child processes


# ----------------------------------------------------------------------------- files

def side_dir(video):
    return os.path.join(os.path.dirname(video), "brushwork")


def stem(video):
    return os.path.splitext(os.path.basename(video))[0]


def analysis_path(video):
    return os.path.join(side_dir(video), stem(video) + ".brushwork.json")


def prepped_path(video):
    return os.path.join(side_dir(video), stem(video) + " (prepped).mp4")


def probe(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration:stream=codec_type,width,height,avg_frame_rate",
                          "-of", "json", video], capture_output=True, text=True,
                         creationflags=NOWIN).stdout
    j = json.loads(out)
    info = {"duration": float(j["format"]["duration"]), "width": 0, "height": 0, "fps": 25.0, "audio": False}
    for s in j["streams"]:
        if s["codec_type"] == "video" and not info["width"]:
            info["width"], info["height"] = s["width"], s["height"]
            n, d = s.get("avg_frame_rate", "25/1").split("/")
            info["fps"] = float(n) / float(d) if float(d) else 25.0
        if s["codec_type"] == "audio":
            info["audio"] = True
    return info


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


# ----------------------------------------------------------------------------- layout

def grab_small(video, t):
    out = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                          "-vf", f"scale={W}:{H}:flags=area,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, creationflags=NOWIN).stdout
    if len(out) < W * H:
        return None
    return np.frombuffer(out[:W * H], np.uint8).reshape(H, W).astype(np.int16)


def runs_from(m):
    """Per row: length of the run of True starting at column 0 (breaks of up to 3 px allowed)."""
    b = ~m
    k = np.ones(4, int)
    # a break is 4 False in a row
    brk = np.zeros_like(m)
    if m.shape[1] >= 4:
        c = np.apply_along_axis(lambda r: np.convolve(r, k, "valid"), 1, b.astype(int)) == 4
        brk[:, :c.shape[1]] = c
    has = brk.any(axis=1)
    return np.where(has, brk.argmax(axis=1), m.shape[1])


def find_main(frames):
    med = np.median(np.stack(frames), axis=0)
    bright = med > 22
    cols = np.where(bright.mean(axis=0) > 0.6)[0]
    rows = np.where(bright.mean(axis=1) > 0.6)[0]
    if len(cols) and len(rows):
        return [int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1]
    return [0, 0, W, H]


def find_inset(f, main):
    """Find a picture-in-picture rectangle in one of the main view's corners in a single
    frame: a straight horizontal edge running in from the left or right side, meeting a
    straight vertical edge running to the top or bottom. Returns [x0,y0,x1,y1] or None."""
    mx0, my0, mx1, my1 = main
    w, h = mx1 - mx0, my1 - my0
    ey = np.abs(np.diff(f, axis=0)) > 14          # row y = edge between y and y+1
    ex = np.abs(np.diff(f, axis=1)) > 14          # col x = edge between x and x+1
    best = None
    for side in ("l", "r"):
        sub = ey[my0:my1 - 1, mx0 + 1:mx1 - 1]
        if side == "r":
            sub = sub[:, ::-1]
        run = runs_from(sub)
        for yy in np.where((run >= w * 0.15) & (run <= w * 0.75))[0]:
            y = my0 + yy
            n = run[yy]
            x = mx0 + 1 + n if side == "l" else mx1 - 1 - n
            for vert in ("t", "b"):
                if vert == "t" and y - my0 < h * 0.15 or vert == "b" and my1 - y < h * 0.15:
                    continue
                if vert == "t" and y > my0 + h * 0.75 or vert == "b" and y < my0 + h * 0.25:
                    continue
                ys = slice(my0 + 3, y - 2) if vert == "t" else slice(y + 3, my1 - 3)
                band = ex[ys, max(x - 3, 0):min(x + 2, W - 1)]
                if band.size == 0:
                    continue
                frac = band.any(axis=1).mean()
                if frac < 0.7:
                    continue
                score = n * frac
                if side == "l":
                    rect = [mx0, my0 if vert == "t" else y + 1, x + 1, y + 1 if vert == "t" else my1]
                else:
                    rect = [x + 1, my0 if vert == "t" else y + 1, mx1, y + 1 if vert == "t" else my1]
                # a camera picture-in-picture is about 16:9 — rejects paint marks on the palette
                # being taken for its edge
                aspect = (rect[2] - rect[0]) / max(1, rect[3] - rect[1])
                if not 1.45 <= aspect <= 2.15:
                    continue
                if best is None or score > best[0]:
                    best = (score, rect)
    return best[1] if best else None


def same_rect(a, b, tol=4):
    return a is not None and b is not None and all(abs(p - q) <= tol for p, q in zip(a, b))


def detect_layout(video, duration, log=print):
    """Main view from frames across the video; the palette inset is tracked during analysis."""
    ts = [duration * (i + 0.5) / 16 for i in range(16)]
    frames = [f for f in (grab_small(video, t) for t in ts) if f is not None]
    main = find_main(frames)
    found = [find_inset(f, main) for f in frames]
    log(f"layout: main {main}; inset in sample frames: {found}")
    return main, found


# ----------------------------------------------------------------------------- analysis

class Job:
    """Progress of one video's analysis + prep, shared with the HTTP server."""
    def __init__(self, video):
        self.video = video
        self.analyze = {"state": "waiting", "progress": 0.0, "message": ""}
        self.prep = {"state": "waiting", "progress": 0.0, "message": ""}


def audio_levels(video, duration, job=None):
    """Loudness (dB) per STEP of the audio, from 8 kHz mono."""
    sr = 8000
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", str(sr),
                          "-af", "highpass=f=100,lowpass=f=3500", "-f", "s16le", "-"],
                         stdout=subprocess.PIPE, creationflags=NOWIN)
    n = int(sr * STEP)
    db = []
    while True:
        buf = p.stdout.read(n * 2)
        if not buf:
            break
        a = np.frombuffer(buf, np.int16).astype(np.float32) / 32768
        db.append(round(float(10 * np.log10(np.mean(a * a) + 1e-10)), 1))
        if job and len(db) % 2000 == 0:
            job.analyze["message"] = f"listening {100 * len(db) * STEP / duration:.0f}%"
    p.wait()
    return db


def make_masks(main, inset):
    """Canvas area (main view minus the inset) and palette area, plus the inset's inner
    border lines used to check it's still there."""
    mx0, my0, mx1, my1 = main
    canvas = np.zeros((H, W), bool)
    canvas[my0 + 2:my1 - 2, mx0 + 2:mx1 - 2] = True
    if inset is None:
        return canvas, None, None
    ix0, iy0, ix1, iy1 = inset
    canvas[max(iy0 - 4, 0):iy1 + 4, max(ix0 - 4, 0):ix1 + 4] = False
    pal = np.zeros((H, W), bool)
    pal[iy0 + 3:iy1 - 3, ix0 + 3:ix1 - 3] = True
    hy = iy1 - 1 if iy0 <= my0 + 2 else iy0 - 1          # horizontal border: bottom edge if inset is at the top
    vx = ix1 - 1 if ix0 <= mx0 + 2 else ix0 - 1          # vertical border: right edge if inset is on the left
    border = (hy, slice(ix0 + 4, ix1 - 4), vx, slice(iy0 + 4, iy1 - 4))
    return canvas, pal, border


def border_present(fr, border):
    hy, xs, vx, ys = border
    a = np.abs(fr[hy + 1, xs] - fr[hy, xs]) > 10 if 0 <= hy < H - 1 else np.zeros(1, bool)
    b = np.abs(fr[ys, vx + 1] - fr[ys, vx]) > 10 if 0 <= vx < W - 1 else np.zeros(1, bool)
    return (a.mean() + b.mean()) / 2 > 0.45


def analyze(video, job=None, log=print):
    job = job or Job(video)
    os.makedirs(side_dir(video), exist_ok=True)
    out = analysis_path(video)
    info = probe(video)
    dur = info["duration"]
    job.analyze.update(state="running", message="finding the layout")
    main, _ = detect_layout(video, dur, log)

    job.analyze["message"] = "listening"
    db = audio_levels(video, dur, job) if info["audio"] else []
    if db:
        d_ = np.array(db); floor = np.percentile(d_, 10); loud = d_[d_ > floor + 20]
        med = float(np.median(loud)) if len(loud) else -30.0
        speech_thr = float(round(max(-55.0, min(-25.0, med - 16)), 1))   # same rule as the viewer
    else:
        speech_thr = 0.0

    frac = lambda r: None if r is None else [round(v / (W if k % 2 == 0 else H), 4) for k, v in enumerate(r)]
    res = {
        "app": "brushwork", "version": VERSION, "video": {"name": os.path.basename(video), **info},
        "step": STEP, "layout": {"main": frac(main), "insets": []},
        "analyzedUntil": 0.0, "complete": False,
        "audio": {"db": db, "speechThreshold": speech_thr},
        "samples": {"canvas": [], "palette": [], "layout": []},
        "stretches": [],
        "settings": {"canvasMotion": 0.004, "paletteMotion": 0.01, "gap": 3.0},
    }
    write_json(out, res)

    job.analyze["message"] = "watching"
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-hwaccel", "auto", "-i", video, "-an",
                          "-vf", f"fps={1 / STEP},scale={W * FINE}:{H * FINE}:flags=area,format=gray",
                          "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=W * H * FINE * FINE * 16,
                         creationflags=NOWIN)
    C_ACT, GAP = 0.004, int(3.0 / STEP)
    S = res["samples"]
    # open_st: [start_index, last_active_index, before_frame, clean canvas before, [(index, clean canvas)]]
    prev, ring, fring, open_st = None, [], [], None
    inset, cand, cand_n, misses = None, None, 0, 0
    canvas, pal, border = make_masks(main, None)
    i, last_write = 0, time.time()
    pending, quiet_n = [], 0     # stretches waiting for their check 30 s later; samples without a stretch
    history = []                 # (index, clean canvas) from quiet moments, the last couple of minutes

    def clean(frames):
        """The canvas with a moving hand mostly gone: the per-pixel median of a few frames."""
        return np.median(np.stack(frames), axis=0).astype(np.int16)

    def differs(X, Y, cmask, R=SHIFT, T=DIFF):
        """Where X differs from Y by more than T even allowing Y to shift up to R pixels
        (the camera shakes when the panel is touched, and the board's grain is full of edges)
        and allowing for an overall brightness change."""
        X = X - int(np.median((X - Y)[cmask]))
        out = np.ones(X.shape, bool)
        for dy in range(-R, R + 1):
            for dx in range(-R, R + 1):
                out &= np.abs(X - np.roll(np.roll(Y, dy, axis=0), dx, axis=1)) > T
        return out

    def close(st, after, after_clean=None):
        s_i, last_i, before, before_clean, bounds, earlier = st
        change = -1.0
        if after is not None and before is not None:
            change = float((np.abs(after - before)[canvas] > 18).mean())
        rec = [round((s_i - 1) * STEP, 2), round(last_i * STEP, 2), round(change, 5)]
        res["stretches"].append(rec)
        if after_clean is not None and before_clean is not None:
            judge(rec, before_clean, bounds, after_clean, last_i, earlier)
            remember(after_clean, i)
        elif after_clean is None:
            settle_all()     # the camera or the layout moved: a later look would compare different views
            history.clear()

    def judge(rec, A0, bounds, F, last_i, E):
        """Split a stretch into 5-second pieces and find the paint each one added.

        Everything is measured against the clean canvas just before the stretch (A0). A pixel
        counts as paint when it differs from A0 just after the stretch (F), still differs 30 s
        later (L, see settle), and also differs from a canvas at least 30 s *before* the
        stretch (E) -- so a hand that passes over the painting while pointing, that rests
        there just after the stretch, or that was resting there just before it, doesn't count.
        Each such pixel belongs to the piece in which it first changed."""
        cmask = np.repeat(np.repeat(canvas, FINE, axis=0), FINE, axis=1)
        pts = [(rec[0], A0)] + [(b * STEP, c) for b, c in bounds if b * STEP < rec[1] - 1.0] + [(rec[1], F)]
        parts, seen = [], np.zeros(A0.shape, bool)
        for (t0, A), (t1, B) in zip(pts, pts[1:]):
            now = differs(B, A0, cmask)
            parts.append((t0, t1, now & ~seen))
            seen |= now
        pending.append((rec, cmask, parts, last_i, A0, F, E))

    def settle(item, L):
        rec, cmask, parts, _, A0, F, E = item
        if L is None:
            L = F
        lasting = differs(F, A0, cmask) & differs(L, A0, cmask)
        if E is not None:
            lasting &= differs(L, E, cmask)
        rec.append([[round(t0, 2), round(t1, 2), round(float((m & lasting)[cmask].mean()), 5)]
                    for t0, t1, m in parts])

    def remember(C, at_i):
        """A clean canvas from a quiet moment: the second look for stretches 30 s or more
        before, and the earlier canvas for stretches starting 30 s or more after."""
        history.append((at_i, C))
        while len(history) > 2 and history[1][0] < at_i - 4 * LATER:
            history.pop(0)
        for item in [x for x in pending if x[3] + LATER <= at_i]:
            settle(item, C); pending.remove(item)

    def earlier_canvas(at_i):
        old = [c for k, c in history if k <= at_i - LATER]
        return old[-1] if old else (history[0][1] if history else None)

    def settle_all(L=None):
        for item in pending:
            settle(item, L)
        pending.clear()

    while True:
        buf = p.stdout.read(W * H * FINE * FINE)
        if len(buf) < W * H * FINE * FINE:
            break
        big = np.frombuffer(buf, np.uint8).reshape(H * FINE, W * FINE)
        fr = big.reshape(H, FINE, W, FINE).mean(axis=(1, 3)).round().astype(np.int16)
        fring.append(big); fring = fring[-(2 * HALF + 1):]

        # track the palette inset: look every 2 s; switch after 5 matching sightings in a row,
        # drop it after a minute without seeing it
        if i % 4 == 0:
            r = find_inset(fr, main)
            if r is not None and same_rect(r, inset):
                misses = 0
            elif r is not None:
                if same_rect(r, cand):
                    cand_n += 1
                else:
                    cand, cand_n = r, 1
                if cand_n >= 5:
                    if open_st:
                        close(open_st, None); open_st = None
                    inset, cand, cand_n, misses = cand, None, 0, 0
                    canvas, pal, border = make_masks(main, inset)
                    res["layout"]["insets"].append([round(i * STEP, 1), frac(inset)])
                    log(f"  palette inset at {i * STEP / 60:.1f} min: {inset}")
            else:
                misses += 1
                if inset is not None and misses >= 30:
                    if open_st:
                        close(open_st, None); open_st = None
                    inset = None
                    canvas, pal, border = make_masks(main, None)
                    res["layout"]["insets"].append([round(i * STEP, 1), None])

        ok = inset is not None and border_present(fr, border)
        if prev is None or inset is None:
            cf = pf = 0.0
        else:
            d = np.abs(fr - prev)
            cf = float((d[canvas] > 20).mean())
            pf = float((d[pal] > 20).mean())
        S["canvas"].append(int(round(cf * 10000)))
        S["palette"].append(int(round(pf * 10000)))
        S["layout"].append(int(ok))

        active = ok and C_ACT < cf <= 0.3
        if cf > 0.3 and open_st:                     # camera moved: close without judging
            close(open_st, None); open_st = None
        if active:
            if open_st is None:
                open_st = [i, i, ring[-2] if len(ring) >= 2 else None,
                           clean(fring[-5:-1]) if len(fring) >= 2 else None, [], earlier_canvas(i)]
            else:
                open_st[1] = i
        elif open_st and i - open_st[1] > GAP:
            # the GAP + 1 quiet frames since the last movement give the clean canvas after
            close(open_st, fr, clean(fring[-(GAP + 1):])); open_st = None
        # a clean canvas every PIECE samples through the stretch (+-HALF samples around each point)
        if open_st and i - HALF > open_st[0] and (i - HALF - open_st[0]) % PIECE == 0:
            open_st[4].append((i - HALF, clean(fring)))
        # long quiet spells give second looks too
        quiet_n = 0 if open_st else quiet_n + 1
        if quiet_n >= 2 * HALF + 1 and i % PIECE == 0:
            remember(clean(fring), i)

        ring.append(fr); ring = ring[-4:]
        prev = fr
        i += 1
        if i % 200 == 0:
            job.analyze["progress"] = min(0.999, i * STEP / dur)
            if time.time() - last_write > 20:
                # an open stretch isn't judged yet; the viewer plays unanalysed time normally
                res["analyzedUntil"] = round(min([((open_st[0] - 1) if open_st else i) * STEP] +
                                                 [x[0][0] for x in pending]), 1)
                write_json(out, res)
                last_write = time.time()
    p.wait()
    settle_all(clean(fring[-(GAP + 1):]) if fring else None)
    if open_st:
        close(open_st, None)
    res["analyzedUntil"] = round(i * STEP, 1)
    res["complete"] = True
    write_json(out, res)
    job.analyze.update(state="done", progress=1.0, message="")
    log(f"analysis written: {out}")
    return res


def prep(video, job=None, log=print):
    job = job or Job(video)
    os.makedirs(side_dir(video), exist_ok=True)
    out = prepped_path(video)
    tmp = out[:-4] + ".partial.mp4"
    dur = probe(video)["duration"]
    job.prep.update(state="running", message="")
    vf = "scale=-2:'min(1080,ih)'"
    # ~1.1 Mbit/s: a mostly still canvas needs little, and the copy should be small enough for an iPad
    for enc in (["-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-b:v", "1100k", "-maxrate", "1800k", "-bufsize", "3600k"],
                ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "1100k", "-maxrate", "1800k", "-bufsize", "3600k"]):
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", vf, *enc,
               "-g", "25", "-keyint_min", "25", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
               "-progress", "pipe:1", "-nostats", tmp]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             creationflags=NOWIN)
        for line in p.stdout:
            if line.startswith("out_time_us="):
                try:
                    job.prep["progress"] = min(0.999, int(line.split("=")[1]) / 1e6 / dur)
                except ValueError:
                    pass
        p.wait()
        if p.returncode == 0:
            os.replace(tmp, out)
            job.prep.update(state="done", progress=1.0)
            log(f"prepped copy written: {out}")
            return out
        log(f"encoder {enc[1]} failed: {p.stderr.read()[-300:]}")
    job.prep.update(state="error", message="ffmpeg failed")
    return None


def busy_elsewhere(path, secs=90):
    """A file another helper/batch run is still writing (changed in the last minute or so)."""
    return os.path.exists(path) and time.time() - os.path.getmtime(path) < secs


def analysis_complete(video):
    try:
        return json.load(open(analysis_path(video))).get("complete", False)
    except Exception:
        return False


IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif")


def images_for(video):
    """The images in the video's folder (reference, finished painting, progress shots): the
    ones named after this video first ("Session 1 ...jpg"), then the rest of the course's."""
    d, s = os.path.dirname(video), stem(video).lower()
    try:
        names = [f for f in os.listdir(d) if f.lower().endswith(IMG_EXT) and os.path.isfile(os.path.join(d, f))]
    except OSError:
        return []
    def mine(f):
        return f.lower().startswith(s + " ") or os.path.splitext(f)[0].lower() == s
    names.sort(key=lambda f: (not mine(f), f.lower()))
    return [{"name": f, "session": mine(f)} for f in names]


IPAD_IMG_MAX = 4096   # long side of the copies in the brushwork folder; the originals can be 24 MP


def copy_images(video, log=print):
    """Put the course's images in the brushwork folder too, so that one folder has everything
    the iPad needs. Big photos are scaled down to IPAD_IMG_MAX on the long side."""
    import cv2
    sd = side_dir(video)
    os.makedirs(sd, exist_ok=True)
    n = 0
    for im in images_for(video):
        src, dst = os.path.join(os.path.dirname(video), im["name"]), os.path.join(sd, im["name"])
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        img = cv2.imdecode(np.fromfile(src, dtype=np.uint8), cv2.IMREAD_COLOR)   # applies EXIF rotation
        ext = os.path.splitext(src)[1].lower()
        if img is None or ext == ".gif" or max(img.shape[:2]) <= IPAD_IMG_MAX:
            shutil.copy2(src, dst)
        else:
            k = IPAD_IMG_MAX / max(img.shape[:2])
            img = cv2.resize(img, (round(img.shape[1] * k), round(img.shape[0] * k)), interpolation=cv2.INTER_AREA)
            params = [cv2.IMWRITE_JPEG_QUALITY, 90] if ext in (".jpg", ".jpeg") else []
            ok, buf = cv2.imencode(ext if ext != ".jpeg" else ".jpg", img, params)
            if not ok:
                shutil.copy2(src, dst)
            else:
                buf.tofile(dst)
        n += 1
    if n:
        log(f"copied {n} image(s) to {sd}")


def process(video, job=None, log=print):
    """Analysis and prep run side by side."""
    job = job or Job(video)
    try:
        copy_images(video, log)
    except Exception as e:
        log(f"couldn't copy the images: {e}")
    threads = []
    partial_prep = prepped_path(video)[:-4] + ".partial.mp4"
    if not analysis_complete(video) and busy_elsewhere(analysis_path(video)):
        job.analyze.update(state="elsewhere", message="being analysed by another run")
    elif not analysis_complete(video):
        threads.append(threading.Thread(target=_safe, args=(analyze, video, job, log, "analyze")))
    else:
        job.analyze.update(state="done", progress=1.0)
    if not os.path.exists(prepped_path(video)) and busy_elsewhere(partial_prep):
        job.prep.update(state="elsewhere", message="being prepped by another run")
    elif not os.path.exists(prepped_path(video)):
        threads.append(threading.Thread(target=_safe, args=(prep, video, job, log, "prep")))
    else:
        job.prep.update(state="done", progress=1.0)
    for t in threads: t.start()
    for t in threads: t.join()
    return job


def _safe(fn, video, job, log, key):
    try:
        fn(video, job, log)
    except Exception as e:
        traceback.print_exc()
        getattr(job, key).update(state="error", message=str(e))


# ----------------------------------------------------------------------------- server

def load_config():
    cfg = {"folders": [], "port": PORT}
    if os.path.exists(CONFIG):
        cfg.update(json.load(open(CONFIG)))
    return cfg


def vid_id(path):
    return hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode()).hexdigest()[:16]


class Library:
    def __init__(self):
        self.paths = {}
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = []
        threading.Thread(target=self._worker, daemon=True).start()

    def scan(self):
        cfg = load_config()
        items = []
        for folder in cfg["folders"]:
            for root, dirs, files in os.walk(folder):
                dirs[:] = [d for d in dirs if d.lower() not in ("brushwork",)]
                for f in sorted(files):
                    if f.lower().endswith((".mp4", ".mov", ".m4v", ".mkv")):
                        p = os.path.join(root, f)
                        i = vid_id(p)
                        self.paths[i] = p
                        items.append(self.status(i))
        return {"folders": cfg["folders"], "videos": items}

    def status(self, i):
        p = self.paths[i]
        a, pr = analysis_path(p), prepped_path(p)
        complete = False
        if os.path.exists(a):
            try:
                complete = json.load(open(a)).get("complete", False)
            except Exception:
                pass
        job = self.jobs.get(i)
        if job and job.analyze["state"] == "elsewhere":
            try:
                a_ = json.load(open(a))
                job.analyze["progress"] = a_["analyzedUntil"] / a_["video"]["duration"]
                if a_.get("complete"):
                    job.analyze.update(state="done", progress=1.0)
                elif not busy_elsewhere(a):
                    job.analyze.update(state="error", message="the other run stopped")
                else:
                    job.analyze["state_shown"] = "running"
            except Exception:
                pass
        if job and job.prep["state"] == "elsewhere":
            if os.path.exists(pr):
                job.prep.update(state="done", progress=1.0)
            elif not busy_elsewhere(pr[:-4] + ".partial.mp4"):
                job.prep.update(state="error", message="the other run stopped")
        return {"id": i, "name": os.path.basename(p), "folder": os.path.dirname(p), "path": p,
                "size": os.path.getsize(p), "analysis": "done" if complete else ("partial" if os.path.exists(a) else "none"),
                "prepped": os.path.exists(pr),
                "job": None if not job else {"analyze": job.analyze, "prep": job.prep,
                                             "queued": i in self.queue}}

    def start(self, i):
        with self.lock:
            if i in self.jobs and any(s["state"] in ("running", "waiting", "elsewhere") for s in (self.jobs[i].analyze, self.jobs[i].prep)):
                return
            self.jobs[i] = Job(self.paths[i])
            self.queue.append(i)

    def _worker(self):
        while True:
            if self.queue:
                i = self.queue[0]
                try:
                    process(self.paths[i], self.jobs[i])
                finally:
                    with self.lock:
                        self.queue.pop(0)
            else:
                time.sleep(0.5)


LIB = Library()
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
        ".png": "image/png", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4",
        ".svg": "image/svg+xml", ".md": "text/plain", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.send_header("Content-Length", "0"); self.end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/api/process":
            i = q.get("id", [""])[0]
            if i not in LIB.paths:
                LIB.scan()
            if i not in LIB.paths:
                return self.send_json({"error": "unknown video"}, 404)
            LIB.start(i)
            return self.send_json(LIB.status(i))
        self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        try:
            if u.path == "/api/hello":
                return self.send_json({"app": "brushwork-helper", "version": VERSION})
            if u.path == "/api/library":
                return self.send_json(LIB.scan())
            if u.path in ("/api/status", "/api/analysis", "/video", "/api/images", "/image"):
                i = q.get("id", [""])[0]
                if i not in LIB.paths:
                    LIB.scan()
                if i not in LIB.paths:
                    return self.send_json({"error": "unknown video"}, 404)
                p = LIB.paths[i]
                if u.path == "/api/status":
                    return self.send_json(LIB.status(i))
                if u.path == "/api/images":
                    return self.send_json(images_for(p))
                if u.path == "/image":
                    n = q.get("n", [""])[0]
                    if n not in [im["name"] for im in images_for(p)]:
                        return self.send_json({"error": "no such image"}, 404)
                    f = os.path.join(os.path.dirname(p), n)
                    return self.send_file(f, MIME.get(os.path.splitext(f)[1].lower(), "application/octet-stream"))
                if u.path == "/api/analysis":
                    a = analysis_path(p)
                    if not os.path.exists(a):
                        return self.send_json({"error": "not analyzed"}, 404)
                    return self.send_file(a, "application/json", nocache=True)
                which = q.get("v", ["best"])[0]
                f = prepped_path(p) if which in ("prepped", "best") and os.path.exists(prepped_path(p)) else p
                return self.send_file(f, "video/mp4")
            # the viewer app itself
            rel = unquote(u.path).lstrip("/") or "index.html"
            f = os.path.normpath(os.path.join(APP_DIR, rel))
            if not f.startswith(APP_DIR) or not os.path.isfile(f) or os.sep + "helper" + os.sep in f:
                return self.send_json({"error": "not found"}, 404)
            return self.send_file(f, MIME.get(os.path.splitext(f)[1].lower(), "application/octet-stream"), nocache=True)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def send_file(self, f, ctype, nocache=False):
        size = os.path.getsize(f)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                else:
                    start = size - int(m.group(2))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if nocache:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def serve(open_browser=False):
    cfg = load_config()
    if not cfg["folders"]:
        print(f"No video folders set. Add them to {CONFIG}, e.g. {{\"folders\": [\"D:/Videos/Painting demos\"]}}")
    port = cfg.get("port", PORT)
    url = f"http://127.0.0.1:{port}/"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        # most likely the helper is already running in another window
        print(f"Port {port} is already in use - the helper is probably already running. Opening {url}")
        if open_browser:
            import webbrowser
            webbrowser.open(url)
        time.sleep(4)
        return
    print(f"Brushwork helper running - open {url}  (close this window to stop it)")
    print("Video folders:", ", ".join(cfg["folders"]) or "(none)")
    if open_browser:   # only once the server is listening, so the first page load works
        import webbrowser
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    srv.serve_forever()


def main():
    args = sys.argv[1:]
    if not args or args[0] == "serve":
        return serve(open_browser="--open" in args)
    if args[0] in ("process", "analyze", "prep") and len(args) > 1:
        target = args[1]
        vids = [target] if os.path.isfile(target) else [
            os.path.join(r, f) for r, d, fs in os.walk(target) if "brushwork" not in r.lower()
            for f in sorted(fs) if f.lower().endswith((".mp4", ".mov", ".m4v", ".mkv"))]
        for v in vids:
            print(f"== {v}")
            t0 = time.time()
            if args[0] == "analyze":
                analyze(v)
            elif args[0] == "prep":
                prep(v)
            else:
                process(v)
            print(f"   took {(time.time() - t0) / 60:.1f} min")
        return
    print(__doc__)


if __name__ == "__main__":
    main()
