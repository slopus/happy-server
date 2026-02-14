# Incremental Message Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `updatedAfter` and `before` query parameters to the messages endpoint for incremental sync.

**Architecture:** Extend existing GET `/v1/sessions/:sessionId/messages` endpoint with optional query params. Add database index on `(sessionId, updatedAt)` for efficient queries.

**Tech Stack:** Fastify, Zod validation, Prisma ORM, Vitest

---

## Task 1: Add Query Parameter Schema

**Files:**
- Modify: `sources/app/api/routes/sessionRoutes.ts:308-355`

**Step 1: Update the schema to include querystring validation**

Find the existing route at line 308 and update the schema:

```typescript
app.get('/v1/sessions/:sessionId/messages', {
    schema: {
        params: z.object({
            sessionId: z.string()
        }),
        querystring: z.object({
            updatedAfter: z.coerce.number().int().min(0).optional(),
            before: z.coerce.number().int().min(0).optional(),
            limit: z.coerce.number().int().min(1).max(150).default(150)
        })
    },
    preHandler: app.authenticate
}, async (request, reply) => {
```

**Step 2: Update the handler to use query params**

Replace the handler body (lines 315-354) with:

```typescript
}, async (request, reply) => {
    const userId = request.userId;
    const { sessionId } = request.params;
    const { updatedAfter, before, limit } = request.query;

    // Verify session belongs to user
    const session = await db.session.findFirst({
        where: {
            id: sessionId,
            accountId: userId
        }
    });

    if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
    }

    const messages = await db.sessionMessage.findMany({
        where: {
            sessionId,
            ...(updatedAfter !== undefined ? { updatedAt: { gt: new Date(updatedAfter) } } : {}),
            ...(before !== undefined ? { createdAt: { lt: new Date(before) } } : {})
        },
        orderBy: updatedAfter !== undefined ? { updatedAt: 'asc' } : { createdAt: 'desc' },
        take: limit,
        select: {
            id: true,
            seq: true,
            localId: true,
            content: true,
            createdAt: true,
            updatedAt: true
        }
    });

    return reply.send({
        messages: messages.map((v) => ({
            id: v.id,
            seq: v.seq,
            content: v.content,
            localId: v.localId,
            createdAt: v.createdAt.getTime(),
            updatedAt: v.updatedAt.getTime()
        })),
        hasMore: messages.length === limit,
        ...(messages.length > 0 ? {
            oldestTimestamp: Math.min(...messages.map(m => m.createdAt.getTime())),
            newestTimestamp: Math.max(...messages.map(m => m.updatedAt.getTime()))
        } : {})
    });
});
```

**Step 3: Run TypeScript check**

Run: `yarn build`
Expected: No errors

**Step 4: Commit**

```bash
git add sources/app/api/routes/sessionRoutes.ts
git commit -m "feat: add updatedAfter and before params to messages endpoint

Enables incremental sync by allowing clients to request only
messages updated after a specific timestamp.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Add Database Index

**Files:**
- Modify: `prisma/schema.prisma:116-129`

**Step 1: Add the index to SessionMessage model**

Find the `SessionMessage` model (around line 116) and add the index:

```prisma
model SessionMessage {
    id        String   @id @default(cuid())
    sessionId String
    session   Session  @relation(fields: [sessionId], references: [id])
    localId   String?
    seq       Int
    /// [SessionMessageContent]
    content   Json
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@unique([sessionId, localId])
    @@index([sessionId, seq])
    @@index([sessionId, updatedAt])
}
```

**Step 2: Generate Prisma client**

Run: `yarn generate`
Expected: Success message about Prisma client generation

**Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "chore: add index for incremental message sync

Index on (sessionId, updatedAt) optimizes queries with updatedAfter parameter.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

**Note:** Migration must be created by a human. The index will be applied when they run `yarn migrate`.

---

## Task 3: Manual Testing

**Step 1: Start the server**

Run: `yarn start` (or however the dev server runs)

**Step 2: Test backwards compatibility (no params)**

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/v1/sessions/<sessionId>/messages"
```

Expected: Returns up to 150 messages with `hasMore`, `oldestTimestamp`, `newestTimestamp` fields

**Step 3: Test with updatedAfter**

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/v1/sessions/<sessionId>/messages?updatedAfter=1735600000000"
```

Expected: Returns only messages updated after the timestamp

**Step 4: Test with limit**

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/v1/sessions/<sessionId>/messages?limit=10"
```

Expected: Returns at most 10 messages

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add query params to endpoint | `sessionRoutes.ts` |
| 2 | Add database index | `schema.prisma` |
| 3 | Manual testing | - |

**Total commits:** 2 (code change + index)

**Migration note:** After Task 2, a human must create and apply the migration.
