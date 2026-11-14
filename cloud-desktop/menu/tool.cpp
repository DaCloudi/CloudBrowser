// Cloud Desktop Tool: the in-headset menu for desktop mode, and quick commands.
//
//   CloudDesktopTool.exe recenter      put the desktop screens back in front of you
//   CloudDesktopTool.exe menu <dir>    run the menu overlay (CloudBrowser sends "toggle", "show",
//                                      "hide", "quit" on stdin; button presses come back on stdout
//                                      as "click CODE")
//
// Screens are Desktop+ overlays placed in SteamVR's seated space, so recentering is just
// resetting the seated position to where your head is now. Size, distance and curve are changed
// by sending Desktop+ the same window messages its own settings window uses.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <openvr.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "dplus_ids.h"
#include "menu_layout.h"

#pragma comment(lib, "openvr_api.lib")
#pragma comment(lib, "user32.lib")

// ---------- Desktop+ ----------

static void DesktopPlusPost(const wchar_t* message, WPARAM w, LPARAM l) {
    HWND win = FindWindowW(L"elvdesktop", nullptr);
    if (win) PostMessageW(win, RegisterWindowMessageW(message), w, l);
}
static void DesktopPlusFloat(int id, float value) {
    DesktopPlusPost(L"WMIPC_DPLUS_SetConfig", DP_ID_INT_CURRENT_OVERLAY, 1); // the screen in the room (Overlay1)
    uint32_t bits;
    memcpy(&bits, &value, sizeof(bits));
    DesktopPlusPost(L"WMIPC_DPLUS_SetConfig", id, (LPARAM)bits);
}
static void DesktopPlusAction(int action, LPARAM value) {
    DesktopPlusPost(L"WMIPC_DPLUS_SetConfig", DP_ID_INT_CURRENT_OVERLAY, 1);
    DesktopPlusPost(L"WMIPC_DPLUS_Action", action, value);
}

static void Recenter() {
    vr::VRChaperone()->ResetZeroPose(vr::TrackingUniverseSeated);
}

// ---------- the menu overlay ----------

static float g_width = 2.2f, g_curve = 0.2f; // matches Cloud Desktop's Desktop+ starting settings

static void Say(const char* text) {
    printf("%s\n", text);
    fflush(stdout);
}

static int HitTest(float x, float y) {
    for (int i = 0; i < MENU_COUNT; i++) {
        const int* r = MENU_RECTS[i];
        if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return i;
    }
    return -1;
}

static void PlaceInFront(vr::VROverlayHandle_t overlay) {
    vr::TrackedDevicePose_t pose;
    vr::VRSystem()->GetDeviceToAbsoluteTrackingPose(vr::TrackingUniverseStanding, 0, &pose, 1);
    if (!pose.bPoseIsValid) return;
    const vr::HmdMatrix34_t& m = pose.mDeviceToAbsoluteTracking;
    // Forward is -Z of the head; keep it level (yaw only).
    float fx = -m.m[0][2], fz = -m.m[2][2];
    float len = sqrtf(fx * fx + fz * fz);
    if (len < 0.001f) { fx = 0; fz = -1; len = 1; }
    fx /= len; fz /= len;
    const float dist = 0.65f;
    float px = m.m[0][3] + fx * dist, py = m.m[1][3] - 0.18f, pz = m.m[2][3] + fz * dist;
    // Face the viewer: the overlay's +Z points back at the head; tilt up a little.
    float yaw = atan2f(-fx, -fz);
    float c = cosf(yaw), s = sinf(yaw);
    float tilt = 0.25f, ct = cosf(tilt), st = sinf(tilt);
    vr::HmdMatrix34_t t = {{
        {c, s * st, s * ct, px},
        {0, ct, -st, py},
        {-s, c * st, c * ct, pz},
    }};
    vr::VROverlay()->SetOverlayTransformAbsolute(overlay, vr::TrackingUniverseStanding, &t);
}

