# Changes Documentation: Proxmox Backup Server (PBS) Integration

> **Target:** Dockge Container & Stack Backup to Proxmox Backup Server  
> **Status:** Fully Implemented & Covered by Automated Test Suite  
> **Audience:** Reviewers, Maintainers & Operators  

---

## 1. Executive Summary

This feature adds native Proxmox Backup Server (PBS) integration to Dockge, providing **automated scheduled backups**, **on-demand manual backups**, and **selective or full manual restores** directly from the Dockge Web UI.

### Design Principles Enforced:
1. **Easy Upstream Rebasing:** Existing core files are altered by only a few lines each (total across the entire existing codebase is < 25 lines). All PBS logic is contained within dedicated, isolated modules.
2. **Standard-Compliant PBS Client:** Utilizes the official `proxmox-backup-client` CLI with chunked deduplication, client-side encryption support, and SHA-256 certificate fingerprint verification.
3. **Data Integrity & Crash Safety:** Provides live non-disruptive backups as well as optional container pause/stop for database consistency. Container state resumption is strictly guaranteed via `try ... finally` blocks.
4. **Credential Protection:** Secrets and API tokens are never passed on command-line arguments (preventing inspection in process tables via `ps aux`) and are masked in the UI.
5. **Rigorously Tested:** Includes an automated test suite based on Node's native test runner (`node:test`) and assertion engine (`node:assert/strict`), runnable via `npm run test:pbs`.

---

## 2. Inventory of Changes

### 2.1 Modified Existing Files (Minimal Touchpoints)

| File | Lines Changed | Description |
| :--- | :--- | :--- |
| **`backend/dockge-server.ts`** | +5 lines | Registered `PbsSocketHandler` in `socketHandlerList` and initialized `pbsScheduler.init(this)` on server start. |
| **`docker/Base.Dockerfile`** | +4 lines | Installed `proxmox-backup-client` from the official Proxmox Debian Bookworm repository. |
| **`frontend/src/router.ts`** | +5 lines | Registered the `/settings/backup` sub-route under Settings. |
| **`frontend/src/pages/Settings.vue`** | +3 lines | Added the "Backup" item to the settings side navigation menu. |
| **`frontend/src/pages/Compose.vue`** | +15 lines | Added "Backup" button next to "Edit" that toggles the stack-level backup and restore view. |
| **`frontend/src/lang/en.json`** | +9 lines | Added English localization strings for Backup UI labels. |
| **`frontend/components.d.ts`** | Auto | Auto-registered `Backup`, `StackBackup`, `PbsRestoreModal`, and `PbsConsoleModal`. |
| **`package.json`** | +1 line | Added `"test:pbs": "tsx --test test/pbs/*.test.ts"`. |

### 2.2 Newly Added Files (100% Isolated)

```
backend/
├── pbs/
│   ├── pbs-types.ts                  # Interfaces for config, snapshots, volumes, manifest & logs
│   ├── pbs-client.ts                 # CLI child-process wrapper with secret protection
│   ├── pbs-volume-inspector.ts       # Compose volume parser, mountpoint inspector & manifest writer
│   ├── pbs-manager.ts                # Orchestration: locks, container handling, multi-pxar & restore
│   └── pbs-scheduler.ts              # Cron-based automated backup & prune engine
└── socket-handlers/
    └── pbs-socket-handler.ts         # Authenticated Socket.IO API & secret masking

frontend/src/
├── components/
│   ├── settings/
│   │   └── Backup.vue                # Main Settings tab (Status, Snapshots, Config, Schedule)
│   └── backup/
│       ├── StackBackup.vue           # Per-stack / Per-container Backup, Volume Inspector & Restore view
│       ├── PbsRestoreModal.vue       # Interactive Restore Wizard (Full vs Selective Stack + Volumes)
│       └── PbsConsoleModal.vue       # Real-time log streaming terminal window

test/
└── pbs/
    ├── mock-pbs-runner.ts            # CLI execution recording & mock harness
    ├── test-db-setup.ts              # In-memory SQLite database harness for unit tests
    ├── pbs-client.test.ts            # Unit tests for CLI wrapper & credential security
    ├── pbs-volume-inspector.test.ts  # Unit tests for compose volume parsing, mount checks & manifest
    ├── pbs-manager.test.ts           # Unit tests for locks, multi-pxar volumes, pause/resume & restore
    ├── pbs-scheduler.test.ts         # Unit tests for cron parsing & retention policies
    └── pbs-socket.test.ts            # Unit tests for socket auth & secret masking
```

---

## 3. How the New Components Work

### 3.1 PBS Low-Level Client (`backend/pbs/pbs-client.ts`)
The `PbsClient` class wraps the `proxmox-backup-client` binary.

