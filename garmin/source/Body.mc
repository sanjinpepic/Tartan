import Toybox.ActivityMonitor;
import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.Math;
import Toybox.SensorHistory;
import Toybox.Time;
import Toybox.Time.Gregorian;
import Toybox.UserProfile;

// The day's recovery and sleep numbers, read on the watch and sent to the phone, which keeps them
// in the engine's body signals as "garmin" (docs/signals.md, docs/garmin.md):
//
//   { "t": "day", "v": 1, "days": [ { "date": "2026-11-23", "energy": 64, "stress": 31,
//       "recovery_h": 18, "breathing_rate": 14.2, "resting_hr": 48, "vo2max": 54,
//       "night_hr_min": 44, "spo2_max": 98 } ] }
//
// The names and units are SignalValues' (src/signals.ts). A day is the morning it begins with: the
// night that ended that morning, Body Battery on waking, the day's stress so far. Only what this
// watch measured goes; nothing is guessed. Connect IQ gives a watch app no sleep stages, HRV,
// sleep score or actual bed and wake times, so those never go (the sleep score is a complication,
// which only watch faces may read; UserProfile's sleep and wake times are the athlete's schedule,
// used here only to know roughly when the night was).
//
// Read by the background service (Service.mc) about every 30 minutes, and in the app when it opens
// and when the phone asks. Small on purpose: the background has 32 KB on the oldest watches.
(:background)
module Body {
    const KEY = "body";
    // How often the background service runs (Garmin's least is 5 minutes).
    const EVERY = 1800;
    // A day that didn't change is sent again after this long (the phone may have been closed).
    const RESEND = 7200;
    // The fields, in a fixed order (for telling whether anything changed).
    const FIELDS = ["energy", "stress", "recovery_h", "breathing_rate", "resting_hr", "vo2max", "night_hr_min", "spo2_max"];

    // "2026-11-23" for a moment, in local time.
    function dateOf(m as Time.Moment) as String {
        var t = Gregorian.info(m, Time.FORMAT_SHORT);
        return Lang.format("$1$-$2$-$3$", [t.year, (t.month as Number).format("%02d"), (t.day as Number).format("%02d")]);
    }

    function load() as Dictionary {
        var s = Application.Storage.getValue(KEY);
        return s instanceof Dictionary ? s as Dictionary : {};
    }

    function save(s as Dictionary) as Void {
        try {
            Application.Storage.setValue(KEY, s as Dictionary<String, Application.PropertyValueType>);
        } catch (e) {
        }
    }

    // A whole number in a range, or null.
    function num(v, lo as Number, hi as Number) as Number or Null {
        if (v instanceof Number || v instanceof Float || v instanceof Long || v instanceof Double) {
            var n = v.toNumber();
            return n >= lo && n <= hi ? n : null;
        }
        return null;
    }

    // The highest (or lowest) sample between two times (seconds), newest first, or null.
    function extreme(it as SensorHistory.SensorHistoryIterator, from as Number, to as Number, high as Boolean) as Number or Null {
        var best = null;
        for (var s = it.next(); s != null; s = it.next()) {
            var t = s.when.value();
            if (t < from) {
                break;
            }
            var v = s.data;
            if (t <= to && v != null && v > 0) {
                var n = v.toNumber();
                if (best == null || (high ? n > best : n < best)) {
                    best = n;
                }
            }
        }
        return best;
    }

    // The average stress (0 to 100) between two times, or null with fewer than 5 readings.
    function stress(from as Number, to as Number, now as Number) as Number or Null {
        if (!(SensorHistory has :getStressHistory)) {
            return null;
        }
        var it = SensorHistory.getStressHistory({ :period => new Time.Duration(now - from + 60), :order => SensorHistory.ORDER_NEWEST_FIRST });
        var sum = 0;
        var n = 0;
        for (var s = it.next(); s != null; s = it.next()) {
            var t = s.when.value();
            if (t < from) {
                break;
            }
            var v = s.data;
            if (t < to && v != null && v >= 0 && v <= 100) {
                sum += v.toNumber();
                n++;
            }
        }
        return n >= 5 ? Math.round(sum.toFloat() / n).toNumber() : null;
    }

