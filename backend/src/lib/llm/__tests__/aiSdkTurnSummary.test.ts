import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { parts } = vi.hoisted(() => ({ parts: [] as unknown[] }));

vi.mock("ai", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("ai");
    return {
        ...actual,
        streamText: () => ({
            stream: (async function* () {
                for (const part of parts) yield part;
            })(),
        }),
    };
});

import { EmptyReplyError, streamAiSdk } from "../aiSdk";

const config = {
    provider: "claude" as const,
    label: "Anthropic",
    model: {} as never,
    modelId: "claude-opus-5-5",
};

function usage(output: number, reasoning: number) {
    return {
        inputTokens: 40_000,
        outputTokens: output,
        outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
    };
}

function finishStep(finishReason: string, raw: string, output = 100, reasoning = 0) {
    return { type: "finish-step", finishReason, rawFinishReason: raw, usage: usage(output, reasoning) };
}

function finish(finishReason: string, raw: string, output = 100, reasoning = 0) {
    return { type: "finish", finishReason, rawFinishReason: raw, totalUsage: usage(output, reasoning) };
}

function turnLogs(log: ReturnType<typeof vi.spyOn>) {
    return log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[llm/turn] "))
        .map((line) => JSON.parse(line.slice("[llm/turn] ".length)));
}

const run = () =>
    streamAiSdk({ model: "claude-opus-5-5", systemPrompt: "", messages: [] }, config);

describe("streamAiSdk turn summary", () => {
    let log: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        log = vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => log.mockRestore());

    it("logs the model, finish reason and token use of every turn", async () => {
        parts.splice(
            0,
            parts.length,
            { type: "start-step" },
            { type: "text-delta", id: "t", text: "The clause is enforceable." },
            finishStep("stop", "end_turn", 900, 600),
            finish("stop", "end_turn", 900, 600),
        );

        await expect(run()).resolves.toEqual({ fullText: "The clause is enforceable." });

        expect(turnLogs(log)).toEqual([
            {
                provider: "claude",
                model: "claude-opus-5-5",
                steps: 1,
                finishReason: "stop",
                rawFinishReason: "end_turn",
                stepFinishReasons: ["stop"],
                inputTokens: 40_000,
                outputTokens: 900,
                reasoningTokens: 600,
                maxOutputTokens: 16_384,
                replyChars: 26,
            },
        ]);
    });

    it("refuses a turn cut off by the token limit before any reply text", async () => {
        // Reasoning used the whole output budget: the shape a long review hits.
        parts.splice(
            0,
            parts.length,
            { type: "start-step" },
            { type: "reasoning-delta", id: "r", text: "Weighing clause 4" },
            finishStep("length", "max_tokens", 16_384, 16_384),
            finish("length", "max_tokens", 16_384, 16_384),
        );

        const caught = await run().catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(EmptyReplyError);
        expect((caught as Error).message).toBe(
            "claude-opus-5-5 ended its turn with no reply text (finish reason: length / max_tokens, after 1 step).",
        );
        // Logged before it throws, so the cause is readable in production.
        expect(turnLogs(log)[0]).toMatchObject({ finishReason: "length", replyChars: 0 });
    });

    it("refuses a turn that hit the step cap while still calling tools", async () => {
        const steps = Array.from({ length: 10 }, () => [
            { type: "start-step" },
            finishStep("tool-calls", "tool_use"),
        ]).flat();
        parts.splice(0, parts.length, ...steps, finish("tool-calls", "tool_use"));

        const caught = await run().catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(EmptyReplyError);
        expect((caught as Error).message).toContain("step cap of 10 reached");
    });

    it("lets a model that chose to stop without text through, and logs it", async () => {
        // An edit-only turn can end this way on purpose; the client decides.
        parts.splice(
            0,
            parts.length,
            { type: "start-step" },
            finishStep("stop", "end_turn"),
            finish("stop", "end_turn"),
        );

        await expect(run()).resolves.toEqual({ fullText: "" });
        expect(turnLogs(log)[0]).toMatchObject({ finishReason: "stop", replyChars: 0 });
    });
});
