# Dockge with Proxmox Backup Server (PBS) — Build & Test Guide

This document provides step-by-step instructions for building, running, testing, and developing Dockge with the native Proxmox Backup Server (PBS) integration.

---

## 1. macOS Setup Guide (Step-by-Step)

To build, test, and run Dockge on a Mac, you need **Xcode Command Line Tools**, **Node.js (v22)**, and **Docker Desktop**. Follow these steps:

### Step 1: Install Xcode Command Line Tools
Required for native C/C++ compilation of SQLite and PTY dependencies:
```bash
xcode-select --install
```

### Step 2: Install Homebrew (if not already installed)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Step 3: Install Node.js (v22)
Dockge requires Node.js `>= 22.14.0`. Choose either **Option A (recommended for version isolation)** or **Option B (direct)**:

* **Option A: Using `fnm` (Fast Node Manager — Python `venv`/`pyenv` style isolation)**
  ```bash
  # 1. Install fnm:
  brew install fnm

  # 2. Add to your ~/.zshrc (or ~/.bash_profile):
  echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc
  source ~/.zshrc

  # 3. Install and activate Node 22:
  fnm install 22
  fnm use 22

  # 4. Verify version:
  node -v   # Should show v22.x.x
  npm -v    # Should show 10.x.x
  ```

* **Option B: Directly via Homebrew**
  ```bash
  brew install node@22
  brew link node@22 --force --overwrite
  ```

### Step 4: Install Docker Desktop for Mac
Required for container management and Docker Compose integration:
```bash
brew install --cask docker
```
*After installation, open **Docker Desktop** from your Applications folder and wait for the engine status to show **Running**.*

### Step 5: Install Project Dependencies
In the root directory of the `dockge` repository:
```bash
npm install
```
*(This installs all dependencies locally into `./node_modules`, including `tsx`, `vite`, `croner`, `redbean-node`, and testing tools).*

---

### Alternative: 100% Containerized Testing (Zero Mac Setup)
If you prefer not to install Node.js directly on your Mac, you can run all automated tests directly through Docker:
```bash
docker run --rm -v "$(pwd):/app" -w /app node:22-bookworm-slim \
  sh -c "npm install && npx tsx --test test/pbs/*.test.ts"
```

---

## 2. Linux Setup Guide (Debian / Ubuntu — Step-by-Step)

On a Linux server or Proxmox VM/LXC (`amd64`), you can either run Dockge inside Docker (recommended for production) or directly on the host for development.

### Option A: Production Docker Setup on Linux (Recommended)

1. **Install Docker & Docker Compose Plugin (if not already installed):**
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

2. **Clone the Repository & Build the Image:**
   *(If you just want to build the Docker image without installing Node.js on the host, install Node 22 or run `./build-docker.sh` after installing Node 22 below):*
   ```bash
   git clone -b proofofconcept git@github.com:userrand6/dockge-pbs.git
   cd dockge-pbs
   cp .env.example .env
   # Edit .env with your PBS_HOST, PBS_DATASTORE, PBS_AUTH_ID, PBS_SECRET, and PBS_FINGERPRINT
   nano .env
   ```

3. **Build the Docker Image with the Incremental Build Script:**
   ```bash
   ./build-docker.sh
   ```

4. **Configure `compose.yaml` for Linux (with Named Volume Support):**
   On Linux, mount `/opt/stacks:/opt/stacks` and `/var/lib/docker/volumes:/var/lib/docker/volumes:rslave` so Dockge can back up and restore both stack folders and Docker named volumes:
   ```yaml
   services:
     dockge:
       image: dockge-pbs:latest
       restart: unless-stopped
       ports:
         - 5001:5001
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
         - ./data:/app/data
         - /opt/stacks:/opt/stacks
         # Mount Docker named volumes root so Dockge can back up & restore named volumes:
         - /var/lib/docker/volumes:/var/lib/docker/volumes:rslave
       environment:
         - DOCKGE_STACKS_DIR=/opt/stacks
       env_file:
         - path: ./.env
           required: false
   ```

5. **Start Dockge:**
   ```bash
   sudo mkdir -p /opt/stacks
   docker compose up -d
   ```

---

### Option B: Bare-Metal / Development Setup on Linux (Debian 12 Bookworm / Debian 13 Trixie)

1. **Install Build Essentials & System Dependencies:**
   ```bash
   sudo apt update && sudo apt install -y \
     curl ca-certificates gnupg build-essential python3 git
   ```

2. **Install Node.js 22:**
   ```bash
   # Using fnm (Fast Node Manager):
   curl -fsSL https://fnm.vercel.app/install | bash
   source ~/.bashrc
   fnm install 22
   fnm use 22
   node -v   # v22.x.x
   ```