    // Folds one reading into the night's record: the lowest or highest so far.
    function fold(n as Dictionary, k as String, v as Number or Null, high as Boolean) as Void {
        if (v == null) {
            return;
        }
        var was = n[k];
        if (was == null || (high ? v > (was as Number) : v < (was as Number))) {
            n[k] = v;
        }
    }

    // Reads the day's numbers into storage. A new day keeps yesterday's last numbers to send once more.
    function collect() as Dictionary {
        var s = load();
        var now = Time.now().value();
        var midnight = Time.today().value();
        var today = dateOf(Time.now());
        var cur = s["cur"];
        if (!(cur instanceof Dictionary) || !today.equals((cur as Dictionary)["date"])) {
            s.remove("prev");
            var prev = cur instanceof Dictionary ? cur as Dictionary : null;
            if (prev != null && dateOf(new Time.Moment(midnight - 43200)).equals(prev["date"])) {
                // Yesterday's stress over the whole day, when the history still has it.
                var all = stress(midnight - 86400, midnight, now);
                if (all != null) {
                    prev["stress"] = all;
                }
                s["prev"] = prev;
                s["ps"] = false;
            }
            cur = { "date" => today };
        }
        var day = cur as Dictionary;

        // The night, from the athlete's usual bed and wake times (Garmin's sleep settings): only
        // where to look in the history, never sent.
        var p = UserProfile.getProfile();
        var bedAt = p.sleepTime != null ? (p.sleepTime as Time.Duration).value() % 86400 : 22 * 3600;
        var wakeAt = p.wakeTime != null ? (p.wakeTime as Time.Duration).value() % 86400 : 7 * 3600;
        var wake = midnight + wakeAt;
        var bed = bedAt < wakeAt ? midnight + bedAt : midnight - 86400 + bedAt;
        // Which morning the night is for: this one until 3 hours after waking, then tonight's (tomorrow's).
        var morning = today;
        if (now >= wake + 3 * 3600) {
            if (now >= bed + 86400 - 3600) {
                bed += 86400;
                wake += 86400;
                morning = dateOf(new Time.Moment(wake));
            } else {
                morning = null;
            }
        }
        var night = s["n"] instanceof Dictionary ? s["n"] as Dictionary : {};
        if (morning != null) {
            if (!morning.equals(night["m"])) {
                night = { "m" => morning };
            }
            var from = bed - 3600;
            var dur = new Time.Duration(now - from + 60);
            // Lowest heart rate and highest blood oxygen in the night, Body Battery at its peak by
            // the morning (it charges in sleep and drains once up: the peak is the value on waking).
            if (now > from) {
                if (SensorHistory has :getHeartRateHistory) {
                    fold(night, "hr", extreme(SensorHistory.getHeartRateHistory({ :period => dur, :order => SensorHistory.ORDER_NEWEST_FIRST }), from, wake + 3600, false), false);
                }
                if (SensorHistory has :getOxygenSaturationHistory) {
                    fold(night, "o2", extreme(SensorHistory.getOxygenSaturationHistory({ :period => dur, :order => SensorHistory.ORDER_NEWEST_FIRST }), from, wake + 3600, true), true);
                }
                if (SensorHistory has :getBodyBatteryHistory) {
                    fold(night, "bb", extreme(SensorHistory.getBodyBatteryHistory({ :period => dur, :order => SensorHistory.ORDER_NEWEST_FIRST }), bed, wake + 3 * 3600, true), true);
                }
            }
            // While asleep: breathing, a reading now (API 3.3 on), averaged over the night's readings.
            var info = ActivityMonitor.getInfo();
            if (now >= bed && now < wake && info has :respirationRate) {
                var rr = num(info.respirationRate, 3, 60);
                if (rr != null) {
                    night["rs"] = (night["rs"] != null ? night["rs"] as Number : 0) + rr;
                    night["rn"] = (night["rn"] != null ? night["rn"] as Number : 0) + 1;
                }
            }
            s["n"] = night;
        }

        // The morning's numbers, once it's morning (an hour before the usual wake time on).
        if (today.equals(night["m"]) && now >= wake - 3600) {
            var v = num(night["bb"], 0, 100);
            if (v != null) {
                day["energy"] = v;
            }
            v = num(night["hr"], 20, 200);
            if (v != null) {
                day["night_hr_min"] = v;
            }
            v = num(night["o2"], 50, 100);
            if (v != null) {
                day["spo2_max"] = v;
            }
            if (night["rn"] != null && (night["rn"] as Number) >= 2) {
                day["breathing_rate"] = Math.round((night["rs"] as Number).toFloat() * 10 / (night["rn"] as Number)) / 10.0;
            }
            // Recovery time (API 3.3 on, whole hours) as it stood in the morning: the first reading
            // in the 4 hours from the usual wake time, kept for the day (a run later is tomorrow's).
            var info = ActivityMonitor.getInfo();
            if (day["recovery_h"] == null && now >= wake && now < wake + 4 * 3600 && info has :timeToRecovery) {
                v = num(info.timeToRecovery, 0, 240);
                if (v != null) {
                    day["recovery_h"] = v;
                }
            }
            v = num(p.restingHeartRate, 20, 200);
            if (v != null) {
                day["resting_hr"] = v;
            }
        }
        // VO2 max for running (API 3.3 on), as of today.
        var vo2 = p has :vo2maxRunning ? num(p.vo2maxRunning, 10, 100) : null;
        if (vo2 != null) {
            day["vo2max"] = vo2;
        }
        var st = stress(midnight, now + 60, now);
        if (st != null) {
            day["stress"] = st;
        }
        s["cur"] = day;
        save(s);
        return s;
    }

