# CloudBrowser

A lightweight Windows browser that searches with DuckDuckGo and updates itself.

## Try it on your PC

You need [Node.js](https://nodejs.org) (the LTS version).

```
npm install
npm start
```

## Make the installer

```
npm run dist
```

The installer appears in `dist\CloudBrowser Setup 1.0.0.exe`. Run it to install CloudBrowser
with a desktop and Start menu shortcut.

## How auto-update works

CloudBrowser checks GitHub Releases when it starts and every 4 hours after that.
When it finds a newer version, it downloads it quietly in the background. A green
**Update ready – restart** button then appears. If you never click it, the update
installs the next time you close the app.

### One-time setup

1. Make a free GitHub account and create a repository called `CloudBrowser`.
2. `package.json` is already set to the DaCloudi account.
3. Upload this folder to that repository.

### Releasing an update

1. Change whatever you like.
2. Raise `"version"` in `package.json` (for example `1.0.0` → `1.0.1`) and push to `main`.
3. GitHub Actions (`.github/workflows/release.yml`) builds the installer and publishes
   release `v1.0.1`. Every installed CloudBrowser picks it up automatically.

Always use a higher version number than the last one, or the update won't be offered.
You can also start a release by hand from the repository's **Actions** tab → **Release** → **Run workflow**.

> The repository must be **public**. Installed apps can't download updates from a
> private repository without a token.

## Features

- A home page with search, your most-visited sites and a count of blocked trackers
- Incognito windows (Ctrl+Shift+N) that forget everything when closed, and multiple windows (Ctrl+N)
- Can be set as the Windows default browser, so links and .html files open in it
- Ad, tracker and pop-up blocking, with a count in the toolbar
- Sites must ask before using your camera, microphone, location or notifications
- Bookmarks and a bookmarks bar, history, and address-bar suggestions from both
- Downloads with progress, pause/resume and a downloads page
- Find on page, right-click menus, zoom, print, full-screen video
- Reopens your tabs on start; Ctrl+Shift+T brings back closed tabs
- Settings: search engine, home page, theme (light/dark), clearing data, site permissions
- Built-in pages: `cloud://newtab`, `cloud://settings`, `cloud://history`, `cloud://bookmarks`, `cloud://downloads`

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+W | New tab / close tab |
| Ctrl+Shift+T | Reopen closed tab |
| Ctrl+N | New window |
| Ctrl+Shift+N | New incognito window |
| Ctrl+Shift+W | Close window |
| Ctrl+L or Alt+D | Go to the address bar |
| Ctrl+F, F3 | Find on page, next match |
| Ctrl+D | Bookmark / un-bookmark this page |
| Ctrl+Shift+B | Show or hide the bookmarks bar |
| Ctrl+H / Ctrl+J / Ctrl+Shift+O | History / downloads / bookmarks |
| Ctrl+, | Settings |
| Ctrl+Shift+Delete | Clear browsing data |
| F5 or Ctrl+R | Reload |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+Tab, Ctrl+1…9 | Switch tabs |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| Ctrl+P | Print |
| F11 | Full screen |
| F12 | Developer tools |

## Testing

Pushing to the `dev` branch runs `.github/workflows/test.yml`, which starts CloudBrowser on
a Windows machine, clicks through the main features and prints the results and screenshots
to the log.

## Notes

- Windows SmartScreen will warn "unrecognised app" the first time, because the installer
  isn't code-signed. Click **More info → Run anyway**. Removing that warning means buying
  a code-signing certificate.
- Incognito windows keep cookies and history in memory only. They're wiped when the last incognito window closes.
