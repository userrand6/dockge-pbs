import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PbsClient, PbsClientError } from "../../backend/pbs/pbs-client";
import { MockPbsRunner } from "./mock-pbs-runner";
import { PbsConfig } from "../../backend/pbs/pbs-types";

describe("PbsClient", () => {
    let mockRunner: MockPbsRunner;
    const testConfig: PbsConfig = {
        enabled: true,
        host: "pbs.local",
        port: 8007,
        datastore: "test-ds",
        authId: "dockge@pbs!token1",
        secret: "super-secret-password-12345",
        fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
        backupId: "my-dockge-node",
        namespace: "custom-ns",
    };

    beforeEach(() => {
        mockRunner = new MockPbsRunner();
    });

    it("should format the repository string accurately", () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        assert.equal(
            client.getRepositoryString(),
            "dockge@pbs!token1@pbs.local:8007:test-ds"
        );
    });

    it("should format repository string without authId if authId is empty", () => {
        const noAuthConfig: PbsConfig = {
            ...testConfig,
            authId: "",
        };
        const client = new PbsClient(noAuthConfig, mockRunner.getRunner());
        assert.equal(client.getRepositoryString(), "pbs.local:8007:test-ds");
    });

    it("should securely inject credentials via environment variables and NOT CLI arguments", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("status", 0, JSON.stringify({ version: "3.2.0" }));

        await client.testConnection();

        assert.equal(mockRunner.executions.length, 1);
        const exec = mockRunner.executions[0];

        // Ensure CLI args do NOT contain password
        const fullArgs = exec.args.join(" ");
        assert.ok(
            !fullArgs.includes("super-secret-password-12345"),
            "Password must NEVER be passed as a CLI argument"
        );

        // Ensure Environment contains required variables
        assert.equal(exec.env?.PBS_REPOSITORY, "dockge@pbs!token1@pbs.local:8007:test-ds");
        assert.equal(exec.env?.PBS_PASSWORD, "super-secret-password-12345");
        assert.equal(exec.env?.PBS_FINGERPRINT, testConfig.fingerprint);
    });

    it("should format backup arguments and pass progress events", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("backup", 0, "Uploaded pxar: 100%");

        const logged: string[] = [];
        await client.backup(
            { "stacks.pxar": "/opt/stacks",
                "dockge-data.pxar": "/app/data" },
            "test-node",
            (e) => logged.push(e.text)
        );

        assert.equal(mockRunner.executions.length, 1);
        const exec = mockRunner.executions[0];
        assert.equal(exec.command, "proxmox-backup-client");
        assert.ok(exec.args.includes("backup"));
        assert.ok(exec.args.includes("stacks.pxar:/opt/stacks"));
        assert.ok(exec.args.includes("dockge-data.pxar:/app/data"));
        assert.ok(exec.args.includes("--backup-id"));
        assert.ok(exec.args.includes("test-node"));
        assert.ok(exec.args.includes("--change-detection-mode=metadata"));
        assert.ok(exec.args.includes("--ns"));
        assert.ok(exec.args.includes("custom-ns"));
        assert.ok(logged.some((l) => l.includes("Uploaded pxar: 100%")));
    });

    it("should parse snapshot list JSON correctly", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        const sampleSnapshots = [
            {
                "backup-type": "host",
                "backup-id": "my-dockge-node",
                "backup-time": 1700000000,
                files: [{ filename: "stacks.pxar",
                    size: 5242880 }],
                size: 5242880,
                comment: "Automated daily backup",
            },
        ];
        mockRunner.setResponse("snapshot list", 0, JSON.stringify(sampleSnapshots));

        const snapshots = await client.listSnapshots();

        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]["backup-id"], "my-dockge-node");
        assert.equal(snapshots[0]["backup-time"], 1700000000);
        assert.equal(snapshots[0].snapshotId, "host/my-dockge-node/2023-11-14T22:13:20Z");
        assert.equal(snapshots[0].files?.[0].filename, "stacks.pxar");
    });

    it("should throw PbsClientError on malformed JSON snapshot output", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("snapshot list", 0, "INVALID NON-JSON OUTPUT");

        await assert.rejects(
            async () => await client.listSnapshots(),
            (err: Error) => err instanceof PbsClientError && err.message.includes("Invalid JSON")
        );
    });

    it("should correctly build prune arguments", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("prune", 0, "Pruned 2 snapshots");

        await client.prune({
            keepLast: 5,
            keepDaily: 7,
            keepWeekly: 4,
            keepMonthly: 12,
            backupId: "my-dockge-node",
        });

        assert.equal(mockRunner.executions.length, 1);
        const args = mockRunner.executions[0].args;
        assert.ok(args.includes("prune"));
        assert.ok(args.includes("host/my-dockge-node"));
        assert.ok(args.includes("--keep-last"));
        assert.ok(args.includes("5"));
        assert.ok(args.includes("--keep-daily"));
        assert.ok(args.includes("7"));
        assert.ok(args.includes("--keep-weekly"));
        assert.ok(args.includes("4"));
        assert.ok(args.includes("--keep-monthly"));
        assert.ok(args.includes("12"));
    });

    it("should handle restore command with proper arguments", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("restore", 0, "Restored 15 files");

        await client.restore(
            "host/my-dockge-node/2026-10-28T10:00:00Z",
            "stacks.pxar",
            "/opt/stacks"
        );

        assert.equal(mockRunner.executions.length, 1);
        const args = mockRunner.executions[0].args;
        assert.ok(args.includes("restore"));
        assert.ok(args.includes("host/my-dockge-node/2026-10-28T10:00:00Z"));
        assert.ok(args.includes("stacks.pxar"));
        assert.ok(args.includes("/opt/stacks"));
    });

    it("should throw PbsClientError on non-zero exit code", async () => {
        const client = new PbsClient(testConfig, mockRunner.getRunner());
        mockRunner.setResponse("status", 2, "", "authentication failed: invalid secret");

        await assert.rejects(
            async () => await client.testConnection(),
            (err: Error) => {
                assert.ok(err instanceof PbsClientError);
                assert.equal(err.exitCode, 2);
                assert.ok(err.message.includes("authentication failed"));
                return true;
            }
        );
    });
});

