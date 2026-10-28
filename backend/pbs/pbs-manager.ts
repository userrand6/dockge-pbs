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
    StackBackupConfig,
    StackVolumeInspectionResult,
} from "./pbs-types";
import { PbsVolumeInspector } from "./pbs-volume-inspector";
import childProcessAsync from "promisify-child-process";

/**
 * High-level coordinator for Proxmox Backup Server operations.
 *
 * Manages:
 * - Mutual exclusion lock (preventing concurrent backup/restores).
 * - Container state transitions (pause / stop / resume with guaranteed cleanup).
 * - Compose volume inspection (named volumes & external bind mounts) via `PbsVolumeInspector`.
 * - Multi-pxar archiving and self-contained `.pbs-manifest.json` volume restoration.
 * - Live log event broadcasting to Web UI.
 */
export class PbsManager {
    private static instance: PbsManager;

    private server?: DockgeServer;
    private customRunner?: ProcessRunner;
    private customContainerMounts?: string[] | null;
    private customVolumesRoot?: string;

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
     * Override container mount detection and volumes root for unit testing.
     */
    public setVolumeTestOverrides(containerMounts?: string[] | null, volumesRoot?: string) {
        this.customContainerMounts = containerMounts;
        this.customVolumesRoot = volumesRoot;
    }

    /**
     * Instantiates a PbsVolumeInspector bound to current test/runtime settings.
     */
    public getVolumeInspector(): PbsVolumeInspector {
        return new PbsVolumeInspector(
            this.customRunner,
            this.customContainerMounts,
            this.customVolumesRoot
        );
    }

    /**
     * Retrieves PBS connection configuration from Dockge database,
     * merging or falling back to environment variables (e.g. PBS_HOST, PBS_FINGERPRINT).
     */
    public async getConfig(): Promise<PbsConfig> {
        const raw = await Settings.get("pbs_config");
        const dbConfig: Partial<PbsConfig> = (raw && typeof raw === "object") ? raw : {};

        const envEnabled = process.env.PBS_ENABLED !== undefined
            ? (process.env.PBS_ENABLED === "true" || process.env.PBS_ENABLED === "1")
            : undefined;

        const envPort = process.env.PBS_PORT ? parseInt(process.env.PBS_PORT, 10) : undefined;

        const config: PbsConfig = {
            enabled: dbConfig.enabled ?? envEnabled ?? false,
            host: dbConfig.host || process.env.PBS_HOST || "",
            port: dbConfig.port || (envPort && !isNaN(envPort) ? envPort : 8007),
            datastore: dbConfig.datastore || process.env.PBS_DATASTORE || "",
            authId: dbConfig.authId || process.env.PBS_AUTH_ID || "",
            secret: dbConfig.secret || process.env.PBS_SECRET || process.env.PBS_PASSWORD || "",
            fingerprint: dbConfig.fingerprint || process.env.PBS_FINGERPRINT || undefined,
            encryptionPassword: dbConfig.encryptionPassword || process.env.PBS_ENCRYPTION_PASSWORD || undefined,
            namespace: dbConfig.namespace || process.env.PBS_NAMESPACE || undefined,
            backupId: dbConfig.backupId || process.env.PBS_BACKUP_ID || undefined,
        };

        return config;
    }

    /**
     * Saves PBS connection configuration to Dockge database.
     */
    public async saveConfig(config: PbsConfig): Promise<void> {
        await Settings.set("pbs_config", config);
    }

    /**
     * Retrieves per-stack backup settings from Dockge database.
     */
    public async getStackConfig(stackName: string): Promise<StackBackupConfig> {
        const cleanStack = this.sanitizeStackName(stackName);
        const allConfigs = await Settings.get("pbs_stack_configs");
        if (allConfigs && typeof allConfigs === "object" && allConfigs[cleanStack]) {
            return {
                enabled: true,
                containerMode: "none",
                cron: "",
                includeVolumes: true,
                ...allConfigs[cleanStack],
            };
        }
        return {
            enabled: true,
            containerMode: "none",
            cron: "",
            includeVolumes: true,
        };
    }

