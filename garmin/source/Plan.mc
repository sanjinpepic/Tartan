import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.Time;
import Toybox.Time.Gregorian;
import Toybox.WatchUi;

// The plan the phone sent (src/workout/garmin.ts garminMessage): today's session and the next
// days', kept in Storage so a run works with the phone far away.
//
//   { "v": 1, "made": "2026-11-23",
//     "days": [ { "date": "2026-11-23", "title": "Intervals", "sport": "running", "sum": "6 x 800 m",
//                 "steps": [ { "k": "warmup", "l": "Warm up", "t": 600 },
//                            { "k": "run", "l": "Rep 1 of 6", "d": 800, "p": [230, 240], "n": "..." }, ... ] } ] }
//
// A step lasts "t" seconds or "d" metres; its target is "p" (pace, seconds per km, fast to slow),
// "h" (heart rate, bpm) or "w" (watts), or none (easy).
(:glance)
module Plan {
    const KEY = "plan";

    // What the home screen says about the phone ("Asking your phone", "Couldn't reach your phone").
    var status as String or Null = null;

    function all() as Array<Dictionary> {
        var p = Application.Storage.getValue(KEY);
        if (p instanceof Dictionary) {
            var d = (p as Dictionary)["days"];
            if (d instanceof Array) {
                return d as Array<Dictionary>;
            }
        }
        return [] as Array<Dictionary>;
    }

    function got() as Boolean {
        return Application.Storage.getValue(KEY) != null;
    }

    // Today as the phone writes dates: "2026-11-23".
    function todayKey() as String {
        var t = Gregorian.info(Time.now(), Time.FORMAT_SHORT);
        return Lang.format("$1$-$2$-$3$", [t.year, (t.month as Number).format("%02d"), t.day.format("%02d")]);
    }

    // Today's session, or null (a rest day, or nothing from the phone yet).
    function today() as Dictionary or Null {
        var key = todayKey();
        var days = all();
        for (var i = 0; i < days.size(); i++) {
            // Strings by value: == on objects compares references.
            if (key.equals(days[i]["date"])) {
                return days[i];
            }
        }
        return null;
    }

    // The sessions after today, in order.
    function coming() as Array<Dictionary> {
        var key = todayKey();
        var days = all();
        var out = [] as Array<Dictionary>;
        for (var i = 0; i < days.size(); i++) {
            var d = days[i]["date"] as String;
            if (d.compareTo(key) > 0) {
                out.add(days[i]);
            }
        }
        return out;
    }

    // "2026-11-24" → "TUE".
    function weekday(date as String) as String {
        var names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
        var m = Gregorian.moment({
            :year => date.substring(0, 4).toNumber(),
            :month => date.substring(5, 7).toNumber(),
            :day => date.substring(8, 10).toNumber(),
            :hour => 12,
        });
        var t = Gregorian.info(m, Time.FORMAT_SHORT);
        return names[(t.day_of_week as Number) - 1];
    }
}

// Taking the phone's message, and asking for it (only in the app, not the glance).
module Phone {
    function take(data as Object or Null) as Void {
        if (data instanceof Dictionary && (data as Dictionary)["days"] instanceof Array) {
            Application.Storage.setValue(Plan.KEY, data as Dictionary<String, Application.PropertyValueType>);
            Plan.status = null;
        }
        WatchUi.requestUpdate();
    }

    // Tartan on the phone answers with the plan (when it's open, or the next time it opens).
    function ask() as Void {
        Plan.status = Plan.got() ? null : "Asking your phone";
        try {
            Communications.transmit({ "t" => "want", "v" => 1 }, null, new AskListener());
        } catch (e) {
            Plan.status = null;
            Body.send(true);
        }
    }

    class AskListener extends Communications.ConnectionListener {
        function initialize() {
            ConnectionListener.initialize();
        }
        function onComplete() as Void {
            if (!Plan.got()) {
                Plan.status = "Open Tartan on your phone";
            }
            WatchUi.requestUpdate();
            // Then the day's numbers (one message at a time).
            Body.send(true);
        }
        function onError() as Void {
            if (!Plan.got()) {
                Plan.status = "No phone in reach";
            }
            WatchUi.requestUpdate();
        }
    }
}
