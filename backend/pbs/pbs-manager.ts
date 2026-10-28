import fs, { promises as fsAsync } from "fs";
import path from "path";
import os from "os";
import { log } from "../log";
import { Settings } from "../settings";
import { DockgeServer } from "../dockge-server";
import { PbsClient, ProcessRunner } from "./pbs-client";
import {
    BackupOptions,
    PbsConfig,
    PbsLogEvent,
    PbsManagerStatus,
    PbsSnapshot,
    RestoreOptions,
} from "./pbs-types";
import childProcessAsync from "promisify-child-process";

/**
 * High-level coordinator for Proxmox Backup Server operations.
 *
 * Manages:
 * - Mutual exclusion lock (preventing concurrent backup/restores).
 * - Container state transitions (pause / stop / resume with guaranteed cleanup).
 * - Directory packaging and target sanitization.
 * - Live log event broadcasting to Web UI.
 */
export class PbsManager {
    private static instance: PbsManager;

    private server?: DockgeServer;
    private customRunner?: ProcessRunner;

    // Operation Mutex State
    private _isOperating = false;
    private _currentOperation: "idle" | "backup" | "restore" | "prune" = "idle";
    private _operationStartedAt?: string;

    // In-memory buffer of recent logs for UI subscribers
    private recentLogs: PbsLogEvent[] = [];
    private static readonly MAX_LOG_HISTORY = 300;

    // Listeners for real-time log events
    private logListeners: Set<(event: PbsLogEvent) => void> = new Set();

    private constructor() {}

    /**
     * Singleton instance accessor.
     */
    public static getInstance(): PbsManager {
        if (!PbsManager.instance) {
            PbsManager.instance = new PbsManager();
        }
        return PbsManager.instance;
    }

    /**
     * Bind to the main DockgeServer instance.
     */
    public setServer(server: DockgeServer) {
        this.server = server;
    }

    /**
     * Override runner for unit testing.
     */
    public setCustomRunner(runner?: ProcessRunner) {
        this.customRunner = runner;
    }

    /**
     * Retrieves PBS connection configuration from Dockge database.
     */
    public async getConfig(): Promise<PbsConfig> {
        const raw = await Settings.get("pbs_config");
        if (!raw || typeof raw !== "object") {
            return {
                enabled: false,
                host: "",
                port: 8007,
                datastore: "",
                authId: "",
                secret: "",
            };
        }
        return raw as PbsConfig;
    }

    /**
     * Saves PBS connection configuration to Dockge database.
     */
    public async saveConfig(config: PbsConfig): Promise<void> {
        await Settings.set("pbs_config", config);
    }

    /**
     * Instantiates a PbsClient using the stored or provided configuration.
     */
    public async getClient(overrideConfig?: PbsConfig): Promise<PbsClient> {
        const config = overrideConfig || (await this.getConfig());
        if (!config.host || !config.datastore) {
            throw new Error("Proxmox Backup Server is not fully configured (host and datastore required).");
        }
        return new PbsClient(config, this.customRunner);
    }

    /**
     * Returns current operational status and last backup result.
     */
    public async getStatus(): Promise<PbsManagerStatus> {
        const lastBackup = await Settings.get("pbs_last_backup");
        return {
            isOperating: this._isOperating,
            currentOperation: this._currentOperation,
            operationStartedAt: this._operationStartedAt,
            lastBackup: lastBackup && typeof lastBackup === "object" ? lastBackup : undefined,
        };
    }

    /**
     * Subscribe to live log events.
     */
    public addLogListener(listener: (event: PbsLogEvent) => void): () => void {
        this.logListeners.add(listener);
        return () => this.logListeners.delete(listener);
    }

    /**
     * Returns buffered recent log lines.
     */
    public getRecentLogs(): PbsLogEvent[] {
        return [...this.recentLogs];
    }

    /**
     * Emits a log event to memory buffer and all active listeners.
     */
    private emitLog(event: PbsLogEvent) {
        this.recentLogs.push(event);
        if (this.recentLogs.length > PbsManager.MAX_LOG_HISTORY) {
            this.recentLogs.shift();
        }

        for (const listener of this.logListeners) {
            try {
                listener(event);
            } catch (err) {
                // Ignore listener exceptions
            }
        }
    }

    /**
     * Acquires exclusive operation lock.
     */
    private acquireLock(operation: "backup" | "restore" | "prune") {
        if (this._isOperating) {
            throw new Error(`Another PBS operation is already in progress (${this._currentOperation}).`);
        }
        this._isOperating = true;
        this._currentOperation = operation;
        this._operationStartedAt = new Date().toISOString();
        this.recentLogs = []; // Clear log buffer for new run
    }

    /**
     * Releases exclusive operation lock.
     */
    private releaseLock() {
        this._isOperating = false;
        this._currentOperation = "idle";
        this._operationStartedAt = undefined;
    }

