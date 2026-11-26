# Brushwork

A small web app for watching painting-demo videos (long Zoom recordings of a painter at
work) with the palette mixing and quiet stretches skipped — or fast-forwarded — and any
skipped part one tap away on the timeline.

It works out, for every half second of a video, whether the painter is **painting**
(brush at the canvas *and the painting visibly changes*), **at the palette**, or neither,
and when he's **talking**. Then you choose what to watch:

| Mode | Plays |
| --- | --- |
| Everything | the whole video |
| Painting | only the painting stretches |
| Painting + talking | painting, plus everything he says |
| Fast-forward the rest | painting and talking at normal speed, everything else at 2–16× without sound |

Tap anywhere on the timeline — including a hatched (skipped) part — to watch it; the app
goes back to skipping when that part ends. The eye button (or **W**) replays the part
skipped just before what you're watching. **Time split** shows how the session's time
divides between painting, palette and talking. Settings set how strict "painting" and
"talking" are and the fast-forward speed.

**Hiding the controls:** the button next to full screen (or **C**) gives the video the
whole window. The controls float over its bottom edge and fade out after a few seconds of
playing, and stay hidden when you pause. Move the mouse to the bottom edge, or tap or click
there, to bring them back (a key does too).

**Zoomed strip:** the upper timeline shows about six minutes around the playhead. Drag it
like a tape (left goes forward, right goes back) to scrub; tap it to jump to that spot.

**Jumping:** double-tap (or double-click) the right side of the video to jump forward 10 s,
the left side to jump back; each further quick tap adds another 10 s.

**Speed:** the − and + buttons either side of the speed step it down and up; tapping the
speed itself opens the full list. Playback speed runs from 0.25× to 3×, for
everything that plays (the voice keeps its pitch; fast-forwarded gaps keep their own
speed). **Touch and hold the video** to play at your hold speed (0.25× to 8×, 2× by
default) until you let go. That works while paused too, and on the PC holding **H** does
the same. **<** and **>** step the speed down and up.

**Images:** the picture button (or **I**) opens a floating window with the reference photo,
the finished painting and progress shots. Drag its title bar to move it, any corner to
resize it; scroll or pinch to zoom, drag to look around, double-tap to zoom in or back
out. It remembers where it was and how it was zoomed for each video, and stays put by its
nearest corner when the video goes full screen or back. The arrows switch
images; the expand button (or **O**) shows one full screen and pauses the video until you
close it. The camera button (or **G**) saves the current video frame as an image, and the
**+** adds images from the device. On the PC every image in the video's folder is listed,
that session's own ("Session 1 …") first; processing a video also copies them, scaled to at
most 4096 px, into its `brushwork` folder for the iPad.

**Video effects:** saturation, contrast, brightness, warmth and tint, to bring the
recording's colours closer to the real painting; one setting for every video, kept on each
device. **Match** sets all five for you: open the finished painting (or a progress photo) in
the picture window, tap Match, and drag a box around the painting in the video. The app
compares the colours of the two and sets the sliders. Zoom the picture window in to match
just part of the image, and fine-tune by eye afterwards.

Made for an iPad saved to the home screen, like Comp-Art; works in any modern browser.
Videos never leave the device.

## Two parts

**The viewer** (`index.html` and friends) is a static web page — host it on GitHub Pages
and add it to the iPad's home screen. It plays a video you pick from Files together with
its analysis file.

**The helper** (`helper/brushwork.py`) runs on the PC. It analyses videos and makes a
"prepped" copy of each (1080p, a keyframe every second, so skipping is instant instead of
stalling for a second or two). For each video it writes, in a `brushwork` folder next to it:

- `<name>.brushwork.json` — the analysis (a few hundred KB)
- `<name> (prepped).mp4` — the prepped copy (about half the size of the original)

Analysing a 3-hour session takes about 15 minutes; prepping about 20 (they run together).

## On the PC

1. Put your video folders in `helper/config.json` (copy `config.example.json`).
2. Double-click **Brushwork Helper.bat**. It opens the viewer at http://127.0.0.1:8777/ and
   lists your videos. Opening one that hasn't been analysed and prepped asks first, then
   starts both (or **Just watch** plays it as it is); the video plays straight away, and the skipping modes switch on as the analysis
   catches up (it works front to back, the first hour is ready in about 5 minutes). When
   the prepped copy is ready the viewer switches to it without interrupting.
