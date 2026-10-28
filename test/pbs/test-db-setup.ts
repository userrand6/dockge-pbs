import knex, { Knex } from "knex";
// @ts-ignore
import Dialect from "knex/lib/dialects/sqlite3/index.js";
import sqlite from "@louislam/sqlite3";
import { R } from "redbean-node";
import { Settings } from "../../backend/settings";

let knexInstance: Knex | null = null;

/**
 * Initializes an in-memory SQLite database for test suites
 * that read and write settings via RedBean.
 */
export async function setupTestDb() {
    if (knexInstance) {
        return;
    }

    Dialect.prototype._driver = () => sqlite;
    knexInstance = knex({
        client: Dialect,
        connection: {
            filename: ":memory:",
        },
        useNullAsDefault: true,
        pool: {
            min: 0,
            idleTimeoutMillis: 100,
        },
    });

    // @ts-ignore
    R.setup(knexInstance);

    const hasTable = await knexInstance.schema.hasTable("setting");
    if (!hasTable) {
        await knexInstance.schema.createTable("setting", (table) => {
            table.increments("id");
            table.string("key", 200).notNullable().unique();
            table.text("value");
            table.string("type", 20);
        });
    }
}

/**
 * Cleanup database connection and cache timer so tests exit cleanly.
 */
export async function cleanupTestDb() {
    Settings.stopCacheCleaner();
    if (knexInstance) {
        await knexInstance.destroy();
        knexInstance = null;
    }
}
