/**
 * PBS Volume Inspector & Manifest Manager (`backend/pbs/pbs-volume-inspector.ts`)
 *
 * This module inspects a stack's Docker Compose configuration to discover:
 *   1. Relative bind mounts inside the stack folder (automatically backed up with the stack).
 *   2. Docker Named Volumes (resolved to `/var/lib/docker/volumes/<name>/_data`).
 *   3. External bind mounts located outside the stack folder (e.g. `/mnt/nas/appdata`).
 *
 * How parsing works:
 *   - Primary Parser: Executes `docker compose config --format json` inside the stack folder.
 *     Docker Compose natively resolves `.env` variables, YAML anchors, short/long volume syntax,
 *     and project-prefixed volume names.
 *   - Fallback Parser: If the Docker daemon is unreachable (e.g. offline mode or unit tests),
 *     falls back to Dockge's built-in `dotenv` + `envsubstYAML` + `yaml.parse`.
 *
 * How mount accessibility detection works:
 *   - When Dockge runs inside a Docker container (`/.dockerenv` exists), host paths outside
 *     `/opt/stacks` are only reachable if the user mounted them into Dockge's own `compose.yaml`.
 *   - We inspect `/proc/self/mountinfo` to verify whether a volume's host path is covered by
 *     an active mount inside the Dockge container, preventing silent incomplete backups.
 */

import fs, { promises as fsAsync } from "fs";
import path from "path";
import yaml from "yaml";
import dotenv from "dotenv";
import childProcessAsync from "promisify-child-process";
import { acceptedComposeFileNames, envsubstYAML } from "../../common/util-common";
import {
    DetectedStackVolume,
    PbsStackManifest,
    StackVolumeInspectionResult,
} from "./pbs-types";
import { ProcessRunner } from "./pbs-client";

export const PBS_MANIFEST_FILENAME = ".pbs-manifest.json";
export const DEFAULT_DOCKER_VOLUMES_ROOT = "/var/lib/docker/volumes";

/**
 * Normalized internal representation of a parsed compose config.
 */
interface NormalizedComposeConfig {
    projectName: string;
    services: Record<
        string,
        {
            volumes?: Array<{
                type: string;
                source?: string;
                target?: string;
            }>;
        }
    >;
    volumes: Record<
        string,
        {
            name?: string;
            external?: boolean;
        }
    >;
    networks?: Record<
        string,
        {
            name?: string;
            external?: boolean;
        }
    >;
}

export class PbsVolumeInspector {
    private customRunner?: ProcessRunner;
    /**
     * Optional override for container mount points (used in unit tests to simulate
     * running inside a Docker container with specific mounts).
     */
    private customContainerMounts?: string[] | null;
    private customVolumesRoot?: string;

    constructor(
        customRunner?: ProcessRunner,
        customContainerMounts?: string[] | null,
        customVolumesRoot?: string
    ) {
        this.customRunner = customRunner;
        this.customContainerMounts = customContainerMounts;
        this.customVolumesRoot = customVolumesRoot;
    }

