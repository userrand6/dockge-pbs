import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsAsync } from "fs";
import path from "path";
import os from "os";
import { PbsVolumeInspector } from "../../backend/pbs/pbs-volume-inspector";
import { MockPbsRunner } from "./mock-pbs-runner";

describe("PbsVolumeInspector", () => {
    let tempDir: string;
    let stackDir: string;
    let mockVolumesRoot: string;
    let mockExternalBindDir: string;
    let mockRunner: MockPbsRunner;

    beforeEach(async () => {
        tempDir = path.join(os.tmpdir(), `pbs-vol-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        stackDir = path.join(tempDir, "stacks", "authentik");
        mockVolumesRoot = path.join(tempDir, "docker-volumes");
        mockExternalBindDir = path.join(tempDir, "mnt-nas", "redis-data");

        await fsAsync.mkdir(stackDir, { recursive: true });
        await fsAsync.mkdir(path.join(stackDir, "media"), { recursive: true });
        await fsAsync.mkdir(path.join(mockVolumesRoot, "authentik_db_data", "_data"), { recursive: true });
        await fsAsync.mkdir(mockExternalBindDir, { recursive: true });

        mockRunner = new MockPbsRunner();
    });

    afterEach(async () => {
        await fsAsync.rm(tempDir, { recursive: true,
            force: true }).catch(() => {});
    });

    it("should parse compose.yaml (including .env variables) and classify internal, external, and named volumes", async () => {
        // Write .env and compose.yaml
        await fsAsync.writeFile(
            path.join(stackDir, ".env"),
            `EXTERNAL_REDIS_PATH=${mockExternalBindDir}\n`,
            "utf-8"
        );

        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  postgres:
    image: postgres:16
    volumes:
      - db_data:/var/lib/postgresql/data
      - ./media:/app/media
  redis:
    image: redis:alpine
    volumes:
      - \${EXTERNAL_REDIS_PATH}:/data
volumes:
  db_data:
`,
            "utf-8"
        );

        // Simulate `docker compose config` failing so static fallback + .env substitution is exercised,
        // and simulate bare-metal mode (containerMounts = null) where all host paths are accessible.
        mockRunner.setResponse("config", 1, "", "docker daemon not running");
        mockRunner.setResponse("inspect", 1, "", "docker daemon not running");

        const inspector = new PbsVolumeInspector(
            mockRunner.getRunner(),
            null, // bare-metal mode
            mockVolumesRoot
        );

        const result = await inspector.inspectStack("authentik", stackDir);

        assert.equal(result.stackName, "authentik");
        assert.equal(result.allAccessible, true);
        assert.equal(result.missingMounts.length, 0);
        assert.equal(result.volumes.length, 3);

        const namedVol = result.volumes.find((v) => v.kind === "named-volume");
        assert.ok(namedVol, "Named volume db_data should be detected");
        assert.equal(namedVol.dockerVolumeName, "authentik_db_data");
        assert.equal(namedVol.hostPath, path.join(mockVolumesRoot, "authentik_db_data", "_data"));
        assert.equal(namedVol.archiveName, "vol-authentik-db_data.pxar");
        assert.equal(namedVol.isAccessible, true);
        assert.equal(namedVol.existsOnDisk, true);

        const internalBind = result.volumes.find((v) => v.kind === "internal-bind");
        assert.ok(internalBind, "Internal relative bind mount ./media should be detected");
        assert.equal(internalBind.hostPath, path.join(stackDir, "media"));
        assert.equal(internalBind.isAccessible, true);

        const externalBind = result.volumes.find((v) => v.kind === "external-bind");
        assert.ok(externalBind, "External bind mount should be detected with .env variable resolved");
        assert.equal(externalBind.hostPath, mockExternalBindDir);
        assert.equal(externalBind.isAccessible, true);
    });

    it("should detect unmounted volumes in containerized mode and generate recommendedComposeSnippet", async () => {
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  db:
    image: postgres:16
    volumes:
      - db_data:/var/lib/postgresql/data
      - ${mockExternalBindDir}:/data
volumes:
  db_data:
`,
            "utf-8"
        );

        // Simulate `docker compose config --format json` output directly from Docker CLI
        const composeConfigJson = JSON.stringify({
            name: "authentik",
            services: {
                db: {
                    volumes: [
                        {
                            type: "volume",
                            source: "db_data",
                            target: "/var/lib/postgresql/data",
                        },
                        {
                            type: "bind",
                            source: mockExternalBindDir,
                            target: "/data",
                        },
                    ],
                },
            },
            volumes: {
                db_data: {
                    name: "authentik_db_data",
                },
            },
        });

        mockRunner.setResponse("config", 0, composeConfigJson, "");
        mockRunner.setResponse(
            "inspect",
            0,
            `${path.join(mockVolumesRoot, "authentik_db_data", "_data")}\n`,
            ""
        );

        // Simulate Dockge container having ONLY the stacks directory mounted (neither docker-volumes nor mnt-nas mounted)
        const containerMounts = [ path.join(tempDir, "stacks") ];
        const inspector = new PbsVolumeInspector(
            mockRunner.getRunner(),
            containerMounts,
            mockVolumesRoot
        );

        const result = await inspector.inspectStack("authentik", stackDir);

        assert.equal(result.allAccessible, false);
        assert.equal(result.missingMounts.length, 2);
        assert.ok(result.recommendedComposeSnippet);
        assert.ok(
            result.recommendedComposeSnippet.includes(`${mockVolumesRoot}:${mockVolumesRoot}:rslave`),
            "Snippet should recommend mounting the Docker volumes root with :rslave"
        );
        assert.ok(
            result.recommendedComposeSnippet.includes(`${mockExternalBindDir}:${mockExternalBindDir}`),
            "Snippet should recommend mounting the external bind path"
        );
    });

    it("should write and read .pbs-manifest.json for self-contained volume restores", async () => {
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  db:
    image: postgres:16
    volumes:
      - db_data:/var/lib/postgresql/data
volumes:
  db_data:
`,
            "utf-8"
        );

        mockRunner.setResponse("config", 1, "", "offline");
        mockRunner.setResponse("inspect", 1, "", "offline");

        const inspector = new PbsVolumeInspector(mockRunner.getRunner(), null, mockVolumesRoot);
        const inspection = await inspector.inspectStack("authentik", stackDir);

        const written = await inspector.writeStackManifest("authentik", stackDir, inspection.volumes);
        assert.equal(written.externalArchives.length, 1);
        assert.equal(written.externalArchives[0].archiveName, "vol-authentik-db_data.pxar");
        assert.equal(written.externalArchives[0].dockerVolumeName, "authentik_db_data");

        const readBack = await inspector.readStackManifest(stackDir);
        assert.ok(readBack);
        assert.deepEqual(readBack, written);
    });

    it("should automatically ignore system pseudo-filesystems (/proc, /sys, /dev, /, /var/run/docker.sock, /etc/localtime)", async () => {
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    volumes:
      - /:/rootfs:ro
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /dev/disk:/dev/disk:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /etc/localtime:/etc/localtime:ro
      - ./media:/app/media
`,
            "utf-8"
        );

        mockRunner.setResponse("config", 1, "", "offline");
        const inspector = new PbsVolumeInspector(mockRunner.getRunner(), [ path.join(tempDir, "stacks") ], mockVolumesRoot);
        const result = await inspector.inspectStack("authentik", stackDir);

        // Only ./media should be included; all system pseudo-mounts must be ignored
        assert.equal(result.volumes.length, 1);
        assert.equal(result.volumes[0].kind, "internal-bind");
        assert.equal(result.allAccessible, true);
    });

    it("should fail validateBackupPlan on unresolved .env variables, external single-file mounts, or duplicate/invalid archive targets", async () => {
        const singleFileConfig = path.join(tempDir, "external-traefik.yml");
        await fsAsync.writeFile(singleFileConfig, "entryPoints: {}", "utf-8");

        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  web:
    image: nginx
    volumes:
      - \${UNSET_HOST_DIR}/data:/data
      - ${singleFileConfig}:/etc/traefik/traefik.yml
`,
            "utf-8"
        );

        mockRunner.setResponse("config", 1, "", "offline");
        const inspector = new PbsVolumeInspector(mockRunner.getRunner(), null, mockVolumesRoot);
        const inspection = await inspector.inspectStack("authentik", stackDir);

        // 1. Unresolved variable check
        assert.equal(inspection.unresolvedVariables.length, 1);
        assert.throws(
            () => inspector.validateBackupPlan({ "authentik.pxar": stackDir }, [ inspection ], false),
            (err: Error) => err.message.includes("Unresolved environment variable")
        );

        // Clear unresolvedVariables to test external single-file mount check
        inspection.unresolvedVariables = [];
        assert.throws(
            () => inspector.validateBackupPlan({ "authentik.pxar": stackDir }, [ inspection ], false),
            (err: Error) => err.message.includes("External single-file bind mount")
        );

        // With allowIncompleteBackup = true, external single-file mount is skipped rather than throwing
        assert.doesNotThrow(() =>
            inspector.validateBackupPlan({ "authentik.pxar": stackDir }, [ inspection ], true)
        );

        // 3. Passing a single file directly in the archives map must always be rejected
        assert.throws(
            () => inspector.validateBackupPlan({ "bad.pxar": singleFileConfig }, [], true),
            (err: Error) => err.message.includes("is not a directory")
        );

        // 4. Passing a forbidden system path in archives map must be rejected
        assert.throws(
            () => inspector.validateBackupPlan({ "proc.pxar": "/proc" }, [], true),
            (err: Error) => err.message.includes("forbidden system path")
        );

        // 5. Duplicate target path check
        assert.throws(
            () =>
                inspector.validateBackupPlan(
                    { "a.pxar": stackDir,
                        "b.pxar": stackDir },
                    [],
                    true
                ),
            (err: Error) => err.message.includes("Duplicate archive target path")
        );
    });

    it("should detect external: true networks and volumes and generate preStartCommands without mutating state", async () => {
        await fsAsync.mkdir(path.join(mockVolumesRoot, "shared_media", "_data"), { recursive: true });
        await fsAsync.writeFile(
            path.join(stackDir, "compose.yaml"),
            `services:
  app:
    image: nginx
    volumes:
      - shared_media:/media
    networks:
      - traefik_proxy
volumes:
  shared_media:
    external: true
networks:
  traefik_proxy:
    external: true
`,
            "utf-8"
        );

        mockRunner.setResponse("config", 1, "", "offline");
        mockRunner.setResponse("inspect", 1, "", "offline");

        const inspector = new PbsVolumeInspector(mockRunner.getRunner(), null, mockVolumesRoot);
        const result = await inspector.inspectStack("authentik", stackDir);

        assert.deepEqual(result.externalNetworks, [ "traefik_proxy" ]);
        assert.deepEqual(result.externalVolumes, [ "shared_media" ]);
        assert.deepEqual(result.preStartCommands, [
            "docker network create traefik_proxy",
            "docker volume create shared_media",
        ]);
        assert.equal(result.volumes[0].dockerVolumeName, "shared_media");
        assert.equal(result.volumes[0].isExternalResource, true);
    });
});

