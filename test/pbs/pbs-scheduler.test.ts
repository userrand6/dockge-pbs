import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PbsScheduler } from "../../backend/pbs/pbs-scheduler";
import { pbsManager } from "../../backend/pbs/pbs-manager";
import { setupTestDb, cleanupTestDb } from "./test-db-setup";

describe("PbsScheduler", () => {
    const scheduler = PbsScheduler.getInstance();

    before(async () => {
        await setupTestDb();
    });

    after(async () => {
        scheduler.stop();
        await cleanupTestDb();
    });

    it("should accept and schedule valid cron expressions", async () => {
        await pbsManager.saveConfig({
            enabled: true,
            host: "pbs.local",
            port: 8007,
            datastore: "store",
            authId: "root@pam",
            secret: "pass",
        });

        await scheduler.saveScheduleConfig({
            enabled: true,
            cron: "0 4 * * *", // 4:00 AM daily
            containerMode: "none",
            includeDockgeData: true,
            keepLast: 5,
        });

        const nextRun = scheduler.getNextRun();
        assert.ok(nextRun, "Next run should be calculated for active cron");
        const nextDate = new Date(nextRun);
        assert.ok(!isNaN(nextDate.getTime()), "Next run should be a valid ISO date");
    });

    it("should reject invalid cron expressions with clear error", async () => {
        await assert.rejects(
            async () => {
                await scheduler.saveScheduleConfig({
                    enabled: true,
                    cron: "INVALID CRON PATTERN",
                    containerMode: "none",
                    includeDockgeData: true,
                });
            },
            (err: any) => err.message.includes("Invalid cron expression")
        );
    });

    it("should disable cron execution when schedule is disabled", async () => {
        await scheduler.saveScheduleConfig({
            enabled: false,
            cron: "0 2 * * *",
            containerMode: "none",
            includeDockgeData: true,
        });

        const nextRun = scheduler.getNextRun();
        assert.equal(nextRun, null, "Next run must be null when schedule is disabled");
    });
});

