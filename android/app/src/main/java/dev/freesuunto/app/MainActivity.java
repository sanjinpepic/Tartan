package dev.freesuunto.app;

import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins, registered before the bridge starts.
        registerPlugin(TartanHealthPlugin.class);
        registerPlugin(TartanWidgetPlugin.class);
        registerPlugin(TartanSpeechPlugin.class);
        registerPlugin(TartanModelHubPlugin.class);
        registerPlugin(TartanLocalNetworkPlugin.class);
        registerPlugin(TartanThemePlugin.class);
        // Tartan 2: the native bar and screens over the page (web/lib/shell.ts).
        registerPlugin(dev.freesuunto.app.shell.TartanShellPlugin.class);
        super.onCreate(savedInstanceState);
        WebView web = getBridge().getWebView();
        // An app, not a page: no stretch or glow at the ends (it moved the fixed bars), no web
        // scrollbars, no text selection on a long press outside text fields (the page decides that).
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        // Edge to edge, and the keyboard is the app's to handle: Android doesn't resize the window
        // for it (that jumped, showing the window's grey); the native screens follow its insets as
        // it slides, frame by frame. Under everything, the app's own surface, not the theme's grey.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        getWindow().setBackgroundDrawable(new ColorDrawable(dark ? 0xFF1A1110 : 0xFFFFF8F6));
    }

    /** Tartan 2: touches over a native screen go to it, though it sits under the page (TartanShellPlugin.routeTouch). */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        Boolean routed = dev.freesuunto.app.shell.TartanShellPlugin.route(ev);
        return routed != null ? routed : super.dispatchTouchEvent(ev);
    }
}
