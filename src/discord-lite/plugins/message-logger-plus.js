// ==Discord Lite plugin==
// @version 4
// Message Logger+
//  - Saves deleted and edited messages to disk (survives restarts)
//  - Downloads images/videos as they arrive, and keeps copies of the ones that get deleted
//  - Windows notification when someone ghost-pings you (pings, then deletes or edits it out)
//
//  - "Message Log" button in the channel header (or Ctrl+Shift+L) opens the log viewer
//
// Logs live in %APPDATA%\com.local.discordlite\message-log
// Needs Vencord (it uses Vencord's access to Discord's internals).
// Options are in Settings (tray icon > Settings). Rename to _message-logger-plus.js to turn off.

(() => {
    "use strict";

    // Options come from Settings (tray icon > Settings > Message Logger+) and update live.
    const DEFAULTS = {
        logDeletes: true,
        logEdits: true,
        ignoreOwnMessages: true,
        ignoreBots: true,
        logWhere: "all",              // "all" | "dms" | "servers"
        cacheAttachments: "all",      // "all" | "dms" | "off"
        maxAttachmentMb: 25,
        ghostPingAlerts: true,
        ghostPingWindowMinutes: 15,
        rememberMessages: 30000,
        showButton: true,
        shortcut: true,
    };
    const CONFIG = new Proxy({}, {
        get(_, key) {
            const live = (window.__DL_SETTINGS || {}).logger || {};
            return key in live ? live[key] : DEFAULTS[key];
        },
    });

    const TAG = "[Message Logger+]";
    const cache = new Map(); // message id -> slim message
    let C = null;            // Vencord.Webpack.Common

    // ---------- helpers ----------

    function invoke(cmd, args) {
        try {
            const t = window.__TAURI_INTERNALS__;
            if (!t) return;
            return Promise.resolve(t.invoke(cmd, args)).catch(e => console.warn(TAG, cmd, e));
        } catch (e) {
            console.warn(TAG, e);
        }
    }

    const safe = fn => (...a) => {
        try { fn(...a); } catch (e) { console.warn(TAG, e); }
    };

    function myId() {
        try { return C.UserStore.getCurrentUser()?.id ?? null; } catch { return null; }
    }

    function dateKey(d = new Date()) {
        const p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function ids(list) {
        return (list || []).map(x => (typeof x === "string" ? x : x?.id)).filter(Boolean);
    }

    function slimAttachment(a) {
        return {
            id: a.id,
            filename: a.filename,
            url: a.url,
            content_type: a.content_type || "",
            size: a.size || 0,
        };
    }

    function guildOf(channelId) {
        try { return C.ChannelStore.getChannel(channelId)?.guild_id ?? null; } catch { return null; }
    }

    function remember(raw, guildHint) {
        if (!raw?.id || !raw.author) return null;
        const slim = {
            id: raw.id,
            channel_id: raw.channel_id,
            guild_id: raw.guild_id ?? guildHint ?? guildOf(raw.channel_id),
            author: {
                id: raw.author.id,
                username: raw.author.username,
                global_name: raw.author.global_name ?? null,
                bot: !!raw.author.bot,
            },
            content: raw.content ?? "",
            timestamp: raw.timestamp ?? new Date().toISOString(),
            attachments: (raw.attachments || []).map(slimAttachment),
            mentions: ids(raw.mentions),
            mention_roles: raw.mention_roles || [],
            mention_everyone: !!raw.mention_everyone,
            deleted: false,
        };
        cache.delete(slim.id);
        cache.set(slim.id, slim);
        while (cache.size > CONFIG.rememberMessages) cache.delete(cache.keys().next().value);
        return slim;
    }

    function describeWhere(m) {
        try {
            const ch = C.ChannelStore.getChannel(m.channel_id);
            if (m.guild_id) {
                const g = C.GuildStore.getGuild(m.guild_id);
                return `${g?.name ?? "Unknown server"} › #${ch?.name ?? m.channel_id}`;
            }
            if (ch?.name) return `Group DM "${ch.name}"`;
            const names = (ch?.recipients || [])
                .map(id => C.UserStore.getUser(id)?.username)
                .filter(Boolean);
            return names.length ? `DM with ${names.join(", ")}` : `DM ${m.channel_id}`;
        } catch {
            return m.channel_id;
        }
    }

    function describeAuthor(a) {
        return a.global_name ? `${a.global_name} (@${a.username})` : `@${a.username}`;
    }

    // Group DMs count as DMs.
    function inScope(m) {
        if (CONFIG.logWhere === "dms") return !m.guild_id;
        if (CONFIG.logWhere === "servers") return !!m.guild_id;
        return true;
    }

    function ignored(m) {
        if (!inScope(m)) return true;
        if (CONFIG.ignoreOwnMessages && m.author.id === myId()) return true;
        if (CONFIG.ignoreBots && m.author.bot) return true;
        return false;
    }

    function mentionsMe(m) {
        const me = myId();
        if (!me || m.author.id === me) return false;
        if (m.mention_everyone || m.mentions.includes(me)) return true;
        if (m.guild_id && m.mention_roles.length) {
            try {
                const roles = C.GuildMemberStore.getMember(m.guild_id, me)?.roles || [];
                return m.mention_roles.some(r => roles.includes(r));
            } catch { /* ignore */ }
        }
        return false;
    }

    function recent(m) {
        const t = Date.parse(m.timestamp);
        return !isNaN(t) && Date.now() - t < CONFIG.ghostPingWindowMinutes * 60_000;
    }

    // ---------- actions ----------

    function writeLog(kind, m, extra = {}) {
        const now = new Date();
        const where = describeWhere(m);
        const who = describeAuthor(m.author);
        let text = `[${now.toLocaleString()}] ${kind} in ${where} by ${who}`;
        if (kind === "EDITED") {
            text += `\n  before: ${extra.before}\n  after:  ${extra.after}`;
        } else {
            text += `\n  ${m.content || "(no text)"}`;
        }
        if (extra.how) text += `\n  (${extra.how})`;
        if (m.attachments.length) {
            text += `\n  attachments: ${m.attachments.map(a => `${a.filename} [id ${a.id}]`).join(", ")}`;
        }
        const entry = {
            kind,
            date: dateKey(now),
            logged_at: now.toISOString(),
            sent_at: m.timestamp,
            where,
            guild_id: m.guild_id,
            channel_id: m.channel_id,
            message_id: m.id,
            author: m.author,
            content: m.content,
            attachments: m.attachments,
            ...extra,
            text,
        };
        const keep = kind === "DELETED" ? m.attachments.map(a => a.id) : [];
        invoke("ml_log", { entry, ids: keep });
    }

    function ghostPing(m, how) {
        const who = describeAuthor(m.author);
        const where = describeWhere(m);
        invoke("ml_ghost_ping", {
            title: `Ghost ping from ${who}`,
            body: `${where}\n${(m.content || "(no text)").slice(0, 200)}`,
        });
        writeLog("GHOST PING", m, { how });
    }

    function maybeCacheAttachments(m) {
        if (CONFIG.cacheAttachments === "off" || !m.attachments.length) return;
        if (CONFIG.cacheAttachments === "dms" && m.guild_id) return;
        if (ignored(m)) return; // also skips places you're not logging
        for (const a of m.attachments) {
            const media = /^(image|video)\//.test(a.content_type) ||
                /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov)$/i.test(a.filename || "");
            if (!media || a.size > CONFIG.maxAttachmentMb * 1024 * 1024) continue;
            invoke("ml_cache_attachment", { id: a.id, url: a.url, name: a.filename || "file" });
        }
    }

    // ---------- Discord event handlers ----------

    function onCreate(a) {
        const m = remember(a.message, a.guildId);
        if (m) maybeCacheAttachments(m);
    }

    function onLoad(a) {
        for (const raw of a.messages || []) {
            if (!cache.has(raw.id)) remember(raw, guildOf(a.channelId));
        }
    }

    function onUpdate(a) {
        const raw = a.message;
        if (!raw?.id) return;
        const old = cache.get(raw.id);
        if (!old || old.deleted) return;

        if (typeof raw.content === "string" && raw.content !== old.content) {
            if (CONFIG.logEdits && !ignored(old)) {
                writeLog("EDITED", old, { before: old.content, after: raw.content });
            }
            if (CONFIG.ghostPingAlerts && inScope(old) && raw.mentions && mentionsMe(old) && recent(old)) {
                const after = {
                    ...old,
                    mentions: ids(raw.mentions),
                    mention_roles: raw.mention_roles ?? old.mention_roles,
                    mention_everyone: raw.mention_everyone ?? old.mention_everyone,
                };
                if (!mentionsMe(after)) ghostPing(old, "ping was edited out");
            }
            old.content = raw.content;
        }
        if (raw.mentions) old.mentions = ids(raw.mentions);
        if (raw.mention_roles) old.mention_roles = raw.mention_roles;
        if (typeof raw.mention_everyone === "boolean") old.mention_everyone = raw.mention_everyone;
        if (raw.attachments) old.attachments = raw.attachments.map(slimAttachment);
    }

    function onDelete(a) {
        if (a.mlDeleted) return; // Vencord's logger removing an already-deleted message
        const list = a.id ? [a.id] : (a.ids || []);
        for (const id of list) {
            const m = cache.get(id);
            if (!m || m.deleted) continue;
            m.deleted = true;
            if (CONFIG.ghostPingAlerts && inScope(m) && mentionsMe(m) && recent(m)) {
                ghostPing(m, "message was deleted");
            }
            if (CONFIG.logDeletes && !ignored(m)) writeLog("DELETED", m);
        }
    }

    // ---------- Message Log button + shortcut ----------

    const openViewer = () => invoke("ml_open_viewer");

    const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></svg>';

    function addButton() {
        if (document.getElementById("dl-message-log-btn")) return;
        // The icon row at the right of the channel header (threads, pins, members, search…)
        const bar = document.querySelector('section[class*="title"] [class*="toolbar"]') ||
            document.querySelector('[class*="toolbar_"]');
        if (!bar) return;
        const b = document.createElement("div");
        b.id = "dl-message-log-btn";
        b.setAttribute("role", "button");
        b.setAttribute("aria-label", "Message Log");
        b.title = "Message Log (Ctrl+Shift+L)";
        b.tabIndex = 0;
        b.innerHTML = ICON;
        Object.assign(b.style, {
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "24px", height: "24px", margin: "0 8px", cursor: "pointer",
            color: "var(--interactive-normal)", flex: "0 0 auto",
        });
        b.onmouseenter = () => (b.style.color = "var(--interactive-hover)");
        b.onmouseleave = () => (b.style.color = "var(--interactive-normal)");
        b.onclick = openViewer;
        b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") openViewer(); };
        bar.prepend(b);
    }

    // Discord rebuilds the header when you switch channels; cheap check once a second.
    setInterval(() => {
        try {
            if (CONFIG.showButton) addButton();
            else document.getElementById("dl-message-log-btn")?.remove();
        } catch { /* ignore */ }
    }, 1000);
    document.addEventListener("keydown", e => {
        if (CONFIG.shortcut && e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyL") {
            e.preventDefault();
            e.stopPropagation();
            openViewer();
        }
    }, true);

    // ---------- start once Vencord has found Discord's internals ----------

    const timer = setInterval(() => {
        try {
            const common = window.Vencord?.Webpack?.Common;
            const D = common?.FluxDispatcher;
            if (!D?.subscribe || !common.UserStore || !common.ChannelStore || !common.GuildStore) return;
            clearInterval(timer);
            C = common;
            D.subscribe("MESSAGE_CREATE", safe(onCreate));
            D.subscribe("LOAD_MESSAGES_SUCCESS", safe(onLoad));
            D.subscribe("MESSAGE_UPDATE", safe(onUpdate));
            D.subscribe("MESSAGE_DELETE", safe(onDelete));
            D.subscribe("MESSAGE_DELETE_BULK", safe(onDelete));
            console.log(TAG, "ready");
        } catch { /* keep waiting */ }
    }, 500);
})();
