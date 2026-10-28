/**
 * PBS (Proxmox Backup Server) Type Definitions and Interfaces
 *
 * This module defines all data models, options, and status payloads
 * used across the PBS client, manager, scheduler, and socket handlers.
 */

/**
 * Authentication configuration for Proxmox Backup Server.
 */
export interface PbsConfig {
    /** Whether PBS backup functionality is enabled */
    enabled: boolean;
    /** PBS server host or IP (e.g. "pbs.example.com" or "192.168.1.50") */
    host: string;
    /** PBS server port (defaults to 8007) */
    port: number;
    /** Target datastore name on PBS (e.g. "backup-ds") */
    datastore: string;
    /**
     * Auth ID / Username.
     * Can be an API token (e.g. "dockge@pbs!backup-token") or user (e.g. "root@pam", "admin@pbs").
     */
    authId: string;
    /**
     * Secret password or API token secret.
     * Never returned in plain text to the UI.
     */
    secret: string;
    /**
     * SHA-256 certificate fingerprint of the PBS server.
     * Necessary when PBS uses self-signed TLS certificates.
     * Format: "aa:bb:cc:...:zz"
     */
    fingerprint?: string;
    /**
     * Optional client-side encryption password or key.
     */
    encryptionPassword?: string;
    /**
     * Optional PBS namespace (for multi-tenant datastores).
     */
    namespace?: string;
    /**
     * Backup ID to identify this Dockge node on PBS (defaults to hostname).
     */
    backupId?: string;
}

/**
 * Backup container transition mode during backup.
 */
export type ContainerBackupMode = "none" | "pause" | "stop";

/**
 * Options for triggering a backup.
 */
export interface BackupOptions {
    /**
     * Mode of container handling during archive creation:
     * - "none": live backup without stopping or pausing (default)
     * - "pause": pauses containers during pxar archiving
     * - "stop": temporarily stops containers for crash-consistent database volumes
     */
    containerMode?: ContainerBackupMode;
    /**
     * Optional specific stack to backup. If omitted, all stacks in stacksDir are backed up.
     */
    stackName?: string;
    /**
     * Whether to also back up Dockge's own application data (/app/data/dockge.db).
     * Defaults to true for full disaster recovery.
     */
    includeDockgeData?: boolean;
}

/**
 * Options for restoring from a PBS snapshot.
 */
export interface RestoreOptions {
    /**
     * The snapshot identifier to restore from (e.g. "host/dockge/2026-10-28T10:00:00Z").
     */
    snapshot: string;
    /**
     * Name of the pxar archive inside the snapshot (e.g. "stacks.pxar").
     */
    archiveName?: string;
    /**
     * If specified, restores only this specific stack folder from the archive.
     */
    stackName?: string;
    /**
     * Target directory to restore into.
     * Defaults to the server's stacks directory.
     */
    targetDir?: string;
    /**
     * If true, runs `docker compose up -d` on restored stack(s) after extraction.
     */
    startAfterRestore?: boolean;
    /**
     * If true, creates a backup copy of existing files before overwriting.
     */
    createPreRestoreBackup?: boolean;
}

/**
 * Schedule and retention configuration.
 */
export interface PbsScheduleConfig {
    /** Whether scheduled backups are enabled */
    enabled: boolean;
    /** Cron expression (e.g. "0 2 * * *" for daily at 2:00 AM) */
    cron: string;
    /** Container handling mode during scheduled backups */
    containerMode: ContainerBackupMode;
    /** Whether to include Dockge internal data in scheduled backups */
    includeDockgeData: boolean;
    /** Retention: keep last N snapshots */
    keepLast?: number;
    /** Retention: keep N daily snapshots */
    keepDaily?: number;
    /** Retention: keep N weekly snapshots */
    keepWeekly?: number;
    /** Retention: keep N monthly snapshots */
    keepMonthly?: number;
}

/**
 * Snapshot representation returned by `proxmox-backup-client snapshot list --output-format json`.
 */
export interface PbsSnapshot {
    /** Backup type, usually "host" */
    "backup-type": string;
    /** Backup ID, e.g. "dockge" */
    "backup-id": string;
    /** Unix timestamp (seconds) of the backup */
    "backup-time": number;
    /** ISO formatted timestamp string */
    backupTimeISO?: string;
    /** Files / archives inside this snapshot (e.g. ["stacks.pxar", "client.log"]) */
    files?: Array<{
        filename: string;
        size?: number;
        crypt?: string;
    }>;
    /** Human readable size string */
    size?: number;
    /** Full snapshot identifier: "backup-type/backup-id/timestamp" */
    snapshotId: string;
    /** Verification comment or status */
    comment?: string;
}

/**
 * Current runtime status of the PBS manager.
 */
export interface PbsManagerStatus {
    /** True if an operation (backup/restore) is currently running */
    isOperating: boolean;
    /** Type of current operation: "idle" | "backup" | "restore" | "prune" */
    currentOperation: "idle" | "backup" | "restore" | "prune";
    /** ISO timestamp when current operation started */
    operationStartedAt?: string;
    /** Last completed backup details */
    lastBackup?: {
        timestamp: string;
        status: "success" | "error";
        message: string;
        snapshotId?: string;
    };
    /** Next scheduled backup run time in ISO format */
    nextScheduledRun?: string;
}

/**
 * Live log chunk emitted to subscribers during backup or restore.
 */
export interface PbsLogEvent {
    type: "stdout" | "stderr" | "info" | "error" | "done";
    text: string;
    timestamp: number;
}

