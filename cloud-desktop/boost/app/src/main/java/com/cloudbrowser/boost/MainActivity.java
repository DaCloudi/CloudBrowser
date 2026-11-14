package com.cloudbrowser.boost;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import io.github.muntashirakon.adb.AdbPairingRequiredException;
import io.github.muntashirakon.adb.AdbStream;
import io.github.muntashirakon.adb.android.AdbMdns;
import io.github.muntashirakon.adb.android.AndroidUtils;

/**
 * Cloud Boost: tune Quest games (resolution, refresh rate, CPU/GPU level, foveation) from inside
 * the headset. It talks to the headset's own developer connection (Wireless debugging), paired
 * once with a code, so no PC is needed.
 */
public class MainActivity extends Activity {
    // CloudBrowser's colours
    static final int BG = 0xFF07101B, CARD = 0xFF0D1B2E, FIELD = 0xFF152133, LINE = 0xFF233042,
            TEXT = 0xFFE8EEF6, MUTED = 0xFF9AA7B6, ACCENT = 0xFF4D8DFF, GOOD = 0xFF3BA55D, WARN = 0xFFF0B232;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;
    private Tweaks tweaks;
    private int presetIndex = -1;

    private TextView status, setupText, pairPortText, applyNote;
    private EditText codeField, portField;
    private LinearLayout setupCard, tuneCard;
    private Button[] presetButtons;
    private TextView resLabel;
    private SeekBar resBar;
    private LinearLayout hzRow, cpuRow, gpuRow, fovRow;
    private AdbMdns pairingFinder;
    private volatile int pairingPort = -1;
    private volatile boolean connected;
    private volatile boolean settingUp;
    private TextView liveText;
    private Button autoButton;
    private LinearLayout gamesList;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable liveTick = new Runnable() {
        public void run() { refreshLive(); ui.postDelayed(this, 1000); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("boost", MODE_PRIVATE);
        tweaks = Tweaks.load(prefs);
        presetIndex = prefs.getInt("preset", -1);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        setContentView(build());
        refreshTune();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (getIntent() != null && getIntent().getBooleanExtra("setup", false)) {
            getIntent().removeExtra("setup");
            settingUp = true;
            setStatus("Setting up… tick “Always allow” and press Allow when asked", WARN);
            // CloudBrowser switches the headset to port 5555 right after opening us; give it a moment.
            ui.postDelayed(() -> connect(false), 4000);
            ui.postDelayed(() -> connect(false), 12000);
            ui.postDelayed(() -> connect(false), 25000);
        } else connect(false);
        refreshGames();
        ui.post(liveTick);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopFindingPairing();
        ui.removeCallbacks(liveTick);
    }

    private boolean autoOn() { return prefs.getBoolean("auto", true); }

    // ---------- connecting ----------

    private AbsAdbConnectionManager adb() throws Exception {
        return Adb.getInstance(getApplication());
    }

    /** Connect to the headset's Wireless debugging; apply saved settings once connected. */
    private void connect(boolean userAsked) {
        setStatus("Connecting…", MUTED);
        worker.execute(() -> {
            try {
                AbsAdbConnectionManager m = adb();
                boolean canSwitch = checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
                if (canSwitch) {
                    // Set up from the PC: we may switch Wireless debugging on ourselves (Quest turns it off on restart).
                    try {
                        if (Settings.Global.getInt(getContentResolver(), "adb_wifi_enabled", 0) != 1) {
                            Settings.Global.putInt(getContentResolver(), "adb_wifi_enabled", 1);
                            Thread.sleep(2500);
                        }
                    } catch (Throwable ignored) {}
                }
                boolean ok = m.isConnected();
                if (!ok) try { ok = m.autoConnect(getApplication(), 6000) || m.isConnected(); } catch (AdbPairingRequiredException e) { if (!canSwitch) throw e; }
                if (!ok) {
                    // During PC setup the headset listens on port 5555; connecting there shows the
                    // "Allow debugging?" message once, which authorises Cloud Boost for good.
                    try { ok = m.connect("127.0.0.1", 5555) || m.isConnected(); } catch (Throwable ignored) {}
                    if (ok && settingUp) {
                        settingUp = false;
                        try { m.openStream("usb:"); } catch (Throwable ignored) {} // back to normal so the USB cable works again
                        Thread.sleep(3000);
                        try { m.disconnect(); } catch (Throwable ignored) {}
                        ok = false;
                        try { ok = m.autoConnect(getApplication(), 8000) || m.isConnected(); } catch (Throwable ignored) {}
                        if (!ok) { runOnUiThread(() -> { setStatus("Set up done. Reopen Cloud Boost.", GOOD); toast("Cloud Boost is set up. If it doesn’t connect, close and reopen it."); }); return; }
                    }
                }
                if (!ok) throw new java.io.IOException("not found");
                connected = true;
                prefs.edit().putBoolean("paired", true).apply();
                if (autoOn()) runOnUiThread(() -> BoostService.start(this));
                String applied = tweaks.isNormal() ? null : shell(tweaks.command());
                runOnUiThread(() -> {
                    showSetup(false);
                    setStatus(applied != null ? "Connected · your settings are on" : "Connected", GOOD);
                });
            } catch (AdbPairingRequiredException e) {
                connected = false;
                prefs.edit().putBoolean("paired", false).apply();
                runOnUiThread(() -> { showSetup(true); setStatus("Pair once to get started", WARN); });
            } catch (Throwable e) {
                connected = false;
                boolean paired = prefs.getBoolean("paired", false);
                runOnUiThread(() -> {
                    showSetup(true);
                    setStatus(paired ? "Wireless debugging is off" : "Not set up yet", WARN);
                    if (userAsked) toast(paired ? "Turn on Wireless debugging first (Quest turns it off when it restarts)." : "Pair first: steps below.");
                });
            }
        });
    }

    private String shell(String cmd) throws Exception {
        AdbStream s = adb().openStream("shell:" + cmd);
        try (InputStream in = s.openInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8).trim();
        } finally {
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    private void pair() {
        String code = codeField.getText().toString().trim();
        int port = pairingPort;
        try { if (portField.getText().length() > 0) port = Integer.parseInt(portField.getText().toString().trim()); } catch (NumberFormatException ignored) {}
        if (code.length() != 6) { toast("Type the 6-digit code from the pairing window."); return; }
        if (port <= 0) { toast("Waiting for the pairing window. Tap “Pair device with pairing code” in Wireless debugging."); return; }
        final int p = port;
        setStatus("Pairing…", MUTED);
        worker.execute(() -> {
            try {
                boolean ok = adb().pair(AndroidUtils.getHostIpAddress(getApplication()), p, code);
                runOnUiThread(() -> {
                    if (ok) { prefs.edit().putBoolean("paired", true).apply(); toast("Paired!"); codeField.setText(""); connect(true); }
                    else setStatus("Pairing failed. Check the code and try again.", WARN);
                });
            } catch (Throwable e) {
                runOnUiThread(() -> setStatus("Pairing failed: " + e.getMessage(), WARN));
            }
        });
    }

    private void startFindingPairing() {
        if (pairingFinder != null) return;
        pairingFinder = new AdbMdns(getApplication(), AdbMdns.SERVICE_TYPE_TLS_PAIRING, (host, port) -> {
            pairingPort = port;
            runOnUiThread(() -> pairPortText.setText(port > 0 ? "✓ Pairing window found" : "Waiting for the pairing window…"));
        });
        pairingFinder.start();
    }

    private void stopFindingPairing() {
        if (pairingFinder != null) { try { pairingFinder.stop(); } catch (Exception ignored) {} pairingFinder = null; }
    }

    private void openWirelessDebugging() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT | Intent.FLAG_ACTIVITY_MULTIPLE_TASK);
        try { startActivity(i); } catch (Exception e) {
            try {
                Intent j = new Intent(Settings.ACTION_SETTINGS);
                j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT);
                startActivity(j);
            } catch (Exception e2) { toast("Couldn’t open settings on this headset."); }
        }
    }

    // ---------- applying ----------

    private void apply() {
        tweaks.save(prefs);
        prefs.edit().putInt("preset", presetIndex).apply();
        if (!connected) { toast("Saved. They go on as soon as Cloud Boost connects."); connect(true); return; }
        setStatus("Applying…", MUTED);
        worker.execute(() -> {
            try {
                shell(tweaks.command());
                runOnUiThread(() -> {
                    setStatus(tweaks.isNormal() ? "Connected · Meta's normal settings" : "Connected · your settings are on", GOOD);
                    applyNote.setText("Done. Restart the game you’re playing so it picks them up.");
                });
            } catch (Throwable e) {
                connected = false;
                runOnUiThread(() -> { setStatus("Lost the connection. Tap Connect.", WARN); showSetup(true); });
            }
        });
    }

    // ---------- the screen ----------

    private View build() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        LinearLayout root = column();
        root.setPadding(dp(28), dp(24), dp(28), dp(32));
        scroll.addView(root);

        LinearLayout head = row();
        TextView title = text("Cloud Boost", 30, TEXT, true);
        head.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        status = text("", 14, MUTED, true);
        head.addView(status);
        root.addView(head);
        root.addView(text("Faster or sharper games on your " + Tweaks.modelName() + ".", 15, MUTED, false), margins(0, 2, 0, 16));

        // Set up (pairing)
        setupCard = card();
        setupCard.addView(text("Set up", 19, TEXT, true));
        setupText = text("Cloud Boost changes Quest settings through the headset’s developer connection. Set it up once from your PC:", 14, MUTED, false);
        setupCard.addView(setupText, margins(0, 4, 0, 12));
        setupCard.addView(step("1", "Plug your Quest into your PC. In CloudBrowser open Cloud Desktop and click “Set up Cloud Boost”.", null));
        setupCard.addView(step("2", "A message appears in the headset: tick “Always allow” and press Allow. That’s it — after the Quest restarts, Cloud Boost switches Wireless debugging back on by itself.", null));
        setupCard.addView(text("Older Quest software (before v81) can pair without a PC instead:", 15, TEXT, true), margins(0, 10, 0, 8));
        setupCard.addView(step("a", "Open Wireless debugging (in the Android settings, not Quest settings) and switch it on.",
                button("Open Wireless debugging", true, v -> { openWirelessDebugging(); startFindingPairing(); })));
        setupCard.addView(step("b", "Tap the words “Wireless debugging”, then “Pair device with pairing code”. Keep that window open beside this one.", null));
        pairPortText = text("Waiting for the pairing window…", 13, MUTED, false);
        setupCard.addView(pairPortText, margins(34, 0, 0, 8));
        LinearLayout codeRow = row();
        codeField = field("6-digit code", InputType.TYPE_CLASS_NUMBER);
        codeRow.addView(codeField, new LinearLayout.LayoutParams(0, dp(48), 1));
        portField = field("port (optional)", InputType.TYPE_CLASS_NUMBER);
        codeRow.addView(portField, weight(0.6f, 10));
        codeRow.addView(button("Pair", true, v -> pair()), margins(10, 0, 0, 0));
        setupCard.addView(step("c", "Type the code here and tap Pair.", null));
        setupCard.addView(codeRow, margins(34, 0, 0, 12));
        setupCard.addView(step("d", "If it can’t connect after a restart:",
                button("Connect", false, v -> connect(true))));
        root.addView(setupCard, margins(0, 0, 0, 14));

        tuneCard = column();

        // Live: what's playing now and how it's running
        LinearLayout live = card();
        LinearLayout liveHead = row();
        liveHead.addView(text("Now", 19, TEXT, true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        autoButton = button("", false, v -> {
            boolean on = !autoOn();
            prefs.edit().putBoolean("auto", on).apply();
            if (on) BoostService.start(this); else BoostService.stop(this);
            refreshLive();
        });
        liveHead.addView(autoButton);
        live.addView(liveHead, margins(0, 0, 0, 8));
        liveText = text("", 15, MUTED, false);
        live.addView(liveText);
        tuneCard.addView(live, margins(0, 0, 0, 14));

        // Presets
        LinearLayout presets = card();
        presets.addView(text("Quick picks", 19, TEXT, true), margins(0, 0, 0, 10));
        presetButtons = new Button[Tweaks.PRESET_NAMES.length];
        for (int i = 0; i < presetButtons.length; i++) {
            final int idx = i;
            LinearLayout r = row();
            Button b = button(Tweaks.PRESET_NAMES[i], false, v -> {
                presetIndex = idx;
                tweaks = Tweaks.preset(idx);
                refreshTune();
                apply();
            });
            presetButtons[i] = b;
            r.addView(b, new LinearLayout.LayoutParams(dp(170), dp(48)));
            r.addView(text(Tweaks.PRESET_HINTS[i], 14, MUTED, false), weight(1, 14));
            presets.addView(r, margins(0, 0, 0, 8));
        }
        tuneCard.addView(presets, margins(0, 0, 0, 14));

        // Custom
        LinearLayout custom = card();
        custom.addView(text("Your own mix", 19, TEXT, true), margins(0, 0, 0, 10));
        resLabel = text("", 15, TEXT, false);
        custom.addView(resLabel);
        resBar = new SeekBar(this);
        resBar.setMax(16); // 70% … 150% in 5% steps
        resBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar s, int p, boolean user) {
                if (!user) return;
                float r = (70 + p * 5) / 100f;
                tweaks.resolution = Math.abs(r - 1f) < 0.001f ? null : r;
                presetIndex = -1;
                refreshTune();
            }
            public void onStartTrackingTouch(SeekBar s) {}
            public void onStopTrackingTouch(SeekBar s) {}
        });
        custom.addView(resBar, margins(0, 4, 0, 14));
        custom.addView(text("Refresh rate", 15, TEXT, false));
        custom.addView(hzRow = chips(), margins(0, 6, 0, 14));
        custom.addView(text("CPU level (higher = faster, more battery)", 15, TEXT, false));
        custom.addView(cpuRow = chips(), margins(0, 6, 0, 14));
        custom.addView(text("GPU level (higher = faster, more battery)", 15, TEXT, false));
        custom.addView(gpuRow = chips(), margins(0, 6, 0, 14));
        custom.addView(text("Foveation (blurs the edges you don’t look at; higher = faster)", 15, TEXT, false));
        custom.addView(fovRow = chips(), margins(0, 6, 0, 16));
        custom.addView(button("Apply", true, v -> apply()));
        applyNote = text("Games pick up changes when they start, so restart the game you’re playing. Quest clears these on restart; Cloud Boost puts them back when it connects.", 13, MUTED, false);
        custom.addView(applyNote, margins(0, 10, 0, 0));
        tuneCard.addView(custom, margins(0, 0, 0, 14));

        // Per game
        LinearLayout games = card();
        games.addView(text("Per game", 19, TEXT, true));
        games.addView(text("Pick a setting for each game. It goes on the moment the game starts and comes off when you leave. "
                + "Games you’ve played show how they ran and what Cloud Boost suggests.", 14, MUTED, false), margins(0, 4, 0, 10));
        gamesList = column();
        games.addView(gamesList);
        tuneCard.addView(games);
        root.addView(tuneCard);

        root.addView(text("Tip: a game that already runs well won’t get faster by raising CPU/GPU level. "
                + "Lower resolution or higher foveation helps games that stutter.", 13, MUTED, false), margins(0, 16, 0, 0));
        return scroll;
    }

    private void refreshLive() {
        if (liveText == null) return;
        boolean auto = autoOn();
        autoButton.setText(auto ? "Per-game: on" : "Per-game: off");
        style(autoButton, auto);
        String game = BoostService.currentGame;
        GameStats.Sample s = BoostService.lastSample;
        if (!auto) liveText.setText("Per-game switching is off. Your main setting applies to every game.");
        else if (!BoostService.watching) liveText.setText(connected ? "Starting…" : "Waiting for Wireless debugging.");
        else if (game == null) liveText.setText("Watching for games. Start one and its setting goes on straight away.");
        else {
            String line = "Playing " + BoostService.label(this, game) + " · " + Profiles.nameFor(prefs, game);
            if (s != null) line += String.format(Locale.US, "\n%d / %d fps%s%s%s", s.fps, s.target,
                    s.appMs >= 0 ? String.format(Locale.US, " · frame %.1f ms", s.appMs) : "",
                    s.gpu >= 0 ? String.format(Locale.US, " · CPU %d GPU %d", s.cpu, s.gpu) : "",
                    s.temp > 0 ? String.format(Locale.US, " · %.0f°C", s.temp) : "");
            liveText.setText(line);
        }
    }

    /** Installed games, the ones with stats first. */
    private void refreshGames() {
        if (gamesList == null) return;
        PackageManager pm = getPackageManager();
        List<ApplicationInfo> apps = new ArrayList<>();
        for (ApplicationInfo ai : pm.getInstalledApplications(0)) {
            if (!BoostService.isGame(this, ai.packageName)) continue;
            if (pm.getLaunchIntentForPackage(ai.packageName) == null) continue;
            if (ai.packageName.startsWith("com.cloudbrowser.")) continue;
            apps.add(ai);
        }
        Collections.sort(apps, (a, b) -> {
            long ua = GameStats.load(prefs, a.packageName).updated, ub = GameStats.load(prefs, b.packageName).updated;
            if (ua != ub) return Long.compare(ub, ua);
            return String.valueOf(pm.getApplicationLabel(a)).compareToIgnoreCase(String.valueOf(pm.getApplicationLabel(b)));
        });
        gamesList.removeAllViews();
        if (apps.isEmpty()) { gamesList.addView(text("No games installed yet.", 14, MUTED, false)); return; }
        for (ApplicationInfo ai : apps) {
            final String pkg = ai.packageName;
            GameStats st = GameStats.load(prefs, pkg);
            LinearLayout item = column();
            item.setPadding(0, dp(10), 0, dp(10));
            item.addView(text(String.valueOf(pm.getApplicationLabel(ai)), 16, TEXT, true));
            item.addView(text(st.summary(), 13, MUTED, false));
            String tip = st.suggestionText();
            if (!tip.isEmpty()) item.addView(text(tip, 13, st.suggestion() == 0 ? WARN : st.suggestion() == 3 ? ACCENT : GOOD, false));
            LinearLayout chips = chips();
            LinearLayout inner = (LinearLayout) ((HorizontalScrollView) chips.getChildAt(0)).getChildAt(0);
            int cur = Profiles.get(prefs, pkg);
            String[] names = new String[Tweaks.PRESET_NAMES.length + 1];
            names[0] = "Main setting";
            System.arraycopy(Tweaks.PRESET_NAMES, 0, names, 1, Tweaks.PRESET_NAMES.length);
            for (int i = 0; i < names.length; i++) {
                final int preset = i - 1;
                Button b = button(names[i], false, v -> { Profiles.set(prefs, pkg, preset); refreshGames(); });
                style(b, cur == preset);
                if (preset >= 0 && preset == st.suggestion() && cur != preset) b.setText(names[i] + " ★");
                inner.addView(b, margins(0, 0, 8, 0));
            }
            item.addView(chips, margins(0, 6, 0, 0));
            gamesList.addView(item);
            View line = new View(this);
            line.setBackgroundColor(LINE);
            gamesList.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));
        }
    }

    private void refreshTune() {
        for (int i = 0; presetButtons != null && i < presetButtons.length; i++) style(presetButtons[i], i == presetIndex);
        float r = tweaks.resolution == null ? 1f : tweaks.resolution;
        int[] base = Tweaks.baseSize();
        resLabel.setText(String.format(java.util.Locale.US, "Resolution: %d%% (%d × %d per eye)%s", Math.round(r * 100),
                Math.round(base[0] * r / 8f) * 8, Math.round(base[1] * r / 8f) * 8, Math.abs(r - 1f) < 0.001f ? " · normal" : ""));
        resBar.setProgress(Math.round((r * 100 - 70) / 5));
        fillChips(hzRow, Tweaks.refreshRates(), tweaks.refreshRate, " Hz", v -> tweaks.refreshRate = v);
        fillChips(cpuRow, range(0, Tweaks.maxCpu()), tweaks.cpuLevel, "", v -> tweaks.cpuLevel = v);
        fillChips(gpuRow, range(0, Tweaks.maxGpu()), tweaks.gpuLevel, "", v -> tweaks.gpuLevel = v);
        fillChips(fovRow, range(0, 4), tweaks.foveation, "", v -> tweaks.foveation = v);
    }

    interface Setter { void set(Integer v); }

    private void fillChips(LinearLayout row, int[] values, Integer current, String suffix, Setter setter) {
        LinearLayout inner = (LinearLayout) ((HorizontalScrollView) row.getChildAt(0)).getChildAt(0);
        inner.removeAllViews();
        Button auto = button("Auto", false, v -> { setter.set(null); presetIndex = -1; refreshTune(); });
        style(auto, current == null);
        inner.addView(auto, margins(0, 0, 8, 0));
        for (int v : values) {
            Button b = button(v + suffix, false, x -> { setter.set(v); presetIndex = -1; refreshTune(); });
            style(b, current != null && current == v);
            inner.addView(b, margins(0, 0, 8, 0));
        }
    }

    private static int[] range(int a, int b) {
        int[] r = new int[b - a + 1];
        for (int i = 0; i < r.length; i++) r[i] = a + i;
        return r;
    }

    private void showSetup(boolean on) {
        setupCard.setVisibility(on ? View.VISIBLE : View.GONE);
        if (on && !prefs.getBoolean("paired", false)) startFindingPairing(); else stopFindingPairing();
    }

    private void setStatus(String s, int color) { status.setText(s); status.setTextColor(color); }

    private void toast(String s) { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show(); }

    // ---------- little view helpers ----------

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private LinearLayout column() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }

    private LinearLayout row() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }

    private LinearLayout card() {
        LinearLayout c = column();
        c.setPadding(dp(20), dp(18), dp(20), dp(18));
        c.setBackground(round(CARD, 16, LINE));
        return c;
    }

    private LinearLayout chips() {
        LinearLayout wrap = row();
        HorizontalScrollView h = new HorizontalScrollView(this);
        h.setHorizontalScrollBarEnabled(false);
        h.addView(row());
        wrap.addView(h);
        return wrap;
    }

    private LinearLayout step(String n, String what, View action) {
        LinearLayout r = row();
        TextView num = text(n, 14, Color.WHITE, true);
        num.setGravity(Gravity.CENTER);
        num.setBackground(round(ACCENT, 13, 0));
        r.addView(num, new LinearLayout.LayoutParams(dp(26), dp(26)));
        r.addView(text(what, 15, TEXT, false), weight(1, 8));
        if (action != null) r.addView(action, margins(10, 0, 0, 0));
        r.setPadding(0, 0, 0, dp(8));
        return r;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, boolean primary, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setMinHeight(dp(44));
        b.setPadding(dp(16), 0, dp(16), 0);
        b.setTag(primary);
        style(b, primary);
        b.setOnClickListener(click);
        return b;
    }

    private void style(Button b, boolean on) {
        b.setTextColor(Color.WHITE);
        b.setBackground(round(on ? ACCENT : FIELD, 12, on ? 0 : LINE));
    }

    private EditText field(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(MUTED);
        e.setTextColor(TEXT);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setPadding(dp(14), 0, dp(14), 0);
        e.setBackground(round(FIELD, 12, LINE));
        return e;
    }

    private GradientDrawable round(int color, int radiusDp, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(l), dp(t), dp(r), dp(b));
        return p;
    }

    private LinearLayout.LayoutParams weight(float w, int leftMargin) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, w);
        p.setMargins(dp(leftMargin), 0, 0, 0);
        return p;
    }
}
