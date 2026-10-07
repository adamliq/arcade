# arcade

Classic games and demos rebuilt to run in a modern browser. Open `index.html` for the list.

## Blood & Magic — 1996 non-interactive preview

`blood-and-magic/` is a browser port of Interplay / Tachyon Studios' DOS demo player (`BAM_DEMO.EXE`).
It plays the **original** Smacker movie (`data/BAMDEMOF.SMK`) and run-time script (`data/DEMOF.SCR`)
directly. Nothing is pre-converted.

- `js/smacker.js` is a dependency-free Smacker 2/4 decoder that handles video, palette deltas and compressed audio.
  Its output matches ffmpeg on all 1726 frames, and the audio is bit-exact.
- `js/script.js` interprets the demo script's commands: `u`/`d` palette fades, `r` palette cuts, and `+`/`-` music fades.
- `js/player.js` is the player itself. It syncs video to the Web Audio clock and decodes snapshots up front so seeking is instant.
  It also shows scene chapters with thumbnails and hover previews on the timeline, and offers a CRT mode, fullscreen,
  keyboard shortcuts, Media Session controls and drag-and-drop for any `.smk` file.

### Running locally

Browsers don't let pages fetch local files, so serve the repo over HTTP:

```sh
python3 -m http.server 8000
# open http://localhost:8000/blood-and-magic/
```

It also works as-is on GitHub Pages or any static host.

Deep links: `?frame=605` or `?t=90`.

Blood & Magic © 1996 Tachyon Studios. Blood & Magic is a trademark of TSR; Interplay is a trademark of
Interplay Productions. The demo data is the freely distributed non-interactive preview, included for
personal, non-commercial use under its original license.