static int RunMenu(const std::string& dir) {
    vr::EVRInitError err = vr::VRInitError_None;
    vr::VR_Init(&err, vr::VRApplication_Overlay);
    if (err != vr::VRInitError_None) { Say("error vr"); return 1; }

    vr::VROverlayHandle_t overlay = vr::k_ulOverlayHandleInvalid;
    if (vr::VROverlay()->CreateOverlay("cloud.desktop.menu", "Cloud Desktop", &overlay) != vr::VROverlayError_None) {
        Say("error overlay");
        vr::VR_Shutdown();
        return 2;
    }
    vr::VROverlay()->SetOverlayWidthInMeters(overlay, 0.62f);
    vr::VROverlay()->SetOverlayInputMethod(overlay, vr::VROverlayInputMethod_Mouse);
    vr::HmdVector2_t scale = {(float)MENU_W, (float)MENU_H};
    vr::VROverlay()->SetOverlayMouseScale(overlay, &scale);
    vr::VROverlay()->SetOverlayFlag(overlay, vr::VROverlayFlags_MakeOverlaysInteractiveIfVisible, true);
    vr::VROverlay()->SetOverlaySortOrder(overlay, 100);

    int shownImage = -2;
    auto setImage = [&](int hover) {
        if (hover == shownImage) return;
        shownImage = hover;
        std::string file = dir + (hover < 0 ? "\\menu.png" : "\\menu_" + std::to_string(hover) + ".png");
        vr::VROverlay()->SetOverlayFromFile(overlay, file.c_str());
    };
    setImage(-1);

    // Commands from CloudBrowser arrive on stdin, one per line.
    std::mutex lock;
    std::vector<std::string> inbox;
    std::atomic<bool> stdinClosed{false};
    std::thread reader([&] {
        char line[256];
        while (fgets(line, sizeof(line), stdin)) {
            std::string s(line);
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            std::lock_guard<std::mutex> g(lock);
            inbox.push_back(s);
        }
        stdinClosed = true;
    });
    reader.detach();

    auto show = [&](bool on) {
        if (on) { PlaceInFront(overlay); setImage(-1); vr::VROverlay()->ShowOverlay(overlay); }
        else vr::VROverlay()->HideOverlay(overlay);
        Say(on ? "menu shown" : "menu hidden");
    };

    Say("ready");
    bool running = true;
    while (running) {
        std::vector<std::string> todo;
        { std::lock_guard<std::mutex> g(lock); todo.swap(inbox); }
        for (const std::string& cmd : todo) {
            if (cmd == "toggle") show(!vr::VROverlay()->IsOverlayVisible(overlay));
            else if (cmd == "show") show(true);
            else if (cmd == "hide") show(false);
            else if (cmd == "recenter") Recenter();
            else if (cmd == "quit") running = false;
        }
        if (stdinClosed) running = false; // CloudBrowser went away

        vr::VREvent_t ev;
        while (vr::VROverlay()->PollNextOverlayEvent(overlay, &ev, sizeof(ev))) {
            if (ev.eventType == vr::VREvent_MouseMove) {
                setImage(HitTest(ev.data.mouse.x, MENU_H - ev.data.mouse.y));
            } else if (ev.eventType == vr::VREvent_FocusLeave) {
                setImage(-1);
            } else if (ev.eventType == vr::VREvent_MouseButtonUp && ev.data.mouse.button == vr::VRMouseButton_Left) {
                int hit = HitTest(ev.data.mouse.x, MENU_H - ev.data.mouse.y);
                if (hit < 0) continue;
                std::string code = MENU_CODES[hit];
                if (code == "RECENTER") Recenter();
                else if (code == "KEYBOARD") DesktopPlusAction(DP_ACT_ACTION_DO, 1); // Desktop+'s "Show keyboard" action
                else if (code == "BIGGER") DesktopPlusFloat(DP_ID_FLOAT_WIDTH, g_width = fminf(g_width * 1.15f, 8.0f));
                else if (code == "SMALLER") DesktopPlusFloat(DP_ID_FLOAT_WIDTH, g_width = fmaxf(g_width / 1.15f, 0.5f));
                else if (code == "CLOSER") DesktopPlusAction(DP_ACT_POSITION_ADJUST, DP_ADJ_FORWBACK);
                else if (code == "FURTHER") DesktopPlusAction(DP_ACT_POSITION_ADJUST, DP_ADJ_FORWBACK | DP_ADJ_INCREASE);
                else if (code == "CURVE_MORE") DesktopPlusFloat(DP_ID_FLOAT_CURVATURE, g_curve = fminf(g_curve + 0.1f, 1.0f));
                else if (code == "CURVE_LESS") DesktopPlusFloat(DP_ID_FLOAT_CURVATURE, g_curve = fmaxf(g_curve - 0.1f, 0.0f));
                std::string msg = "click " + code;
                Say(msg.c_str());
                if (code == "CLOSE" || code == "EXIT" || code == "RECENTER") show(false);
            }
        }
        vr::VREvent_t sys;
        while (vr::VRSystem()->PollNextEvent(&sys, sizeof(sys))) {
            if (sys.eventType == vr::VREvent_Quit) running = false;
        }
        Sleep(11);
    }
    vr::VROverlay()->DestroyOverlay(overlay);
    vr::VR_Shutdown();
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    std::wstring mode = argc > 1 ? argv[1] : L"";
    if (mode == L"recenter") {
        vr::EVRInitError err = vr::VRInitError_None;
        vr::VR_Init(&err, vr::VRApplication_Utility);
        if (err != vr::VRInitError_None) return 1;
        Recenter();
        vr::VR_Shutdown();
        return 0;
    }
    if (mode == L"menu" && argc > 2) {
        char dir[MAX_PATH * 3];
        WideCharToMultiByte(CP_UTF8, 0, argv[2], -1, dir, sizeof(dir), nullptr, nullptr);
        return RunMenu(dir);
    }
    fprintf(stderr, "usage: CloudDesktopTool recenter | menu <images folder>\n");
    return 2;
}
