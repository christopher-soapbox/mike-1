import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        res.locals.userEmail = "user-1@example.com";
        next();
    },
}));

/**
 * Chainable Supabase mock for the `chats` table only — this route's
 * POST /create handler never touches `projects` unless a project_id is
 * given, and none of these tests supply one.
 */
function makeChatsDb(existingByExternalRef: Record<string, { id: string }>) {
    const inserted: Record<string, unknown>[] = [];
    let nextId = 1;

    function chatsBuilder() {
        const filters: Record<string, unknown> = {};
        const b: any = {
            select: () => b,
            eq: (col: string, val: unknown) => {
                filters[col] = val;
                return b;
            },
            maybeSingle: () => {
                const externalRef = filters.external_ref as
                    | string
                    | undefined;
                const match =
                    externalRef !== undefined
                        ? existingByExternalRef[externalRef]
                        : undefined;
                return Promise.resolve({ data: match ?? null, error: null });
            },
            insert: (row: Record<string, unknown>) => {
                inserted.push(row);
                const id = `new-${nextId++}`;
                return {
                    select: () => ({
                        single: () =>
                            Promise.resolve({ data: { id }, error: null }),
                    }),
                };
            },
        };
        return b;
    }

    const db = {
        from: (table: string) => {
            if (table === "chats") return chatsBuilder();
            throw new Error(`unexpected table in test: ${table}`);
        },
    };
    return { db: db as any, inserted };
}

/**
 * Simulates the race between two concurrent POST /create calls sharing an
 * external_ref: the initial lookup finds nothing (both requests raced past
 * it), the insert hits the unique partial index and comes back as a
 * Postgres 23505 unique-violation, and only the re-lookup after that
 * finds the row the other, faster request actually created.
 */
function makeRacingChatsDb(winningChatId: string) {
    const inserted: Record<string, unknown>[] = [];
    let selectCallCount = 0;

    function chatsBuilder() {
        const b: any = {
            select: () => b,
            eq: () => b,
            maybeSingle: () => {
                selectCallCount += 1;
                // First select = the initial get-or-create lookup (misses).
                // Second select = the post-conflict re-lookup (hits).
                const data =
                    selectCallCount >= 2 ? { id: winningChatId } : null;
                return Promise.resolve({ data, error: null });
            },
            insert: (row: Record<string, unknown>) => {
                inserted.push(row);
                return {
                    select: () => ({
                        single: () =>
                            Promise.resolve({
                                data: null,
                                error: {
                                    code: "23505",
                                    message:
                                        'duplicate key value violates unique constraint "chats_user_external_ref_unique"',
                                },
                            }),
                    }),
                };
            },
        };
        return b;
    }

    const db = {
        from: (table: string) => {
            if (table === "chats") return chatsBuilder();
            throw new Error(`unexpected table in test: ${table}`);
        },
    };
    return { db: db as any, inserted };
}

let currentDb: ReturnType<typeof makeChatsDb>["db"];

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: () => currentDb,
}));

import { chatRouter } from "../chat";

const app = express();
app.use(express.json());
app.use("/chat", chatRouter);

describe("POST /chat/create", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("creates a new chat and returns its id when no chat exists for the external_ref", async () => {
        const { db, inserted } = makeChatsDb({});
        currentDb = db;

        const response = await request(app)
            .post("/chat/create")
            .send({ external_ref: "slack:C123:456.789" });

        expect(response.status).toBe(200);
        expect(response.body.id).toBeTruthy();
        expect(inserted).toEqual([
            {
                user_id: "user-1",
                project_id: null,
                external_ref: "slack:C123:456.789",
            },
        ]);
    });

    it("returns the existing chat id for a repeat external_ref instead of inserting again", async () => {
        const { db, inserted } = makeChatsDb({
            "slack:C123:456.789": { id: "existing-chat-id" },
        });
        currentDb = db;

        const response = await request(app)
            .post("/chat/create")
            .send({ external_ref: "slack:C123:456.789" });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ id: "existing-chat-id" });
        expect(inserted).toEqual([]);
    });

    it("still creates a chat with no external_ref, matching prior frontend behavior", async () => {
        const { db, inserted } = makeChatsDb({});
        currentDb = db;

        const response = await request(app).post("/chat/create").send({});

        expect(response.status).toBe(200);
        expect(response.body.id).toBeTruthy();
        expect(inserted).toEqual([
            {
                user_id: "user-1",
                project_id: null,
                external_ref: null,
            },
        ]);
    });

    it("returns the winning request's chat id on a concurrent-insert race, instead of a 500", async () => {
        const { db, inserted } = makeRacingChatsDb("winner-chat-id");
        currentDb = db;

        const response = await request(app)
            .post("/chat/create")
            .send({ external_ref: "slack:C123:456.789" });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ id: "winner-chat-id" });
        // The losing request still attempted exactly one insert before
        // recovering via the re-lookup.
        expect(inserted).toEqual([
            {
                user_id: "user-1",
                project_id: null,
                external_ref: "slack:C123:456.789",
            },
        ]);
    });
});
