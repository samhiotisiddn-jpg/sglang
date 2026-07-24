import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ALLOWLIST = new Set(["echo", "uname", "date", "uptime", "id"]);

function wrapA2ASBoundary(payload: string): string {
  return `<a2as-boundary><tool-input>${payload}</tool-input></a2as-boundary>`;
}

function unwrapA2ASBoundary(payload: string): string {
  const match = payload.match(/^<a2as-boundary><tool-input>([\s\S]*)<\/tool-input><\/a2as-boundary>$/);
  if (!match) {
    throw new Error("A2AS boundary violation: missing required wrapper tags");
  }
  return match[1];
}

export const systemExecTool = {
  name: "system-exec",
  description:
    "Execute bounded system commands. Input must be wrapped in <a2as-boundary><tool-input>...</tool-input></a2as-boundary>.",
  inputSchema: {
    type: "object",
    properties: {
      wrappedCommand: { type: "string" },
      timeoutMs: { type: "number", minimum: 100, maximum: 5000 },
    },
    required: ["wrappedCommand"],
    additionalProperties: false,
  },
  async execute(input: { wrappedCommand: string; timeoutMs?: number }) {
    const unwrapped = unwrapA2ASBoundary(input.wrappedCommand).trim();
    const [binary, ...args] = unwrapped.split(/\s+/g);

    if (!ALLOWLIST.has(binary)) {
      throw new Error(`Command denied by allowlist: ${binary}`);
    }

    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: input.timeoutMs ?? 1500,
      maxBuffer: 64 * 1024,
      shell: false,
    });

    return {
      wrappedResult: wrapA2ASBoundary(JSON.stringify({ stdout, stderr })),
    };
  },
};
