import { spawn } from "child_process";
import { log } from "../log";
import { PbsConfig, PbsLogEvent, PbsSnapshot } from "./pbs-types";

/**
 * Custom error thrown when a PBS CLI operation fails.
 */
export class PbsClientError extends Error {
    public exitCode: number;
    public stderr: string;

    constructor(message: string, exitCode = 1, stderr = "") {
        super(message);
        this.name = "PbsClientError";
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

/**
 * Interface for executing CLI processes, abstracted to allow mock injection in tests.
 */
export type ProcessRunner = (
    command: string,
    args: string[],
    options: {
        env?: NodeJS.ProcessEnv;
        cwd?: string;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
    }
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Default process runner using Node.js child_process.spawn.
 */
export const defaultProcessRunner: ProcessRunner = (command, args, options) => {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            env: options.env,
            cwd: options.cwd,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
            const str = chunk.toString();
            stdout += str;
            options.onStdout?.(str);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
            const str = chunk.toString();
            stderr += str;
            options.onStderr?.(str);
        });

        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code: code ?? 0,
            stdout,
            stderr }));
    });
};

/**
 * Low-level client wrapper around the `proxmox-backup-client` CLI binary.
 *
 * All sensitive credentials (password, API secret, TLS fingerprint) are passed
 * exclusively via process environment variables to prevent leaking into system
 * process tables (`ps aux`).
 */
export class PbsClient {
    private config: PbsConfig;
    private runner: ProcessRunner;
    private binaryPath: string;

    /**
     * @param config Connection parameters for Proxmox Backup Server.
     * @param runner Optional runner override (used for automated unit testing).
     * @param binaryPath Path to proxmox-backup-client binary (defaults to 'proxmox-backup-client').
     */
    constructor(config: PbsConfig, runner: ProcessRunner = defaultProcessRunner, binaryPath = "proxmox-backup-client") {
        this.config = config;
        this.runner = runner;
        this.binaryPath = binaryPath;
    }

    /**
     * Formats the PBS repository connection string:
     * `[authId@]host[:port]:datastore`
     */
    public getRepositoryString(): string {
        const port = this.config.port || 8007;
        const host = this.config.host.trim();
        const datastore = this.config.datastore.trim();

        if (this.config.authId && this.config.authId.trim()) {
            return `${this.config.authId.trim()}@${host}:${port}:${datastore}`;
        }
        return `${host}:${port}:${datastore}`;
    }

    /**
     * Constructs the environment variables required for `proxmox-backup-client`.
     */
    public getEnvironment(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PBS_REPOSITORY: this.getRepositoryString(),
        };

        if (this.config.secret) {
            env.PBS_PASSWORD = this.config.secret;
        }

        if (this.config.fingerprint && this.config.fingerprint.trim()) {
            env.PBS_FINGERPRINT = this.config.fingerprint.trim();
        }

        if (this.config.encryptionPassword) {
            env.PBS_ENCRYPTION_PASSWORD = this.config.encryptionPassword;
        }

