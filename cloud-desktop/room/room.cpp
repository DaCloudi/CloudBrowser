// Cloud Desktop Room: the backdrop for passthrough desktop mode.
//
// A tiny SteamVR "scene" app that shows nothing but pure green (0, 255, 0) in every direction.
// The headset's chroma key turns that green into your real room (passthrough), so only the
// Desktop+ screens are left floating in front of you, like Virtual Desktop's passthrough.
// When a game starts, SteamVR asks this app to quit and it does.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <openvr.h>
#include <cstdint>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "openvr_api.lib")

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    vr::EVRInitError err = vr::VRInitError_None;
    vr::IVRSystem* system = vr::VR_Init(&err, vr::VRApplication_Scene);
    if (err != vr::VRInitError_None || !system) return 1;

    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, nullptr, &context))) {
        vr::VR_Shutdown();
        return 2;
    }

    // A small solid green texture; the compositor stretches it over each eye.
    const UINT side = 64;
    std::vector<uint32_t> pixels(side * side, 0xFF00FF00u);  // bytes R=0x00 G=0xFF B=0x00 A=0xFF
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = side;
    desc.Height = side;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init = {pixels.data(), side * 4, 0};
    ID3D11Texture2D* texture = nullptr;
    if (FAILED(device->CreateTexture2D(&desc, &init, &texture))) {
        vr::VR_Shutdown();
        return 3;
    }

    vr::Texture_t eye = {texture, vr::TextureType_DirectX, vr::ColorSpace_Gamma};
    vr::TrackedDevicePose_t poses[vr::k_unMaxTrackedDeviceCount];
    bool running = true;
    while (running) {
        vr::VREvent_t event;
        while (system->PollNextEvent(&event, sizeof(event))) {
            if (event.eventType == vr::VREvent_Quit) running = false;
        }
        if (!running) break;
        if (vr::VRCompositor()->WaitGetPoses(poses, vr::k_unMaxTrackedDeviceCount, nullptr, 0) != vr::VRCompositorError_None) {
            Sleep(10);
        }
        vr::VRCompositor()->Submit(vr::Eye_Left, &eye);
        vr::VRCompositor()->Submit(vr::Eye_Right, &eye);
    }

    texture->Release();
    context->Release();
    device->Release();
    vr::VR_Shutdown();
    return 0;
}
