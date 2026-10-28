import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsAsync } from "fs";
import path from "path";
import os from "os";
import { PbsManager } from "../../backend/pbs/pbs-manager";
import { MockPbsRunner } from "./mock-pbs-runner";
import { PbsConfig } from "../../backend/pbs/pbs-types";
import { setupTestDb, cleanupTestDb } from "./test-db-setup";
import { DockgeServer } from "../../backend/dockge-server";
import { ProcessRunner } from "../../backend/pbs/pbs-client";

describe("PbsManager", () => {
    let manager: PbsManager;
    let mockRunner: MockPbsRunner;
    let tempStacksDir: string;

    const dummyConfig: PbsConfig = {
        enabled: true,
        host: "10.0.0.100",
        port: 8007,
        datastore: "backup-ds",
        authId: "root@pam",
        secret: "tokensecret",
    };

    beforeEach(async () => {
        await setupTestDb();
        manager = PbsManager.getInstance();
        mockRunner = new MockPbsRunner();
        manager.setCustomRunner(mockRunner.getRunner());
        manager.setVolumeTestOverrides(null, undefined);

        // Create temporary stacks directory
        tempStacksDir = path.join(os.tmpdir(), `test-stacks-${Date.now()}`);
        await fsAsync.mkdir(tempStacksDir, { recursive: true });

        // Save dummy config
        await manager.saveConfig(dummyConfig);

        // Bind mock server
        manager.setServer({
            stacksDir: tempStacksDir,
            sendStackList: () => {},
        } as unknown as DockgeServer);
    });

    after(async () => {
        await cleanupTestDb();
    });

    it("should sanitize stack names properly against directory traversal", () => {
        assert.equal(manager.sanitizeStackName("my-stack"), "my-stack");
        assert.equal(manager.sanitizeStackName("subdir/my-stack"), "my-stack");
        assert.equal(manager.sanitizeStackName("/opt/stacks/my-stack"), "my-stack");
        assert.throws(() => manager.sanitizeStackName(".."));
        assert.throws(() => manager.sanitizeStackName("."));
        assert.throws(() => manager.sanitizeStackName(""));
    });

    it("should enforce mutual exclusion lock during concurrent operations", async () => {
        // Setup a long-running response
        let resolveBackup: () => void;
        const backupPromise = new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
            resolveBackup = () => res({ code: 0,
                stdout: "done",
                stderr: "" });
        });

        const customRunner: ProcessRunner = async () => backupPromise;
        manager.setCustomRunner(customRunner);

        // Start first backup (in background)
        const run1 = manager.startBackup();

        // Check manager status while running
        const status = await manager.getStatus();
        assert.equal(status.isOperating, true);
        assert.equal(status.currentOperation, "backup");

        // Attempting a second backup should immediately reject with a lock error
        await assert.rejects(
            async () => await manager.startBackup(),
            (err: Error) => err.message.includes("Another PBS operation is already in progress")
        );

        // Attempting a restore should also reject
        await assert.rejects(
            async () => await manager.startRestore({ snapshot: "host/dockge/2026-10-28T00:00:00Z" }),
            (err: Error) => err.message.includes("Another PBS operation is already in progress")
        );

        // Resolve first backup
        resolveBackup!();
        await run1;

        // Verify lock is released
        const postStatus = await manager.getStatus();
        assert.equal(postStatus.isOperating, false);
        assert.equal(postStatus.currentOperation, "idle");
    });

    it("should emit real-time logs to registered listeners and maintain recent buffer", async () => {
        manager.setCustomRunner(mockRunner.getRunner());
        mockRunner.setResponse("backup", 0, "Deduplication ratio: 4.5x");

        const receivedLogs: string[] = [];
        const unsubscribe = manager.addLogListener((event) => {
            receivedLogs.push(event.text);
        });

        await manager.startBackup();
        unsubscribe();

        assert.ok(receivedLogs.length > 0);
        assert.ok(receivedLogs.some((l) => l.includes("Starting backup")));
        assert.ok(receivedLogs.some((l) => l.includes("Deduplication ratio: 4.5x")));

        // Verify memory buffer stores logs
        const recent = manager.getRecentLogs();
        assert.ok(recent.length > 0);
    });

    it("should handle single stack selective restore into target directory", async () => {
        // Create mock target stack in temp directory
        const sampleStackDir = path.join(tempStacksDir, "nginx-app");
        await fsAsync.mkdir(sampleStackDir, { recursive: true });
        await fsAsync.writeFile(path.join(sampleStackDir, "compose.yaml"), "services:\n  web:\n    image: nginx\n");

        manager.setCustomRunner(async (cmd, args, opts) => {
            if (args[0] === "restore") {
                // Simulate extraction into the tempExtractDir
                const targetDir = args[args.length - 1];
                const extractedStackDir = path.join(targetDir, "nginx-app");
                await fsAsync.mkdir(extractedStackDir, { recursive: true });
                await fsAsync.writeFile(path.join(extractedStackDir, "compose.yaml"), "# Restored Nginx\n");
                return { code: 0,
                    stdout: "Extracted",
                    stderr: "" };
            }
            return { code: 0,
                stdout: "",
                stderr: "" };
        });

        await manager.startRestore({
            snapshot: "host/dockge/2026-10-28T00:00:00Z",
            stackName: "nginx-app",
            createPreRestoreBackup: true,
        });

        // Verify the file was restored
        const restoredContent = await fsAsync.readFile(path.join(sampleStackDir, "compose.yaml"), "utf-8");
        assert.equal(restoredContent, "# Restored Nginx\n");

        // Verify pre-restore safety backup was created
        const entries = await fsAsync.readdir(tempStacksDir);
        const backupCopy = entries.find((e) => e.startsWith("nginx-app.bak-"));
        assert.ok(backupCopy, "Pre-restore safety backup directory must exist");
    });

    it("should allow setting PBS host and fingerprint via environment variables", async () => {
        const originalEnv = { ...process.env };
        try {
            // Clear DB config
            await manager.saveConfig({} as unknown as PbsConfig);

            process.env.PBS_HOST = "env-pbs.local";
            process.env.PBS_PORT = "8008";
            process.env.PBS_DATASTORE = "env-ds";
            process.env.PBS_AUTH_ID = "env-user@pbs";
            process.env.PBS_SECRET = "env-secret";
            process.env.PBS_FINGERPRINT = "aa:bb:cc:dd:ee:ff";
            process.env.PBS_ENABLED = "true";

            const config = await manager.getConfig();
            assert.equal(config.enabled, true);
            assert.equal(config.host, "env-pbs.local");
            assert.equal(config.port, 8008);
            assert.equal(config.datastore, "env-ds");
            assert.equal(config.authId, "env-user@pbs");
            assert.equal(config.secret, "env-secret");
            assert.equal(config.fingerprint, "aa:bb:cc:dd:ee:ff");
        } finally {
            process.env = originalEnv;
        }
    });

    it("should block incomplete backup when unmounted volumes exist unless allowIncompleteBackup is true", async () => {
        const mockVolumesRoot = path.join(os.tmpdir(), `pbs-mgr-vols-${Date.now()}`);
        const stackDir = path.join(tempStacksDir, "pg-app");
        await fsAsync.mkdir(stackDir, { recursive: true });
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            "services:\n  db:\n    image: postgres:16\n    volumes:\n      - pg_data:/var/lib/postgresql/data\nvolumes:\n  pg_data:\n"
        );

        // Simulate running inside a Dockge container where /var/lib/docker/volumes is NOT mounted
        manager.setVolumeTestOverrides([ tempStacksDir ], mockVolumesRoot);
        mockRunner.setResponse("config", 1, "", "use static fallback");
        mockRunner.setResponse("inspect", 1, "", "use fallback path");
        mockRunner.setResponse("backup", 0, "Backup done", "");

        await assert.rejects(
            async () => await manager.startBackup({ stackName: "pg-app" }),
            (err: Error) => err.message.includes("Incomplete backup blocked") && err.message.includes("pg_data")
        );

        // Now explicitly allow incomplete backup
        const res = await manager.startBackup({
            stackName: "pg-app",
            allowIncompleteBackup: true,
        });
        assert.equal(res.ok, true);
    });

    it("should archive named volumes into separate .pxar files and restore them with docker volume create", async () => {
        const mockVolumesRoot = path.join(os.tmpdir(), `pbs-mgr-volrestore-${Date.now()}`);
        const volDataDir = path.join(mockVolumesRoot, "pg-app_pg_data", "_data");
        const stackDir = path.join(tempStacksDir, "pg-app");

        await fsAsync.mkdir(stackDir, { recursive: true });
        await fsAsync.mkdir(volDataDir, { recursive: true });
        await fsAsync.writeFile(path.join(volDataDir, "PG_VERSION"), "16\n");
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            "services:\n  db:\n    image: postgres:16\n    volumes:\n      - pg_data:/var/lib/postgresql/data\nvolumes:\n  pg_data:\n"
        );

        // Simulate container with both stacks and volumes root mounted
        manager.setVolumeTestOverrides([ tempStacksDir, mockVolumesRoot ], mockVolumesRoot);

        const executedCommands: Array<{ cmd: string; args: string[] }> = [];
        let capturedManifestJson = "";

        manager.setCustomRunner(async (cmd, args) => {
            executedCommands.push({ cmd,
                args });

            if (cmd === "docker" && args.includes("config")) {
                return { code: 1,
                    stdout: "",
                    stderr: "fallback" };
            }
            if (cmd === "docker" && args.includes("inspect")) {
                return { code: 0,
                    stdout: `${volDataDir}\n`,
                    stderr: "" };
            }
            if (cmd === "proxmox-backup-client" && args[0] === "backup") {
                // Capture the manifest written inside stackDir before backup
                capturedManifestJson = await fsAsync.readFile(
                    path.join(stackDir, ".pbs-manifest.json"),
                    "utf-8"
                );
                return { code: 0,
                    stdout: "Uploaded 2 archives",
                    stderr: "" };
            }
            if (cmd === "proxmox-backup-client" && args[0] === "restore") {
                const archiveArg = args[2];
                const destArg = args[3];
                if (archiveArg === "pg-app.pxar") {
                    await fsAsync.mkdir(destArg, { recursive: true });
                    await fsAsync.writeFile(path.join(destArg, "compose.yaml"), "# Restored pg-app\n");
                    await fsAsync.writeFile(path.join(destArg, ".pbs-manifest.json"), capturedManifestJson);
                } else if (archiveArg === "vol-pg-app-pg_data.pxar") {
                    await fsAsync.mkdir(destArg, { recursive: true });
                    await fsAsync.writeFile(path.join(destArg, "PG_VERSION"), "16-restored\n");
                }
                return { code: 0,
                    stdout: "Restored",
                    stderr: "" };
            }
            return { code: 0,
                stdout: "",
                stderr: "" };
        });

        // 1. Run Backup
        await manager.startBackup({ stackName: "pg-app" });

        const backupCall = executedCommands.find(
            (c) => c.cmd === "proxmox-backup-client" && c.args[0] === "backup"
        );
        assert.ok(backupCall, "proxmox-backup-client backup must be called");
        assert.ok(
            backupCall.args.some((a) => a.startsWith("pg-app.pxar:")),
            "Should include stack archive pg-app.pxar"
        );
        assert.ok(
            backupCall.args.some((a) => a.startsWith("vol-pg-app-pg_data.pxar:")),
            "Should include named volume archive vol-pg-app-pg_data.pxar"
        );

        // 2. Run Restore
        await manager.startRestore({
            snapshot: "host/dockge/2026-10-28T02:00:00Z",
            archiveName: "pg-app.pxar",
            stackName: "pg-app",
            restoreVolumes: true,
        });

        // Verify `docker volume create pg-app_pg_data` was executed prior to volume extraction
        const volCreateCall = executedCommands.find(
            (c) => c.cmd === "docker" && c.args[0] === "volume" && c.args[1] === "create"
        );
        assert.ok(volCreateCall, "docker volume create must be called during restore");
        assert.equal(volCreateCall.args[2], "pg-app_pg_data");

        // Verify the volume content was restored
        const restoredPgVersion = await fsAsync.readFile(path.join(volDataDir, "PG_VERSION"), "utf-8");
        assert.equal(restoredPgVersion, "16-restored\n");

        await fsAsync.rm(mockVolumesRoot, { recursive: true,
            force: true }).catch(() => {});
    });

    it("should run global backups sequentially on a per-stack basis, skipping disabled stacks and avoiding shared volume collisions", async () => {
        const mockVolumesRoot = path.join(os.tmpdir(), `pbs-mgr-global-${Date.now()}`);
        const sharedVolDir = path.join(mockVolumesRoot, "shared_media", "_data");
        await fsAsync.mkdir(sharedVolDir, { recursive: true });

        // Create 3 stacks: stack-a (enabled), stack-b (enabled, shares external volume with stack-a), stack-c (disabled)
        const stackADir = path.join(tempStacksDir, "stack-a");
        const stackBDir = path.join(tempStacksDir, "stack-b");
        const stackCDir = path.join(tempStacksDir, "stack-c");
        await fsAsync.mkdir(stackADir, { recursive: true });
        await fsAsync.mkdir(stackBDir, { recursive: true });
        await fsAsync.mkdir(stackCDir, { recursive: true });

        const sharedCompose = `services:
  app:
    image: nginx
    volumes:
      - shared_media:/media
volumes:
  shared_media:
    external: true
`;
        await fsAsync.writeFile(path.join(stackADir, "compose.yaml"), sharedCompose);
        await fsAsync.writeFile(path.join(stackBDir, "compose.yaml"), sharedCompose);
        await fsAsync.writeFile(path.join(stackCDir, "compose.yaml"), sharedCompose);

        await manager.saveConfig({ ...dummyConfig,
            backupId: "myhost" });
        await manager.saveStackConfig("stack-c", {
            enabled: false,
            containerMode: "none",
            cron: "",
            includeVolumes: true,
        });

        manager.setVolumeTestOverrides([ tempStacksDir, mockVolumesRoot ], mockVolumesRoot);

        const pbsBackupCalls: string[][] = [];
        manager.setCustomRunner(async (cmd, args) => {
            if (cmd === "docker" && args.includes("config")) {
                return { code: 1,
                    stdout: "",
                    stderr: "fallback" };
            }
            if (cmd === "docker" && args.includes("inspect")) {
                return { code: 0,
                    stdout: `${sharedVolDir}\n`,
                    stderr: "" };
            }
            if (cmd === "proxmox-backup-client" && args[0] === "backup") {
                pbsBackupCalls.push(args);
                return { code: 0,
                    stdout: "Uploaded",
                    stderr: "" };
            }
            return { code: 0,
                stdout: "",
                stderr: "" };
        });

        // Execute Global Backup (no stackName passed)
        await manager.startBackup({ includeDockgeData: false });

        // Should have executed exactly 2 sequential backup calls (stack-a and stack-b; stack-c skipped)
        assert.equal(pbsBackupCalls.length, 2);
        assert.ok(pbsBackupCalls[0].includes("myhost-stack-a"));
        assert.ok(pbsBackupCalls[1].includes("myhost-stack-b"));

        await fsAsync.rm(mockVolumesRoot, { recursive: true,
            force: true }).catch(() => {});
    });
});

