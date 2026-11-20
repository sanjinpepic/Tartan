/**
 * The `main.js` step runner that goes into every workout guide zip ("sequence" guide).
 *
 * It is an ES5 script the watch evaluates as a function body; it returns the event handler
 * `function (event, input, data)`. It loads `step0.js`, `step1.js`, ... one at a time with
 * `evalFile`, starts each on the watch with `initStep`, handles repeat markers, own laps, the
 * between-parts popup / beep, and answers the 4096 view query.
 *
 * Written clean-room, only from `docs/cleanroom/workout-runner-spec.md` and the public
 * SuuntoPlus API reference. Keep the first line (`// 20613`), keep it ES5, and keep it small:
 * the watch has little memory.
 */
export const TARTAN_RUNNER: string = `// 20613
// Tartan workout runner (clean-room, see docs/cleanroom/workout-runner-spec.md)
// i index, s step, rl/rs/re repeats left/start/end, ol own laps pending
// lg/pg/bg lap/popup/beep guards (3 = set, 0 = clear)
var i, s, rl = 0, rs, re, ol = 0, lg = 0, pg = 0, bg = 0;
function tt(v) { return v && (v.title || v.text); }
function ld() {
  s = undefined; // free memory before loading
  s = evalFile('{file_path}/step' + i + '.js');
}
function go() {
  var n = i + 1 || 0, v;
  if (s && s.endOnLap) close('ex-lap');
  initStep();
  i = n;
  if (rl > 0 && i == re) { rl--; if (rl) i = rs; }
  ld();
  if (s.type == 2) { // repeat marker
    rs = i + 1; re = rs + s.next; rl = s.count;
    i++; ld();
  }
  if (s.lap && !lg) { lg = 3; ol++; $.put('Activity/Trigger', 0); }
  if (s.type == 1) {
    v = s.view;
    if (tt(v) && !pg) {
      pg = 3; zPopupShown = 1; close('ex-lap');
      open('z-popup', true, 1, { TITLE: v.title || '', TEXT: v.text || '' });
    } else if (!pg && !lg && !bg) { bg = 3; playIndication('Interval'); }
  }
  initStep(s.type, s.target);
  unload('_cm');
}
return function (e, input, data) {
  var v;
  if (e == 128) { lg = 3; ol = 0; zPopupShown = 0; i = -1; }
  else if (e == 1) {
    if (lg > 0) lg--;
    if (pg > 0) pg--;
    if (bg > 0) bg--;
    if (i == -1) go();
  }
  else if (e == 16384) go();
  else if (e == 4) { lg = 3; if (ol > 0) ol--; else if (s && s.endOnLap) go(); }
  else if (e == 4096 && s && (s.type != 1 || tt(s.view))) {
    v = s.view;
    return v && v.length ? v : [v];
  }
};
`;
