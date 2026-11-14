package com.cloudbrowser.boost;

import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a game actually did while you played it, from the headset's own performance log (the
 * once-a-second "VrApi" line: FPS=72/72, App=9.1ms, Temp=36.0C, CPU4/GPU=3/4 …).
 */
public class GameStats {
    public long samples;
    public double fpsSum, targetSum, appMsSum;
    public double maxTemp;
    public int lastCpu = -1, lastGpu = -1;
    public long updated;

    private static final Pattern FPS = Pattern.compile("FPS=(\\d+)/(\\d+)");
    private static final Pattern APP = Pattern.compile("App=([\\d.]+)ms");
    private static final Pattern TEMP = Pattern.compile("Temp=([\\d.]+)C");
    private static final Pattern LEVELS = Pattern.compile("CPU\\d*/GPU=(\\d+)/(\\d+)");

    /** One parsed VrApi line, or null if the line isn't one. */
    public static class Sample {
        public int fps, target;
        public double appMs = -1, temp = -1;
        public int cpu = -1, gpu = -1;
    }

    public static Sample parse(String line) {
        Matcher m = FPS.matcher(line);
        if (!m.find()) return null;
        Sample s = new Sample();
        s.fps = Integer.parseInt(m.group(1));
        s.target = Integer.parseInt(m.group(2));
        if (s.target <= 0) return null;
        Matcher a = APP.matcher(line);
        if (a.find()) s.appMs = Double.parseDouble(a.group(1));
        Matcher t = TEMP.matcher(line);
        if (t.find()) s.temp = Double.parseDouble(t.group(1));
        Matcher l = LEVELS.matcher(line);
        if (l.find()) { s.cpu = Integer.parseInt(l.group(1)); s.gpu = Integer.parseInt(l.group(2)); }
        return s;
    }

    public void add(Sample s) {
        // Older numbers fade out, so the summary follows your current settings.
        if (samples >= 600) { double k = 599.0 / samples; fpsSum *= k; targetSum *= k; appMsSum *= k; samples = 599; }
        samples++;
        fpsSum += s.fps;
        targetSum += s.target;
        appMsSum += Math.max(0, s.appMs);
        if (s.temp > maxTemp) maxTemp = s.temp;
        if (s.cpu >= 0) lastCpu = s.cpu;
        if (s.gpu >= 0) lastGpu = s.gpu;
        updated = System.currentTimeMillis();
    }

    public double avgFps() { return samples == 0 ? 0 : fpsSum / samples; }
    public double avgTarget() { return samples == 0 ? 0 : targetSum / samples; }
    public double avgAppMs() { return samples == 0 ? 0 : appMsSum / samples; }
    /** Share of frames the game missed. */
    public double dropped() { double t = avgTarget(); return t <= 0 ? 0 : Math.max(0, 1 - avgFps() / t); }

    public String summary() {
        if (samples < 5) return "Not played with Cloud Boost watching yet";
        return String.format(Locale.US, "%.0f / %.0f fps · %s dropped · %.0f°C max", avgFps(), avgTarget(),
                dropped() < 0.005 ? "none" : String.format(Locale.US, "%.0f%%", dropped() * 100), maxTemp);
    }

    /** Index into Tweaks presets to suggest, or -1 for "it's fine as it is". */
    public int suggestion() {
        if (samples < 20) return -1;
        double frameMs = 1000.0 / Math.max(1, avgTarget());
        if (dropped() > 0.05) return 0;                         // struggling: lower resolution (Battery saver)
        if (dropped() < 0.01 && avgAppMs() > 0 && avgAppMs() < frameMs * 0.6) return 3; // lots of headroom: Sharp
        return -1;
    }

    public String suggestionText() {
        int s = suggestion();
        if (samples < 20) return "";
        if (s == 0) return "Missing frames. Try Battery saver (lower resolution) or a higher foveation.";
        if (s == 3) return "Running easily with room to spare. Try Sharp for a crisper picture.";
        return "Running well.";
    }

    // ---------- saving ----------

    public static GameStats load(SharedPreferences p, String pkg) {
        GameStats g = new GameStats();
        try {
            String raw = p.getString("stats_" + pkg, null);
            if (raw == null) return g;
            JSONObject o = new JSONObject(raw);
            g.samples = o.optLong("n");
            g.fpsSum = o.optDouble("fps");
            g.targetSum = o.optDouble("target");
            g.appMsSum = o.optDouble("app");
            g.maxTemp = o.optDouble("temp");
            g.lastCpu = o.optInt("cpu", -1);
            g.lastGpu = o.optInt("gpu", -1);
            g.updated = o.optLong("at");
        } catch (Exception ignored) {}
        return g;
    }

    public void save(SharedPreferences p, String pkg) {
        try {
            JSONObject o = new JSONObject();
            o.put("n", samples); o.put("fps", fpsSum); o.put("target", targetSum); o.put("app", appMsSum);
            o.put("temp", maxTemp); o.put("cpu", lastCpu); o.put("gpu", lastGpu); o.put("at", updated);
            p.edit().putString("stats_" + pkg, o.toString()).apply();
        } catch (Exception ignored) {}
    }
}
