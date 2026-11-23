import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// Today: the session, what it is, START to go. Down: the next days.
class HomeView extends WatchUi.View {
    function initialize() {
        View.initialize();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        dc.setColor(Look.BG, Look.BG);
        dc.clear();

        // Garmin's START hint: an arc by the start button (upper right).
        dc.setPenWidth(w / 40 + 2);
        dc.setColor(Look.accent(), Graphics.COLOR_TRANSPARENT);
        dc.drawArc(cx, h / 2, w / 2 - w / 80 - 2, Graphics.ARC_CLOCKWISE, 40, 20);

        var s = Plan.today();
        var head;
        var title;
        var sub;
        if (s != null) {
            head = "TODAY";
            title = s["title"] as String;
            sub = s["sum"] as String;
        } else if (!Plan.got()) {
            head = "TARTAN";
            title = "No plan yet";
            sub = Plan.status != null ? Plan.status as String : "Open Tartan on your phone";
        } else {
            head = "TODAY";
            title = "Rest day";
            sub = "START for a run anyway";
        }
        var said = app().said;
        if (said != null) {
            sub = said;
        }

        dc.setColor(Look.accent(), Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 18 / 100, Graphics.FONT_XTINY, head, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 36 / 100, Look.fit(dc, title, w * 84 / 100, [Graphics.FONT_LARGE, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL]), title, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 52 / 100, Look.fit(dc, sub, w * 86 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), sub, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // The main target: the first work step's (else the first step's), what to aim for.
        if (s != null) {
            var steps = s["steps"] as Array<Dictionary>;
            if (steps.size() > 0) {
                var main = steps[0];
                for (var i = 0; i < steps.size(); i++) {
                    if ("run".equals(steps[i]["k"])) {
                        main = steps[i];
                        break;
                    }
                }
                var line = Look.target(main);
                dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
                dc.drawText(cx, h * 65 / 100, Look.fit(dc, line, w * 80 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), line, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            }
        }

        // The next session, under a line.
        var next = Plan.coming();
        if (next.size() > 0) {
            dc.setColor(Look.DIM, Graphics.COLOR_TRANSPARENT);
            dc.setPenWidth(1);
            dc.drawLine(w * 30 / 100, h * 75 / 100, w * 70 / 100, h * 75 / 100);
            var n = Plan.weekday(next[0]["date"] as String) + "  " + (next[0]["title"] as String);
            dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h * 83 / 100, Look.fit(dc, n, w * 60 / 100, [Graphics.FONT_XTINY]), n, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        }
    }
}

class HomeDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    // START (or a tap): today's session; without one, a run without steps.
    function onSelect() as Boolean {
        app().said = null;
        var s = Plan.today();
        startRun(s);
        return true;
    }

    function onNextPage() as Boolean {
        var v = new WeekView();
        WatchUi.pushView(v, new WeekDelegate(v), WatchUi.SLIDE_UP);
        return true;
    }

    // The menu (hold UP): ask the phone again.
    function onMenu() as Boolean {
        Phone.ask();
        WatchUi.requestUpdate();
        return true;
    }
}

function startRun(s as Dictionary or Null) as Void {
    var r = new Run(s);
    app().run = r;
    var v = new RunView(r);
    WatchUi.pushView(v, new RunDelegate(r), WatchUi.SLIDE_LEFT);
}

// The coming days: one row each; UP and DOWN pick, START runs that one instead.
class WeekView extends WatchUi.View {
    var at as Number = 0;

    function initialize() {
        View.initialize();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        dc.setColor(Look.BG, Look.BG);
        dc.clear();
        var days = Plan.coming();
        dc.setColor(Look.accent(), Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 14 / 100, Graphics.FONT_XTINY, "COMING UP", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        if (days.size() == 0) {
            dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h / 2, Graphics.FONT_SMALL, "Nothing planned", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }
        if (at >= days.size()) {
            at = days.size() - 1;
        }
        // Up to five rows, the picked one in the middle when it can be.
        var rows = days.size() < 5 ? days.size() : 5;
        var first = at - 2;
        if (first > days.size() - rows) {
            first = days.size() - rows;
        }
        if (first < 0) {
            first = 0;
        }
        var rowH = h * 14 / 100;
        var top = h / 2 - (rows * rowH) / 2 + rowH / 2;
        for (var i = 0; i < rows; i++) {
            var d = days[first + i];
            var y = top + i * rowH;
            var picked = first + i == at;
            var text = Plan.weekday(d["date"] as String) + "  " + (d["title"] as String);
            if (picked) {
                dc.setColor(Look.accent(), Graphics.COLOR_TRANSPARENT);
                dc.fillRoundedRectangle(w * 12 / 100, y - rowH / 2 + 2, w * 76 / 100, rowH - 4, rowH / 2 - 2);
                dc.setColor(Look.BG, Graphics.COLOR_TRANSPARENT);
            } else {
                dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
            }
            dc.drawText(cx, y, Look.fit(dc, text, w * 70 / 100, [Graphics.FONT_SMALL, Graphics.FONT_XTINY]), text, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        }
        var sum = days[at]["sum"] as String;
        dc.setColor(Look.MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 88 / 100, Look.fit(dc, sum, w * 56 / 100, [Graphics.FONT_XTINY]), sum, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

class WeekDelegate extends WatchUi.BehaviorDelegate {
    var view as WeekView;

    function initialize(v as WeekView) {
        BehaviorDelegate.initialize();
        view = v;
    }

    function onNextPage() as Boolean {
        if (view.at < Plan.coming().size() - 1) {
            view.at++;
        }
        WatchUi.requestUpdate();
        return true;
    }

    function onPreviousPage() as Boolean {
        if (view.at > 0) {
            view.at--;
            WatchUi.requestUpdate();
        } else {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
        }
        return true;
    }

    function onSelect() as Boolean {
        var days = Plan.coming();
        if (days.size() > 0) {
            var s = days[view.at < days.size() ? view.at : 0];
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            startRun(s);
        }
        return true;
    }
}
