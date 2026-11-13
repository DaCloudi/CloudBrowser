#!/usr/bin/env python3
"""Turn an ALVR source checkout into Cloud Desktop.

Cloud Desktop is CloudBrowser's own wireless PC-to-Quest streamer. It is built on ALVR
(https://github.com/alvr-org/ALVR, MIT licence), with its own name, app ID, icon, navy
CloudBrowser look and app signing key, so it installs alongside (not over) ALVR.

Usage: python brand.py <path to ALVR checkout> <path to keystore>
"""
import pathlib
import re
import shutil
import sys

SRC = pathlib.Path(sys.argv[1]).resolve()
KEYSTORE = pathlib.Path(sys.argv[2]).resolve()
APP_ID = "com.cloudbrowser.desktop"
NAME = "Cloud Desktop"

changes = []


def edit(rel, pairs, regex=False):
    p = SRC / rel
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        if regex:
            s2, n = re.subn(old, new, s)
        else:
            n = s.count(old)
            s2 = s.replace(old, new)
        if n == 0:
            sys.exit(f"brand.py: '{old}' not found in {rel}; ALVR has changed, update brand.py")
        s = s2
        changes.append(f"{rel}: {old[:50]!r} x{n}")
    p.write_text(s, encoding="utf-8")


# ---- Quest app: name, app ID (so it sits next to ALVR), icon ----
edit("alvr/client_openxr/Cargo.toml", [
    (r'package = "alvr\.client[^"]*"', f'package = "{APP_ID}"'),
    (r'label = "ALVR"', f'label = "{NAME}"'),
], regex=True)
# The packaging step rewrites ALVR's own IDs; ours must survive it.
edit("alvr/xtask/src/packaging.rs", [
    (r'r#"package = "alvr.client.stable""#', f'r#"package = "{APP_ID}""#'),
    (r'r#"package = "alvr.client""#', f'r#"package = "{APP_ID}""#'),
])

res = SRC / "alvr/client_openxr/resources"
(res / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#07101B</color>\n</resources>\n',
    encoding="utf-8")
# CloudBrowser's cloud, as an Android vector icon (white on navy).
(res / "drawable/ic_launcher_foreground.xml").write_text("""<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#FFFFFF"
      android:pathData="M37,70 L73,70 C80.2,70 86,64.4 86,57.5 C86,50.9 80.7,45.5 74,45.1 C72.2,36.9 64.9,31 56.2,31 C48.3,31 41.5,35.9 39.1,42.9 C30.6,43.4 24,50.2 24,58.5 C24,64.9 29.8,70 37,70 Z"/>
</vector>
""", encoding="utf-8")
changes.append("Quest app icon: white cloud on navy")

# ---- In the headset: navy lobby, our name on the status screen ----
edit("alvr/graphics/src/lobby.rs", [
    ("r: 0.0,\n                    g: 0.0,\n                    b: 0.02,", "r: 0.0024,\n                    g: 0.0052,\n                    b: 0.0103,"),  # #07101b in linear light
])
CD_VERSION = (pathlib.Path(__file__).resolve().parent / "VERSION").read_text(encoding="utf-8").strip()
# The status screen in the headset: our name and version, and messages that point to CloudBrowser.
# (Rust source text below: \\n is a newline inside a Rust string.)
edit("alvr/client_core/src/connection.rs", [
    (r'"ALVR v{}\nhostname: {}\nIP: {}\n\n{message}"',
     r'"Cloud Desktop ' + CD_VERSION + r'{}\nheadset: {}\nIP: {}\n\n{message}"'),
    ("        *ALVR_VERSION,\n        Config::load().hostname,", '        "",\n        Config::load().hostname,'),
    ("ViewParams, ALVR_VERSION,", "ViewParams,"),  # no longer used here
    (r'''    "Searching for streamer...\n",
    "Open ALVR on your PC then click \"Trust\"\n",
    "next to the device entry",''',
     r'''    "Looking for your PC...\n\n",
    "On your PC open CloudBrowser:\n",
    "Cloud Desktop > Connect\n\n",
    "USB cable: just plug it in\n",
    "Wi-Fi: click Trust on your PC",'''),
    (r'"Cannot connect to the streamer.\nNetwork error."', r'"Can' + "'" + r't reach your PC.\nCheck the cable or Wi-Fi."'),
    (r'"Successful connection!\nPlease wait..."', r'"Connected!\nOne moment..."'),
    (r'"The stream will begin soon\nPlease wait..."', r'"Your PC is coming up\nOne moment..."'),
    (r'"The streamer is restarting\nPlease wait..."', r'"Cloud Desktop is restarting\nOne moment..."'),
    ('"The streamer has disconnected."', r'"Your PC disconnected.\nClick Connect in CloudBrowser\nto carry on."'),
    ('"Connection timeout."', r'"Lost the connection.\nTrying again..."'),
])
edit("alvr/client_openxr/src/lib.rs", [
    ('application_name: "ALVR Client"', f'application_name: "{NAME}"'),
])

