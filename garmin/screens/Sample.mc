import Toybox.Application;
import Toybox.Lang;
import Toybox.Time;
import Toybox.Time.Gregorian;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

// The screenshot build only (screens.jungle): a sample week, then the app drives itself through
// home (0 to 10 s), the run before START (10 to 20 s), a step change (20 to 30 s) and the run
// (from 30 s), with made-up readings, so the simulator can be photographed at each.
module Sample {
    var driver as Driver or Null = null;

    function day(offset as Number) as String {
        var t = Gregorian.info(Time.today().add(new Time.Duration(offset * 86400)), Time.FORMAT_SHORT);
        return Lang.format("$1$-$2$-$3$", [t.year, (t.month as Number).format("%02d"), t.day.format("%02d")]);
    }

    function seed() as Boolean {
        var steps = [{ "k" => "warmup", "l" => "Warm up", "t" => 900, "h" => [120, 140] }];
        for (var i = 1; i <= 6; i++) {
            steps.add({ "k" => "run", "l" => "Rep " + i + " of 6", "d" => 800, "p" => [230, 240] });
            steps.add({ "k" => "recover", "l" => "Recover", "t" => 90 });
        }
        steps.add({ "k" => "cooldown", "l" => "Cool down", "t" => 600 });
        Application.Storage.setValue("plan", {
            "v" => 1, "made" => day(0),
            "days" => [
                { "date" => day(0), "title" => "Intervals", "sport" => "running", "sum" => "6 x 800 m", "steps" => steps },
                { "date" => day(1), "title" => "Easy Run", "sport" => "running", "sum" => "45 min", "steps" => [{ "k" => "run", "l" => "Run", "t" => 2700, "h" => [135, 148] }] },
                { "date" => day(3), "title" => "Tempo", "sport" => "running", "sum" => "3 x 10 min", "steps" => [{ "k" => "run", "l" => "Run", "t" => 600, "p" => [265, 275] }] },
                { "date" => day(5), "title" => "Long Run", "sport" => "running", "sum" => "1 h 30 min", "steps" => [{ "k" => "run", "l" => "Run", "t" => 5400, "h" => [130, 145] }] },
            ],
        });
        driver = new Driver();
        return true;
    }

    // Readings for the pictures: 4:05 /km, 162 bpm, the rep a third done.
    // Held still, so each phase is one picture.
    function fake(r as Run) as Void {
        r.hr = 162;
        r.speed = 1000.0 / 245.0;
        r.gps = true;
        if (r.started()) {
            r.timerMs = 1154000;
        }
        if (r.started() && r.at == 1) {
            r.meters = r.fromM + 270.0;
        }
    }

    class Driver {
        var n as Number = 0;
        var timer as Timer.Timer;

        function initialize() {
            timer = new Timer.Timer();
            timer.start(method(:tick), 1000, true);
        }

        function tick() as Void {
            n++;
            if (n == 10) {
                startRun(Plan.today());
            } else if (n == 20) {
                var r = app().run;
                if (r != null) {
                    r.start();
                    // Straight to the first rep: its screen, held for the picture.
                    r.advance();
                    r.alertUntil = System.getTimer() + 10000;
                }
            } else if (n > 60) {
                timer.stop();
            }
        }
    }
}