    // What a day holds, as text (to tell whether it changed since it was sent).
    function keyOf(d as Dictionary) as String {
        var k = d["date"] as String;
        for (var i = 0; i < FIELDS.size(); i++) {
            k += "," + d[FIELDS[i]];
        }
        return k;
    }

    // Reads the numbers and sends them: today's when they changed (or weren't sent for a while, or
    // `all`), and yesterday's last ones until they've gone once. True when a message went.
    function send(all as Boolean) as Boolean {
        var s = collect();
        var days = [] as Array<Dictionary>;
        var cur = s["cur"] as Dictionary;
        var key = keyOf(cur);
        var sentAt = s["sa"] != null ? s["sa"] as Number : 0;
        if (cur.size() > 1 && (all || !key.equals(s["sk"]) || Time.now().value() - sentAt > RESEND)) {
            days.add(cur);
        }
        var prev = s["prev"];
        var withPrev = prev instanceof Dictionary && (prev as Dictionary).size() > 1 && (all || s["ps"] != true);
        if (withPrev) {
            days.add(prev as Dictionary);
        }
        if (days.size() == 0) {
            return false;
        }
        try {
            Communications.transmit({ "t" => "day", "v" => 1, "days" => days }, null, new Sent(days[0] == cur ? key : null, withPrev));
            return true;
        } catch (e) {
            return false;
        }
    }

    // Each half hour in the background, from now on (it stays registered when the app closes).
    function start() as Void {
        try {
            Background.registerForTemporalEvent(new Time.Duration(EVERY));
        } catch (e) {
        }
    }

    // How a send went: when the phone got it, remember what went. Ends the background run either way.
    class Sent extends Communications.ConnectionListener {
        var key as String or Null;
        var prev as Boolean;

        function initialize(k as String or Null, p as Boolean) {
            ConnectionListener.initialize();
            key = k;
            prev = p;
        }

        function onComplete() as Void {
            var s = load();
            if (key != null) {
                s["sk"] = key;
                s["sa"] = Time.now().value();
            }
            if (prev) {
                s["ps"] = true;
            }
            save(s);
            Background.exit(null);
        }

        function onError() as Void {
            Background.exit(null);
        }
    }
}
