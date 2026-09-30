import { describe, expect, it, vi } from "vitest";

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

import { NoSuchToolError } from "ai";
import { streamAiSdk } from "../aiSdk";
import { UnavailableToolCallError } from "../types";

const config = {
    provider: "anthropic" as const,
    label: "Anthropic",
    model: {} as never,
    modelId: "test-model",
};

describe("streamAiSdk unknown tool calls", () => {
    it("keeps the tool name and input of a call to a tool that was not offered", async () => {
        const input = { items: [{ kind: "text", question: "Which party?" }] };
        parts.splice(0, parts.length, { type: "start-step" }, {
            type: "tool-error",
            toolCallId: "c1",
            toolName: "ask_inputs",
            input,
            error: new NoSuchToolError({
                toolName: "ask_inputs",
                availableTools: ["read_document"],
            }),
        });

        const caught = await streamAiSdk(
            { model: "test-model", systemPrompt: "", messages: [] },
            config,
        ).catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(UnavailableToolCallError);
        expect(caught).toMatchObject({ toolName: "ask_inputs", input });
    });

    it("still reports any other tool error as a plain error", async () => {
        parts.splice(0, parts.length, {
            type: "tool-error",
            toolCallId: "c1",
            toolName: "read_document",
            input: {},
            error: new Error("document not found"),
        });

        const caught = await streamAiSdk(
            { model: "test-model", systemPrompt: "", messages: [] },
            config,
        ).catch((e: unknown) => e);

        expect(caught).not.toBeInstanceOf(UnavailableToolCallError);
        expect((caught as Error).message).toBe("document not found");
    });
});