    /**
     * Inspects a stack directory and returns all detected volumes, their host paths,
     * whether Dockge can access them, and a ready-to-copy YAML snippet for any missing mounts.
     */
    public async inspectStack(stackName: string, stackDir: string): Promise<StackVolumeInspectionResult> {
        const absStackDir = path.resolve(stackDir);
        const config = await this.parseComposeDirectory(stackName, absStackDir);
        const containerMounts = this.getActiveContainerMounts();

        const detectedVolumes: DetectedStackVolume[] = [];
        const unresolvedVariables: string[] = [];
        // Track seen hostPaths so shared volumes mounted by multiple services in the same stack are not duplicated
        const seenHostPaths = new Set<string>();

        for (const [ serviceName, serviceObj ] of Object.entries(config.services || {})) {
            const serviceVolumes = serviceObj?.volumes || [];

            for (const vol of serviceVolumes) {
                if (!vol || !vol.source || !vol.target) {
                    continue;
                }

                // Ignore tmpfs or named pipes
                if (vol.type !== "volume" && vol.type !== "bind") {
                    continue;
                }

                // Detect unexpanded environment variables (e.g. ${UNSET_VAR} or $UNSET_VAR)
                if (vol.source.includes("$") || vol.target.includes("$")) {
                    unresolvedVariables.push(`${serviceName}: ${vol.source}:${vol.target}`);
                    continue;
                }

                if (vol.type === "volume") {
                    // Named Docker Volume
                    const topLevelVol = config.volumes?.[vol.source];
                    const dockerVolumeName = topLevelVol?.name || `${config.projectName}_${vol.source}`;
                    const hostPath = await this.resolveNamedVolumeHostPath(dockerVolumeName);

                    if (seenHostPaths.has(hostPath)) {
                        continue;
                    }
                    seenHostPaths.add(hostPath);

                    const existsOnDisk = fs.existsSync(hostPath);
                    const isDirectory = !existsOnDisk || fs.statSync(hostPath).isDirectory();
                    const isAccessible = this.isHostPathMountedInDockge(hostPath, absStackDir, containerMounts);
                    const volumesRoot = this.customVolumesRoot || DEFAULT_DOCKER_VOLUMES_ROOT;

                    detectedVolumes.push({
                        kind: "named-volume",
                        serviceName,
                        source: vol.source,
                        target: vol.target,
                        dockerVolumeName,
                        hostPath,
                        archiveName: this.buildArchiveName("vol", stackName, vol.source),
                        isAccessible,
                        existsOnDisk,
                        isDirectory,
                        isExternalResource: Boolean(topLevelVol?.external),
                        recommendedDockgeMount: isAccessible
                            ? undefined
                            : `${volumesRoot}:${volumesRoot}:rslave`,
                    });
                } else if (vol.type === "bind") {
                    // Bind Mount: resolve relative paths against the stack directory
                    const resolvedHostPath = path.isAbsolute(vol.source)
                        ? path.normalize(vol.source)
                        : path.resolve(absStackDir, vol.source);

                    // Skip system pseudo-filesystems (/proc, /sys, /dev, /var/run/docker.sock, /etc/localtime, etc.)
                    if (this.isIgnoredSystemPath(resolvedHostPath)) {
                        continue;
                    }

                    if (seenHostPaths.has(resolvedHostPath)) {
                        continue;
                    }
                    seenHostPaths.add(resolvedHostPath);

                    const existsOnDisk = fs.existsSync(resolvedHostPath);
                    const isDirectory = !existsOnDisk || fs.statSync(resolvedHostPath).isDirectory();

                    // Check if the bind mount is inside the stack folder itself (e.g. ./data)
                    const isInsideStackDir =
                        resolvedHostPath === absStackDir ||
                        resolvedHostPath.startsWith(absStackDir + path.sep);

                    if (isInsideStackDir) {
                        detectedVolumes.push({
                            kind: "internal-bind",
                            serviceName,
                            source: vol.source,
                            target: vol.target,
                            hostPath: resolvedHostPath,
                            archiveName: `${stackName}.pxar`,
                            isAccessible: true,
                            existsOnDisk,
                            isDirectory,
                        });
                    } else {
                        const isAccessible = this.isHostPathMountedInDockge(
                            resolvedHostPath,
                            absStackDir,
                            containerMounts
                        );

                        detectedVolumes.push({
                            kind: "external-bind",
                            serviceName,
                            source: vol.source,
                            target: vol.target,
                            hostPath: resolvedHostPath,
                            archiveName: this.buildArchiveName("bind", stackName, resolvedHostPath),
                            isAccessible,
                            existsOnDisk,
                            isDirectory,
                            recommendedDockgeMount: isAccessible
                                ? undefined
                                : `${resolvedHostPath}:${resolvedHostPath}`,
                        });
                    }
                }
            }
        }

        const missingMounts = detectedVolumes.filter((v) => !v.isAccessible);
        const uniqueMountLines = Array.from(
            new Set(
                missingMounts
                    .map((m) => m.recommendedDockgeMount)
                    .filter((line): line is string => Boolean(line))
            )
        );

        const recommendedComposeSnippet =
            uniqueMountLines.length > 0
                ? [ "volumes:", ...uniqueMountLines.map((line) => `  - ${line}`) ].join("\n")
                : undefined;

        // Collect external: true networks and volumes so Dockge can inform the user
        // what to create on a new host before starting the stack (without silently mutating network state).
        const externalNetworks = this.extractExternalResourceNames(config.networks);
        const externalVolumes = this.extractExternalResourceNames(config.volumes);
        const preStartCommands = [
            ...externalNetworks.map((net) => `docker network create ${net}`),
            ...externalVolumes.map((vol) => `docker volume create ${vol}`),
        ];

        return {
            stackName,
            volumes: detectedVolumes,
            allAccessible: missingMounts.length === 0,
            missingMounts,
            unresolvedVariables,
            externalNetworks,
            externalVolumes,
            preStartCommands,
            recommendedComposeSnippet,
        };
    }

