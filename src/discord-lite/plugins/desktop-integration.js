// ==Discord Lite plugin==
// @version 12
// Desktop Integration
//  - Opens web links in your default browser (Discord's "Leaving Discord" warning still works)
//  - Desktop notifications through Windows
//  - Unread / mention badge on the tray icon and taskbar
//  - Ctrl+, opens Discord Lite's Settings
//  - "Read all" button in the server list (marks every server as read)
//  - Plain, solid-colour server folders
//  - Discord Lite logo on the Direct Messages (home) button
//  - Windows title bar painted to match the top of Discord
//  - "Main" section above Direct Messages (right-click a DM > Pin DMs > Main), via Vencord PinDMs
//  - Direct Messages starts collapsed; click its heading to open it
//  - Ctrl+Alt+C: capture the page's structure (no text/images/IDs) to help tune the theme
//  - Reloads Discord if it goes blank or shows its crash screen (with the app's freeze watchdog)
//
// Options are in Settings (tray icon > Settings > Desktop).
// Rename this file to _desktop-integration.js to turn it off.

(() => {
    "use strict";

    const TAG = "[Desktop Integration]";
    const settings = () => window.__DL_SETTINGS || {};

    function invoke(cmd, args) {
        try {
            const t = window.__TAURI_INTERNALS__;
            if (!t) return Promise.resolve();
            return Promise.resolve(t.invoke(cmd, args)).catch(e => console.warn(TAG, cmd, e));
        } catch (e) {
            console.warn(TAG, e);
            return Promise.resolve();
        }
    }

    // ---------- 1. Links in your browser ----------

    const DISCORD_HOSTS = ["discord.com", "discordapp.com", "discord.gg", "discord.new", "discordapp.net"];

    function externalUrl(raw) {
        try {
            const u = new URL(String(raw), location.href);
            if (u.protocol !== "https:" && u.protocol !== "http:") return null;
            const h = u.hostname;
            if (DISCORD_HOSTS.some(d => h === d || h.endsWith("." + d))) return null;
            return u.href;
        } catch {
            return null;
        }
    }

    // Plain link clicks. Runs *after* Discord's own handlers (bubble phase on window), so if
    // Discord shows its "Leaving Discord" warning it will have called preventDefault and we
    // stay out of the way; its "Visit site" button then goes through window.open below.
    function onLinkClick(e) {
        if (!settings().openLinksInBrowser || e.defaultPrevented) return;
        if (e.type === "click" && e.button !== 0) return;
        if (e.type === "auxclick" && e.button !== 1) return;
        const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        const url = externalUrl(a.href);
        if (!url) return;
        e.preventDefault();
        invoke("dl_open_external", { url });
    }
    window.addEventListener("click", onLinkClick);
    window.addEventListener("auxclick", onLinkClick);

    const origOpen = window.open;
    window.open = function (url, ...rest) {
        const ext = settings().openLinksInBrowser ? externalUrl(url) : null;
        if (ext) {
            invoke("dl_open_external", { url: ext });
            return null;
        }
        return origOpen.call(this, url, ...rest);
    };

    // ---------- 2. Notifications ----------

    // Discord shows notifications with the browser's Notification API. Route them to
    // Windows notifications instead (permission is always "granted" here; the on/off
    // switch is in Settings and in Discord's own Notifications settings).
    class DLNotification extends EventTarget {
        constructor(title, options = {}) {
            super();
            this.title = String(title ?? "");
            this.body = String(options.body ?? "");
            this.tag = options.tag ?? "";
            this.icon = options.icon ?? "";
            this.data = options.data;
            this.onclick = null;
            this.onclose = null;
            this.onerror = null;
            this.onshow = null;
            invoke("dl_notify", { title: this.title, body: this.body });
            setTimeout(() => {
                try { this.onshow && this.onshow(new Event("show")); } catch { /* ignore */ }
            }, 0);
        }
        close() {
            try { this.onclose && this.onclose(new Event("close")); } catch { /* ignore */ }
        }
        static get permission() { return "granted"; }
        static requestPermission(cb) {
            if (typeof cb === "function") cb("granted");
            return Promise.resolve("granted");
        }
    }
    try {
        Object.defineProperty(window, "Notification", { value: DLNotification, configurable: true, writable: true });
    } catch (e) {
        console.warn(TAG, "couldn't replace Notification", e);
    }

    // ---------- 3. Unread badge ----------

    // Discord's tab title shows "(3) Discord | …" for mentions and "• Discord | …" for unreads.
    let lastBadge = "";
    function checkTitle() {
        if (!settings().unreadBadge) { lastBadge = ""; return; }
        const t = document.title || "";
        const m = t.match(/^\((\d+)\)/);
        const mentions = m ? parseInt(m[1], 10) : 0;
        const unread = mentions > 0 || /^[•●]/.test(t);
        const key = mentions + ":" + unread;
        if (key === lastBadge) return;
        lastBadge = key;
        invoke("dl_set_unread", { mentions, unread });
    }
    setInterval(checkTitle, 1500);

    // ---------- 4. Ctrl+, opens Settings ----------

    document.addEventListener("keydown", e => {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Comma") {
            e.preventDefault();
            e.stopPropagation();
            invoke("dl_open_settings");
        }
    }, true);

    // ---------- 5. Freeze / blank-screen recovery ----------

    // Heartbeat for the app's watchdog: if these stop while the window is on screen,
    // the app pings once and then reloads Discord.
    const beat = () => invoke("dl_heartbeat");
    window.__dlPing = beat;
    setInterval(beat, 10000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
    beat();

    // The page is running but showing nothing (or Discord's crash screen) for a while: reload.
    let badChecks = 0;
    setInterval(() => {
        if (settings().autoRecover === false || document.hidden || !navigator.onLine) { badChecks = 0; return; }
        const mount = document.getElementById("app-mount");
        const text = mount ? (mount.innerText || "") : "";
        const blank = !mount || mount.childElementCount === 0;
        const crashed = text.length < 600 && /something went wrong|whoops/i.test(text);
        badChecks = blank || crashed ? badChecks + 1 : 0;
        if (badChecks >= 3) { // ~45 seconds in a row
            console.warn(TAG, "Discord looks blank/crashed, reloading");
            badChecks = 0;
            location.reload();
        }
    }, 15000);

    // ---------- 6. "Read all" button ----------

    function stores() {
        const W = window.Vencord && window.Vencord.Webpack;
        if (!W) return null;
        const C = W.Common || {};
        const find = name => {
            try { return C[name] || (W.findStore && W.findStore(name)) || null; } catch { return null; }
        };
        return {
            flux: C.FluxDispatcher,
            guilds: find("GuildStore"),
            guildChannels: find("GuildChannelStore"),
            readState: find("ReadStateStore"),
            threads: find("ActiveJoinedThreadsStore"),
        };
    }

    // Same approach as Vencord's ReadAllNotificationsButton: acknowledge every unread
    // channel and thread in every server in one go.
    function markAllRead() {
        const s = stores();
        if (!s || !s.flux || !s.guilds || !s.guildChannels || !s.readState) {
            console.warn(TAG, "read all: Discord isn't ready yet");
            return -1;
        }
        const channels = [];
        const add = id => {
            try {
                if (!id || !s.readState.hasUnread(id)) return;
                channels.push({ channelId: id, messageId: s.readState.lastMessageId(id), readStateType: 0 });
            } catch { /* ignore */ }
        };
        for (const g of Object.values(s.guilds.getGuilds() || {})) {
            const list = s.guildChannels.getChannels(g.id) || {};
            for (const c of [...(list.SELECTABLE || []), ...(list.VOCAL || [])]) add(c.channel && c.channel.id);
            try {
                const byParent = (s.threads && s.threads.getActiveJoinedThreadsForGuild(g.id)) || {};
                for (const group of Object.values(byParent)) {
                    for (const t of Object.values(group || {})) add((t.channel && t.channel.id) || t.id);
                }
            } catch { /* ignore */ }
        }
        if (channels.length) s.flux.dispatch({ type: "BULK_ACK", context: "APP", channels });
        return channels.length;
    }
    window.__dlMarkAllRead = markAllRead;

    const CHECKS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12.5 6.5 17 15 7.5"/><path d="M10 15.5l1.5 1.5L22 7.5"/></svg>';

    function addReadAllButton() {
        const existing = document.getElementById("dl-read-all");
        if (!settings().readAllButton) { if (existing) existing.parentElement.remove(); return; }
        if (existing) return;
        // Put it right under the Direct Messages button, above the line of servers.
        const sep = document.querySelector('[class*="guilds_"] [class*="guildSeparator_"]');
        if (!sep) return;
        const anchor = sep.closest('[class*="listItem_"]') || sep.parentElement;
        const wrap = document.createElement("div");
        wrap.className = "dl-read-all-wrap";
        const b = document.createElement("div");
        b.id = "dl-read-all";
        b.setAttribute("role", "button");
        b.setAttribute("aria-label", "Mark all servers as read");
        b.title = "Mark all servers as read";
        b.tabIndex = 0;
        b.innerHTML = CHECKS;
        const run = () => {
            const n = markAllRead();
            b.classList.add("dl-done");
            b.title = n > 0 ? `Marked ${n} channel${n === 1 ? "" : "s"} as read` : n === 0 ? "Nothing unread" : "Try again in a moment";
            setTimeout(() => { b.classList.remove("dl-done"); b.title = "Mark all servers as read"; }, 1500);
        };
        b.onclick = run;
        b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") run(); };
        wrap.appendChild(b);
        anchor.before(wrap);
    }

    // ---------- 7. Plain, solid-colour folders ----------

    const FOLDER = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.2c.6 0 1.2.25 1.6.7l1.3 1.3h5.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';

    // "rgb(r, g, b)" from any CSS colour string, or null if it's fully see-through.
    function rgbOf(str) {
        const m = str && str.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/);
        if (!m) return null;
        if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
        return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
    }

    // Every folder (open or closed) is a button with aria-expanded; servers aren't.
    function folderTiles() {
        const tiles = new Set();
        document.querySelectorAll('[class*="guilds_"] [aria-expanded]').forEach(btn => {
            const fo = btn.querySelector("foreignObject");
            const tile = (fo && fo.firstElementChild) ||
                btn.querySelector('[class*="folderIconWrapper"], [class*="closedFolderIconWrapper"]');
            if (tile) tiles.add(tile);
        });
        document.querySelectorAll('[class*="guilds_"] [class*="folderIconWrapper_"]').forEach(t => tiles.add(t));
        return [...tiles];
    }

    // The folder's colour: Discord uses it as a see-through background (closed) or as the
    // folder icon colour (open). Take it at full strength.
    function folderColor(tile) {
        const els = [tile, ...tile.querySelectorAll("*")].slice(0, 25);
        for (const el of els) {
            const c = rgbOf(el.style && el.style.backgroundColor) || rgbOf(getComputedStyle(el).backgroundColor);
            if (c) return c;
        }
        for (const svg of tile.querySelectorAll("svg")) {
            const c = rgbOf(svg.style.color || getComputedStyle(svg).color);
            if (c && c !== "rgb(255, 255, 255)") return c;
        }
        return null;
    }

    function plainFolders() {
        const on = !!settings().plainFolders;
        if (!on) {
            document.querySelectorAll("[data-dl-plain]").forEach(w => {
                w.removeAttribute("data-dl-plain");
                w.querySelector(".dl-folder-glyph")?.remove();
            });
            return;
        }
        for (const w of folderTiles()) {
            if (!w.hasAttribute("data-dl-plain")) {
                const color = folderColor(w); // read before we restyle it
                if (color) w.setAttribute("data-dl-color", color);
            }
            const color = w.getAttribute("data-dl-color");
            if (color) w.style.setProperty("--dl-folder", color);
            w.setAttribute("data-dl-plain", "");
            if (!w.querySelector(".dl-folder-glyph")) {
                const g = document.createElement("span");
                g.className = "dl-folder-glyph";
                g.innerHTML = FOLDER;
                w.appendChild(g);
            }
        }
    }

    // ---------- 8. Our logo on the home (Direct Messages) button ----------

    const LOGO = '<svg class="dl-logo" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">' +
        '<rect width="48" height="48" rx="14" fill="#000"/>' +
        '<rect x="10.3" y="13.1" width="27.4" height="17.8" rx="5.6" fill="#fff"/>' +
        '<path d="M15.9 30 14.1 37.5 22.5 30.5z" fill="#fff"/>' +
        '<circle cx="17.8" cy="22" r="2.1" fill="#000"/><circle cx="24" cy="22" r="2.1" fill="#000"/>' +
        '<circle cx="30.2" cy="22" r="2.1" fill="#000"/></svg>';

    function brandHome() {
        const home = document.querySelector('[class*="guilds_"] [data-list-item-id="guildsnav___home"]') ||
            document.querySelector('[class*="guilds_"] [aria-label="Direct Messages"]') ||
            document.querySelector('nav [data-list-item-id="guildsnav___home"]');
        if (!home) return;
        // Discord draws each server button as <svg><foreignObject><div>icon</div></foreignObject></svg>
        const fo = home.querySelector("foreignObject");
        const wrap = (fo && fo.firstElementChild) || home.querySelector('[class*="childWrapper"]');
        if (!wrap || wrap.querySelector(".dl-logo")) return;
        wrap.setAttribute("data-dl-logo", "");
        wrap.insertAdjacentHTML("beforeend", LOGO);
    }

    const style = document.createElement("style");
    style.id = "dl-desktop-integration";
    style.textContent = `
      [data-dl-logo] { background: transparent !important; position: relative; }
      [data-dl-logo] > svg:not(.dl-logo), [data-dl-logo] > img { display: none !important; }
      [data-dl-logo]::after { display: none !important; }
      [data-dl-logo] .dl-logo { position: absolute; inset: 0; width: 100%; height: 100%; }
      [data-dl-logo] .dl-logo rect:first-child { rx: 14px; }
      .dl-read-all-wrap { display: flex; justify-content: center; margin: 0 0 8px; }
      #dl-read-all {
        width: 40px; height: 40px; border-radius: 12px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        background: var(--cl-bg-3, var(--background-surface-high, #2b2d31));
        color: var(--cl-text-muted, var(--interactive-normal, #b5bac1));
      }
      #dl-read-all:hover { color: var(--cl-text-strong, #fff); background: var(--cl-strong, rgba(255,255,255,.13)); }
      #dl-read-all.dl-done { color: #3ba55d; }
      [data-dl-plain] {
        background-color: var(--dl-folder, var(--cl-accent, #5865f2)) !important;
        border-radius: 14px !important; position: relative;
      }
      [data-dl-plain] > *:not(.dl-folder-glyph) { visibility: hidden !important; }
      [data-dl-plain] .dl-folder-glyph {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #fff; pointer-events: none; visibility: visible !important;
      }
      [class*="guilds_"] [class*="expandedFolderBackground_"] {
        background: var(--cl-hover, rgba(255,255,255,.05)) !important; border-radius: 16px !important;
      }
    `;
    const addStyle = () => (document.head || document.documentElement).appendChild(style);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addStyle); else addStyle();

    // The server list re-renders often; a light check every second keeps both in place.
    setInterval(() => {
        try { addReadAllButton(); } catch (e) { /* ignore */ }
        try { plainFolders(); } catch (e) { /* ignore */ }
        try { brandHome(); } catch (e) { /* ignore */ }
    }, 1000);

    // ---------- 9. Layout capture for theme tuning (Ctrl+Alt+C, or tray menu) ----------
    // Saves the *structure* of what's on screen (part names only) so the theme can target
    // Discord's real elements. All text, names, images, links and IDs are removed.

    const KEEP_ATTRS = new Set(["class", "role", "aria-expanded", "aria-selected", "aria-checked",
        "aria-hidden", "type", "data-list-id", "tabindex"]);

    function sanitize(node, budget) {
        if (budget.n-- <= 0) return null;
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.trim() ? document.createTextNode("…") : null;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const tag = node.tagName.toLowerCase();
        if (["script", "style", "link", "meta", "noscript"].includes(tag)) return null;
        const el = document.createElement(tag === "foreignobject" ? "div" : tag);
        for (const a of node.attributes) {
            if (KEEP_ATTRS.has(a.name)) el.setAttribute(a.name, a.value.replace(/\d{6,}/g, "#"));
            else if (a.name === "aria-label") el.setAttribute("aria-label", "…");
            else if (a.name === "data-list-item-id") el.setAttribute(a.name, a.value.replace(/\d{6,}/g, "#"));
        }
        if (tag === "svg") return el; // icons: shape not needed
        for (const child of node.childNodes) {
            const c = sanitize(child, budget);
            if (c) el.appendChild(c);
        }
        return el;
    }

    function captureLayout() {
        const budget = { n: 12000 };
        const out = document.createElement("div");
        // Pop-ups (profile cards, pickers, menus, modals) live in Discord's "layer" containers.
        const layers = document.querySelectorAll('[class*="layerContainer_"], [class*="layers_"] > [class*="layer_"]');
        const popups = document.createElement("section");
        popups.setAttribute("data-capture", "popups");
        layers.forEach(l => { const c = sanitize(l, budget); if (c) popups.appendChild(c); });
        out.appendChild(popups);
        // The main app (server list, channels, chat, members), for reference.
        const app = document.getElementById("app-mount");
        const main = document.createElement("section");
        main.setAttribute("data-capture", "app");
        if (app) { const c = sanitize(app, budget); if (c) main.appendChild(c); }
        out.appendChild(main);
        const theme = document.documentElement.className.replace(/\d{6,}/g, "#");
        const html = `<!-- Discord Lite layout capture: structure only, no content -->\n` +
            `<html class="${theme}"><body>\n${out.innerHTML}\n</body></html>`;
        const t = window.__TAURI_INTERNALS__;
        if (!t) { toast("Capture failed: can't reach Discord Lite", true); return; }
        Promise.resolve(t.invoke("dl_save_capture", { html }))
            .then(name => toast(`Layout captured (${Math.round(html.length / 1024)} KB). Tell Claude you're done.`))
            .catch(err => toast("Capture failed: " + err, true));
    }

    // Small on-screen message (doesn't rely on Windows notifications).
    function toast(text, bad) {
        const el = document.createElement("div");
        el.textContent = text;
        Object.assign(el.style, {
            position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)",
            zIndex: 2147483647, padding: "10px 16px", borderRadius: "12px",
            font: "500 14px system-ui, 'Segoe UI', sans-serif",
            background: bad ? "#5c1d22" : "#13202f", color: "#fff",
            border: "1px solid " + (bad ? "#f2555a" : "rgba(255,255,255,.12)"),
            boxShadow: "0 0 12px rgba(0,0,0,.5)", pointerEvents: "none",
        });
        (document.body || document.documentElement).appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }
    window.__dlToast = toast;

    window.__dlCapture = () => {
        try { captureLayout(); } catch (err) { toast("Capture failed: " + err, true); }
    };
    // From the tray: count down, so there's time to open a pop-up first.
    window.__dlCaptureSoon = () => {
        toast("Capturing in 5 seconds: open the pop-up now");
        setTimeout(window.__dlCapture, 5000);
    };

    // Ctrl+Alt+C (Ctrl+Shift+D is Discord's own Deafen shortcut).
    window.addEventListener("keydown", e => {
        if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyC") {
            e.preventDefault();
            e.stopPropagation();
            window.__dlCapture();
        }
    }, true);

    // ---------- 10. Title bar colour ----------
    // Read the colour at the very top of Discord (whatever theme is on) and paint the
    // Windows title bar to match.
    let lastTitlebar = "";
    function opaqueBg(el) {
        for (; el && el !== document.documentElement; el = el.parentElement) {
            const m = getComputedStyle(el).backgroundColor.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
            if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) return [+m[1], +m[2], +m[3]];
        }
        const m = getComputedStyle(document.body || document.documentElement).backgroundColor
            .match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
    }
    function syncTitlebar() {
        const bar = document.querySelector('[class*="base_"] > [class*="bar_"]:not([class*="sidebar"])') ||
            document.getElementById("app-mount");
        const rgb = bar && opaqueBg(bar);
        if (!rgb) return;
        const key = rgb.join(",");
        if (key === lastTitlebar) return;
        lastTitlebar = key;
        invoke("dl_set_titlebar", { r: rgb[0], g: rgb[1], b: rgb[2] });
    }
    setInterval(() => { try { syncTitlebar(); } catch { /* ignore */ } }, 2000);

    // ---------- 11. "Main" pinned section + collapsed Direct Messages ----------
    // Uses Vencord's PinDMs plugin, so pinned people are Discord's own rows: nicknames,
    // right-click menus, typing, unread badges and calls all work as normal.
    // Discord Lite turns PinDMs on once, makes a "Main" category, and closes the
    // Direct Messages section every time the app starts.
    // Add someone: right-click their DM > Pin DMs > Main.

    const PIN_TRIED = "discord-lite:pindms-enabled-once";
    const MAIN_MADE = "discord-lite:main-category-made:";
    const OLD_MAIN = "discord-lite:main-dms";
    const MAIN_COLOR = 10070709; // PinDMs default grey; change it from right-click > Pin DMs > Edit category

    const pinSettings = () => window.Vencord?.Settings?.plugins?.PinDMs || null;
    const pinDmsOn = () => !!pinSettings()?.enabled;

    // Start with Direct Messages closed. Set as early as possible (before the list is
    // drawn) and again when the app closes.
    function startCollapsed() {
        const p = pinSettings();
        if (!p) return false;
        p.canCollapseDmSection = true;
        p.dmSectionCollapsed = true;
        return true;
    }
    const earlyTimer = setInterval(() => {
        try { if (startCollapsed() || performance.now() > 30000) clearInterval(earlyTimer); } catch { /* ignore */ }
    }, 50);
    addEventListener("beforeunload", () => { try { startCollapsed(); } catch { /* ignore */ } });

    // Make the "Main" category once per account (if you delete it, it stays deleted).
    function ensureMain(me) {
        const p = pinSettings();
        if (!p) return false;
        try { if (localStorage.getItem(MAIN_MADE + me)) return false; } catch { return false; }
        const all = p.userBasedCategoryList || {};
        const cats = Array.isArray(all[me]) ? all[me] : [];
        let changed = false;
        if (!cats.some(c => c && String(c.name).toLowerCase() === "main")) {
            let carried = [];
            try { carried = JSON.parse(localStorage.getItem(OLD_MAIN) || "[]").map(d => d && d.id).filter(id => /^\d+$/.test(id || "")); } catch { /* ignore */ }
            cats.unshift({ id: "dl-main", name: "Main", color: MAIN_COLOR, collapsed: false, channels: carried });
            p.userBasedCategoryList = { ...all, [me]: cats };
            changed = true;
        }
        try { localStorage.setItem(MAIN_MADE + me, "1"); localStorage.removeItem(OLD_MAIN); } catch { /* ignore */ }
        return changed;
    }

    function setupPinDms() {
        const V = window.Vencord;
        const p = pinSettings();
        if (!V || !p) return;
        const me = V.Webpack?.Common?.UserStore?.getCurrentUser?.()?.id;
        if (!me) return;
        clearInterval(pinTimer);

        p.canCollapseDmSection = true;
        let needReload = ensureMain(me);
        if (!p.enabled) {
            let tried = false;
            try { tried = localStorage.getItem(PIN_TRIED) === "1"; localStorage.setItem(PIN_TRIED, "1"); } catch { /* ignore */ }
            if (tried) return; // you turned it off yourself; leave it off
            p.enabled = true;
            needReload = true;
        }
        if (needReload) {
            toast("Setting up your Main section…");
            setTimeout(() => location.reload(), 1500);
        }
    }
    const pinTimer = setInterval(() => { try { setupPinDms(); } catch (e) { console.warn(TAG, "pindms", e); } }, 1000);

    // ---------- Fallback when PinDMs isn't available: click "Direct Messages" to collapse ----------

    let dmsCollapsed = true;

    const CHEVRON = '<svg class="dl-dm-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 9l6 6 6-6"/></svg>';

    function findDmHeader() {
        const byName = document.querySelector('[class*="privateChannelsHeaderContainer_"]');
        if (byName) return byName;
        const list = document.querySelector('[class*="privateChannels_"]') || document.querySelector('nav[aria-label]');
        if (!list) return null;
        for (const el of list.querySelectorAll("h2, h3, [class*='header']")) {
            if ((el.textContent || "").trim().toLowerCase() === "direct messages") return el.closest("h2, h3") || el;
        }
        return null;
    }

    function setupDmCollapse() {
        if (pinDmsOn()) {
            // PinDMs does the collapsing; take ours off if it was added before Vencord loaded.
            for (const h of document.querySelectorAll("[data-dl-dm-header]")) {
                h.removeAttribute("data-dl-dm-header");
                h.removeAttribute("data-dl-dms-collapsed");
                h.querySelector(":scope > .dl-dm-chevron")?.remove();
            }
            return;
        }
        const header = findDmHeader();
        if (!header) return;
        if (!header.hasAttribute("data-dl-dm-header")) {
            header.setAttribute("data-dl-dm-header", "");
            header.insertAdjacentHTML("afterbegin", CHEVRON);
            header.addEventListener("click", e => {
                if (!header.hasAttribute("data-dl-dm-header")) return;
                if (e.target.closest('[role="button"], button') && !e.target.closest(".dl-dm-chevron")) return;
                dmsCollapsed = !dmsCollapsed;
                applyDmCollapse(header);
            });
        }
        applyDmCollapse(header);
    }

    function applyDmCollapse(header) {
        if (dmsCollapsed) header.setAttribute("data-dl-dms-collapsed", "");
        else header.removeAttribute("data-dl-dms-collapsed");
        header.title = dmsCollapsed ? "Show direct messages" : "Hide direct messages";
    }

    const dmStyle = document.createElement("style");
    dmStyle.textContent = `
      [data-dl-dm-header] { cursor: pointer; user-select: none; display: flex; align-items: center; }
      [data-dl-dm-header]:hover { color: var(--cl-text, var(--interactive-hover)) !important; }
      [data-dl-dm-header] .dl-dm-chevron { flex: 0 0 auto; margin-right: 4px; transition: transform .15s; opacity: .8; }
      [data-dl-dms-collapsed] .dl-dm-chevron { transform: rotate(-90deg); }
      [data-dl-dm-header] .dl-dm-chevron + * { flex: 1 1 auto; text-align: left; }
      [data-dl-dms-collapsed] ~ * { display: none !important; }
    `;
    const addDmStyle = () => (document.head || document.documentElement).appendChild(dmStyle);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addDmStyle); else addDmStyle();
    setInterval(() => { try { setupDmCollapse(); } catch { /* ignore */ } }, 1000);


    console.log(TAG, "ready");
})();