# The lobby you see before the picture starts: CloudBrowser navy, a blue grid, and a glowing
# circle where you stand.
edit("alvr/graphics/resources/lobby_quad.wgsl", [
    ("let ground_center = vec3f(0.0, 0.0, 0.0);", "let ground_center = vec3f(0.0024, 0.0052, 0.0103);"),
    ("let ground_horizon = vec3f(0.0, 0.0, 0.015);", "let ground_horizon = vec3f(0.006, 0.014, 0.04);"),
    ("let grid_close = vec3f(0.114, 0.545, 0.804);", "let grid_close = vec3f(0.074, 0.266, 1.0);"),
    ("let grid_far = vec3f(0.259, 0.863, 0.886);", "let grid_far = vec3f(0.42, 0.62, 1.0);"),
    ("        // Fade to the horizon colour over distance\n",
     "        // Cloud Desktop: a soft glowing circle where you stand\n"
     "        let ring = clamp(1.0 - abs(distance - 1.25) / (2.0 * fwidth(distance) + 0.01), 0.0, 1.0);\n"
     "        out_color += ring * vec3f(0.3, 0.55, 1.0) * 2.0;\n\n"
     "        // Fade to the horizon colour over distance\n"),
])

# SteamVR's device list: our name, not ALVR's.
edit("alvr/server_openvr/src/props.rs", [
    ('"ALVR Remote Controller', '"Cloud Desktop Controller'),
    ('"ALVR Tracker (', '"Cloud Desktop Tracker ('),
    ('"ALVR driver server"', f'"{NAME}"'),
])

# ---- On the PC: dashboard name and CloudBrowser's navy theme ----
edit("alvr/dashboard/src/main.rs", [
    ('"ALVR Dashboard (streamer v{})"', '"Cloud Desktop advanced settings (streamer v{})"'),
])
edit("alvr/dashboard/src/dashboard/mod.rs", [
    ('ui.heading(RichText::new("ALVR")', 'ui.heading(RichText::new("Cloud Desktop")'),
])
edit("alvr/gui_common/src/theme.rs", [
    (r"pub const ACCENT: Color32 = Color32::from_rgb\([^)]*\);", "pub const ACCENT: Color32 = Color32::from_rgb(77, 141, 255);"),
    (r"pub const BG: Color32 = Color32::from_rgb\([^)]*\);", "pub const BG: Color32 = Color32::from_rgb(7, 16, 27);"),
    (r"pub const LIGHTER_BG: Color32 = Color32::from_rgb\([^)]*\);", "pub const LIGHTER_BG: Color32 = Color32::from_rgb(12, 22, 36);"),
    (r"pub const SECTION_BG: Color32 = Color32::from_rgb\([^)]*\);", "pub const SECTION_BG: Color32 = Color32::from_rgb(12, 22, 36);"),
    (r"pub const DARKER_BG: Color32 = Color32::from_rgb\([^)]*\);", "pub const DARKER_BG: Color32 = Color32::from_rgb(5, 11, 19);"),
    (r"pub const SEPARATOR_BG: Color32 = Color32::from_rgb\([^)]*\);", "pub const SEPARATOR_BG: Color32 = Color32::from_rgb(25, 33, 43);"),
], regex=True)