    /**
     * Extracts resolved names of top-level compose resources (`networks` or `volumes`) marked `external: true`.
     */
    private extractExternalResourceNames(
        resourceMap?: Record<string, { name?: string; external?: boolean }>
    ): string[] {
        return Object.entries(resourceMap || {})
            .filter(([ , obj ]) => Boolean(obj?.external))
            .map(([ key, obj ]) => obj.name || key);
    }

    /**
     * Parses a stack's compose file.
     * Step 1: Attempts `docker compose config --format json` (canonical Docker CLI parser).
     * Step 2: Falls back to static YAML + `.env` parsing if the Docker CLI/daemon is unavailable.
     */
    public async parseComposeDirectory(
        stackName: string,
        stackDir: string
    ): Promise<NormalizedComposeConfig> {
        // 1. Try canonical `docker compose config --format json`
        try {
            const stdout = await this.execCommand(
                "docker",
                [ "compose", "config", "--format", "json" ],
                stackDir
            );
            if (stdout && stdout.trim().startsWith("{")) {
                const parsed = JSON.parse(stdout);
                return {
                    projectName: parsed.name || stackName,
                    services: parsed.services || {},
                    volumes: parsed.volumes || {},
                    networks: parsed.networks || {},
                };
            }
        } catch {
            // Fall through to static YAML parser if Docker daemon is offline or in test mode
        }

        // 2. Fallback: Static YAML + .env parser
        return this.parseComposeStaticFallback(stackName, stackDir);
    }

    /**
     * Normalizes a top-level `volumes` or `networks` block from raw parsed YAML.
     */
    private parseTopLevelResourceMap(
        rawMap: unknown,
        stackName: string
    ): Record<string, { name?: string; external?: boolean }> {
        const result: Record<string, { name?: string; external?: boolean }> = {};
        if (!rawMap || typeof rawMap !== "object") {
            return result;
        }
        for (const [ key, val ] of Object.entries(rawMap)) {
            const obj = (val && typeof val === "object" ? val : {}) as Record<string, unknown>;
            const isExternal = Boolean(obj.external);
            const customName = typeof obj.name === "string" ? obj.name : undefined;
            result[key] = {
                name: customName || (isExternal ? key : `${stackName}_${key}`),
                external: isExternal,
            };
        }
        return result;
    }