    /**
     * Saves per-stack backup settings to Dockge database.
     */
    public async saveStackConfig(stackName: string, config: StackBackupConfig): Promise<void> {
        const cleanStack = this.sanitizeStackName(stackName);
        const raw = await Settings.get("pbs_stack_configs");
        const allConfigs: Record<string, StackBackupConfig> =
            raw && typeof raw === "object" ? { ...raw } : {};

        allConfigs[cleanStack] = {
            enabled: Boolean(config.enabled),
            containerMode: config.containerMode || "none",
            cron: config.cron ? String(config.cron).trim() : "",
            includeVolumes: config.includeVolumes !== false,
        };

        await Settings.set("pbs_stack_configs", allConfigs);
    }

    /**
     * Resolves the root directory where Dockge stacks are stored.
     */
    private getStacksDir(overrideDir?: string): string {
        if (overrideDir) {
            return overrideDir;
        }
        return this.server ? this.server.stacksDir : process.env.DOCKGE_STACKS_DIR || "/opt/stacks";
    }

    /**
     * Inspects a stack's compose.yaml to detect named volumes and external bind mounts,
     * and checks whether they are currently mounted/accessible inside Dockge.
     */
    public async inspectStackVolumes(stackName: string): Promise<StackVolumeInspectionResult> {
        const cleanStack = this.sanitizeStackName(stackName);
        const stackDir = path.join(this.getStacksDir(), cleanStack);
        return await this.getVolumeInspector().inspectStack(cleanStack, stackDir);
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
        return [ ...this.recentLogs ];
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
            } catch {
                // Ignore listener exceptions
            }
        }
    }

    /**
     * Shorthand helper to emit a timestamped log message.
     */
    private logProgress(type: PbsLogEvent["type"], text: string) {
        this.emitLog({ type,
            text,
            timestamp: Date.now() });
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
            if (this.customRunner) {
                await this.customRunner("docker", [ "compose", ...args ], { env: process.env,
                    cwd: stackDir });
                return;
            }
            await childProcessAsync.spawn("docker", [ "compose", ...args ], {
                cwd: stackDir,
                encoding: "utf-8",
            });
        } catch (err) {
            log.warn("pbs-manager", `Docker compose ${args.join(" ")} failed in ${stackDir}: ${err}`);
        }
    }

    /**
     * Builds a PBS-compliant backup-id (`[a-zA-Z0-9_-]+`) for a specific stack or system archive.
     */
    public buildStackBackupId(baseBackupId: string, stackName: string): string {
        const cleanBase = (baseBackupId || "dockge").replace(/[^a-zA-Z0-9_-]/g, "_");
        const cleanStack = stackName.replace(/[^a-zA-Z0-9_-]/g, "_");
        return `${cleanBase}-${cleanStack}`;
    }

    /**
     * Backs up a single stack (and its named/external volumes) as an isolated PBS snapshot
     * under `<baseBackupId>-<stackName>`.
     *
     * Why per-stack snapshots:
     *   1. Container downtime (`pause`/`stop`) is limited to a single stack for a few seconds,
     *      rather than taking all stacks offline for the entire backup window.
     *   2. Avoids duplicate target path collisions when two stacks share an `external: true` volume.
     *   3. Preserves 100% of PBS chunk deduplication across the datastore while giving each stack
     *      its own snapshot timeline.
     */
    private async backupSingleStack(
        client: PbsClient,
        baseBackupId: string,
        stackName: string,
        stackDir: string,
        options: BackupOptions
    ): Promise<void> {
        const containerMode = options.containerMode || "none";
        const includeVolumes = options.includeVolumes !== false;
        const inspector = this.getVolumeInspector();
        const stackBackupId = this.buildStackBackupId(baseBackupId, stackName);

        let inspection: StackVolumeInspectionResult | undefined;
        const archives: Record<string, string> = {
            [`${stackName}.pxar`]: stackDir,
        };

        // Step 1: Inspect stack volumes and write `.pbs-manifest.json` before stopping containers
        if (includeVolumes) {
            inspection = await inspector.inspectStack(stackName, stackDir);

            if (!inspection.allAccessible) {
                const missingList = inspection.missingMounts
                    .map((m) => `${stackName} -> ${m.source} (${m.hostPath})`)
                    .join(", ");

                if (!options.allowIncompleteBackup) {
                    const snippet = inspection.recommendedComposeSnippet
                        ? `\nAdd the following to your Dockge compose.yaml:\n${inspection.recommendedComposeSnippet}`
                        : "";
                    throw new Error(
                        `Incomplete backup blocked: Unmounted volume paths detected (${missingList}).${snippet}`
                    );
                }

                this.logProgress(
                    "info",
                    `[PBS Backup Warning] Proceeding with incomplete backup for "${stackName}" (skipping unmounted paths: ${missingList})\n`
                );
            }

            if (inspection.preStartCommands.length > 0) {
                this.logProgress(
                    "info",
                    `[PBS Backup Note] Stack "${stackName}" uses external resources. Before starting on a new host, run: ${inspection.preStartCommands.join(" && ")}\n`
                );
            }

            const manifest = await inspector.writeStackManifest(
                stackName,
                stackDir,
                inspection.volumes,
                inspection.externalNetworks,
                inspection.externalVolumes
            );

            for (const ext of manifest.externalArchives) {
                archives[ext.archiveName] = ext.hostPath;
                this.logProgress(
                    "info",
                    `[PBS Backup] Including ${ext.kind} "${ext.source}" (${ext.hostPath}) as ${ext.archiveName}\n`
                );
            }
        }

        // Step 2: Execute Final Pre-Flight Sanity Check BEFORE pausing/stopping this stack's containers
        inspector.validateBackupPlan(
            archives,
            inspection ? [ inspection ] : [],
            Boolean(options.allowIncompleteBackup)
        );

        // Step 3: Pause/stop ONLY this stack, upload to PBS, and immediately resume in `finally`
        let appliedAction: "pause" | "stop" | null = null;
        try {
            if (containerMode === "pause" || containerMode === "stop") {
                this.logProgress("info", `[PBS Backup] Applying ${containerMode} to stack "${stackName}"...\n`);
                await this.runCompose(stackDir, containerMode);
                appliedAction = containerMode;
            }

            this.logProgress(
                "info",
                `[PBS Backup] Uploading stack "${stackName}" (${Object.keys(archives).length} archive(s), backup-id: ${stackBackupId}) to ${client.getRepositoryString()}...\n`
            );

            await client.backup(archives, stackBackupId, (event) => this.emitLog(event));
        } finally {
            if (appliedAction === "pause") {
                this.logProgress("info", `[PBS Backup] Resuming stack "${stackName}" (unpause)...\n`);
                await this.runCompose(stackDir, "unpause");
            } else if (appliedAction === "stop") {
                this.logProgress("info", `[PBS Backup] Restarting stack "${stackName}" (start)...\n`);
                await this.runCompose(stackDir, "start");
            }
        }
    }

    /**
     * Starts a backup of Dockge stacks (and their named/external volumes) to Proxmox Backup Server.
     *
     * - When `options.stackName` is provided: backs up only that stack under `<baseBackupId>-<stackName>`.
     * - When `options.stackName` is omitted (Global Backup): iterates through all enabled stacks
     *   sequentially on a per-stack basis so only one stack is paused/stopped at a time and shared
     *   external volumes never collide in a single command invocation.
     */
    public async startBackup(options: BackupOptions = {}): Promise<{ ok: boolean; message: string }> {
        this.acquireLock("backup");

        const config = await this.getConfig();
        const client = await this.getClient(config);
        const baseBackupId = config.backupId || os.hostname() || "dockge";
        const stacksDir = this.getStacksDir();
        const containerMode = options.containerMode || "none";
        const includeVolumes = options.includeVolumes !== false;
        const inspector = this.getVolumeInspector();

        this.logProgress(
            "info",
            `[PBS Backup] Starting backup (Mode: ${containerMode}, Include Volumes: ${includeVolumes}, Include Dockge Data: ${options.includeDockgeData !== false})\n`
        );

        try {
            if (options.stackName) {
                const cleanStack = this.sanitizeStackName(options.stackName);
                const targetStackDir = path.join(stacksDir, cleanStack);
                if (!fs.existsSync(targetStackDir)) {
                    throw new Error(`Stack directory does not exist: ${targetStackDir}`);
                }

                await this.backupSingleStack(client, baseBackupId, cleanStack, targetStackDir, {
                    ...options,
                    containerMode,
                    includeVolumes,
                });
            } else {
                if (!fs.existsSync(stacksDir)) {
                    await fsAsync.mkdir(stacksDir, { recursive: true });
                }

                const entries = await fsAsync.readdir(stacksDir, { withFileTypes: true });
                const stackDirs = entries
                    .filter((e) => e.isDirectory() && !e.name.includes(".bak-"))
                    .map((e) => ({ name: e.name,
                        dir: path.join(stacksDir, e.name) }));

                let backedUpCount = 0;

                for (const stack of stackDirs) {
                    const stackCfg = await this.getStackConfig(stack.name);
                    if (!stackCfg.enabled) {
                        this.logProgress(
                            "info",
                            `[PBS Backup] Skipping stack "${stack.name}" (disabled in per-stack backup settings).\n`
                        );
                        continue;
                    }

                    await this.backupSingleStack(client, baseBackupId, stack.name, stack.dir, {
                        ...options,
                        stackName: stack.name,
                        containerMode: options.containerMode || stackCfg.containerMode || "none",
                        includeVolumes: options.includeVolumes ?? stackCfg.includeVolumes !== false,
                    });
                    backedUpCount++;
                }

                // Back up Dockge internal SQLite DB (`/app/data`) or empty stacksDir fallback
                const dockgeDataDir = "/app/data";
                if (options.includeDockgeData !== false && fs.existsSync(dockgeDataDir)) {
                    const sysArchives = { "dockge-data.pxar": dockgeDataDir };
                    inspector.validateBackupPlan(sysArchives, [], true);
                    await client.backup(
                        sysArchives,
                        this.buildStackBackupId(baseBackupId, "system"),
                        (event) => this.emitLog(event)
                    );
                } else if (backedUpCount === 0) {
                    // Fallback when /opt/stacks has no enabled stacks yet: archive stacksDir directly
                    const fallbackArchives = { "stacks.pxar": stacksDir };
                    inspector.validateBackupPlan(fallbackArchives, [], true);
                    await client.backup(fallbackArchives, baseBackupId, (event) => this.emitLog(event));
                }
            }

            const successMsg = `Backup completed successfully at ${new Date().toLocaleString()}`;
            this.logProgress("done", `[PBS Backup] ${successMsg}\n`);

            await Settings.set("pbs_last_backup", {
                timestamp: new Date().toISOString(),
                status: "success",
                message: successMsg,
            });

            return { ok: true,
                message: successMsg };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logProgress("error", `[PBS Backup Error] ${errorMsg}\n`);

            await Settings.set("pbs_last_backup", {
                timestamp: new Date().toISOString(),
                status: "error",
                message: errorMsg,
            });

            throw error;

        } finally {
            this.releaseLock();
        }
    }

    /**
     * Restores stacks (and any associated named/external volumes recorded in `.pbs-manifest.json`)
     * from a PBS snapshot.
     */
    public async startRestore(options: RestoreOptions): Promise<{ ok: boolean; message: string }> {
        if (!options.snapshot) {
            throw new Error("Snapshot identifier is required for restore.");
        }

        this.acquireLock("restore");

        const client = await this.getClient();
        const stacksDir = this.getStacksDir(options.targetDir);
        const restoreVolumes = options.restoreVolumes !== false;
        const inspector = this.getVolumeInspector();

        this.logProgress("info", `[PBS Restore] Initiating restore from snapshot: ${options.snapshot}\n`);

        try {
            const restoredStackDirs: string[] = [];

            if (options.stackName) {
                // SELECTIVE RESTORE: Restore a single stack
                const cleanStack = this.sanitizeStackName(options.stackName);
                const archiveName = options.archiveName || "stacks.pxar";
                const tempExtractDir = path.join(os.tmpdir(), `dockge-restore-${Date.now()}`);
                await fsAsync.mkdir(tempExtractDir, { recursive: true });

                this.logProgress("info", `[PBS Restore] Selective restore for stack "${cleanStack}" from ${archiveName}...\n`);

                try {
                    await client.restore(options.snapshot, archiveName, tempExtractDir, (event) => this.emitLog(event));

                    // Determine whether the archive was a full `stacks.pxar` (containing `<cleanStack>/`)
                    // or a dedicated single-stack `<cleanStack>.pxar` (containing compose.yaml at root)
                    const nestedStackPath = path.join(tempExtractDir, cleanStack);
                    const sourceStackPath =
                        fs.existsSync(nestedStackPath) && fs.statSync(nestedStackPath).isDirectory()
                            ? nestedStackPath
                            : archiveName.startsWith(`${cleanStack}.pxar`)
                                ? tempExtractDir
                                : nestedStackPath;

                    const destStackPath = path.join(stacksDir, cleanStack);

                    if (!fs.existsSync(sourceStackPath)) {
                        throw new Error(`Stack "${cleanStack}" was not found inside snapshot archive ${archiveName}.`);
                    }

                    if (options.createPreRestoreBackup && fs.existsSync(destStackPath)) {
                        const backupCopyPath = path.join(stacksDir, `${cleanStack}.bak-${Date.now()}`);
                        await fsAsync.cp(destStackPath, backupCopyPath, { recursive: true });
                        this.logProgress("info", `[PBS Restore] Created pre-restore backup: ${backupCopyPath}\n`);
                    }

                    await fsAsync.cp(sourceStackPath, destStackPath, { recursive: true });
                    restoredStackDirs.push(destStackPath);
                    this.logProgress("info", `[PBS Restore] Successfully restored stack files to ${destStackPath}\n`);

                } finally {
                    await fsAsync.rm(tempExtractDir, { recursive: true,
                        force: true }).catch(() => {});
                }

            } else {
                // FULL RESTORE: Extract directly into stacksDir
                const archiveName = options.archiveName || "stacks.pxar";
                this.logProgress("info", `[PBS Restore] Full restore of ${archiveName} into ${stacksDir}...\n`);

                await client.restore(options.snapshot, archiveName, stacksDir, (event) => this.emitLog(event));

                if (fs.existsSync(stacksDir)) {
                    const entries = await fsAsync.readdir(stacksDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && !entry.name.includes(".bak-")) {
                            restoredStackDirs.push(path.join(stacksDir, entry.name));
                        }
                    }
                }
            }

            // Step 2: Restore external bind mounts and named Docker volumes from `.pbs-manifest.json`
            if (restoreVolumes) {
                const containerMounts = inspector.getActiveContainerMounts();

                for (const stackDir of restoredStackDirs) {
                    const manifest = await inspector.readStackManifest(stackDir);
                    if (!manifest) {
                        continue;
                    }

                    // Inform the user of any external: true networks or volumes required before starting the stack
                    const preStartCmds = [
                        ...(manifest.externalNetworks || []).map((n) => `docker network create ${n}`),
                        ...(manifest.externalVolumes || []).map((v) => `docker volume create ${v}`),
                    ];
                    if (preStartCmds.length > 0) {
                        this.logProgress(
                            "info",
                            `[PBS Restore Note] Stack "${manifest.stackName}" uses external resources. Before starting the stack on a new host, run:\n  ${preStartCmds.join("\n  ")}\n`
                        );
                    }

                    for (const ext of manifest.externalArchives) {
                        let targetHostPath = ext.hostPath;

                        if (ext.kind === "named-volume" && ext.dockerVolumeName) {
                            if (ext.isExternalResource) {
                                this.logProgress(
                                    "info",
                                    `[PBS Restore Note] Volume "${ext.dockerVolumeName}" is external: true. Ensure it exists (docker volume create ${ext.dockerVolumeName}) before starting.\n`
                                );
                                targetHostPath = await inspector.resolveNamedVolumeHostPath(ext.dockerVolumeName);
                            } else {
                                this.logProgress(
                                    "info",
                                    `[PBS Restore] Ensuring Docker volume "${ext.dockerVolumeName}" is registered...\n`
                                );
                                targetHostPath = await inspector.ensureDockerVolumeCreated(ext.dockerVolumeName);
                            }
                        }

                        if (!inspector.isHostPathMountedInDockge(targetHostPath, stackDir, containerMounts)) {
                            this.logProgress(
                                "error",
                                `[PBS Restore Warning] Skipping volume "${ext.source}" because ${targetHostPath} is not mounted into Dockge.\n`
                            );
                            continue;
                        }

                        if (options.createPreRestoreBackup && fs.existsSync(targetHostPath)) {
                            const backupVolPath = `${targetHostPath}.bak-${Date.now()}`;
                            await fsAsync.cp(targetHostPath, backupVolPath, { recursive: true }).catch(() => {});
                        }

                        await fsAsync.mkdir(targetHostPath, { recursive: true });
                        this.logProgress(
                            "info",
                            `[PBS Restore] Restoring ${ext.kind} "${ext.source}" (${ext.archiveName}) -> ${targetHostPath}...\n`
                        );

                        await client.restore(options.snapshot, ext.archiveName, targetHostPath, (event) =>
                            this.emitLog(event)
                        );
                    }
                }
            }

            // Step 3: Start containers if requested (after both stack files AND volumes are restored)
            if (options.startAfterRestore) {
                for (const stackDir of restoredStackDirs) {
                    this.logProgress("info", `[PBS Restore] Starting stack at ${stackDir} (docker compose up -d)...\n`);
                    await this.runCompose(stackDir, "up", "-d");
                }
            }

            if (this.server) {
                this.server.sendStackList();
            }

            const successMsg = `Restore from ${options.snapshot} finished successfully.`;
            this.logProgress("done", `[PBS Restore] ${successMsg}\n`);
            return { ok: true,
                message: successMsg };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logProgress("error", `[PBS Restore Error] ${errorMsg}\n`);
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
     * Lists snapshots on PBS that contain backups for a specific stack
     * (either via a per-stack backup-id `<baseBackupId>-<stackName>`, a `<stackName>.pxar` archive,
     * or a legacy `stacks.pxar` archive).
     */
    public async listStackSnapshots(stackName: string): Promise<PbsSnapshot[]> {
        const cleanStack = this.sanitizeStackName(stackName);
        const config = await this.getConfig();
        const baseBackupId = config.backupId || os.hostname() || "dockge";
        const expectedStackBackupId = this.buildStackBackupId(baseBackupId, cleanStack);
        const allSnapshots = await this.listSnapshots();

        return allSnapshots.filter((snap) => {
            if (snap["backup-id"] === expectedStackBackupId) {
                return true;
            }
            if (!Array.isArray(snap.files) || snap.files.length === 0) {
                return false;
            }
            return snap.files.some(
                (f) =>
                    f.filename === "stacks.pxar" ||
                    f.filename === "stacks.pxar.didx" ||
                    f.filename === "stacks.mpxar.didx" ||
                    f.filename === `${cleanStack}.pxar` ||
                    f.filename === `${cleanStack}.pxar.didx` ||
                    f.filename === `${cleanStack}.mpxar.didx` ||
                    f.filename === `${cleanStack}.ppxar.didx`
            );
        });
    }

    /**
     * Deletes a specific snapshot on PBS.
     */
    public async deleteSnapshot(snapshot: string): Promise<{ ok: boolean; message: string }> {
        const client = await this.getClient();
        await client.forget(snapshot);
        return { ok: true,
            message: `Snapshot ${snapshot} deleted.` };
    }
}

export const pbsManager = PbsManager.getInstance();
