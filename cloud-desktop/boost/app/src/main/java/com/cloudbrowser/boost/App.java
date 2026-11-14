// Based on the libadb-android sample (MuntashirAkon), used under Apache-2.0.

package com.cloudbrowser.boost;

import android.app.Application;
import android.content.Context;
import android.os.Build;

import org.lsposed.hiddenapibypass.HiddenApiBypass;

import io.github.muntashirakon.adb.PRNGFixes;

public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        PRNGFixes.apply();
    }

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            HiddenApiBypass.addHiddenApiExemptions("L");
        }
    }
}
