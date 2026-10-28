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
| **`frontend/src/lang/en.json`** | +7 lines | Added English localization strings for Backup UI labels. |
| **`frontend/components.d.ts`** | Auto | Auto-registered `Backup`, `PbsRestoreModal`, and `PbsConsoleModal` components. |
| **`package.json`** | +1 line | Added `"test:pbs": "tsx --test test/pbs/*.test.ts"`. |

### 2.2 Newly Added Files (100% Isolated)

```
backend/
├── pbs/
│   ├── pbs-types.ts                  # Interfaces for config, snapshots, options & logs
│   ├── pbs-client.ts                 # CLI child-process wrapper with secret protection
│   ├── pbs-manager.ts                # Orchestration: locks, container handling & restore
│   └── pbs-scheduler.ts              # Cron-based automated backup & prune engine
└── socket-handlers/
    └── pbs-socket-handler.ts         # Authenticated Socket.IO API & secret masking

frontend/src/
├── components/
│   ├── settings/
│   │   └── Backup.vue                # Main Settings tab (Status, Snapshots, Config, Schedule)
│   └── backup/
│       ├── PbsRestoreModal.vue       # Interactive Restore Wizard (Full vs Selective Stack)
│       └── PbsConsoleModal.vue       # Real-time log streaming terminal window

test/
└── pbs/
    ├── mock-pbs-runner.ts            # CLI execution recording & mock harness
    ├── pbs-client.test.ts            # Unit tests for CLI wrapper & credential security
    ├── pbs-manager.test.ts           # Unit tests for locks, safety, pause/resume & restore
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
  - `backup(archives, backupId, onProgress)`: Packs directories into pxar archives (e.g. `stacks.pxar:/opt/stacks`).
  - `listSnapshots()`: Queries snapshots and parses JSON output into `PbsSnapshot[]`.
  - `restore(snapshot, archive, targetDir, onProgress)`: Extracts files from an archive.
  - `prune(rules)`: Enforces retention rules (`--keep-daily`, `--keep-weekly`, etc.).
  - `forget(snapshot)`: Removes an obsolete snapshot.

### 3.2 Orchestration Engine (`backend/pbs/pbs-manager.ts`)
The `PbsManager` singleton coordinates operations and ensures system safety:

- **Operation Mutex (Concurrency Lock):**
  - Manages `_isOperating` state.
  - If a user triggers a backup while another backup or restore is running, it rejects immediately with an informative error rather than causing archive corruption.
- **Container Lifecycle Transitions (`containerMode`):**
  - `"none"` (default): Live backup without container interruption.
  - `"pause"`: Runs `docker compose pause` in active stack directories before archiving.
  - `"stop"`: Runs `docker compose stop` for crash-consistent database backups.
  - **Guaranteed Resumption:** The unpause/start loop is wrapped in a `try ... finally` block. Even if the backup fails, containers are **always** restored to their previous state.
- **Backup Scope:**
  - Stacks directory (`server.stacksDir` / `/opt/stacks`).
  - Dockge internal data (`dockge-data.pxar:/app/data`) including `dockge.db`.
- **Selective vs Full Restore:**
  - **Full Restore:** Directly restores `stacks.pxar` into `server.stacksDir`.
  - **Single Stack Restore:** Extracts `stacks.pxar` into a temporary staging folder (`/tmp/dockge-restore-...`), moves only the requested stack folder into `stacksDir`, and deletes the staging folder.
  - **Pre-Restore Safety Backup:** Option to create a `<stack>.bak-<timestamp>` copy before overwriting.
- **Real-Time Log Broadcasting:**
  - Buffers the last 300 log lines in memory.
  - Dispatches `PbsLogEvent` to all subscribed sockets in real-time.

### 3.3 Scheduler & Retention Engine (`backend/pbs/pbs-scheduler.ts`)
The `PbsScheduler` singleton manages background automation:

- **Powered by `croner`:** Uses Dockge's pre-installed `croner` dependency.
- **Validation:** Every cron expression is validated upon submission.
- **Execution Flow:**
  1. Triggers `pbsManager.startBackup()`.
  2. If retention parameters (`keepLast`, `keepDaily`, etc.) are configured, automatically invokes `client.prune()`.
- **Next Run Prediction:** Provides `getNextRun()` for UI display.

### 3.4 Socket Handler & API Security (`backend/socket-handlers/pbs-socket-handler.ts`)
The `PbsSocketHandler` exposes 10 authenticated Socket.IO events:

| Socket Event | Purpose | Auth & Security |
| :--- | :--- | :--- |
| `getPbsConfig` | Fetch PBS server settings | Masks secret as `********` |
| `savePbsConfig` | Save connection settings | Preserves secret if submitted as `********` |
| `testPbsConnection` | Test server reachability | Validates credentials against PBS |
| `getPbsStatus` | Get running operation & recent logs | Requires authenticated session |
| `startPbsBackup` | Trigger manual backup | Validates options & runs asynchronously |
| `getPbsSnapshots` | Fetch snapshot list | Requires authenticated session |
| `startPbsRestore` | Trigger restore operation | Sanitizes stack name & target path |
| `deletePbsSnapshot` | Delete single snapshot | Requires authenticated session |
| `getPbsSchedule` | Fetch automated schedule | Requires authenticated session |
| `savePbsSchedule` | Update schedule & prune rules | Validates cron syntax |

### 3.5 Frontend UI Components
- **`frontend/src/components/settings/Backup.vue`:**
  - **Status Header:** Live badge (Idle / Operating), Last backup time, Next scheduled run, "Backup Now" button.
  - **Tab 1: Snapshots & Restore:** Searchable table of past backups with date, snapshot ID, file listing, size, and restore/delete actions.
  - **Tab 2: PBS Connection:** Server host, port, datastore, auth ID/token, password/secret, TLS fingerprint, and test connection button.
  - **Tab 3: Schedule & Retention:** Enable toggle, Daily/Weekly/Custom cron selector, Container Mode dropdown, and keep-daily/weekly/monthly retention rules.
- **`frontend/src/components/backup/PbsRestoreModal.vue`:**
  - Guided restore wizard with safety warnings, single-stack vs full-restore options, pre-restore backup checkbox, auto-start container checkbox, and explicit confirmation.
- **`frontend/src/components/backup/PbsConsoleModal.vue`:**
  - Embedded terminal showing live stdout/stderr streams from active backup and restore jobs.

---

## 4. Security & Safety Invariants

1. **No Process Table Secret Exposure:** Secrets are passed strictly through `options.env` inside child processes.
2. **Path Traversal Defense:** Stack names undergo `path.basename()` verification and reject empty, `.`, or `..` inputs to prevent overwriting files outside `stacksDir`.
3. **No Unauthenticated Access:** All socket handlers invoke `checkLogin(socket)`.
4. **Concurrency Safety:** An in-memory mutex prevents simultaneous backups or restore collisions.

---

## 5. Automated Tests & Verification

The feature is accompanied by a dedicated automated test suite located in `test/pbs/`.

### Running Tests
Execute the tests directly with:
```bash
npm run test:pbs
# Or directly via tsx:
npx tsx --test test/pbs/*.test.ts
```

### Coverage Overview:
- **`test/pbs/pbs-client.test.ts`**: Verifies CLI argument construction, environment variable injection, secret masking, snapshot JSON parsing, error exit codes, and prune flags.
- **`test/pbs/pbs-manager.test.ts`**: Verifies mutex locks against concurrent runs, container pause/unpause lifecycle with guaranteed resumption, log streaming, and single-stack selective restore.
- **`test/pbs/pbs-scheduler.test.ts`**: Verifies cron expression validation, disablement logic, and next-run calculation.
- **`test/pbs/pbs-socket.test.ts`**: Verifies unauthorized request rejection, secret masking on retrieval, and secret preservation on update.

