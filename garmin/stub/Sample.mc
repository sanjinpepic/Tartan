import Toybox.Lang;

// The real app: no sample plan, nothing driven (screens/Sample.mc is the screenshot build's).
module Sample {
    // False: the real plan, from the phone.
    function seed() as Boolean {
        return false;
    }
    function fake(r as Run) as Void {}
}
