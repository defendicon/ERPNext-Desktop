# ERPNext Desktop

A Windows-first desktop installer and local manager for ERPNext. It presents ERPNext Core and compatible official Frappe apps as a selectable catalog, then builds and runs the chosen suite with the official `frappe_docker` toolchain.

## What is implemented

- Electron desktop shell with a production Vite/React interface.
- Real checks for Git, Docker Desktop, Docker Compose v2, and a running Docker engine.
- Automatic silent installation of WSL 2, Git and Docker Desktop through official Windows mechanisms.
- Administrator permission requested once when ERPNext Desktop starts.
- Full-screen installation progress with the active prerequisite, package or Docker image name.
- Selectable official-app catalog. ERPNext Core is always included.
- ERPNext version 16 release line.
- Official `apps.json` generation and layered custom-image build.
- Local MariaDB, Redis, workers, scheduler, Socket.IO, Nginx and persistent volumes.
- Site creation and installation of each selected app.
- Credentials saved under Electron's per-user app-data directory.
- Workspace removal with an explicit keep-data or permanently-delete-data choice.
- Standard Windows Apps & Features uninstallation plus an NSIS data-retention prompt.

## Important distinction

ERPNext's Accounting, Selling, Buying, Stock, Manufacturing, Projects, Assets, Quality and Support modules ship together inside `erpnext`; they are not separately installable repositories. The selectable cards are official Frappe applications that can be added to the same site.

## Development

```powershell
npm install
npm run dev
```

Web-only UI preview:

```powershell
npm run dev:web
```

Build a Windows NSIS installer:

```powershell
npm run dist:win
```

Rust is not required. The Windows app detects and installs missing prerequisites automatically; Windows may require one UAC confirmation and a restart after enabling WSL 2.

## Safety and production notes

- The generated database password is random.
- Administrator credentials are written only to the app's local per-user data directory.
- App repositories and branches are allow-listed in `electron/installer.cjs`.
- Child processes are launched without a shell.
- Production releases should pin tested app commits/tags, add compatibility checks, sign the installer, encrypt stored credentials using Windows DPAPI, and implement backups before updates.