# ---- USB cable (wired) connection ----
# ALVR only looks for its own apps on a USB-connected headset; make it find Cloud Desktop.
edit("alvr/system_info/src/lib.rs", [
    ('pub const PACKAGE_NAME_STORE: &str = "alvr.client";', f'pub const PACKAGE_NAME_STORE: &str = "{APP_ID}";'),
    ('pub const PACKAGE_NAME_GITHUB_DEV: &str = "alvr.client.dev";', f'pub const PACKAGE_NAME_GITHUB_DEV: &str = "{APP_ID}";'),
    ('pub const PACKAGE_NAME_GITHUB_STABLE: &str = "alvr.client.stable";', f'pub const PACKAGE_NAME_GITHUB_STABLE: &str = "{APP_ID}";'),
])
# Wired is switched on from the start: plug the cable in and it's used (Wi-Fi still works).
edit("alvr/session/src/lib.rs", [
    ("            client_connections: HashMap::new(),\n            session_settings: settings::session_settings_default(),",
     "            client_connections: HashMap::from([(\n"
     "                \"client.wired\".to_owned(),\n"
     "                ClientConnectionConfig {\n"
     "                    display_name: \"USB cable\".into(),\n"
     "                    current_ip: None,\n"
     "                    manual_ips: HashSet::new(),\n"
     "                    trusted: true,\n"
     "                    connection_state: ConnectionState::Disconnected,\n"
     "                },\n"
     "            )]),\n"
     "            session_settings: settings::session_settings_default(),"),
])
# With a phone, an emulator (BlueStacks) or the Quest's Wi-Fi debugging also connected, ALVR
# picked whichever came first. Use the device on the USB cable.
edit("alvr/adb/src/lib.rs", [
    ('.find(|s| !s.starts_with("127.0.0.1"))',
     '.find(|s| !s.contains(\':\') && !s.starts_with("emulator-") && !s.starts_with("adb-"))'),
])
edit("alvr/dashboard/src/dashboard/components/devices.rs", [
    ('ui.heading("Wired Connection")', 'ui.heading("USB Cable (Wired)")'),
])

# ---- Build fixes for this ALVR version (skipped when ALVR already has them) ----
def compat(rel, old, new, regex=False):
    p = SRC / rel
    if not p.exists():
        return
    s = p.read_text(encoding="utf-8")
    s2 = re.sub(old, new, s, flags=re.S) if regex else s.replace(old, new)
    if s2 != s:
        p.write_text(s2, encoding="utf-8")
        changes.append(f"build fix in {rel}: {old[:40]!r}")

# The FFmpeg 7.1 download ALVR 20.14 asks for is gone; use 8.1 (what newer ALVR uses).
compat("alvr/xtask/src/dependencies.rs", "ffmpeg-n7.1-latest-win64-gpl-shared-7.1", "ffmpeg-n8.1-latest-win64-gpl-shared-8.1")
# FFmpeg 8 renamed these.
compat("alvr/server_openvr/cpp/platform/win32/VideoEncoderSW.cpp", r"\bFF_PROFILE_H264_", "AV_PROFILE_H264_", regex=True)

# Newer Cargo puts build scripts' OUT_DIR one level deeper, so "four folders up" no longer
# reaches target/. Look for the folder named "target" instead.
compat("alvr/filesystem/src/lib.rs",
       r"pub fn target_dir\(\) -> PathBuf \{.*?\n\}",
       'pub fn target_dir() -> PathBuf {\n'
       '    let out = Path::new(env!("OUT_DIR"));\n'
       '    out.ancestors()\n'
       '        .find(|p| p.file_name().is_some_and(|n| n == "target"))\n'
       '        .unwrap_or_else(|| out.parent().unwrap().parent().unwrap().parent().unwrap().parent().unwrap())\n'
       '        .to_owned()\n'
       '}', regex=True)

# Use the licence tool newer ALVR uses (the old one doesn't know the Ubuntu font licence).
compat("alvr/xtask/src/packaging.rs", '"cargo install cargo-about --version 0.6.4"', '"cargo install cargo-about --version 0.8.4 --locked"')
compat("alvr/xtask/src/packaging.rs",
       r'let licenses_content = cmd!\(sh, "cargo about generate \{licenses_template\}"\)\s*\.read\(\)\s*\.unwrap\(\);\s*sh\.write_file\(licenses_dir\.join\("dependencies\.html"\), licenses_content\)\s*\.unwrap\(\);',
       'let licenses_output = licenses_dir.join("dependencies.html");\n'
       '    cmd!(sh, "cargo about generate {licenses_template} -o {licenses_output}").run().unwrap();', regex=True)
compat("about.toml", '    "BSD-3-Clause",\n', '    "BSD-3-Clause",\n    "bzip2-1.0.6",\n    "CDLA-Permissive-2.0",\n')

# ---- Our own signing key, so updates install over the top ----
out = SRC / "build/alvr_client_android"
out.mkdir(parents=True, exist_ok=True)
shutil.copyfile(KEYSTORE, out / "debug.keystore")  # the build only makes a key if this is missing
changes.append("signing key: Cloud Desktop's own")

print("Cloud Desktop branding applied:")
for c in changes:
    print("  -", c)
