package com.cloudbrowser.boost;

import android.content.SharedPreferences;
import android.os.Build;

/**
 * The Quest settings Cloud Boost changes. They are Meta's documented developer system properties
 * (debug.oculus.*), the same ones Quest Games Optimizer and SideQuest use. Meta clears them on
 * every restart, so Cloud Boost applies them again whenever it connects.
 * A value of null means "let the game / Meta decide".
 */
public class Tweaks {
    public Float resolution;   // multiplier on the headset's normal eye texture size
    public Integer refreshRate;
    public Integer cpuLevel;
    public Integer gpuLevel;
    public Integer foveation;  // 0 off … 4 highest

    public static final String[] PRESET_NAMES = {"Battery saver", "Normal", "Smooth", "Sharp", "Max FPS"};
    public static final String[] PRESET_HINTS = {
            "Lower resolution and 72 Hz. Longer battery, cooler headset.",
            "Meta's own settings. Undo everything.",
            "90 Hz with a bit more CPU and GPU. Smoother in most games.",
            "Higher resolution for crisper text and detail. Best in lighter games.",
            "120 Hz with full CPU and GPU. For games that can keep up; uses more battery.",
    };

    public static Tweaks preset(int i) {
        Tweaks t = new Tweaks();
        switch (i) {
            case 0: t.resolution = 0.85f; t.refreshRate = 72; t.foveation = 3; break;
            case 1: break;
            case 2: t.resolution = 1.0f; t.refreshRate = 90; t.cpuLevel = 4; t.gpuLevel = 4; t.foveation = 2; break;
            case 3: t.resolution = 1.25f; t.refreshRate = 72; t.gpuLevel = maxGpu(); t.foveation = 1; break;
            case 4: t.resolution = 0.9f; t.refreshRate = 120; t.cpuLevel = maxCpu(); t.gpuLevel = maxGpu(); t.foveation = 3; break;
        }
        return t;
    }

    // ---------- headset model ----------

    /** Normal eye texture size for this headset (Meta's documented defaults). */
    public static int[] baseSize() {
        String d = Build.DEVICE == null ? "" : Build.DEVICE.toLowerCase();
        if (d.contains("eureka") || d.contains("panther")) return new int[]{1680, 1760}; // Quest 3, 3S
        if (d.contains("hollywood") || d.contains("seacliff")) return new int[]{1440, 1584}; // Quest 2, Pro
        return new int[]{1440, 1584};
    }
    public static boolean isQuest3() {
        String d = Build.DEVICE == null ? "" : Build.DEVICE.toLowerCase();
        return d.contains("eureka") || d.contains("panther");
    }
    public static String modelName() {
        String d = Build.DEVICE == null ? "" : Build.DEVICE.toLowerCase();
        if (d.contains("eureka")) return "Quest 3";
        if (d.contains("panther")) return "Quest 3S";
        if (d.contains("hollywood")) return "Quest 2";
        if (d.contains("seacliff")) return "Quest Pro";
        return Build.MODEL;
    }
    public static int maxCpu() { return isQuest3() ? 5 : 4; }
    public static int maxGpu() { return isQuest3() ? 5 : 4; }
    public static int[] refreshRates() { return new int[]{72, 80, 90, 120}; }

    // ---------- shell command ----------

    private static String prop(String name, Object value) {
        return "setprop " + name + " " + (value == null ? "''" : String.valueOf(value));
    }

    /** One shell command that sets (or clears) every property. */
    public String command() {
        int[] base = baseSize();
        Integer w = null, h = null;
        if (resolution != null && Math.abs(resolution - 1f) > 0.001f) {
            w = Math.round(base[0] * resolution / 8f) * 8;
            h = Math.round(base[1] * resolution / 8f) * 8;
        }
        return prop("debug.oculus.textureWidth", w) + "; "
                + prop("debug.oculus.textureHeight", h) + "; "
                + prop("debug.oculus.refreshRate", refreshRate) + "; "
                + prop("debug.oculus.cpuLevel", cpuLevel) + "; "
                + prop("debug.oculus.gpuLevel", gpuLevel) + "; "
                + prop("debug.oculus.foveation.level", foveation) + "; "
                + prop("debug.oculus.foveation.dynamic", foveation == null ? null : 0) + "; "
                + "echo ok";
    }

    public boolean isNormal() {
        return (resolution == null || Math.abs(resolution - 1f) < 0.001f) && refreshRate == null
                && cpuLevel == null && gpuLevel == null && foveation == null;
    }

    // ---------- saving ----------

    public void save(SharedPreferences p) {
        SharedPreferences.Editor e = p.edit();
        put(e, "res", resolution == null ? null : Math.round(resolution * 100));
        put(e, "hz", refreshRate);
        put(e, "cpu", cpuLevel);
        put(e, "gpu", gpuLevel);
        put(e, "fov", foveation);
        e.apply();
    }
    private static void put(SharedPreferences.Editor e, String k, Integer v) {
        if (v == null) e.remove(k); else e.putInt(k, v);
    }
    public static Tweaks load(SharedPreferences p) {
        Tweaks t = new Tweaks();
        if (p.contains("res")) t.resolution = p.getInt("res", 100) / 100f;
        if (p.contains("hz")) t.refreshRate = p.getInt("hz", 72);
        if (p.contains("cpu")) t.cpuLevel = p.getInt("cpu", 0);
        if (p.contains("gpu")) t.gpuLevel = p.getInt("gpu", 0);
        if (p.contains("fov")) t.foveation = p.getInt("fov", 0);
        return t;
    }
}