    /**
     * Sanitizes stack name to prevent path traversal attacks.
     */
    public sanitizeStackName(name: string): string {
        const cleaned = path.basename(name.trim());
        if (!cleaned || cleaned === "." || cleaned === "..") {
            throw new Error(`Invalid stack name: ${name}`);
        }
        return cleaned;
    }

    /**
     * Executes `docker compose` command in a stack directory.
     */
    private async runCompose(stackDir: string, ...args: string[]): Promise<void> {
        try {
            await childProcessAsync.spawn("docker", ["compose", ...args], {
                cwd: stackDir,
                encoding: "utf-8",
            });
        } catch (err) {
            log.warn("pbs-manager", `Docker compose ${args.join(" ")} failed in ${stackDir}: ${err}`);
        }
    }

    /**
     * Starts a backup of Dockge stacks to Proxmox Backup Server.
     */
    public async startBackup(options: BackupOptions = {}): Promise<{ ok: boolean; message: string }> {
        this.acquireLock("backup");

        const client = await this.getClient();
        const stacksDir = this.server ? this.server.stacksDir : process.env.DOCKGE_STACKS_DIR || "/opt/stacks";
        const containerMode = options.containerMode || "none";
        const pausedOrStoppedStacks: Array<{ dir: string; action: "pause" | "stop" }> = [];

        this.emitLog({
            type: "info",
            text: `[PBS Backup] Starting backup (Mode: ${containerMode}, Include Dockge Data: ${options.includeDockgeData !== false})\n`,
            timestamp: Date.now(),
        });

        try {
            // Step 1: Pre-backup container state transitions if requested
            if (containerMode === "pause" || containerMode === "stop") {
                this.emitLog({
                    type: "info",
                    text: `[PBS Backup] Applying ${containerMode} to running containers before archiving...\n`,
                    timestamp: Date.now(),
                });

                if (fs.existsSync(stacksDir)) {
                    const entries = await fsAsync.readdir(stacksDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const stackPath = path.join(stacksDir, entry.name);
                            if (options.stackName && entry.name !== options.stackName) {
                                continue;
                            }

                            if (containerMode === "pause") {
                                await this.runCompose(stackPath, "pause");
                                pausedOrStoppedStacks.push({ dir: stackPath, action: "pause" });
                            } else if (containerMode === "stop") {
                                await this.runCompose(stackPath, "stop");
                                pausedOrStoppedStacks.push({ dir: stackPath, action: "stop" });
                            }
                        }
                    }
                }
            }

            // Step 2: Build archive list
            const archives: Record<string, string> = {};

            if (options.stackName) {
                const cleanStack = this.sanitizeStackName(options.stackName);
                const targetStackDir = path.join(stacksDir, cleanStack);
                if (!fs.existsSync(targetStackDir)) {
                    throw new Error(`Stack directory does not exist: ${targetStackDir}`);
                }
                archives[`${cleanStack}.pxar`] = targetStackDir;
            } else {
                if (!fs.existsSync(stacksDir)) {
                    await fsAsync.mkdir(stacksDir, { recursive: true });
                }
                archives["stacks.pxar"] = stacksDir;
            }

            // Optional: Include Dockge internal SQLite DB
            const dockgeDataDir = "/app/data";
            if (options.includeDockgeData !== false && fs.existsSync(dockgeDataDir) && !options.stackName) {
                archives["dockge-data.pxar"] = dockgeDataDir;
            }

            // Step 3: Run pxar backup via PbsClient
            this.emitLog({
                type: "info",
                text: `[PBS Backup] Uploading deduplicated pxar streams to PBS repository: ${client.getRepositoryString()}...\n`,
                timestamp: Date.now(),
            });

            await client.backup(archives, undefined, (event) => {
                this.emitLog(event);
            });

            const successMsg = `Backup completed successfully at ${new Date().toLocaleString()}`;
            this.emitLog({
                type: "done",
                text: `[PBS Backup] ${successMsg}\n`,
                timestamp: Date.now(),
            });

            await Settings.set("pbs_last_backup", {
                timestamp: new Date().toISOString(),
                status: "success",
                message: successMsg,
            });

            return { ok: true, message: successMsg };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.emitLog({
                type: "error",
                text: `[PBS Backup Error] ${errorMsg}\n`,
                timestamp: Date.now(),
            });

            await Settings.set("pbs_last_backup", {
                timestamp: new Date().toISOString(),
                status: "error",
                message: errorMsg,
            });

            throw error;

        } finally {
            // Step 4: GUARANTEED RESUMPTION of containers
            if (pausedOrStoppedStacks.length > 0) {
                this.emitLog({
                    type: "info",
                    text: "[PBS Backup] Restoring container states (unpause/start)...\n",
                    timestamp: Date.now(),
                });

                for (const item of pausedOrStoppedStacks) {
                    if (item.action === "pause") {
                        await this.runCompose(item.dir, "unpause");
                    } else if (item.action === "stop") {
                        await this.runCompose(item.dir, "start");
                    }
                }
            }

            this.releaseLock();
        }
    }

    /**
     * Restores stacks from a snapshot.
     */
    public async startRestore(options: RestoreOptions): Promise<{ ok: boolean; message: string }> {
        if (!options.snapshot) {
            throw new Error("Snapshot identifier is required for restore.");
        }

        this.acquireLock("restore");

        const client = await this.getClient();
        const stacksDir = options.targetDir || (this.server ? this.server.stacksDir : process.env.DOCKGE_STACKS_DIR || "/opt/stacks");
        const archiveName = options.archiveName || "stacks.pxar";

        this.emitLog({
            type: "info",
            text: `[PBS Restore] Initiating restore from snapshot: ${options.snapshot}\n`,
            timestamp: Date.now(),
        });

        try {
            if (options.stackName) {
                // SELECTIVE RESTORE: Restore to a temporary folder, then move only the requested stack
                const cleanStack = this.sanitizeStackName(options.stackName);
                const tempExtractDir = path.join(os.tmpdir(), `dockge-restore-${Date.now()}`);
                await fsAsync.mkdir(tempExtractDir, { recursive: true });

                this.emitLog({
                    type: "info",
                    text: `[PBS Restore] Selective restore for stack "${cleanStack}" to temporary staging...\n`,
                    timestamp: Date.now(),
                });

                try {
                    await client.restore(options.snapshot, archiveName, tempExtractDir, (event) => {
                        this.emitLog(event);
                    });

                    // Target stack directory
                    const sourceStackPath = path.join(tempExtractDir, cleanStack);
                    const destStackPath = path.join(stacksDir, cleanStack);

                    if (!fs.existsSync(sourceStackPath)) {
                        throw new Error(`Stack "${cleanStack}" was not found inside snapshot archive ${archiveName}.`);
                    }

                    // Optional pre-restore backup
                    if (options.createPreRestoreBackup && fs.existsSync(destStackPath)) {
                        const backupCopyPath = path.join(stacksDir, `${cleanStack}.bak-${Date.now()}`);
                        await fsAsync.cp(destStackPath, backupCopyPath, { recursive: true });
                        this.emitLog({
                            type: "info",
                            text: `[PBS Restore] Created pre-restore backup: ${backupCopyPath}\n`,
                            timestamp: Date.now(),
                        });
                    }

                    // Copy extracted stack to destination
                    await fsAsync.cp(sourceStackPath, destStackPath, { recursive: true });

                    this.emitLog({
                        type: "info",
                        text: `[PBS Restore] Successfully restored stack files to ${destStackPath}\n`,
                        timestamp: Date.now(),
                    });

                    // Start container if requested
                    if (options.startAfterRestore) {
                        this.emitLog({
                            type: "info",
                            text: `[PBS Restore] Starting stack "${cleanStack}" (docker compose up -d)...\n`,
                            timestamp: Date.now(),
                        });
                        await this.runCompose(destStackPath, "up", "-d");
                    }

                } finally {
                    // Clean up temp extraction folder
                    await fsAsync.rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});
                }

            } else {
                // FULL RESTORE: Extract directly into stacksDir
                this.emitLog({
                    type: "info",
                    text: `[PBS Restore] Full restore into ${stacksDir}...\n`,
                    timestamp: Date.now(),
                });

                await client.restore(options.snapshot, archiveName, stacksDir, (event) => {
                    this.emitLog(event);
                });
            }

            // Refresh Dockge UI stacks list if server is attached
            if (this.server) {
                this.server.sendStackList();
            }

            const successMsg = `Restore from ${options.snapshot} finished successfully.`;
            this.emitLog({
                type: "done",
                text: `[PBS Restore] ${successMsg}\n`,
                timestamp: Date.now(),
            });

            return { ok: true, message: successMsg };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.emitLog({
                type: "error",
                text: `[PBS Restore Error] ${errorMsg}\n`,
                timestamp: Date.now(),
            });
            throw error;
        } finally {
            this.releaseLock();
        }
    }

    /**
     * Lists all snapshots available on PBS.
     */
    public async listSnapshots(): Promise<PbsSnapshot[]> {
        const client = await this.getClient();
        return await client.listSnapshots();
    }

    /**
     * Deletes a specific snapshot on PBS.
     */
    public async deleteSnapshot(snapshot: string): Promise<{ ok: boolean; message: string }> {
        const client = await this.getClient();
        await client.forget(snapshot);
        return { ok: true, message: `Snapshot ${snapshot} deleted.` };
    }
}

export const pbsManager = PbsManager.getInstance();

