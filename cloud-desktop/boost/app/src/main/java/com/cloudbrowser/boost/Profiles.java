package com.cloudbrowser.boost;

import android.content.SharedPreferences;

/** Per-game settings: each game can use one of the quick picks, or your main setting. */
public class Profiles {
    public static final int MAIN = -1; // "use my main setting"

    public static int get(SharedPreferences p, String pkg) {
        return p.getInt("profile_" + pkg, MAIN);
    }

    public static void set(SharedPreferences p, String pkg, int preset) {
        if (preset == MAIN) p.edit().remove("profile_" + pkg).apply();
        else p.edit().putInt("profile_" + pkg, preset).apply();
    }

    public static Tweaks tweaksFor(SharedPreferences p, String pkg) {
        int i = get(p, pkg);
        return i == MAIN ? Tweaks.load(p) : Tweaks.preset(i);
    }

    public static String nameFor(SharedPreferences p, String pkg) {
        int i = get(p, pkg);
        return i == MAIN ? "main setting" : Tweaks.PRESET_NAMES[i];
    }
}