        return env;
    }

    /**
     * Appends `--ns <namespace>` when a PBS namespace is configured.
     */
    private withNamespace(args: string[]): string[] {
        return this.config.namespace ? [ ...args, "--ns", this.config.namespace ] : args;
    }

    /**
     * Executes the PBS CLI binary with safe environment variables and progress handlers.
     */
    private async execute(
        args: string[],
        onProgress?: (event: PbsLogEvent) => void,
        cwd?: string
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        const env = this.getEnvironment();
        log.debug("pbs-client", `Executing: ${this.binaryPath} ${args.join(" ")}`);

        try {
            const result = await this.runner(this.binaryPath, args, {
                env,
                cwd,
                onStdout: (text) => onProgress?.({ type: "stdout",
                    text,
                    timestamp: Date.now() }),
                onStderr: (text) => onProgress?.({ type: "stderr",
                    text,
                    timestamp: Date.now() }),
            });

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || result.stdout.trim() || `Process exited with code ${result.code}`;
                log.error("pbs-client", `PBS CLI failed (${result.code}): ${errMsg}`);
                throw new PbsClientError(errMsg, result.code, result.stderr);
            }

            return result;
        } catch (error) {
            if (error instanceof PbsClientError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            log.error("pbs-client", `Failed to spawn PBS CLI: ${message}`);
            throw new PbsClientError(`PBS execution error: ${message}`, 1, message);
        }
    }

    /**
     * Test connection to Proxmox Backup Server by checking datastore status.
     * Returns true if connection succeeds, throws PbsClientError otherwise.
     */
    public async testConnection(): Promise<{ ok: boolean; message: string; version?: string }> {
        const res = await this.execute(this.withNamespace([ "status", "--output-format", "json" ]));
        return {
            ok: true,
            message: "Connection successful",
            version: res.stdout,
        };
    }

    /**
     * Performs a backup of one or more directories into `.pxar` archives on PBS.
     *
     * @param archives Map of archive names to directory paths (e.g. `{ "stacks.pxar": "/opt/stacks" }`).
     * @param backupId Optional backup identifier (defaults to configured backupId or system hostname).
     * @param onProgress Callback receiving live stdout/stderr streams.
     */
    public async backup(
        archives: Record<string, string>,
        backupId?: string,
        onProgress?: (event: PbsLogEvent) => void
    ): Promise<{ code: number; stdout: string }> {
        const id = backupId || this.config.backupId || "dockge";
        const archiveArgs = Object.entries(archives).map(([ name, dir ]) => `${name}:${dir}`);
        const args = this.withNamespace([
            "backup",
            ...archiveArgs,
            "--backup-id",
            id,
            "--backup-type",
            "host",
            "--change-detection-mode=metadata",
        ]);

        const res = await this.execute(args, onProgress);
        return { code: res.code,
            stdout: res.stdout };
    }

    /**
     * Retrieves the list of available snapshots from Proxmox Backup Server.
     */
    public async listSnapshots(): Promise<PbsSnapshot[]> {
        const res = await this.execute(this.withNamespace([ "snapshot", "list", "--output-format", "json" ]));

        try {
            const raw = JSON.parse(res.stdout);
            if (!Array.isArray(raw)) {
                return [];
            }

            return raw.map((item: Partial<PbsSnapshot>) => {
                const bType = item["backup-type"] || "host";
                const bId = item["backup-id"] || "";
                const bTime = item["backup-time"] || 0;
                // PBS requires RFC3339 timestamps without milliseconds (e.g. "2026-10-28T20:53:26Z", NOT ".000Z")
                const iso = new Date(bTime * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

                return {
                    "backup-type": bType,
                    "backup-id": bId,
                    "backup-time": bTime,
                    backupTimeISO: iso,
                    files: item.files || [],
                    size: item.size || 0,
                    snapshotId: `${bType}/${bId}/${iso}`,
                    comment: item.comment || "",
                };
            });
        } catch {
            log.error("pbs-client", `Failed to parse snapshots JSON: ${res.stdout}`);
            throw new PbsClientError(`Invalid JSON response from PBS: ${res.stdout}`);
        }
    }

    /**
     * Restores an archive from a snapshot into a target directory.
     *
     * @param snapshot Snapshot ID, e.g. "host/dockge/2026-10-28T10:00:00Z".
     * @param archiveName Name of pxar archive to restore, e.g. "stacks.pxar".
     * @param targetDir Local target directory where archive should be extracted.
     * @param onProgress Callback receiving live progress logs.
     */
    public async restore(
        snapshot: string,
        archiveName: string,
        targetDir: string,
        onProgress?: (event: PbsLogEvent) => void
    ): Promise<{ code: number; stdout: string }> {
        const cleanSnapshot = snapshot.replace(/\.\d{3}Z$/, "Z");
        const args = this.withNamespace([ "restore", cleanSnapshot, archiveName, targetDir ]);
        const res = await this.execute(args, onProgress);
        return { code: res.code,
            stdout: res.stdout };
    }

    /**
     * Prunes old snapshots based on retention rules.
     */
    public async prune(rules: {
        keepLast?: number;
        keepDaily?: number;
        keepWeekly?: number;
        keepMonthly?: number;
        backupId?: string;
    }): Promise<{ code: number; stdout: string }> {
        const id = rules.backupId || this.config.backupId || "dockge";
        const args = [ "prune", `host/${id}` ];

        const flagMap: Array<[string, number | undefined]> = [
            [ "--keep-last", rules.keepLast ],
            [ "--keep-daily", rules.keepDaily ],
            [ "--keep-weekly", rules.keepWeekly ],
            [ "--keep-monthly", rules.keepMonthly ],
        ];
        for (const [ flag, val ] of flagMap) {
            if (val !== undefined && val > 0) {
                args.push(flag, String(val));
            }
        }

        return await this.execute(this.withNamespace(args));
    }

    /**
     * Forgets (deletes) a specific snapshot.
     */
    public async forget(snapshot: string): Promise<{ code: number; stdout: string }> {
        const cleanSnapshot = snapshot.replace(/\.\d{3}Z$/, "Z");
        return await this.execute(this.withNamespace([ "snapshot", "forget", cleanSnapshot ]));
    }
}

