import { beforeEach, describe, expect, it, vi } from "vitest";

type RunTools = (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<unknown>;

const { streamChatWithTools } = vi.hoisted(() => ({
    streamChatWithTools: vi.fn(),
}));

vi.mock("../../llm", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../../llm/models")),
    streamChatWithTools: (...args: unknown[]) => streamChatWithTools(...args),
}));

vi.mock("../../mcpConnectors", () => ({
    buildUserMcpTools: vi.fn(async () => []),
}));

import { runLLMStream } from "../streaming";
import { SYSTEM_PROMPT } from "../prompts";
import { UnavailableToolCallError } from "../../llm/types";

const ASK_CALL = {
    id: "call-1",
    name: "ask_inputs",
    input: {
        items: [
            {
                id: "party",
                kind: "choice",
                question: "Which party do you represent?",
                options: [{ value: "Buyer" }, { value: "Seller" }],
            },
        ],
    },
};

function emptyDb() {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "order"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
}

function sseEvents(write: ReturnType<typeof vi.fn>) {
    return write.mock.calls
        .map((call) => String(call[0]))
        .filter((chunk) => chunk.startsWith("data: {"))
        .map((chunk) => JSON.parse(chunk.slice(6)) as { type: string });
}

async function run(opts: { includeAskInputs?: boolean } = {}) {
    const write = vi.fn();
    const db = emptyDb();
    const result = await runLLMStream({
        apiMessages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: "Review this NDA" },
        ],
        docStore: {},
        docIndex: {},
        userId: "user-1",
        db: db as never,
        write,
        ...opts,
    });
    return { write, result };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("runLLMStream ask_inputs pause", () => {
    it("reaches the client as ask_inputs, not error, when the adapter rewraps the pause", async () => {
        // The AI SDK adapter reports a throwing tool as a tool-error part and
        // rethrows it as a NEW Error with the same message (lib/llm/aiSdk.ts),
        // so the pause arrives without its class.
        streamChatWithTools.mockImplementation(
            async (params: { runTools: RunTools }) => {
                try {
                    await params.runTools([ASK_CALL]);
                } catch (err) {
                    throw new Error((err as Error).message);
                }
                return { fullText: "" };
            },
        );

        const { write, result } = await run();

        const types = sseEvents(write).map((e) => e.type);
        expect(types).toContain("ask_inputs");
        expect(types).not.toContain("error");
        expect(result.events.map((e) => e.type)).toContain("ask_inputs");
        expect(result.events.map((e) => e.type)).not.toContain("error");
    });

    it("recognises the pause through an error's cause chain", async () => {
        streamChatWithTools.mockImplementation(
            async (params: { runTools: RunTools }) => {
                try {
                    await params.runTools([ASK_CALL]);
                } catch (err) {
                    throw new Error("tool failed", { cause: err });
                }
                return { fullText: "" };
            },
        );

        const { write } = await run();
        expect(sseEvents(write).map((e) => e.type)).not.toContain("error");
    });

    it("does not advertise ask_inputs when the caller opts out", async () => {
        streamChatWithTools.mockResolvedValue({ fullText: "An answer." });

        await run({ includeAskInputs: false });

        const tools = (
            streamChatWithTools.mock.calls[0][0] as {
                tools: { function: { name: string } }[];
            }
        ).tools.map((t) => t.function.name);
        expect(tools).not.toContain("ask_inputs");
    });

    it("does not tell the model about ask_inputs when the caller opts out", async () => {
        streamChatWithTools.mockResolvedValue({ fullText: "An answer." });

        await run({ includeAskInputs: false });

        const { systemPrompt } = streamChatWithTools.mock.calls[0][0] as {
            systemPrompt: string;
        };
        expect(SYSTEM_PROMPT).toContain("ask_inputs");
        expect(systemPrompt).not.toContain("ask_inputs");
        expect(systemPrompt).toContain("ask for it in plain text");
    });

    it("keeps the ask_inputs instructions for callers that can answer the picker", async () => {
        streamChatWithTools.mockResolvedValue({ fullText: "An answer." });

        await run();

        const { systemPrompt } = streamChatWithTools.mock.calls[0][0] as {
            systemPrompt: string;
        };
        expect(systemPrompt).toBe(SYSTEM_PROMPT);
    });

    it("turns a call to the withheld ask_inputs tool into a plain-text question", async () => {
        streamChatWithTools.mockRejectedValue(
            new UnavailableToolCallError("ask_inputs", {
                items: [
                    {
                        id: "party",
                        kind: "choice",
                        question: "Which party do you represent?",
                        options: [{ value: "Buyer" }, { value: "Seller" }],
                    },
                ],
            }),
        );

        const { write, result } = await run({ includeAskInputs: false });

        const events = sseEvents(write) as { type: string; text?: string }[];
        expect(events.map((e) => e.type)).not.toContain("error");
        const text = events
            .filter((e) => e.type === "content_delta")
            .map((e) => e.text)
            .join("");
        expect(text).toContain("Which party do you represent? (options: Buyer, Seller)");
        expect(result.fullText).toContain("Which party do you represent?");
    });

    it("still fails a call to any other unavailable tool", async () => {
        streamChatWithTools.mockRejectedValue(
            new UnavailableToolCallError("delete_everything", {}),
        );

        await expect(run({ includeAskInputs: false })).rejects.toThrow();
    });
});
