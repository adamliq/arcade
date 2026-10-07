// Interpreter for BAM_DEMO.EXE run-time scripts (DEMO*.SCR).
//
// Each non-comment line is "<first> <last> <op>", frames numbered from 1:
//   u  fade the VGA palette up from black over the range
//   d  fade the palette down to black over the range (stays black until the next "u")
//   r  switch to the movie's new palette instantly (a hard cut, no fade)
//   +  fade the music track in over the range
//   -  fade the music track out over the range
//   i  (only in the older DEMO.SCR) ignored
//
// Levels are evaluated on a continuous frame position, so fades stay smooth on
// modern displays instead of stepping at the movie's 9 fps.

export function parseScript(text) {
  const palette = [];
  const music = [];
  const cuts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S)/);
    if (!m) continue;
    const a = +m[1], b = +m[2], op = m[3];
    if (b < a) continue; // e.g. the "1697 1626 -" typo in DEMOS.SCR
    if (op === 'u' || op === 'd') palette.push({ a, b, up: op === 'u' });
    else if (op === '+' || op === '-') music.push({ a, b, up: op === '+' });
    else if (op === 'r') cuts.push(a);
  }
  palette.sort((x, y) => x.a - y.a);
  music.sort((x, y) => x.a - y.a);
  return { palette, music, cuts };
}

// pos: 1-based continuous frame position (frame N is on screen during [N, N+1)).
function level(ranges, pos) {
  if (!ranges.length) return 1;
  let cur = null;
  for (const r of ranges) {
    if (r.a <= pos) cur = r;
    else break;
  }
  if (!cur) return ranges[0].up ? 0 : 1;
  const k = Math.min(1, (pos - cur.a) / (cur.b - cur.a + 1));
  return cur.up ? k : 1 - k;
}

export const paletteLevel = (script, pos) => (script ? level(script.palette, pos) : 1);
export const musicLevel = (script, pos) => (script ? level(script.music, pos) : 1);