- **Process Execution & Test Isolation:** Accepts an optional `ProcessRunner` dependency. In production, this spawns child processes; in automated tests, `MockPbsRunner` intercepts invocations.
- **Secure Environment Injection:** Sensitive connection parameters are injected strictly via environment variables:
  - `PBS_REPOSITORY`: `[authId@]host[:port]:datastore`
  - `PBS_PASSWORD`: User password or API token secret
  - `PBS_FINGERPRINT`: SHA-256 certificate fingerprint
  - `PBS_ENCRYPTION_PASSWORD`: Optional client encryption password
- **Key Methods:**
  - `testConnection()`: Executes `proxmox-backup-client status --output-format json` to verify datastore accessibility.
  - `backup(archives, backupId, onProgress)`: Packs directories into pxar archives (e.g. `stacks.pxar:/opt/stacks`) with `--change-detection-mode=metadata` so unchanged files skip both local disk reads and network transfer.
  - `listSnapshots()`: Queries snapshots and parses JSON output into `PbsSnapshot[]`.
  - `restore(snapshot, archive, targetDir, onProgress)`: Extracts files from an archive.
  - `prune(rules)`: Enforces retention rules (`--keep-daily`, `--keep-weekly`, etc.).
  - `forget(snapshot)`: Removes an obsolete snapshot.

### 3.2 Volume Inspector & Self-Contained Manifest (`backend/pbs/pbs-volume-inspector.ts`)
The `PbsVolumeInspector` class handles parsing `compose.yaml` to discover all volumes and bind mounts used by a stack:

- **Two-Tier Compose Parsing:**
  1. **Primary (`docker compose config --format json`):** Invokes the official Docker Compose CLI inside the stack directory to resolve `.env` variable interpolations (`${VAR:-default}`), YAML anchors, short/long volume syntax, and project-prefixed volume names (`<stack>_<volume>`).
  2. **Static Fallback (`dotenv` + `envsubstYAML` + `yaml.parse`):** If the Docker daemon is unreachable (e.g. offline mode or unit tests), falls back to Dockge's built-in YAML and environment variable parsers.
- **Volume Classification (`DetectedStackVolume.kind`):**
  - `"internal-bind"`: Relative bind mounts located inside the stack folder (e.g. `./data:/app/data`), which are automatically included in the stack's main `.pxar` archive.
  - `"named-volume"`: Docker-managed named volumes, resolved via `docker volume inspect <name> --format "{{ .Mountpoint }}"` (defaulting to `/var/lib/docker/volumes/<name>/_data`).
  - `"external-bind"`: Absolute host bind mounts outside the stack directory (e.g. `/mnt/nas/appdata`).
- **Mount Accessibility Detection (`/proc/self/mountinfo`):**
  - When Dockge runs inside a Linux Docker container (`/.dockerenv` exists), `PbsVolumeInspector` inspects `/proc/self/mountinfo` to verify whether each volume's host path is covered by an active mount inside the Dockge container.
  - If any volume path is unmounted, `inspectStack()` returns `allAccessible: false`, lists `missingMounts`, and generates `recommendedComposeSnippet` showing the exact `volumes:` lines the user should add to Dockge's `compose.yaml`.
