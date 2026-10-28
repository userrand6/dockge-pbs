import { ProcessRunner } from "../../backend/pbs/pbs-client";

/**
 * Recorded invocation of a child process command.
 */
export interface RecordedExecution {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}

/**
 * Mock process runner for testing PBS and Docker CLI commands
 * without needing an actual Proxmox Backup Server or Docker daemon.
 */
export class MockPbsRunner {
    public executions: RecordedExecution[] = [];
    public mockResponses: Map<string, { code: number; stdout: string; stderr: string }> = new Map();
    public defaultResponse = { code: 0, stdout: "{}", stderr: "" };

    /**
     * Program a specific response for a command matching a prefix.
     */
    public setResponse(commandKey: string, code: number, stdout: string, stderr = "") {
        this.mockResponses.set(commandKey, { code, stdout, stderr });
    }

    /**
     * Clears all recorded executions and mock responses.
     */
    public reset() {
        this.executions = [];
        this.mockResponses.clear();
    }

    /**
     * Returns a ProcessRunner function compatible with PbsClient.
     */
    public getRunner(): ProcessRunner {
        return async (command, args, options) => {
            const fullCmd = `${command} ${args.join(" ")}`;
            this.executions.push({
                command,
                args: [...args],
                env: options.env ? { ...options.env } : undefined,
                cwd: options.cwd,
            });

            // Find matching response or use default
            let resp = this.defaultResponse;
            for (const [key, val] of this.mockResponses.entries()) {
                if (fullCmd.includes(key)) {
                    resp = val;
                    break;
                }
            }

            if (options.onStdout && resp.stdout) {
                options.onStdout(resp.stdout);
            }
            if (options.onStderr && resp.stderr) {
                options.onStderr(resp.stderr);
            }

            return {
                code: resp.code,
                stdout: resp.stdout,
                stderr: resp.stderr,
            };
        };
    }
}

