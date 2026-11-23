import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;

// The background service: every half hour it reads the day's numbers and sends them to the phone
// when they changed (Body.mc). It runs whether the app is open or not; Garmin ends it after 30
// seconds, and it ends itself as soon as the send is answered.
(:background)
class Service extends System.ServiceDelegate {
    function initialize() {
        ServiceDelegate.initialize();
    }

    function onTemporalEvent() as Void {
        if (!Body.send(false)) {
            Background.exit(null);
        }
    }

    // A message from the phone while the app is closed (watches with 64 KB for the background:
    // monkey.jungle leaves this out on the 32 KB ones, where messages wait for the app to open).
    // "ask": send the day now (Tartan just opened on the phone). The plan: kept, as the app would.
    (:phoneInBackground)
    function onPhoneAppMessage(msg as Communications.PhoneAppMessage) as Void {
        var data = msg.data;
        if (data instanceof Dictionary) {
            var d = data as Dictionary;
            if ("ask".equals(d["t"])) {
                if (Body.send(true)) {
                    return;
                }
            } else if (d["days"] instanceof Array) {
                try {
                    Application.Storage.setValue("plan", d as Dictionary<String, Application.PropertyValueType>);
                } catch (e) {
                }
            }
        }
        Background.exit(null);
    }
}
