import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";
import { pbsManager } from "../pbs/pbs-manager";
import { pbsScheduler } from "../pbs/pbs-scheduler";
import { BackupOptions, PbsConfig, PbsScheduleConfig, RestoreOptions, StackBackupConfig } from "../pbs/pbs-types";

const MASKED_SECRET = "********";

/**
 * Socket.IO handler exposing Proxmox Backup Server operations to the Dockge UI.
 *
 * All operations require valid session authentication (`checkLogin`).
 * Sensitive secrets are masked before sending to the client, and preserved
 * if the user submits without changing them.
 */
export class PbsSocketHandler extends SocketHandler {

    /**
     * Authenticates the socket, runs `action()`, and sends the result or error via `callback`.
     */
    private async handleAuth(
        socket: DockgeSocket,
        callback: unknown,
        action: () => Promise<Record<string, unknown>>
    ) {
        try {
            checkLogin(socket);
            const result = await action();
            callbackResult({ ok: true,
                ...result }, callback);
        } catch (e) {
            callbackError(e, callback);
        }
    }

    /**
     * Retains previously stored secrets if the client submits the masked placeholder or an empty string.
     */
    private mergeSecrets(input: PbsConfig, existing: PbsConfig): PbsConfig {
        return {
            ...input,
            secret: (!input.secret || input.secret === MASKED_SECRET)
                ? existing.secret || ""
                : input.secret,
            encryptionPassword: (!input.encryptionPassword || input.encryptionPassword === MASKED_SECRET)
                ? existing.encryptionPassword || ""
                : input.encryptionPassword,
        };
    }

    /**
     * Validates that a socket argument is a non-empty stack name string.
     */
    private requireStackName(stackName: unknown): string {
        if (typeof stackName !== "string" || !stackName.trim()) {
            throw new Error("Invalid stack name.");
        }
        return stackName.trim();
    }

    create(socket: DockgeSocket, _server: DockgeServer) {

        // Setup real-time log event streaming for this socket
        const unsubscribeLogs = pbsManager.addLogListener((event) => {
            socket.emit("pbsLog", event);
        });

        socket.on("disconnect", () => {
            unsubscribeLogs();
        });

        // 1. Get PBS Configuration (with masked secret)
        socket.on("getPbsConfig", (callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const config = await pbsManager.getConfig();
                return {
                    data: {
                        ...config,
                        secret: config.secret ? MASKED_SECRET : "",
                        encryptionPassword: config.encryptionPassword ? MASKED_SECRET : "",
                    },
                };
            })
        );

        // 2. Save PBS Configuration
        socket.on("savePbsConfig", (inputConfig: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                if (!inputConfig || typeof inputConfig !== "object") {
                    throw new Error("Configuration must be a valid object.");
                }
                const existingConfig = await pbsManager.getConfig();
                const merged = this.mergeSecrets(inputConfig as PbsConfig, existingConfig);

                await pbsManager.saveConfig(merged);
                await pbsScheduler.reschedule();
                return { msg: "PBS configuration saved successfully." };
            })
        );

        // 3. Test PBS Connection
        socket.on("testPbsConnection", (testConfigInput: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const existingConfig = await pbsManager.getConfig();
                const testConfig = (testConfigInput && typeof testConfigInput === "object")
                    ? this.mergeSecrets(testConfigInput as PbsConfig, existingConfig)
                    : existingConfig;

                const client = await pbsManager.getClient(testConfig);
                const result = await client.testConnection();
                return {
                    msg: "Connection to Proxmox Backup Server successful!",
                    version: result.version,
                };
            })
        );

        // 4. Get Current PBS Status & Recent Logs
        socket.on("getPbsStatus", (callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const status = await pbsManager.getStatus();
                return {
                    data: {
                        ...status,
                        nextScheduledRun: pbsScheduler.getNextRun(),
                        recentLogs: pbsManager.getRecentLogs(),
                    },
                };
            })
        );

        // 5. Trigger Manual Backup
        socket.on("startPbsBackup", (optionsInput: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const options = (optionsInput && typeof optionsInput === "object" ? optionsInput : {}) as BackupOptions;

                pbsManager.startBackup(options).then((res) => {
                    socket.emit("pbsBackupFinished", { ok: true,
                        message: res.message });
                }).catch((err) => {
                    socket.emit("pbsBackupFinished", { ok: false,
                        message: err.message || String(err) });
                });

                return { msg: "Backup operation initiated." };
            })
        );

        // 6. List Snapshots from PBS
        socket.on("getPbsSnapshots", (callback: unknown) =>
            this.handleAuth(socket, callback, async () => ({
                data: await pbsManager.listSnapshots(),
            }))
        );

        // 7. Trigger Restore
        socket.on("startPbsRestore", (restoreInput: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                if (!restoreInput || typeof restoreInput !== "object") {
                    throw new Error("Restore options must be provided.");
                }

                pbsManager.startRestore(restoreInput as RestoreOptions).then((res) => {
                    socket.emit("pbsRestoreFinished", { ok: true,
                        message: res.message });
                }).catch((err) => {
                    socket.emit("pbsRestoreFinished", { ok: false,
                        message: err.message || String(err) });
                });

                return { msg: "Restore operation initiated." };
            })
        );

        // 8. Delete / Forget Snapshot
        socket.on("deletePbsSnapshot", (snapshotId: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                if (typeof snapshotId !== "string" || !snapshotId.trim()) {
                    throw new Error("Invalid snapshot identifier.");
                }
                const result = await pbsManager.deleteSnapshot(snapshotId.trim());
                return { msg: result.message };
            })
        );

        // 9. Get Schedule Configuration
        socket.on("getPbsSchedule", (callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const schedule = await pbsScheduler.getScheduleConfig();
                return {
                    data: {
                        ...schedule,
                        nextRun: pbsScheduler.getNextRun(),
                    },
                };
            })
        );

        // 10. Save Schedule Configuration
        socket.on("savePbsSchedule", (scheduleInput: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                if (!scheduleInput || typeof scheduleInput !== "object") {
                    throw new Error("Schedule configuration must be an object.");
                }
                await pbsScheduler.saveScheduleConfig(scheduleInput as PbsScheduleConfig);
                return {
                    msg: "Backup schedule updated successfully.",
                    nextRun: pbsScheduler.getNextRun(),
                };
            })
        );

        // 11. Get Stack Backup Configuration
        socket.on("getStackBackupConfig", (stackName: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => ({
                data: await pbsManager.getStackConfig(this.requireStackName(stackName)),
            }))
        );

        // 12. Save Stack Backup Configuration
        socket.on("saveStackBackupConfig", (stackName: unknown, configInput: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => {
                const cleanName = this.requireStackName(stackName);
                if (!configInput || typeof configInput !== "object") {
                    throw new Error("Configuration must be an object.");
                }
                await pbsManager.saveStackConfig(cleanName, configInput as StackBackupConfig);
                return { msg: "Stack backup configuration saved." };
            })
        );

        // 13. Get Snapshots for a specific stack
        socket.on("getStackSnapshots", (stackName: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => ({
                data: await pbsManager.listStackSnapshots(this.requireStackName(stackName)),
            }))
        );

        // 14. Inspect Stack Volumes & Mount Accessibility
        socket.on("inspectStackVolumes", (stackName: unknown, callback: unknown) =>
            this.handleAuth(socket, callback, async () => ({
                data: await pbsManager.inspectStackVolumes(this.requireStackName(stackName)),
            }))
        );
    }
}

