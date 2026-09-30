package com.toursjelle.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/** The audio tour web app in a full-screen WebView, with location, autoplaying audio and the screen kept on. */
public class MainActivity extends Activity {
    private static final int LOCATION_REQUEST = 1;
    private WebView web;
    private String geoOrigin;
    private GeolocationPermissions.Callback geoCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); // riders look at the map, not the lock screen
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // stories and turn prompts play when you arrive
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                Uri home = Uri.parse(url());
                if (u.getHost() != null && u.getHost().equals(home.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // Google Maps, sources and shares open outside
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    cb.invoke(origin, true, false);
                    return;
                }
                geoOrigin = origin;
                geoCallback = cb;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
            }
        });
        if (state != null) web.restoreState(state);
        else if (url().isEmpty()) askUrl();
        else web.loadUrl(url());
    }

    private String url() {
        String saved = getSharedPreferences("app", MODE_PRIVATE).getString("url", "");
        return saved.isEmpty() ? BuildConfig.TOUR_URL : saved;
    }

    /** Only when the APK was built without a web address: ask for it once. */
    private void askUrl() {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("https://your-app.up.railway.app");
        new AlertDialog.Builder(this)
            .setTitle("Web address of the tour app")
            .setView(field)
            .setCancelable(false)
            .setPositiveButton("Open", (d, w) -> {
                String u = field.getText().toString().trim();
                if (!u.startsWith("http")) u = "https://" + u;
                SharedPreferences.Editor e = getSharedPreferences("app", MODE_PRIVATE).edit();
                e.putString("url", u).apply();
                web.loadUrl(u);
            })
            .show();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != LOCATION_REQUEST || geoCallback == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        geoCallback.invoke(geoOrigin, ok, false);
        geoCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); // the app's own screens use browser history
        else super.onBackPressed();
    }
}