3. **Install `proxmox-backup-client` (only needed if running outside Docker):**
   - **For Debian 12 (Bookworm):**
     ```bash
     sudo install -m 0755 -d /etc/apt/keyrings
     curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg \
       | sudo tee /etc/apt/keyrings/proxmox-release-bookworm.gpg > /dev/null
     echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/proxmox-release-bookworm.gpg] http://download.proxmox.com/debian/pbs-client bookworm main" \
       | sudo tee /etc/apt/sources.list.d/pbs-client.list
     sudo apt update && sudo apt install -y proxmox-backup-client
     ```
   - **For Debian 13 (Trixie):**
     ```bash
     sudo install -m 0755 -d /etc/apt/keyrings
     curl -fsSL https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
       | sudo tee /etc/apt/keyrings/proxmox-archive-keyring.gpg > /dev/null
     echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/proxmox-archive-keyring.gpg] http://download.proxmox.com/debian/pbs-client trixie main" \
       | sudo tee /etc/apt/sources.list.d/pbs-client.list
     sudo apt update && sudo apt install -y proxmox-backup-client
     ```

4. **Install NPM Dependencies & Run Tests / Dev Server:**
   ```bash
   npm install
   npm run test:pbs
   npm run dev
   ```

---

## 3. Quick Start: Automated Tests

All critical PBS backup, restore, scheduling, locking, and security functions are covered by an automated test suite. **The test suite does not require a live PBS server or Docker daemon** as it uses an integrated mock process runner.

### Run All PBS Tests:
```bash
npm run test:pbs
```
*(Or directly using tsx):*
```bash
npx tsx --test test/pbs/*.test.ts
```

### What is Tested:
1. **`test/pbs/pbs-client.test.ts`**:
   - `proxmox-backup-client` CLI argument construction.
   - **Credential Security**: Confirms passwords and API tokens are passed *only* via process environment variables (`PBS_PASSWORD`), never on the command line (preventing leaks in `ps aux`).
   - JSON parsing for snapshot manifests and error formatting on invalid inputs.
   - Pruning argument generation (`--keep-daily`, `--keep-weekly`, etc.).
2. **`test/pbs/pbs-manager.test.ts`**:
   - **Concurrency Mutex**: Guarantees only one backup or restore runs at any given time.
   - **Container State Transitions**: Verifies container pause/stop and guaranteed unpause/restart recovery via `try ... finally`.
   - **Path Traversal Defense**: Rejects malicious stack names (e.g. `../`, `/`).
   - Selective single-stack restore and pre-restore `.bak` copy creation.
3. **`test/pbs/pbs-scheduler.test.ts`**:
   - Cron syntax validation and automated schedule rescheduling.
   - Disablement logic when PBS is not configured.
4. **`test/pbs/pbs-socket.test.ts`**:
   - Authentication enforcement (`checkLogin`) on all PBS socket handlers.
   - **Secret Masking**: Returns `********` to the UI and safely preserves real secrets when updating settings.

---

## 4. Building the Application

### 4.1 Install Dependencies
```bash
npm ci
```

### 4.2 Code Quality Checks
Verify TypeScript types and linting:
```bash
# Type check (TypeScript)
npm run check-ts

# ESLint check
npm run lint

# Auto-fix formatting
npm run fmt
```

### 4.3 Build the Frontend
Compile Vite assets into `frontend-dist`:
```bash
npm run build:frontend
```

---

## 5. Running in Development Mode

You can run the backend and frontend concurrently with hot-reloading:

```bash
npm run dev
```

> **macOS Tips for `npm run dev`:**
> 1. **Stacks Directory on Mac**: By default outside of Docker, macOS does not allow non-root users to write to `/opt/stacks`. Dockge now automatically defaults to `./stacks` in the project directory when running on macOS (`darwin`). You can also specify any custom path with `DOCKGE_STACKS_DIR=./stacks npm run dev`.
> 2. **Port 5000 (AirPlay Receiver Conflict)**: If you see `Port 5000 is in use, trying another one...`, macOS AirPlay Receiver is using port 5000. To fix this:
>    - Go to **System Settings** -> **General** -> **AirDrop & AirPlay** -> Turn off **AirPlay Receiver**.
>    - This allows Vite to bind to port 5000 cleanly and proxy backend traffic on 5001 without collision.

Or run them individually in separate terminal sessions:

```bash
# Terminal 1: Backend with tsx watch
npm run dev:backend

# Terminal 2: Frontend with Vite dev server
npm run dev:frontend
```

Once started:
- Access the UI at: `http://localhost:5001` (or the Vite dev URL shown in terminal).

---

## 6. Building and Running with Docker