3. To process videos ahead of time (overnight), drag a video or a whole folder onto
   **Process a folder.bat**.

The hosted viewer (GitHub Pages) also finds the helper when it's running on the same PC,
so you can use either address. Chrome/Edge may ask once to allow it to reach "devices on
your local network" — that's the helper.

Needs Python 3 with numpy (`py -3.8` is what the launchers call) and ffmpeg on the PATH.
Uses the NVIDIA encoder when there is one, otherwise x264.

## On the iPad

**Streaming from the PC:** while the helper runs, open `http://<the PC's address>:8777/` in
Safari on the iPad (the helper's window shows the address). You get the same video list as on
the PC, and videos stream from it with nothing to copy. Away from home this works over
Tailscale too, using the PC's Tailscale name or `100.x` address. Windows may ask once to let
Python through the firewall; allow it on private networks. This copy of the app needs the PC
and keeps its own settings, separate from the home-screen app below. To turn streaming off,
add `"network": false` to `helper/config.json`.

**Picking up where you left off:** the helper remembers where you were in each video (in
`helper/positions.json`), so stop on the PC and the iPad starts from there, and the other way
round. Whichever device moved last wins; a video left paused on one device moves to the newer
place when you come back to it. **Continue watching**, at the top of the list, shows the three
videos you watched most recently on any device, and each video in the list shows where you were. This works for every copy of the app that reaches the helper
(not the home-screen app below, which Safari doesn't let talk to it).

**Copying the files over:**

1. Copy the video's `brushwork` folder (the prepped video, its `.brushwork.json` and the images) to the
   iPad, e.g. into Files › On My iPad.
2. Open Brushwork from the home screen, tap **Open video…**, and pick the video, its `.brushwork.json` and the images you want, all together.
3. The analysis is kept in the app. Next time only the video needs picking (Safari won't
   let a web app keep a link to a video in Files) — tap the session under **Recent**.

## How the analysis works

The recordings are Zoom layouts: the canvas camera fills the main view, the palette camera
sits in a corner picture-in-picture, a webcam strip at the side. The helper:

- finds the main view, and tracks the palette inset in any corner (it moves between
  sessions and sometimes within one) by its straight border lines; time without it
  (the gallery view at the start, a screen share) is "other views";
- measures motion over the canvas (minus the inset) and over the palette, at 2 frames a
  second, 384×216;
- groups canvas motion into stretches and splits each stretch into 5-second pieces, then
  measures how much paint each piece added, at 768×432. A change counts only if it stays:
  it's compared with a clean canvas (the hand removed by taking the median of several
  frames) from just before the stretch, from just after it, from 30 seconds later, and
  from at least 30 seconds before. So pointing and gesturing, a brush resting on the
  panel, and a hand held still don't count as painting, and the parts of a long stretch
  that were only talking with the hands over the canvas are skipped. Small camera shakes
  and lighting shifts are allowed for. (Analyses from before v1.12 judge whole stretches;
  the viewer still reads them, and **Process a folder** redoes them);
- measures loudness every half second for talking (Zoom silences the room between
  phrases, so speech stands out clearly).

The viewer turns those numbers into the timeline with your settings, so changing how
strict "painting" is takes effect at once without re-analysing.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page markup: the library, the player, settings and time-split sheets |
| `app.css` | Styles (Comp-Art's dark palette) |
| `app.js` | The app: library, opening files or helper videos, playback with skipping / fast-forward / peeking, timelines, settings |
| `analysis.js` | Turns an analysis file into per-second categories, talking, and each mode's list of kept time ranges |
| `images.js` | Reference / finished images: the zoomable floating window and full-screen view |
| `store.js` | IndexedDB: saved analyses and images, where you were in each video, settings |
| `sw.js`, `version.js` | Offline copy of the app; bump `version.js` on every release |
| `manifest.webmanifest`, `apple-touch-icon.png` | Home-screen install |
| `helper/brushwork.py` | The PC helper: analysis, prep, and a small local server (port 8777) for the viewer |
| `Brushwork Helper.bat` | Starts the helper and opens the viewer |
| `Process a folder.bat` | Drag-and-drop batch processing |