    /**
     * Static fallback parser using Dockge's built-in `dotenv`, `envsubstYAML`, and `yaml` packages.
     * Handles both short syntax (`source:target[:mode]`) and long syntax (`{ type, source, target }`).
     */
    public parseComposeStaticFallback(
        stackName: string,
        stackDir: string
    ): NormalizedComposeConfig {
        const composeFile = acceptedComposeFileNames
            .map((name) => path.join(stackDir, name))
            .find((candidate) => fs.existsSync(candidate));

        if (!composeFile) {
            return { projectName: stackName,
                services: {},
                volumes: {},
                networks: {} };
        }

        const rawYaml = fs.readFileSync(composeFile, "utf-8");
        const envPath = path.join(stackDir, ".env");
        const envVars = fs.existsSync(envPath)
            ? dotenv.parse(fs.readFileSync(envPath, "utf-8"))
            : {};

        let resolvedYaml = rawYaml;
        try {
            resolvedYaml = envsubstYAML(rawYaml, envVars);
        } catch {
            // If envsubst fails on unusual syntax, parse raw YAML directly
        }

        const doc = yaml.parse(resolvedYaml) || {};
        const topLevelVolumes = this.parseTopLevelResourceMap(doc.volumes, stackName);
        const topLevelNetworks = this.parseTopLevelResourceMap(doc.networks, stackName);
        const normalizedServices: NormalizedComposeConfig["services"] = {};

        if (doc.services && typeof doc.services === "object") {
            for (const [ svcName, svcVal ] of Object.entries(doc.services)) {
                const sObj = (svcVal && typeof svcVal === "object" ? svcVal : {}) as Record<string, unknown>;
                const rawVolumes = Array.isArray(sObj.volumes) ? sObj.volumes : [];
                const parsedVolumes: Array<{ type: string; source?: string; target?: string }> = [];

                for (const entry of rawVolumes) {
                    if (typeof entry === "string") {
                        const parsedShort = this.parseShortVolumeString(entry);
                        if (parsedShort) {
                            parsedVolumes.push(parsedShort);
                        }
                    } else if (entry && typeof entry === "object") {
                        const eObj = entry as Record<string, unknown>;
                        if (typeof eObj.type === "string" && typeof eObj.target === "string") {
                            parsedVolumes.push({
                                type: eObj.type,
                                source: typeof eObj.source === "string" ? eObj.source : undefined,
                                target: eObj.target,
                            });
                        }
                    }
                }

                normalizedServices[svcName] = { volumes: parsedVolumes };
            }
        }

        return {
            projectName: typeof doc.name === "string" ? doc.name : stackName,
            services: normalizedServices,
            volumes: topLevelVolumes,
            networks: topLevelNetworks,
        };
    }

    /**
     * Parses a short-syntax Docker volume string (e.g. "./data:/app/data:ro" or "db_data:/var/lib/mysql").
     */
    private parseShortVolumeString(
        spec: string
    ): { type: "bind" | "volume"; source: string; target: string } | null {
        const parts = spec.trim().split(":");
        if (parts.length < 2) {
            return null;
        }

        const source = parts[0].trim();
        const target = parts[1].trim();
        if (!source || !target) {
            return null;
        }

        // In Docker Compose, a source starting with `.`, `/`, or `~` is a bind mount;
        // a bare identifier (e.g. "db_data") is a named volume.
        const isBind =
            source.startsWith(".") ||
            source.startsWith("/") ||
            source.startsWith("~") ||
            source.includes("/");

        return {
            type: isBind ? "bind" : "volume",
            source,
            target,
        };
    }

    /**
     * Resolves the physical host directory for a Docker named volume.
     * Queries `docker volume inspect <name> --format "{{ .Mountpoint }}"` first,
     * and falls back to `/var/lib/docker/volumes/<name>/_data`.
     */
    public async resolveNamedVolumeHostPath(dockerVolumeName: string): Promise<string> {
        const volumesRoot = this.customVolumesRoot || DEFAULT_DOCKER_VOLUMES_ROOT;
        try {
            const stdout = await this.execCommand("docker", [
                "volume",
                "inspect",
                dockerVolumeName,
                "--format",
                "{{ .Mountpoint }}",
            ]);
            const trimmed = stdout.trim();
            if (trimmed && path.isAbsolute(trimmed)) {
                return trimmed;
            }
        } catch {
            // Volume may not be created yet or Docker CLI is offline
        }
        return path.join(volumesRoot, dockerVolumeName, "_data");
    }

