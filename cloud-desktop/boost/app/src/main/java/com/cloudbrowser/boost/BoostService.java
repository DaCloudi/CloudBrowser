package com.cloudbrowser.boost;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.IBinder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import io.github.muntashirakon.adb.AdbStream;

/**
 * Runs while you play: watches which game starts (from the headset's event log) and applies
 * that game's setting straight away, before the game has finished starting, and records how
 * the game performs (from the headset's once-a-second performance line).
 */
public class BoostService extends Service {
    private static final String CHANNEL = "boost";
    // What the screen shows live.
    public static volatile String currentGame;
    public static volatile GameStats.Sample lastSample;
    public static volatile boolean watching;

    private volatile boolean running;
    private Thread thread;
    private SharedPreferences prefs;
    private String appliedCommand;
    private GameStats stats;
    private String statsGame;
    private long lastSave;

    // am_proc_start: [user,pid,uid,PACKAGE,type,component]  ·  *_set_resumed_activity: [user,PACKAGE/Activity,reason]
    private static final Pattern PROC_START = Pattern.compile("am_proc_start.*?\\[\\d+,\\d+,\\d+,([A-Za-z0-9_.]+)(?::[^,]*)?,([^,]*)");
    private static final Pattern RESUMED = Pattern.compile("(?:wm|am)_set_resumed_activity.*?\\[\\d+,([A-Za-z0-9_.]+)/");

    public static void start(Context c) {
        c.startForegroundService(new Intent(c, BoostService.class));
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, BoostService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("boost", MODE_PRIVATE);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Cloud Boost", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, note("Watching for games"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (thread == null || !thread.isAlive()) {
            running = true;
            thread = new Thread(this::loop, "cloud-boost");
            thread.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        watching = false;
        if (thread != null) thread.interrupt();
        saveStats(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private Notification note(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_ff)
                .setContentTitle("Cloud Boost")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    private void update(String text) {
        getSystemService(NotificationManager.class).notify(1, note(text));
    }

    // ---------- the watch loop ----------

    private void loop() {
        while (running) {
            AdbStream stream = null;
            try {
                AbsAdbConnectionManager adb = Adb.getInstance(getApplication());
                if (!adb.isConnected() && !adb.autoConnect(getApplication(), 8000) && !adb.isConnected()) throw new Exception("no connection");
                watching = true;
                update(currentGame == null ? "Watching for games" : "Playing " + label(currentGame));
                // Events (app starts and switches) and the performance line, from now on.
                stream = adb.openStream("shell:logcat -v brief -T 1 -b events -b main VrApi:I am_proc_start:I wm_set_resumed_activity:I am_set_resumed_activity:I *:S");
                BufferedReader in = new BufferedReader(new InputStreamReader(stream.openInputStream(), StandardCharsets.UTF_8));
                String line;
                while (running && (line = in.readLine()) != null) handle(line);
            } catch (Throwable e) {
                watching = false;
                update("Waiting for Wireless debugging");
            } finally {
                if (stream != null) try { stream.close(); } catch (Exception ignored) {}
            }
            if (running) try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        }
    }

    private void handle(String line) {
        if (line.contains("FPS=")) {
            GameStats.Sample s = GameStats.parse(line);
            if (s == null) return;
            lastSample = s;
            if (currentGame != null) {
                if (!currentGame.equals(statsGame)) { saveStats(true); stats = GameStats.load(prefs, currentGame); statsGame = currentGame; }
                stats.add(s);
                saveStats(false);
            }
            return;
        }
        Matcher m = PROC_START.matcher(line);
        if (m.find()) {
            // Only apps starting to be shown (not services in the background).
            if (m.group(2) != null && m.group(2).contains("activity")) switchTo(m.group(1));
            return;
        }
        m = RESUMED.matcher(line);
        if (m.find()) switchTo(m.group(1));
    }

    /** A game (or the home screen) came to the front: put on its setting. */
    private void switchTo(String pkg) {
        boolean game = isGame(pkg);
        String now = game ? pkg : null;
        if (now == null ? currentGame == null : now.equals(currentGame)) return;
        currentGame = now;
        lastSample = null;
        Tweaks t = game ? Profiles.tweaksFor(prefs, pkg) : Tweaks.load(prefs);
        String cmd = t.command();
        if (!cmd.equals(appliedCommand)) {
            try {
                AdbStream s = Adb.getInstance(getApplication()).openStream("shell:" + cmd);
                s.openInputStream().read(new byte[64]);
                s.close();
                appliedCommand = cmd;
            } catch (Throwable ignored) {}
        }
        update(game ? "Playing " + label(pkg) + " · " + Profiles.nameFor(prefs, pkg) : "Watching for games");
    }

    private void saveStats(boolean force) {
        if (stats == null || statsGame == null) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastSave < 10000) return;
        lastSave = now;
        stats.save(prefs, statsGame);
    }

    // ---------- which apps count as games ----------

    static boolean isGame(Context c, String pkg) {
        if (pkg == null || pkg.startsWith("com.oculus.") || pkg.startsWith("com.meta.") || pkg.startsWith("com.android.")
                || pkg.startsWith("android") || pkg.startsWith("com.google.") || pkg.equals(c.getPackageName())) return false;
        try {
            ApplicationInfo ai = c.getPackageManager().getApplicationInfo(pkg, 0);
            return (ai.flags & ApplicationInfo.FLAG_SYSTEM) == 0;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
    private boolean isGame(String pkg) { return isGame(this, pkg); }

    String label(String pkg) { return label(this, pkg); }
    static String label(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception e) {
            return pkg;
        }
    }
}
