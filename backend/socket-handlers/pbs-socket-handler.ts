import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";
import { pbsManager } from "../pbs/pbs-manager";
import { pbsScheduler } from "../pbs/pbs-scheduler";
import { BackupOptions, PbsConfig, PbsScheduleConfig, RestoreOptions } from "../pbs/pbs-types";

/**
 * Socket.IO handler exposing Proxmox Backup Server operations to the Dockge UI.
 *
 * All operations require valid session authentication (`checkLogin`).
 * Sensitive secrets are masked before sending to the client, and preserved
 * if the user submits without changing them.
 */
export class PbsSocketHandler extends SocketHandler {

    create(socket: DockgeSocket, server: DockgeServer) {

        // Setup real-time log event streaming for this socket
        const unsubscribeLogs = pbsManager.addLogListener((event) => {
            socket.emit("pbsLog", event);
        });

        socket.on("disconnect", () => {
            unsubscribeLogs();
        });

        // 1. Get PBS Configuration (with masked secret)
        socket.on("getPbsConfig", async (callback: unknown) => {
            try {
                checkLogin(socket);
                const config = await pbsManager.getConfig();

                // Mask sensitive secrets before sending to client
                const safeConfig: PbsConfig = {
                    ...config,
                    secret: config.secret ? "********" : "",
                    encryptionPassword: config.encryptionPassword ? "********" : "",
                };

                callbackResult({
                    ok: true,
                    data: safeConfig,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 2. Save PBS Configuration
        socket.on("savePbsConfig", async (inputConfig: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                if (!inputConfig || typeof inputConfig !== "object") {
                    throw new Error("Configuration must be a valid object.");
                }

                const newConfig = inputConfig as PbsConfig;
                const existingConfig = await pbsManager.getConfig();

                // If user didn't change masked secret, retain existing secret
                if (newConfig.secret === "********" || !newConfig.secret) {
                    newConfig.secret = existingConfig.secret || "";
                }

                if (newConfig.encryptionPassword === "********" || !newConfig.encryptionPassword) {
                    newConfig.encryptionPassword = existingConfig.encryptionPassword || "";
                }

                await pbsManager.saveConfig(newConfig);
                await pbsScheduler.reschedule();

                callbackResult({
                    ok: true,
                    msg: "PBS configuration saved successfully.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 3. Test PBS Connection
        socket.on("testPbsConnection", async (testConfigInput: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                let testConfig: PbsConfig;

                if (testConfigInput && typeof testConfigInput === "object") {
                    const input = testConfigInput as PbsConfig;
                    const existingConfig = await pbsManager.getConfig();

                    testConfig = {
                        ...input,
                        secret: (input.secret === "********" || !input.secret) ? existingConfig.secret : input.secret,
                        encryptionPassword: (input.encryptionPassword === "********" || !input.encryptionPassword)
                            ? existingConfig.encryptionPassword
                            : input.encryptionPassword,
                    };
                } else {
                    testConfig = await pbsManager.getConfig();
                }

                const client = await pbsManager.getClient(testConfig);
                const result = await client.testConnection();

                callbackResult({
                    ok: true,
                    msg: "Connection to Proxmox Backup Server successful!",
                    version: result.version,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 4. Get Current PBS Status & Recent Logs
        socket.on("getPbsStatus", async (callback: unknown) => {
            try {
                checkLogin(socket);
                const status = await pbsManager.getStatus();
                const nextRun = pbsScheduler.getNextRun();
                const recentLogs = pbsManager.getRecentLogs();

                callbackResult({
                    ok: true,
                    data: {
                        ...status,
                        nextScheduledRun: nextRun,
                        recentLogs,
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 5. Trigger Manual Backup
        socket.on("startPbsBackup", async (optionsInput: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                const options = (optionsInput && typeof optionsInput === "object" ? optionsInput : {}) as BackupOptions;

                // Start backup (runs asynchronously, progress emitted via pbsLog)
                pbsManager.startBackup(options).then((res) => {
                    socket.emit("pbsBackupFinished", { ok: true, message: res.message });
                }).catch((err) => {
                    socket.emit("pbsBackupFinished", { ok: false, message: err.message || String(err) });
                });

                callbackResult({
                    ok: true,
                    msg: "Backup operation initiated.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 6. List Snapshots from PBS
        socket.on("getPbsSnapshots", async (callback: unknown) => {
            try {
                checkLogin(socket);
                const snapshots = await pbsManager.listSnapshots();

                callbackResult({
                    ok: true,
                    data: snapshots,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 7. Trigger Restore
        socket.on("startPbsRestore", async (restoreInput: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                if (!restoreInput || typeof restoreInput !== "object") {
                    throw new Error("Restore options must be provided.");
                }

                const options = restoreInput as RestoreOptions;

                // Run restore asynchronously
                pbsManager.startRestore(options).then((res) => {
                    socket.emit("pbsRestoreFinished", { ok: true, message: res.message });
                }).catch((err) => {
                    socket.emit("pbsRestoreFinished", { ok: false, message: err.message || String(err) });
                });

                callbackResult({
                    ok: true,
                    msg: "Restore operation initiated.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 8. Delete / Forget Snapshot
        socket.on("deletePbsSnapshot", async (snapshotId: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                if (typeof snapshotId !== "string" || !snapshotId.trim()) {
                    throw new Error("Invalid snapshot identifier.");
                }

                const result = await pbsManager.deleteSnapshot(snapshotId.trim());

                callbackResult({
                    ok: true,
                    msg: result.message,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 9. Get Schedule Configuration
        socket.on("getPbsSchedule", async (callback: unknown) => {
            try {
                checkLogin(socket);
                const schedule = await pbsScheduler.getScheduleConfig();
                const nextRun = pbsScheduler.getNextRun();

                callbackResult({
                    ok: true,
                    data: {
                        ...schedule,
                        nextRun,
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // 10. Save Schedule Configuration
        socket.on("savePbsSchedule", async (scheduleInput: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                if (!scheduleInput || typeof scheduleInput !== "object") {
                    throw new Error("Schedule configuration must be an object.");
                }

                await pbsScheduler.saveScheduleConfig(scheduleInput as PbsScheduleConfig);

                callbackResult({
                    ok: true,
                    msg: "Backup schedule updated successfully.",
                    nextRun: pbsScheduler.getNextRun(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}