    /**
     * Ensures a named Docker volume is registered in Docker's volume database (`metadata.db`)
     * prior to restoring files into its mountpoint.
     */
    public async ensureDockerVolumeCreated(dockerVolumeName: string): Promise<string> {
        try {
            await this.execCommand("docker", [ "volume", "create", dockerVolumeName ]);
        } catch {
            // Ignore if Docker daemon is offline in unit test environment
        }
        return await this.resolveNamedVolumeHostPath(dockerVolumeName);
    }

    /**
     * Determines whether a host path is accessible from within the running Dockge process.
     * - If running on bare-metal (`containerMounts === null`), all host paths are directly on the host OS.
     * - If running inside a container, the target path must fall under one of the container's bind mounts.
     */
    public isHostPathMountedInDockge(
        hostPath: string,
        stackDir: string,
        containerMounts: string[] | null
    ): boolean {
        const normalizedTarget = path.resolve(hostPath);
        const normalizedStackDir = path.resolve(stackDir);

        // Paths inside the stack directory are always accessible
        if (
            normalizedTarget === normalizedStackDir ||
            normalizedTarget.startsWith(normalizedStackDir + path.sep)
        ) {
            return true;
        }

        // Bare-metal execution (not inside a Docker container):
        // The path is directly on the host filesystem.
        if (containerMounts === null) {
            return true;
        }

        // Containerized execution:
        // Check if `normalizedTarget` is equal to or inside any active volume mount in Dockge.
        return containerMounts.some(
            (mountPoint) =>
                mountPoint !== "/" &&
                (normalizedTarget === mountPoint ||
                    normalizedTarget.startsWith(mountPoint + path.sep))
        );
    }

    /**
     * Reads `/proc/self/mountinfo` when running inside a Linux Docker container
     * to discover which host directories are actually mounted into Dockge.
     * Returns `null` when running on bare-metal (outside Docker).
     */
    public getActiveContainerMounts(): string[] | null {
        if (this.customContainerMounts !== undefined) {
            return this.customContainerMounts;
        }

        // Detect if Dockge is running inside a container
        const isContainer =
            fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
        if (!isContainer) {
            return null;
        }

        try {
            if (!fs.existsSync("/proc/self/mountinfo")) {
                return null;
            }
            const content = fs.readFileSync("/proc/self/mountinfo", "utf-8");
            const mountPoints: string[] = [];

            // Format of /proc/self/mountinfo lines:
            // 36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
            // Field index 4 (0-based) is the mount point inside the container.
            for (const line of content.split("\n")) {
                const fields = line.trim().split(/\s+/);
                if (fields.length >= 5) {
                    const mountPoint = fields[4].replace(/\\040/g, " ");
                    // Ignore virtual system mounts and single-file container config mounts
                    if (
                        mountPoint !== "/" &&
                        !mountPoint.startsWith("/proc") &&
                        !mountPoint.startsWith("/sys") &&
                        !mountPoint.startsWith("/dev") &&
                        !mountPoint.startsWith("/etc/") &&
                        !mountPoint.startsWith("/run/")
                    ) {
                        mountPoints.push(path.resolve(mountPoint));
                    }
                }
            }
            return mountPoints;
        } catch {
            return null;
        }
    }

    /**
     * Returns true if `hostPath` is a virtual kernel filesystem, socket path, or standard
     * host system file that should never be packaged into a `.pxar` archive
     * (e.g. `/`, `/proc`, `/sys`, `/dev`, `/var/run/docker.sock`, `/etc/localtime`).
     */
    public isIgnoredSystemPath(hostPath: string): boolean {
        const normalized = path.resolve(hostPath);
        if (normalized === "/") {
            return true;
        }

        const systemPrefixes = [ "/proc", "/sys", "/dev", "/run", "/var/run" ];
        for (const prefix of systemPrefixes) {
            if (normalized === prefix || normalized.startsWith(prefix + "/")) {
                return true;
            }
        }

        const systemSingleFiles = new Set([
            "/etc/localtime",
            "/etc/timezone",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/hostname",
            "/etc/passwd",
            "/etc/group",
            "/etc/shadow",
            "/etc/machine-id",
        ]);
        return systemSingleFiles.has(normalized);
    }

