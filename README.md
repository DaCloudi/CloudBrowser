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
2. Push a version tag:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. GitHub Actions (`.github/workflows/release.yml`) builds the installer and publishes
   the release. Every installed CloudBrowser picks it up automatically.

Always tag a higher version number than the last one, or the update won't be offered.

> The repository must be **public**. Installed apps can't download updates from a
> private repository without a token.

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+W | New tab / close tab |
| Ctrl+Shift+N | New private tab |
| Ctrl+Shift+P | Private mode on/off for new tabs |
| Ctrl+L | Go to the address bar |
| F5 or Ctrl+R | Reload |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+Tab | Next tab |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| F12 | Developer tools |

## Notes

- Windows SmartScreen will warn "unrecognised app" the first time, because the installer
  isn't code-signed. Click **More info → Run anyway**. Removing that warning means buying
  a code-signing certificate.
- Private tabs keep cookies and history in memory only. They're wiped when you close the app.
