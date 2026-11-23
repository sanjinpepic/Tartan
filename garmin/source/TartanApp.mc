import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.System;
import Toybox.WatchUi;

// Tartan on a Garmin: today's session from the phone (and the next days'), guided step by step
// and recorded as a normal Garmin activity, which reaches Tartan the way any Garmin run does. The
// day's recovery and sleep numbers go the other way (Body.mc), from a background service.
(:background :glance)
class TartanApp extends Application.AppBase {
    // A run in progress: saved if the app is closed under it, so a run is never lost.
    var run as Run or Null = null;
    // A line for the home screen after a run ("Saved", "Discarded").
    var said as String or Null = null;

    function initialize() {
        AppBase.initialize();
    }

    // Also called when a background run ends: there's never a run there.
    (:typecheck(disableBackgroundCheck))
    function onStop(state as Dictionary or Null) as Void {
        if (run != null) {
            (run as Run).saveIfStarted();
        }
    }

    (:typecheck(disableBackgroundCheck))
    function getInitialView() as [WatchUi.Views] or [WatchUi.Views, WatchUi.InputDelegates] {
        Communications.registerForPhoneAppMessages(method(:onPhone));
        // The screenshot build has its own plan and no phone to ask.
        if (!Sample.seed()) {
            // The day's numbers every half hour from now on, and right after asking for the plan.
            Body.start();
            listenInBackground();
            Phone.ask();
        }
        var v = new HomeView();
        return [v, new HomeDelegate()];
    }

    // Not in the screenshot build (screens.jungle), which opens straight into the app.
    (:glance :withGlance)
    function getGlanceView() as [WatchUi.GlanceView] or [WatchUi.GlanceView, WatchUi.GlanceViewDelegate] or Null {
        return [new TartanGlance()];
    }

    // The background service (Service.mc): the day's numbers to the phone.
    function getServiceDelegate() as [System.ServiceDelegate] {
        return [new Service()];
    }

    // The phone's messages wake the background service while the app is closed (an "ask" sends the
    // day at once), where the background has room for a plan: 64 KB (monkey.jungle).
    (:phoneInBackground)
    function listenInBackground() as Void {
        try {
            Background.registerForPhoneAppMessageEvent();
        } catch (e) {
        }
    }
    // The 32 KB ones: the phone's messages wait for the app to open, as before.
    (:phoneInAppOnly)
    function listenInBackground() as Void {}

    (:typecheck(disableBackgroundCheck))
    function onPhone(msg as Communications.PhoneAppMessage) as Void {
        var d = msg.data;
        if (d instanceof Dictionary && "ask".equals((d as Dictionary)["t"])) {
            Body.send(true);
            return;
        }
        Phone.take(d);
    }
}

function app() as TartanApp {
    return Application.getApp() as TartanApp;
}

// The glance: today's session in a line, or the next one.
(:glance)
class TartanGlance extends WatchUi.GlanceView {
    function initialize() {
        GlanceView.initialize();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Look.accent(), Graphics.COLOR_TRANSPARENT);
        dc.drawText(0, h / 4, Graphics.FONT_GLANCE, "TARTAN", Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
        var s = Plan.today();
        var line;
        if (s != null) {
            line = (s["title"] as String) + "  " + (s["sum"] as String);
        } else if (!Plan.got()) {
            line = "Open Tartan on the phone";
        } else {
            var next = Plan.coming();
            line = next.size() > 0 ? "Rest. " + Plan.weekday(next[0]["date"] as String) + " " + (next[0]["title"] as String) : "Rest day";
        }
        dc.setColor(Look.INK, Graphics.COLOR_TRANSPARENT);
        // The glance's right end runs under the round edge: the line keeps clear of it.
        dc.drawText(0, h * 3 / 4, Look.fit(dc, line, w * 82 / 100, [Graphics.FONT_GLANCE, Graphics.FONT_XTINY]), line, Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}
