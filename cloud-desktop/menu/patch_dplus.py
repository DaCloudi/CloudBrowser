#!/usr/bin/env python3
"""Give Desktop+ Cloud Desktop's Virtual Desktop-style starting setup before it is built.

- A second screen (Overlay1, next to Desktop+'s dashboard one) starts curved, 2.2 m wide, 1.8 m in front of you, always visible (not only in
  the SteamVR dashboard), in SteamVR's seated space so "Recenter" can move it in front of you.
- Controllers (Quest Touch): trigger clicks, A/X right-clicks, thumbstick scrolls, and grip
  grabs and moves a screen.
Usage: python patch_dplus.py <DesktopPlus checkout>
"""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
cfg_path = root / "assets" / "config_default.ini"
raw = cfg_path.read_bytes()
bom = raw.startswith(b"\xef\xbb\xbf")
cfg = raw.decode("utf-8-sig")

overlay0 = re.search(r"\[Overlay0\](.*?)(?=\n\[)", cfg, re.S)
if not overlay0:
    sys.exit("patch_dplus.py: [Overlay0] not found")
body = overlay0.group(1)
want = {
    "Width": "220",
    "Curvature": "20",
    "DisplayMode": "0",          # always visible
    "Origin": "SeatedUniverse",  # recenter = reset seated position
    "TransformLocked": "false",
    "ShowBackside": "false",
    "Transform": "[1 0 0 0 0 1 0 0 0 0 1 0 0 -0.1 -1.8 1]",
}
# Overlay0 stays Desktop+'s dashboard screen; Overlay1 is the screen floating in the room.
for key, value in want.items():
    body, n = re.subn(rf"(?m)^{key}=.*$", f"{key}={value}", body)
    if n != 1:
        sys.exit(f"patch_dplus.py: {key} not found in [Overlay0]")
cfg = cfg[:overlay0.end(1)] + "\n[Overlay1]" + body.rstrip("\n") + "\n" + cfg[overlay0.end(1):]
cfg = re.sub(r"(?m)^QuickStartGuideHidden=.*$", "QuickStartGuideHidden=true", cfg)
cfg_path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + cfg.encode("utf-8"))
print("config_default.ini: VR-first main screen")

bind_path = root / "assets" / "input" / "action_bindings_touch.json"
binds = json.loads(bind_path.read_text(encoding="utf-8-sig"))
changed = 0
for src in binds["bindings"]["/actions/laserpointer"]["sources"]:
    if src["path"].endswith("/input/grip"):
        src["inputs"] = {"click": {"output": "/actions/laserpointer/in/Drag"}}
        changed += 1
if changed != 2:
    sys.exit(f"patch_dplus.py: expected 2 grip bindings, found {changed}")
bind_path.write_text(json.dumps(binds, indent=3), encoding="utf-8")
print("action_bindings_touch.json: grip grabs screens")