    /**
     * Builds a deterministic, PBS-safe `.pxar` archive filename for a named volume or external bind mount.
     * Example:
     *   - Named volume `db_data` in stack `authentik` -> `vol-authentik-db_data.pxar`
     *   - External bind `/mnt/nas/media` in stack `jellyfin` -> `bind-jellyfin-mnt_nas_media.pxar`
     */
    public buildArchiveName(
        prefix: "vol" | "bind",
        stackName: string,
        identifier: string
    ): string {
        const cleanStack = stackName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const cleanId = identifier
            .replace(/^\/+/, "")
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .replace(/_+/g, "_")
            .slice(0, 64);
        return `${prefix}-${cleanStack}-${cleanId}.pxar`;
    }

    /**
     * Writes `.pbs-manifest.json` inside the stack directory before archiving
     * so the snapshot is 100% self-describing for future restores.
     */
    public async writeStackManifest(
        stackName: string,
        stackDir: string,
        volumes: DetectedStackVolume[],
        externalNetworks: string[] = [],
        externalVolumes: string[] = []
    ): Promise<PbsStackManifest> {
        const externalArchives = volumes
            .filter(
                (v): v is DetectedStackVolume & { kind: "named-volume" | "external-bind" } =>
                    (v.kind === "named-volume" || v.kind === "external-bind") &&
                    v.isAccessible &&
                    v.existsOnDisk &&
                    v.isDirectory
            )
            .map((v) => ({
                kind: v.kind,
                archiveName: v.archiveName,
                dockerVolumeName: v.dockerVolumeName,
                hostPath: v.hostPath,
                source: v.source,
                target: v.target,
                isExternalResource: v.isExternalResource,
            }));

        const manifest: PbsStackManifest = {
            version: 1,
            stackName,
            createdAt: new Date().toISOString(),
            externalArchives,
            ...(externalNetworks.length > 0 ? { externalNetworks } : {}),
            ...(externalVolumes.length > 0 ? { externalVolumes } : {}),
        };

        const manifestPath = path.join(stackDir, PBS_MANIFEST_FILENAME);
        await fsAsync.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
        return manifest;
    }

