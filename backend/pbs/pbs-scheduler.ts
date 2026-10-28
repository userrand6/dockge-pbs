import { Cron } from "croner";
import { log } from "../log";
import { Settings } from "../settings";
import { DockgeServer } from "../dockge-server";
import { pbsManager } from "./pbs-manager";
import { PbsScheduleConfig } from "./pbs-types";

/**
 * Automated backup scheduler powered by croner.
 *
 * Runs background backups according to user-configured cron expressions
 * and automatically enforces retention prune policies on Proxmox Backup Server.
 */
export class PbsScheduler {
    private static instance: PbsScheduler;

    private cronJob?: Cron;
    private server?: DockgeServer;

    private constructor() {}

    public static getInstance(): PbsScheduler {
        if (!PbsScheduler.instance) {
            PbsScheduler.instance = new PbsScheduler();
        }
        return PbsScheduler.instance;
    }

    /**
     * Initializes the scheduler on server startup.
     */
    public async init(server: DockgeServer): Promise<void> {
        this.server = server;
        pbsManager.setServer(server);

        try {
            await this.reschedule();
            log.info("pbs-scheduler", "PBS backup scheduler initialized.");
        } catch (err) {
            log.error("pbs-scheduler", `Failed to initialize PBS scheduler: ${err}`);
        }
    }

    /**
     * Retrieves current schedule configuration.
     */
    public async getScheduleConfig(): Promise<PbsScheduleConfig> {
        const raw = await Settings.get("pbs_schedule");
        if (!raw || typeof raw !== "object") {
            return {
                enabled: false,
                cron: "0 2 * * *", // Default: Daily at 2:00 AM
                containerMode: "none",
                includeDockgeData: true,
                keepLast: 7,
                keepDaily: 7,
                keepWeekly: 4,
                keepMonthly: 12,
            };
        }
        return raw as PbsScheduleConfig;
    }

    /**
     * Saves schedule configuration and updates the active cron job.
     */
    public async saveScheduleConfig(config: PbsScheduleConfig): Promise<void> {
        // Validate cron expression before saving
        if (config.enabled && config.cron) {
            try {
                new Cron(config.cron);
            } catch (err) {
                throw new Error(`Invalid cron expression "${config.cron}": ${err}`);
            }
        }

        await Settings.set("pbs_schedule", config);
        await this.reschedule();
    }

    /**
     * Reconfigures and restarts the cron job based on stored configuration.
     */
    public async reschedule(): Promise<void> {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = undefined;
        }

        const config = await this.getScheduleConfig();
        const pbsConfig = await pbsManager.getConfig();

        if (!config.enabled || !pbsConfig.enabled || !pbsConfig.host) {
            log.info("pbs-scheduler", "PBS automated schedule is disabled or PBS is unconfigured.");
            return;
        }

        try {
            this.cronJob = new Cron(config.cron, async () => {
                log.info("pbs-scheduler", "Scheduled PBS backup job triggered.");

                try {
                    // 1. Run backup
                    await pbsManager.startBackup({
                        containerMode: config.containerMode,
                        includeDockgeData: config.includeDockgeData,
                    });

                    // 2. Run prune if retention rules configured
                    if (
                        config.keepLast ||
                        config.keepDaily ||
                        config.keepWeekly ||
                        config.keepMonthly
                    ) {
                        log.info("pbs-scheduler", "Applying PBS retention prune rules...");
                        const client = await pbsManager.getClient();
                        await client.prune({
                            keepLast: config.keepLast,
                            keepDaily: config.keepDaily,
                            keepWeekly: config.keepWeekly,
                            keepMonthly: config.keepMonthly,
                        });
                    }

                } catch (err) {
                    log.error("pbs-scheduler", `Scheduled backup job failed: ${err}`);
                }
            });

            const next = this.cronJob.nextRun();
            log.info("pbs-scheduler", `PBS backup scheduled: "${config.cron}". Next run: ${next?.toISOString()}`);

        } catch (err) {
            log.error("pbs-scheduler", `Failed to schedule PBS cron job: ${err}`);
        }
    }

    /**
     * Stops the active cron job.
     */
    public stop(): void {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = undefined;
        }
    }

    /**
     * Returns the next scheduled execution time, if active.
     */
    public getNextRun(): string | null {
        if (!this.cronJob) {
            return null;
        }
        const next = this.cronJob.nextRun();
        return next ? next.toISOString() : null;
    }
}

export const pbsScheduler = PbsScheduler.getInstance();

