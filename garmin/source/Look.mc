import Toybox.Graphics;
import Toybox.Lang;
import Toybox.System;

// Tartan on a watch: black, white, large numbers, one red. MIP screens (64 colours) get the
// palette's own red and green; AMOLED gets Tartan's finish red (DESIGN.md "finish") and good green.
(:glance)
module Look {
    const BG = Graphics.COLOR_BLACK;
    const INK = Graphics.COLOR_WHITE;
    const MUTED = 0xAAAAAA;
    const DIM = 0x555555;

    function amoled() as Boolean {
        var s = System.getDeviceSettings();
        return (s has :requiresBurnInProtection) && s.requiresBurnInProtection;
    }

    function accent() as Number {
        return amoled() ? 0xFF6A4D : 0xFF5500;
    }

    function good() as Number {
        return amoled() ? 0x7FD6A1 : 0x55FF55;
    }

    function statute() as Boolean {
        return System.getDeviceSettings().paceUnits == System.UNIT_STATUTE;
    }

    // 754 → "12:34", 3725 → "1:02:05".
    function clock(sec as Number) as String {
        if (sec < 0) {
            sec = 0;
        }
        var h = sec / 3600;
        var m = (sec % 3600) / 60;
        var s = sec % 60;
        return h > 0 ? Lang.format("$1$:$2$:$3$", [h, m.format("%02d"), s.format("%02d")]) : Lang.format("$1$:$2$", [m, s.format("%02d")]);
    }

    // A pace in seconds per km as the watch's units say it: "4:50" (per km or per mile).
    function pace(secPerKm as Numeric) as String {
        var s = statute() ? secPerKm * 1.609344 : secPerKm;
        return clock(s.toNumber());
    }

    function paceUnit() as String {
        return statute() ? "/mi" : "/km";
    }

    // Metres as a number and its unit: [ "800", "m" ], [ "1.25", "km" ], [ "0.50", "mi" ].
    function distance(m as Numeric) as Array<String> {
        if (statute()) {
            return [(m / 1609.344).format("%.2f"), "mi"];
        }
        if (m < 1000) {
            return [m.toNumber().toString(), "m"];
        }
        return [(m / 1000.0).format("%.2f"), "km"];
    }

    // A step's length in words: "10:00", "800 m".
    function length(step as Dictionary) as String {
        if (step["t"] != null) {
            return clock(step["t"] as Number);
        }
        if (step["d"] != null) {
            var d = distance(step["d"] as Number);
            return d[0] + " " + d[1];
        }
        return "";
    }

    // A step's target in words: "4:50-5:10 /km", "135-148 bpm", "200-240 W", or "Easy".
    function target(step as Dictionary) as String {
        var p = step["p"] as Array<Number> or Null;
        if (p != null) {
            return pace(p[0]) + "-" + pace(p[1]) + " " + paceUnit();
        }
        var h = step["h"] as Array<Number> or Null;
        if (h != null) {
            return h[0] + "-" + h[1] + " bpm";
        }
        var w = step["w"] as Array<Number> or Null;
        if (w != null) {
            return w[0] + "-" + w[1] + " W";
        }
        return "Easy";
    }

    // Text that fits a width: the font that fits, largest first.
    function fit(dc as Graphics.Dc, text as String, width as Number, fonts as Array<Graphics.FontType>) as Graphics.FontType {
        for (var i = 0; i < fonts.size(); i++) {
            if (dc.getTextWidthInPixels(text, fonts[i]) <= width) {
                return fonts[i];
            }
        }
        return fonts[fonts.size() - 1];
    }

    function upper(s as String) as String {
        return s.toUpper();
    }
}
