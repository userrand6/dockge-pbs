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
    /**
     * Whether to include named Docker volumes and external bind mounts defined in compose.yaml.
     * Defaults to true.
     */
    includeVolumes?: boolean;
    /**
     * If true, proceeds with backing up the stack even if some external/named volumes
     * are not mounted into Dockge (incomplete backup). Defaults to false.
     */
    allowIncompleteBackup?: boolean;
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
    /**
     * Whether to also restore named volumes and external bind mounts recorded in .pbs-manifest.json.
     * Defaults to true.
     */
    restoreVolumes?: boolean;
}

/**
 * Represents a single volume or bind mount detected in a stack's compose.yaml.
 */
export interface DetectedStackVolume {
    /**
     * Mount classification:
     * - "internal-bind": bind mount located inside the stack folder (e.g. ./data) -> backed up automatically with stack
     * - "external-bind": bind mount located outside the stack folder (e.g. /mnt/nas/media)
     * - "named-volume": Docker-managed named volume (e.g. db_data -> /var/lib/docker/volumes/<stack>_db_data/_data)
     */
    kind: "internal-bind" | "external-bind" | "named-volume";
    /** Service in compose.yaml that mounts this volume */
    serviceName: string;
    /** Source identifier in compose.yaml (volume key or host path) */
    source: string;
    /** Target mount path inside the container */
    target: string;
    /** Resolved Docker volume name (e.g. "mystack_db_data") when kind === "named-volume" */
    dockerVolumeName?: string;
    /** Physical directory path on the host filesystem */
    hostPath: string;
    /** Dedicated .pxar archive filename inside PBS snapshot (for external-bind and named-volume) */
    archiveName: string;
    /** True if Dockge can currently read/write this path (mounted into Dockge container or running on bare-metal) */
    isAccessible: boolean;
    /** True if the path currently exists on disk */
    existsOnDisk: boolean;
    /** True if the path is a directory (or does not exist yet); false if it is a single file */
    isDirectory: boolean;
    /** True if this named volume is declared with `external: true` in compose.yaml */
    isExternalResource?: boolean;
    /** Recommended volume line to add to Dockge's own compose.yaml if not accessible */
    recommendedDockgeMount?: string;
}

/**
 * Result of inspecting a stack's compose.yaml for volumes, external dependencies, and mount accessibility.
 */
export interface StackVolumeInspectionResult {
    stackName: string;
    volumes: DetectedStackVolume[];
    /** True if all volumes are accessible to Dockge */
    allAccessible: boolean;
    /** Subset of volumes that are NOT accessible inside Dockge */
    missingMounts: DetectedStackVolume[];
    /** Any volume source strings that still contain unexpanded $VAR or ${VAR} tokens */
    unresolvedVariables: string[];
    /** Ready-to-copy YAML snippet for Dockge's compose.yaml to mount the missing locations */
    recommendedComposeSnippet?: string;
    /** External Docker networks (`networks.<key>.external: true`) required by this stack */
    externalNetworks: string[];
    /** External Docker volumes (`volumes.<key>.external: true`) required by this stack */
    externalVolumes: string[];
    /** Ready-to-run CLI commands (`docker network create ...`, `docker volume create ...`) to run before starting the stack on a new host */
    preStartCommands: string[];
}

/**
 * Self-contained manifest written to `<stackDir>/.pbs-manifest.json` prior to backup.
 * Allows restore operations to automatically recreate stack-owned named volumes (`docker volume create`),
 * restore external archives to their exact host paths, and inform the user of any `external: true` dependencies.
 */
export interface PbsStackManifest {
    version: 1;
    stackName: string;
    createdAt: string;
    externalNetworks?: string[];
    externalVolumes?: string[];
    externalArchives: Array<{
        kind: "named-volume" | "external-bind";
        archiveName: string;
        dockerVolumeName?: string;
        isExternalResource?: boolean;
        hostPath: string;
        source: string;
        target: string;
    }>;
}

/**
 * Per-stack backup configuration.
 */
export interface StackBackupConfig {
    /** Whether automated backup is specifically enabled for this stack */
    enabled: boolean;
    /** Container handling mode for this stack during backup (e.g. "none" / live, "pause", "stop") */
    containerMode: ContainerBackupMode;
    /** Optional custom cron schedule for this stack (if empty, uses global schedule) */
    cron?: string;
    /** Whether to include local bind mounts and data folders inside the stack directory */
    includeVolumes?: boolean;
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

