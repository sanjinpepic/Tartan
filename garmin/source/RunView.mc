import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// The run's screen: the step, what's left of it (large), the target, pace and heart rate, and a
// ring round the edge filling through the step. A step change takes the whole screen for a moment.
class RunView extends WatchUi.View {
    var run as Run;

    function initialize(r as Run) {
        View.initialize();
        run = r;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        var accent = Look.accent();
        var a = run.alert;
        if (a != null) {
            alertScreen(dc, a as Array<String>);
            return;
        }
        dc.setColor(Look.BG, Look.BG);
        dc.clear();

        var s = run.step();
        var left = run.left();

        // The ring: how far through the step.
        if (s != null && run.started()) {
            var share = left[2] as Float;
            share = share < 0.0 ? 0.0 : share > 1.0 ? 1.0 : share;
            var pen = w / 30 + 2;
            var r = w / 2 - pen / 2 - 1;
            dc.setPenWidth(pen);
            dc.setColor(Look.DIM, Graphics.COLOR_TRANSPARENT);
            dc.drawCircle(cx, h / 2, r);
            if (share > 0.005) {
                dc.setColor(accent, Graphics.COLOR_TRANSPARENT);
                var end = 90 - (share * 360).toNumber();
                dc.drawArc(cx, h / 2, r, Graphics.ARC_CLOCKWISE, 90, end < -269 ? -269 : end);
            }
        }

        // The step's name (or the state).
        var label;
        if (!run.started()) {
            label = run.gps ? "GPS READY" : "GPS...";
        } else if (!run.recording()) {
            label = "PAUSED";
        } else if (s != null) {
            label = (s["l"] as String).toUpper();
        } else {
            label = run.steps.size() > 0 ? "WORKOUT DONE" : "RUN";
        }
        dc.setColor(run.started() || run.gps ? accent : Look.MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 17 / 100, Look.fit(dc, label, w * 62 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), label, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // The big number: what's left of the step, else the run's time.
        var big;
        var unit = "";
        if (!run.started()) {
            big = s != null ? Look.length(s) : "0:00";
            if (s != null && s["d"] != null) {
                var d = Look.distance(s["d"] as Number);
                big = d[0];
                unit = d[1];
            }
        } else if (left[0] != null) {
            big = Look.clock(left[0] as Number);
        } else if (left[1] != null) {
            var d = Look.distance(left[1] as Float);
            big = d[0];
            unit = d[1];
        } else {
            big = Look.clock(run.timerMs / 1000);
        }
        var bigFont = Look.fit(dc, big, w * 70 / 100, [Graphics.FONT_NUMBER_HOT, Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_NUMBER_MILD]);
        dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 36 / 100, bigFont, big, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        if (!unit.equals("")) {
            var bw = dc.getTextWidthInPixels(big, bigFont);
            dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx + bw / 2 + 3, h * 40 / 100, Graphics.FONT_XTINY, unit, Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
        }

        // The target: green in it, red out of it (with which way), grey without one.
        var target = s != null ? Look.target(s) : run.started() ? Look.distance(run.meters)[0] + " " + Look.distance(run.meters)[1] : "START to go";
        var vs = run.versus();
        var colour = vs == null ? Look.MUTED : vs == 0 ? Look.good() : accent;
        if (vs != null && vs != 0 && s != null && (s["p"] != null || s["w"] != null)) {
            target = (vs > 0 ? "EASE OFF  " : "SPEED UP  ") + target;
        } else if (vs != null && vs != 0 && s != null && s["h"] != null) {
            target = (vs > 0 ? "EASE OFF  " : "A BIT MORE  ") + target;
        }
        dc.setColor(colour, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 53 / 100, Look.fit(dc, target, w * 84 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), target, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // Pace and heart rate, side by side.
        dc.setColor(Look.DIM, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(1);
        dc.drawLine(w * 14 / 100, h * 61 / 100, w * 86 / 100, h * 61 / 100);
        dc.drawLine(cx, h * 63 / 100, cx, h * 82 / 100);
        var p = run.pace();
        var paceText = p != null ? Look.pace(p) : "--:--";
        var hrText = run.hr != null ? (run.hr as Number).toString() : "--";
        var fieldFont = Look.fit(dc, paceText, w * 30 / 100, [Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_NUMBER_MILD, Graphics.FONT_MEDIUM]);
        dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w * 31 / 100, h * 70 / 100, fieldFont, paceText, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.drawText(w * 69 / 100, h * 70 / 100, fieldFont, hrText, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w * 31 / 100, h * 80 / 100, Graphics.FONT_XTINY, "PACE", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.drawText(w * 69 / 100, h * 80 / 100, Graphics.FONT_XTINY, "HR", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // What comes next (or the run's time once the steps are done).
        // The round edge leaves little room at the foot: the label alone when its length won't fit.
        var n = run.nextStep();
        var foot = Look.clock(run.timerMs / 1000);
        if (n != null) {
            foot = "Next " + (n["l"] as String) + " " + Look.length(n);
            if (dc.getTextWidthInPixels(foot, Graphics.FONT_XTINY) > w * 54 / 100) {
                foot = "Next " + (n["l"] as String);
            }
        }
        dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 88 / 100, Graphics.FONT_XTINY, foot, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // The step change: the whole screen red, what it is, how long, the target.
    function alertScreen(dc as Graphics.Dc, a as Array<String>) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        dc.setColor(Look.accent(), Look.accent());
        dc.clear();
        dc.setColor(Look.BG, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 30 / 100, Look.fit(dc, a[0], w * 80 / 100, [Graphics.FONT_MEDIUM, Graphics.FONT_SMALL, Graphics.FONT_XTINY]), a[0], Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 50 / 100, Look.fit(dc, a[1], w * 84 / 100, [Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_LARGE, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL]), a[1], Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Look.BG, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 70 / 100, Look.fit(dc, a[2], w * 80 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), a[2], Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

// The buttons, as in Garmin's own activities: START starts and pauses (paused: Resume, Save,
// Discard), BACK/LAP takes a lap and moves to the next step, BACK before the start leaves.
// Taps and swipes do nothing while running, so a sleeve can't pause or skip.
class RunDelegate extends WatchUi.BehaviorDelegate {
    var run as Run;

    function initialize(r as Run) {
        BehaviorDelegate.initialize();
        run = r;
    }

    function onKey(e as WatchUi.KeyEvent) as Boolean {
        var k = e.getKey();
        if (k == WatchUi.KEY_ENTER) {
            if (!run.started()) {
                run.start();
            } else if (run.recording()) {
                run.pause();
                pauseMenu(run);
            } else {
                pauseMenu(run);
            }
            return true;
        }
        if (k == WatchUi.KEY_ESC || k == WatchUi.KEY_LAP) {
            if (!run.started()) {
                run.stopAll();
                WatchUi.popView(WatchUi.SLIDE_RIGHT);
            } else if (run.recording()) {
                run.lap();
            } else {
                pauseMenu(run);
            }
            return true;
        }
        return false;
    }

    // The behaviours fall through to onKey (buttons) or are ignored (touch).
    function onSelect() as Boolean {
        return false;
    }

    function onBack() as Boolean {
        return false;
    }

    function onTap(e as WatchUi.ClickEvent) as Boolean {
        return true;
    }

    function onSwipe(e as WatchUi.SwipeEvent) as Boolean {
        return true;
    }

    function onNextPage() as Boolean {
        return true;
    }

    function onPreviousPage() as Boolean {
        return true;
    }
}

function pauseMenu(run as Run) as Void {
    var m = new WatchUi.Menu2({ :title => "Paused" });
    m.addItem(new WatchUi.MenuItem("Resume", null, :resume, null));
    m.addItem(new WatchUi.MenuItem("Save", null, :save, null));
    m.addItem(new WatchUi.MenuItem("Discard", null, :discard, null));
    WatchUi.pushView(m, new PauseDelegate(run), WatchUi.SLIDE_UP);
}

class PauseDelegate extends WatchUi.Menu2InputDelegate {
    var run as Run;

    function initialize(r as Run) {
        Menu2InputDelegate.initialize();
        run = r;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        if (id == :resume) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            run.start();
        } else if (id == :save) {
            run.save();
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            WatchUi.popView(WatchUi.SLIDE_RIGHT);
        } else if (id == :discard) {
            var m = new WatchUi.Menu2({ :title => "Discard run?" });
            m.addItem(new WatchUi.MenuItem("Yes, discard", null, :yes, null));
            m.addItem(new WatchUi.MenuItem("No", null, :no, null));
            WatchUi.pushView(m, new DiscardDelegate(run), WatchUi.SLIDE_UP);
        }
    }

    // BACK in the menu: still paused, back on the run's screen.
    function onBack() as Void {
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}

class DiscardDelegate extends WatchUi.Menu2InputDelegate {
    var run as Run;

    function initialize(r as Run) {
        Menu2InputDelegate.initialize();
        run = r;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (item.getId() == :yes) {
            run.discard();
            // This menu, the pause menu, the run's screen.
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            WatchUi.popView(WatchUi.SLIDE_RIGHT);
        } else {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
        }
    }

    function onBack() as Void {
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
