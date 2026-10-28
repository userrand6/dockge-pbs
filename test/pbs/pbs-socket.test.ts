import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PbsSocketHandler } from "../../backend/socket-handlers/pbs-socket-handler";
import { pbsManager } from "../../backend/pbs/pbs-manager";
import { MockPbsRunner } from "./mock-pbs-runner";
import { setupTestDb, cleanupTestDb } from "./test-db-setup";
import { DockgeServer } from "../../backend/dockge-server";
import { DockgeSocket } from "../../backend/util-server";
import { PbsConfig } from "../../backend/pbs/pbs-types";

type SocketEventFn = (...args: unknown[]) => unknown;
interface SocketResponse {
    ok: boolean;
    msg?: string;
    data?: PbsConfig;
}

describe("PbsSocketHandler", () => {
    const handler = new PbsSocketHandler();

    before(async () => {
        await setupTestDb();
    });

    after(async () => {
        await cleanupTestDb();
    });

    it("should reject unauthenticated socket calls with unauthorized error", async () => {
        const events: Record<string, SocketEventFn> = {};
        const mockSocket = {
            on: (name: string, fn: SocketEventFn) => {
                events[name] = fn;
            },
            emit: () => {},
            userId: undefined, // Not logged in!
        } as unknown as DockgeSocket;

        handler.create(mockSocket, {} as unknown as DockgeServer);

        // Call getPbsConfig without auth
        let callbackResult: SocketResponse | undefined;
        await events["getPbsConfig"]((res: SocketResponse) => {
            callbackResult = res;
        });

        assert.equal(callbackResult?.ok, false);
        assert.ok(
            callbackResult?.msg?.toLowerCase().includes("login") ||
            callbackResult?.msg?.toLowerCase().includes("auth") ||
            callbackResult?.msg?.toLowerCase().includes("user") ||
            callbackResult?.msg?.toLowerCase().includes("logged"),
            `Expected auth error, got: ${callbackResult?.msg}`
        );
    });

    it("should return masked secret to authenticated users and preserve secret on save", async () => {
        const mockRunner = new MockPbsRunner();
        pbsManager.setCustomRunner(mockRunner.getRunner());

        // Pre-save real secret
        await pbsManager.saveConfig({
            enabled: true,
            host: "pbs.domain.com",
            port: 8007,
            datastore: "main-ds",
            authId: "api-user@pbs",
            secret: "ultra-confidential-token-999",
        });

        const events: Record<string, SocketEventFn> = {};
        const mockSocket = {
            on: (name: string, fn: SocketEventFn) => {
                events[name] = fn;
            },
            emit: () => {},
            userID: 1, // Authenticated user (Dockge uses capital ID)
        } as unknown as DockgeSocket;

        handler.create(mockSocket, {} as unknown as DockgeServer);

        // 1. Fetch config
        let getResult: SocketResponse | undefined;
        await events["getPbsConfig"]((res: SocketResponse) => {
            getResult = res;
        });

        assert.equal(getResult?.ok, true);
        assert.equal(getResult?.data?.secret, "********", "Secret must be masked in socket response");

        // 2. Submit form back with the masked secret
        let saveResult: SocketResponse | undefined;
        await events["savePbsConfig"]({
            ...getResult?.data,
            host: "updated-pbs.domain.com",
            secret: "********", // User kept the masked placeholder
        }, (res: SocketResponse) => {
            saveResult = res;
        });

        assert.equal(saveResult?.ok, true);

        // 3. Verify underlying database preserved the real secret!
        const stored = await pbsManager.getConfig();
        assert.equal(stored.host, "updated-pbs.domain.com");
        assert.equal(stored.secret, "ultra-confidential-token-999", "Real secret must NOT be overwritten by mask");
    });
});