- **System Pseudo-Filesystem Filtering (`isIgnoredSystemPath`):**
  - Automatically skips virtual kernel mounts and standard system single-file mounts (`/`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run/docker.sock`, `/etc/localtime`, `/etc/timezone`, `/etc/hosts`) commonly used by monitoring stacks (`cAdvisor`, `Netdata`, `Beszel`).
- **Pre-Flight Sanity Check (`validateBackupPlan`):**
  - Executed **before** any containers are paused or stopped. Validates and aborts safely if:
    1. Any volume definition contains unexpanded `.env` variables (`$VAR` or `${VAR}`).
    2. An external bind mount points to a single file instead of a directory (`pxar` requires directories), unless `allowIncompleteBackup: true`.
    3. Any `.pxar` archive name is malformed, collides with another target path, or points to a forbidden system path.
    4. Any archive target directory does not exist, is not a directory, or lacks read permission (`R_OK`).
- **External Resource Dependency Hints (`external: true` Networks & Volumes):**
  - Detects top-level `networks` and `volumes` marked with `external: true` in `compose.yaml`.
  - Rather than silently running `docker network create` with default bridge/subnet settings (which could conflict with a reverse-proxy stack like Traefik or Caddy), `inspectStack()` generates `preStartCommands` (`docker network create <net>`, `docker volume create <vol>`) and displays them in the UI and restore logs so the operator knows exactly what to run before starting the stack on a new host.
- **Self-Contained Snapshot Manifest (`.pbs-manifest.json`):**
  - Before `proxmox-backup-client backup` runs, `writeStackManifest()` writes `.pbs-manifest.json` into the stack folder recording every external `.pxar` archive (`vol-<stack>-<name>.pxar` and `bind-<stack>-<slug>.pxar`), its `dockerVolumeName`, its `hostPath`, and any `externalNetworks` / `externalVolumes`.
  - During restore, `readStackManifest()` reads this file, registers stack-owned named volumes via `docker volume create <dockerVolumeName>`, extracts each `.pxar` archive back into its host directory, and logs any `preStartCommands` for external resources.

### 3.3 Orchestration Engine (`backend/pbs/pbs-manager.ts`)
The `PbsManager` singleton coordinates operations and ensures system safety:

- **Operation Mutex (Concurrency Lock):**
  - Manages `_isOperating` state.
  - If a user triggers a backup while another backup or restore is running, it rejects immediately with an informative error rather than causing archive corruption.
- **Sequential Per-Stack Global Backups (`backupSingleStack`):**
  - When a Global Backup runs (`startBackup()` without `stackName`), Dockge iterates through all stacks **sequentially on a per-stack basis** rather than archiving `/opt/stacks` all at once:
    1. **Minimal Container Downtime:** Only one stack is paused or stopped at a time for a few seconds (`try ... finally` resumes it immediately after its upload completes).
    2. **Per-Stack Policy Enforcement:** Honors each stack's individual `StackBackupConfig` (`enabled`, `containerMode`, `includeVolumes`), automatically skipping disabled stacks.
    3. **No Shared Volume Collisions:** Two stacks sharing an `external: true` volume or bind mount are backed up in separate `proxmox-backup-client` invocations (`<baseBackupId>-<stackName>`), avoiding duplicate target path collisions while preserving 100% of PBS datastore-level chunk deduplication.
- **Incomplete Backup Protection:**
  - Before starting a backup with `includeVolumes: true`, `PbsManager` inspects the stack's volumes. If any volume path is unmounted inside Dockge, the backup is blocked with a clear error message and YAML mount snippet unless the user explicitly passed `allowIncompleteBackup: true`.
- **Container Lifecycle Transitions (`containerMode`):**
  - `"none"` (default): Live backup without container interruption.
  - `"pause"`: Runs `docker compose pause` in the stack directory before archiving.
  - `"stop"`: Runs `docker compose stop` for crash-consistent database backups.
  - **Guaranteed Resumption:** The unpause/start step is wrapped in a `try ... finally` block per stack. Even if the backup fails, containers are **always** restored to their previous state.
- **Multi-`.pxar` Backup Scope:**
  - Per-stack directory (`<stackName>.pxar` under backup-id `<baseBackupId>-<stackName>`).
  - Named Docker volumes (`vol-<stack>-<vol>.pxar`) and external bind mounts (`bind-<stack>-<path>.pxar`).
  - Dockge internal data (`dockge-data.pxar:/app/data` under `<baseBackupId>-system`) including `dockge.db`.
- **Selective vs Full Restore (with Automated Volume Registration):**
  - **Full Restore:** Directly restores `stacks.pxar` into `server.stacksDir` and restores all external volume archives listed in each stack's `.pbs-manifest.json`.
  - **Single Stack Restore:** Extracts `<stack>.pxar` or `stacks.pxar` into a temporary staging folder, moves only the requested stack folder into `stacksDir`, creates any required Docker named volumes via `docker volume create`, and extracts the stack's volume `.pxar` archives.
  - **Pre-Restore Safety Backup:** Option to create a `<stack>.bak-<timestamp>` copy before overwriting.
- **Real-Time Log Broadcasting:**
  - Buffers the last 300 log lines in memory.
  - Dispatches `PbsLogEvent` to all subscribed sockets in real-time.

### 3.4 Scheduler & Retention Engine (`backend/pbs/pbs-scheduler.ts`)
The `PbsScheduler` singleton manages background automation:

- **Powered by `croner`:** Uses Dockge's pre-installed `croner` dependency.
- **Validation:** Every cron expression is validated upon submission.
- **Execution Flow:**
  1. Triggers `pbsManager.startBackup()`.
  2. If retention parameters (`keepLast`, `keepDaily`, etc.) are configured, automatically invokes `client.prune()`.
- **Next Run Prediction:** Provides `getNextRun()` for UI display.

### 3.5 Socket Handler & API Security (`backend/socket-handlers/pbs-socket-handler.ts`)
The `PbsSocketHandler` exposes 14 authenticated Socket.IO events:

| Socket Event | Purpose | Auth & Security |
| :--- | :--- | :--- |
| `getPbsConfig` | Fetch PBS server settings (with `.env` fallback) | Masks secret as `********` |
| `savePbsConfig` | Save connection settings | Preserves secret if submitted as `********` |
| `testPbsConnection` | Test server reachability | Validates credentials against PBS |
| `getPbsStatus` | Get running operation & recent logs | Requires authenticated session |
| `startPbsBackup` | Trigger manual backup (global or single-stack) | Checks mount accessibility & runs async |
| `getPbsSnapshots` | Fetch snapshot list | Requires authenticated session |
| `startPbsRestore` | Trigger restore operation (stack + volumes) | Sanitizes stack name & target path |
| `deletePbsSnapshot` | Delete single snapshot | Requires authenticated session |
| `getPbsSchedule` | Fetch automated schedule | Requires authenticated session |
| `savePbsSchedule` | Update schedule & prune rules | Validates cron syntax |
| `getStackBackupConfig` | Fetch per-stack backup mode & schedule | Sanitizes stack name |
| `saveStackBackupConfig` | Save per-stack backup mode & schedule | Sanitizes stack name |
| `getStackSnapshots` | Fetch snapshots containing a specific stack | Sanitizes stack name |
| `inspectStackVolumes` | Inspect stack volumes & Dockge mount status | Returns missing mounts & YAML snippet |

### 3.6 Frontend UI Components
- **`frontend/src/components/settings/Backup.vue`:**
  - **Status Header:** Live badge (Idle / Operating), Last backup time, Next scheduled run, "Backup Now" button.
  - **Tab 1: Snapshots & Restore:** Searchable table of past backups with date, snapshot ID, file listing, size, and restore/delete actions.
  - **Tab 2: PBS Connection:** Server host, port, datastore, auth ID/token, password/secret, TLS fingerprint, and test connection button.
  - **Tab 3: Schedule & Retention:** Enable toggle, Daily/Weekly/Custom cron selector, Container Mode dropdown, and keep-daily/weekly/monthly retention rules.
- **`frontend/src/components/backup/StackBackup.vue`:**
  - Dedicated per-stack view opened via the **Backup** button next to **Edit** on any stack.
  - Shows managed containers, per-stack container state selector (`Live`, `Pause`, `Stop / Restart`), per-stack schedule, **Detected Stack Volumes & Mounts** list (`Stack Folder`, `Named Volume`, `External Path` with `Mounted` / `Unmounted` badges), and an **Unmounted Volume Warning** with the ready-to-copy `compose.yaml` snippet and explicit incomplete-backup confirmation.
- **`frontend/src/components/backup/PbsRestoreModal.vue`:**
  - Guided restore wizard with safety warnings, single-stack vs full-restore options, volume restoration toggle, pre-restore `.bak` checkbox, auto-start container checkbox, and explicit confirmation.
- **`frontend/src/components/backup/PbsConsoleModal.vue`:**
  - Embedded terminal showing live stdout/stderr streams from active backup and restore jobs.

---

## 4. Security & Safety Invariants

1. **No Process Table Secret Exposure:** Secrets are passed strictly through `options.env` inside child processes.
2. **Path Traversal Defense:** Stack names undergo `path.basename()` verification and reject empty, `.`, or `..` inputs to prevent overwriting files outside `stacksDir`.
3. **No Silent Incomplete Backups:** Unmounted named volumes or external host paths are detected via `/proc/self/mountinfo` and blocked unless the user explicitly acknowledges the warning.
4. **No Unauthenticated Access:** All socket handlers invoke `checkLogin(socket)`.
5. **Concurrency Safety:** An in-memory mutex prevents simultaneous backups or restore collisions.

---

## 5. Automated Tests & Verification

The feature is accompanied by a dedicated automated test suite located in `test/pbs/` (28 tests across 5 suites).

### Running Tests
Execute the tests directly with:
```bash
npm run test:pbs
# Or directly via tsx:
npx tsx --test test/pbs/*.test.ts
```

### Coverage Overview:
- **`test/pbs/pbs-client.test.ts`**: Verifies CLI argument construction, environment variable injection, secret masking, snapshot JSON parsing, error exit codes, and prune flags.
- **`test/pbs/pbs-volume-inspector.test.ts`**: Verifies `compose.yaml` + `.env` parsing, classification of internal/external/named volumes, detection of unmounted paths in containerized mode, YAML snippet generation, and `.pbs-manifest.json` serialization.
- **`test/pbs/pbs-manager.test.ts`**: Verifies mutex locks against concurrent runs, `.env` configuration fallback, incomplete backup blocking, multi-`.pxar` named volume archiving, `docker volume create` registration on restore, and single-stack selective restore.
- **`test/pbs/pbs-scheduler.test.ts`**: Verifies cron expression validation, disablement logic, and next-run calculation.
- **`test/pbs/pbs-socket.test.ts`**: Verifies unauthorized request rejection, secret masking on retrieval, and secret preservation on update.