    /**
     * Final pre-flight sanity check executed before pausing/stopping containers or
     * invoking `proxmox-backup-client`. Catches unhandled edge cases and aborts safely:
     *   1. Empty archive map check.
     *   2. Unresolved `.env` variables (`$VAR` or `${VAR}`) in compose volume definitions.
     *   3. External single-file bind mounts (`pxar` only supports directories, not single files).
     *   4. Archive key format (`^[a-zA-Z0-9_-]+\.pxar$`) and duplicate target path collisions.
     *   5. Forbidden system/pseudo-filesystem paths (`/`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`).
     *   6. Directory existence, `isDirectory()` verification, and read permission (`R_OK`) checks.
     */
    public validateBackupPlan(
        archives: Record<string, string>,
        inspections: StackVolumeInspectionResult[],
        allowIncompleteBackup = false
    ): void {
        const archiveEntries = Object.entries(archives);
        if (archiveEntries.length === 0) {
            throw new Error("Backup sanity check failed: No archives specified for backup.");
        }

        // 1. Check for unresolved .env variables in any inspected stack
        const allUnresolved: string[] = [];
        const externalSingleFileMounts: string[] = [];

        for (const inspection of inspections) {
            for (const unresolved of inspection.unresolvedVariables || []) {
                allUnresolved.push(`${inspection.stackName} (${unresolved})`);
            }

            // 2. Check for external single-file bind mounts (pxar requires directories)
            for (const vol of inspection.volumes) {
                if (vol.kind === "external-bind" && vol.existsOnDisk && !vol.isDirectory) {
                    externalSingleFileMounts.push(`${inspection.stackName} -> ${vol.hostPath}`);
                }
            }
        }

        if (allUnresolved.length > 0) {
            throw new Error(
                `Backup sanity check failed: Unresolved environment variable(s) in volume paths: ${allUnresolved.join(", ")}. Please define them in your .env file.`
            );
        }

        if (externalSingleFileMounts.length > 0 && !allowIncompleteBackup) {
            throw new Error(
                `Backup sanity check failed: External single-file bind mount(s) cannot be archived as .pxar directories (${externalSingleFileMounts.join(", ")}). Move config files inside the stack folder or enable incomplete backup.`
            );
        }

        // 3. Validate each .pxar archive entry
        const seenTargetPaths = new Set<string>();
        const pxarNameRegex = /^[a-zA-Z0-9_-]+\.pxar$/;

        for (const [ archiveName, targetPath ] of archiveEntries) {
            if (!pxarNameRegex.test(archiveName)) {
                throw new Error(
                    `Backup sanity check failed: Invalid archive name "${archiveName}". Must match [a-zA-Z0-9_-]+.pxar.`
                );
            }

            if (!targetPath || targetPath.includes("$")) {
                throw new Error(
                    `Backup sanity check failed: Invalid or unexpanded target path "${targetPath}" for archive "${archiveName}".`
                );
            }

            const resolvedTarget = path.resolve(targetPath);

            if (this.isIgnoredSystemPath(resolvedTarget)) {
                throw new Error(
                    `Backup sanity check failed: Refusing to archive forbidden system path "${resolvedTarget}" (${archiveName}).`
                );
            }

            if (seenTargetPaths.has(resolvedTarget)) {
                throw new Error(
                    `Backup sanity check failed: Duplicate archive target path "${resolvedTarget}" (${archiveName}).`
                );
            }
            seenTargetPaths.add(resolvedTarget);

            if (!fs.existsSync(resolvedTarget)) {
                throw new Error(
                    `Backup sanity check failed: Target path "${resolvedTarget}" (${archiveName}) does not exist on disk.`
                );
            }

            const stat = fs.statSync(resolvedTarget);
            if (!stat.isDirectory()) {
                throw new Error(
                    `Backup sanity check failed: Target path "${resolvedTarget}" (${archiveName}) is not a directory (proxmox-backup-client pxar requires a directory).`
                );
            }

            try {
                fs.accessSync(resolvedTarget, fs.constants.R_OK);
            } catch {
                throw new Error(
                    `Backup sanity check failed: No read permission on directory "${resolvedTarget}" (${archiveName}).`
                );
            }
        }
    }

    /**
     * Reads `.pbs-manifest.json` from a restored stack directory if present.
     */
    public async readStackManifest(stackDir: string): Promise<PbsStackManifest | null> {
        const manifestPath = path.join(stackDir, PBS_MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        try {
            const raw = await fsAsync.readFile(manifestPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && Array.isArray(parsed.externalArchives)) {
                return parsed as PbsStackManifest;
            }
        } catch {
            // Ignore malformed manifest
        }
        return null;
    }

    /**
     * Helper to execute a CLI command via customRunner (if testing) or childProcessAsync.
     */
    private async execCommand(
        command: string,
        args: string[],
        cwd?: string
    ): Promise<string> {
        if (this.customRunner) {
            const res = await this.customRunner(command, args, { env: process.env,
                cwd });
            if (res.code !== 0) {
                throw new Error(res.stderr || `Command failed with exit code ${res.code}`);
            }
            return res.stdout;
        }

        const res = await childProcessAsync.spawn(command, args, {
            cwd,
            encoding: "utf-8",
        });
        return res.stdout ? res.stdout.toString() : "";
    }
}
