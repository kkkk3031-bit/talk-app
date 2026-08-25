package com.khaled.talkapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    // Live Cloudflare quick tunnel to the sandbox's server — ephemeral, dies on
    // sandbox/tunnel restart. Re-check the current URL before rebuilding.
    private static final String SERVER_URL = "https://generated-container-tips-cherry.trycloudflare.com";
    private static final String VERSION_MANIFEST_PATH = "/apk-version.json";

    private WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean updateCheckPendingAfterSettings = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);

        webView = new WebView(this);
        setContentView(webView);
        WebView.setWebContentsDebuggingEnabled(true); // debug build only — lets chrome://inspect attach for diagnosing WebView-only bugs

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // lets the page's JS tell "running inside our WebView" apart from a real mobile
        // browser (e.g. to give Android-Settings guidance instead of browser-address-bar
        // guidance when mic access is blocked)
        settings.setUserAgentString(settings.getUserAgentString() + " TalkAppAndroid/1");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        request.deny();
                        // the OS permission was denied (once, or permanently via "don't ask
                        // again") — there's otherwise no way back into the request flow, so
                        // offer a direct path to the app's Settings page where the user can
                        // flip the Microphone toggle themselves
                        showMicBlockedDialog();
                    }
                });
            }
        });

        webView.loadUrl(SERVER_URL);

        checkForUpdate();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updateCheckPendingAfterSettings) {
            updateCheckPendingAfterSettings = false;
            checkForUpdate();
        }
    }

    private boolean micBlockedDialogShowing = false;
    private void showMicBlockedDialog() {
        if (micBlockedDialogShowing || isFinishing()) return;
        micBlockedDialogShowing = true;
        new AlertDialog.Builder(this)
                .setTitle("Microphone blocked")
                .setMessage("talk-app needs microphone access for voice chat, but it's currently turned off. Open Settings, tap Permissions, and allow Microphone.")
                .setPositiveButton("Open Settings", (dialog, which) -> {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", getPackageName(), null));
                    startActivity(intent);
                })
                .setNegativeButton("Cancel", null)
                .setOnDismissListener(dialog -> micBlockedDialogShowing = false)
                .show();
    }

    @SuppressWarnings("deprecation") // getPackageInfo(int).versionCode — minSdk 26 doesn't have the long-code accessor
    private int currentVersionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return Integer.MAX_VALUE; // can't identify our own version — don't offer to "update" over it
        }
    }

    // Runs on every launch: fetch the version manifest the server exposes at
    // /apk-version.json, and if it's newer than what's installed, download and
    // launch the system installer automatically — no in-app prompt, per the
    // "push the update straight through" requirement. The OS install-confirm
    // screen is unavoidable (Android doesn't allow silent self-update outside
    // Play/enterprise device-owner setups) but everything up to that point is automatic.
    private void checkForUpdate() {
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                URL url = new URL(SERVER_URL + VERSION_MANIFEST_PATH);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                InputStream in = conn.getInputStream();
                byte[] bytes = readAll(in);
                in.close();
                conn.disconnect();

                JSONObject manifest = new JSONObject(new String(bytes, "UTF-8"));
                int remoteVersionCode = manifest.getInt("versionCode");
                String remoteVersionName = manifest.optString("versionName", "?");
                String apkPath = manifest.getString("url");
                String apkUrl = apkPath.startsWith("http") ? apkPath : SERVER_URL + apkPath;

                if (remoteVersionCode > currentVersionCode()) {
                    mainHandler.post(() -> beginUpdate(apkUrl, remoteVersionName));
                }
            } catch (Exception e) {
                // No connectivity, no manifest yet, or a malformed one — silently skip.
                // This runs on every launch, so a transient failure just retries next time.
            }
        });
    }

    private void beginUpdate(String apkUrl, String versionName) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Allow talk-app to install updates, then reopen the app", Toast.LENGTH_LONG).show();
            updateCheckPendingAfterSettings = true;
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            return;
        }
        Toast.makeText(this, "Updating talk-app to v" + versionName + "…", Toast.LENGTH_SHORT).show();
        downloadAndInstall(apkUrl);
    }

    private void downloadAndInstall(String apkUrl) {
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                File dir = new File(getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("could not create updates dir");
                File apkFile = new File(dir, "talkapp-update.apk");

                HttpURLConnection conn = (HttpURLConnection) new URL(apkUrl).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(15000);
                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(apkFile);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                out.close();
                in.close();
                conn.disconnect();

                mainHandler.post(() -> launchInstaller(apkFile));
            } catch (Exception e) {
                mainHandler.post(() -> Toast.makeText(this, "Update download failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    private void launchInstaller(File apkFile) {
        Uri contentUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(contentUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
