import Toybox.Activity;
import Toybox.ActivityRecording;
import Toybox.Attention;
import Toybox.Lang;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

// A guided run: the session's steps one after another, each ending by its time or distance
// (timer time, so a pause holds it) or by LAP, a lap at each change, a buzz and a screen saying
// what comes next. After the last step the run goes on until it's saved. Recorded with
// ActivityRecording, so it saves as a normal Garmin activity.
class Run {
    var session as Dictionary or Null;
    var steps as Array<Dictionary>;
    var at as Number = 0;
    var fromMs as Number = 0;
    var fromM as Float = 0.0;
    var rec as ActivityRecording.Session or Null = null;
    // The screen at a step change: its lines, and until when (System.getTimer()).
    var alert as Array<String> or Null = null;
    var alertUntil as Number = 0;
    // Pace from speed, smoothed (seconds per km), and the last readings.
    var speed as Float = 0.0;
    var hr as Number or Null = null;
    var power as Number or Null = null;
    var timerMs as Number = 0;
    var meters as Float = 0.0;
    var gps as Boolean = false;
    var tick as Timer.Timer;

    function initialize(s as Dictionary or Null) {
        session = s;
        steps = s != null ? s["steps"] as Array<Dictionary> : [] as Array<Dictionary>;
        tick = new Timer.Timer();
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));
        Sensor.setEnabledSensors([Sensor.SENSOR_HEARTRATE] as Array<Sensor.SensorType>);
        tick.start(method(:onTick), 1000, true);
    }

    function onPosition(info as Position.Info) as Void {
        gps = info.accuracy != null && info.accuracy >= Position.QUALITY_USABLE;
    }

    function started() as Boolean {
        return rec != null;
    }

    function recording() as Boolean {
        return rec != null && (rec as ActivityRecording.Session).isRecording();
    }

    function step() as Dictionary or Null {
        return at < steps.size() ? steps[at] : null;
    }

    function nextStep() as Dictionary or Null {
        return at + 1 < steps.size() ? steps[at + 1] : null;
    }

    function done() as Boolean {
        return at >= steps.size();
    }

    // The sport the session is in (export.ts sportOf): running unless the phone says otherwise.
    function sport() as Array<Number> {
        var sp = session != null ? session["sport"] : null;
        if ("cycling".equals(sp)) {
            return [Activity.SPORT_CYCLING, Activity.SUB_SPORT_GENERIC];
        }
        if ("strength".equals(sp)) {
            return [Activity.SPORT_TRAINING, Activity.SUB_SPORT_STRENGTH_TRAINING];
        }
        if ("other".equals(sp)) {
            return [Activity.SPORT_TRAINING, Activity.SUB_SPORT_CARDIO_TRAINING];
        }
        if ("swimming".equals(sp)) {
            return [Activity.SPORT_GENERIC, Activity.SUB_SPORT_GENERIC];
        }
        return [Activity.SPORT_RUNNING, Activity.SUB_SPORT_GENERIC];
    }

    // START: begin, or carry on after a pause.
    function start() as Void {
        if (rec == null) {
            var sp = sport();
            var name = session != null ? session["title"] as String : "Run";
            if (name.length() > 15) {
                name = name.substring(0, 15);
            }
            rec = ActivityRecording.createSession({ :name => name, :sport => sp[0] as Activity.Sport, :subSport => sp[1] as Activity.SubSport });
            (rec as ActivityRecording.Session).start();
            fromMs = 0;
            fromM = 0.0;
            if (steps.size() > 0) {
                announce(steps[0], false);
            }
        } else {
            (rec as ActivityRecording.Session).start();
        }
        buzz(1);
        WatchUi.requestUpdate();
    }

    function pause() as Void {
        if (recording()) {
            (rec as ActivityRecording.Session).stop();
            buzz(1);
        }
        WatchUi.requestUpdate();
    }

    // LAP: a lap, and on to the next step (as Garmin's own workouts do).
    function lap() as Void {
        if (!recording()) {
            return;
        }
        advance();
    }

    function advance() as Void {
        if (rec != null) {
            (rec as ActivityRecording.Session).addLap();
        }
        at++;
        fromMs = timerMs;
        fromM = meters;
        var s = step();
        if (s != null) {
            announce(s, true);
        } else if (steps.size() > 0) {
            alert = ["DONE", "Workout done", "Keep going, or STOP to save"];
            alertUntil = System.getTimer() + 5000;
            buzz(3);
        } else {
            alert = ["LAP", Look.clock(timerMs / 1000), ""];
            alertUntil = System.getTimer() + 2500;
            buzz(1);
        }
        WatchUi.requestUpdate();
    }

    function announce(s as Dictionary, vibrate as Boolean) as Void {
        var note = s["n"] as String or Null;
        alert = [(s["l"] as String).toUpper(), Look.length(s), note != null ? note : Look.target(s)];
        alertUntil = System.getTimer() + 4000;
        if (vibrate) {
            buzz(2);
        }
    }

    function buzz(times as Number) as Void {
        if (Attention has :vibrate) {
            var p = [] as Array<Attention.VibeProfile>;
            for (var i = 0; i < times; i++) {
                p.add(new Attention.VibeProfile(100, 350));
                p.add(new Attention.VibeProfile(0, 150));
            }
            Attention.vibrate(p);
        }
        if (Attention has :playTone && times > 1) {
            Attention.playTone(Attention.TONE_LAP);
        }
    }

    // How much of the step is left: [seconds or null, metres or null], and how far through (0..1).
    function left() as Array {
        var s = step();
        if (s == null) {
            return [null, null, 0.0];
        }
        if (s["t"] != null) {
            var total = (s["t"] as Number) * 1000;
            var gone = timerMs - fromMs;
            return [(total - gone + 999) / 1000, null, gone.toFloat() / total];
        }
        if (s["d"] != null) {
            var total = (s["d"] as Number).toFloat();
            var gone = meters - fromM;
            return [null, total - gone, gone / total];
        }
        return [null, null, 0.0];
    }

    // Pace in seconds per km, or null when standing.
    function pace() as Number or Null {
        return speed > 0.6 ? (1000.0 / speed).toNumber() : null;
    }

    // Against the step's target: -1 under it (too slow, heart rate low), 0 in it, 1 over it, null without one.
    function versus() as Number or Null {
        var s = step();
        if (s == null || !recording()) {
            return null;
        }
        var p = s["p"] as Array<Number> or Null;
        if (p != null) {
            var now = pace();
            return now == null ? null : now < p[0] ? 1 : now > p[1] ? -1 : 0;
        }
        var h = s["h"] as Array<Number> or Null;
        if (h != null && hr != null) {
            return hr < h[0] ? -1 : hr > h[1] ? 1 : 0;
        }
        var w = s["w"] as Array<Number> or Null;
        if (w != null && power != null) {
            return power < w[0] ? -1 : power > w[1] ? 1 : 0;
        }
        return null;
    }

    function onTick() as Void {
        var info = Activity.getActivityInfo();
        if (info != null) {
            timerMs = info.timerTime != null ? info.timerTime as Number : 0;
            meters = info.elapsedDistance != null ? (info.elapsedDistance as Float) : 0.0;
            hr = info.currentHeartRate;
            if (info has :currentPower) {
                power = info.currentPower;
            }
            var v = info.currentSpeed != null ? info.currentSpeed as Float : 0.0;
            speed = speed == 0.0 ? v : speed * 0.7 + v * 0.3;
        }
        Sample.fake(self);
        if (recording()) {
            var s = step();
            if (s != null) {
                if (s["t"] != null && timerMs - fromMs >= (s["t"] as Number) * 1000) {
                    advance();
                } else if (s["d"] != null && meters - fromM >= (s["d"] as Number)) {
                    advance();
                }
            }
        }
        if (alert != null && System.getTimer() > alertUntil) {
            alert = null;
        }
        WatchUi.requestUpdate();
    }

    function stopAll() as Void {
        tick.stop();
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
        Sensor.setEnabledSensors([] as Array<Sensor.SensorType>);
        app().run = null;
    }

    function save() as Void {
        if (rec != null) {
            var r = rec as ActivityRecording.Session;
            if (r.isRecording()) {
                r.stop();
            }
            r.save();
            rec = null;
        }
        stopAll();
        app().said = "Saved to Garmin Connect";
    }

    function discard() as Void {
        if (rec != null) {
            var r = rec as ActivityRecording.Session;
            if (r.isRecording()) {
                r.stop();
            }
            r.discard();
            rec = null;
        }
        stopAll();
        app().said = "Discarded";
    }

    // The app closed under a run: keep what was recorded.
    function saveIfStarted() as Void {
        if (rec != null) {
            save();
        } else {
            stopAll();
        }
    }
}
