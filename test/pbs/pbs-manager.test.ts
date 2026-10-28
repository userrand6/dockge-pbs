import test, { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs, { promises as fsAsync } from "fs";
import path from "path";
import os from "os";
import { PbsManager } from "../../backend/pbs/pbs-manager";
import { MockPbsRunner } from "./mock-pbs-runner";
import { PbsConfig } from "../../backend/pbs/pbs-types";
import { setupTestDb, cleanupTestDb } from "./test-db-setup";

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

        // Create temporary stacks directory
        tempStacksDir = path.join(os.tmpdir(), `test-stacks-${Date.now()}`);
        await fsAsync.mkdir(tempStacksDir, { recursive: true });

        // Save dummy config
        await manager.saveConfig(dummyConfig);

        // Bind mock server
        manager.setServer({
            stacksDir: tempStacksDir,
            sendStackList: () => {},
        } as any);
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
            resolveBackup = () => res({ code: 0, stdout: "done", stderr: "" });
        });

        const customRunner = async () => backupPromise;
        manager.setCustomRunner(customRunner as any);

        // Start first backup (in background)
        const run1 = manager.startBackup();

        // Check manager status while running
        const status = await manager.getStatus();
        assert.equal(status.isOperating, true);
        assert.equal(status.currentOperation, "backup");

        // Attempting a second backup should immediately reject with a lock error
        await assert.rejects(
            async () => await manager.startBackup(),
            (err: any) => err.message.includes("Another PBS operation is already in progress")
        );

        // Attempting a restore should also reject
        await assert.rejects(
            async () => await manager.startRestore({ snapshot: "host/dockge/2026-10-28T00:00:00Z" }),
            (err: any) => err.message.includes("Another PBS operation is already in progress")
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
                return { code: 0, stdout: "Extracted", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
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
});