### 6.1 Fast Incremental Build (`./build-docker.sh`)

Use the included incremental build script (which automatically builds `louislam/dockge:build-healthcheck`, `louislam/dockge:base` with `proxmox-backup-client`, `frontend-dist`, and `dockge-pbs:latest`, caching unchanged stages so subsequent rebuilds take ~1–2 seconds):

```bash
./build-docker.sh
```

*(Or to force a full rebuild of all stages: `./build-docker.sh --full`)*

### 6.2 Manual Step-by-Step Docker Build (Optional)

1. **Build the Healthcheck Binary**:
   ```bash
   docker build --platform linux/amd64 -t louislam/dockge:build-healthcheck -f docker/BuildHealthCheck.Dockerfile .
   ```

2. **Build the Base Image** (includes `docker-ce-cli`, `docker-compose-plugin`, and `proxmox-backup-client`):
   ```bash
   docker build --platform linux/amd64 -t louislam/dockge:base -f docker/Base.Dockerfile .
   ```

3. **Build the Main Release Image**:
   ```bash
   npm run build:frontend
   docker build --platform linux/amd64 -t dockge-pbs:latest -f docker/Dockerfile .
   ```

### 6.3 Run with Docker Compose

Start the container:
```bash
docker compose up -d
```

---

## 7. Configuring PBS via `.env` (Optional)

Copy `.env.example` to `.env` to pre-configure all Proxmox Backup Server settings without needing to enter them in the UI:

```bash
cp .env.example .env
```

```env
# Proxmox Backup Server Configuration
PBS_ENABLED=true
PBS_HOST=192.168.1.100
PBS_PORT=8007
PBS_DATASTORE=backup-ds
PBS_AUTH_ID=dockge@pbs!backup-token
PBS_SECRET=your-api-token-secret
PBS_FINGERPRINT=aa:bb:cc:dd:...:zz
PBS_BACKUP_ID=dockge-host
# PBS_NAMESPACE=dockge-nodes
# PBS_ENCRYPTION_PASSWORD=my-client-encryption-pass
```

---

## 8. Verifying the PBS Integration in the UI

### 8.1 Global Settings & Management
1. Open Dockge in your browser (`http://localhost:5001`).
2. Log in and navigate to **Settings** (`/settings`) from the top-right menu.
3. Click on **Backup** in the left sidebar menu.
4. **Configure PBS Connection**:
   - Under the **PBS Connection** tab:
     - Check **Enable Proxmox Backup Server Integration** (or set in `.env`).
     - Enter your PBS **Host / IP**, **Port**, and **Datastore**.
     - Enter your **Auth ID** and **Password / Secret**.
     - If using a self-signed certificate, paste your SHA-256 certificate fingerprint.
   - Click **Test Connection** to verify reachability.
   - Click **Save PBS Configuration**.
5. **Run a Manual Backup**:
   - Click **Backup Now** at the top right of the Backup screen.
   - The **PBS Operation Console** modal will open showing real-time streaming progress logs.
6. **Browse Snapshots**:
   - Once the backup completes, navigate to the **Snapshots & Restore** tab to see your new snapshot listed with size and contained `.pxar` files.
7. **Test Restores**:
   - Click **Restore...** on any snapshot.
   - Choose between **Single Stack** (recommended) or **Full Restore**.
   - Check the safety confirmation and click **Start Restore**.

### 8.2 Per-Stack / Per-Container Backup & Restore View
When viewing any individual stack:
1. Click the **Backup** button located directly next to the **Edit** button in the top action bar.
2. The page transforms into the **Stack Backup** view:
   - **Containers in this Stack**: Lists all containers/services managed within this stack.
   - **Container State During Backup**: Choose between **Live** (no downtime), **Pause** (`docker compose pause`), or **Stop / Restart** (`docker compose stop` during archive, restart after).
   - **Automated Schedule**: Set a dedicated schedule for this stack (Daily, Weekly, Custom Cron, or Inherit Global Schedule).
   - **Snapshots for this Stack**: Browse all PBS snapshots containing this stack and click **Restore** to selectively restore only this stack.
   - **Backup Stack Now**: Trigger an instant, isolated backup of this specific stack with live progress output.
3. Click **Back** to return to the normal Compose view.
   - The live console will track the extraction and report completion.
8. **Configure Automated Schedule**:
   - Under the **Schedule & Retention** tab:
     - Enable automated backups and choose your desired frequency (**Daily**, **Weekly**, or **Custom Cron**).
     - Select the container handling mode during backup (**Live**, **Pause**, or **Stop**).
     - Configure retention rules (Keep Daily, Keep Weekly, etc.) to automatically prune old snapshots on PBS.
     - Click **Save Schedule & Retention**.

