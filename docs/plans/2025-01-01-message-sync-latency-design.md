# Message Sync Latency Reduction Design

## Problem

When opening the iOS app, users wait 2-7 seconds before session content (messages) appears. The delay comes from:

1. Socket reconnection (1-5s on mobile)
2. Full HTTP fetch of 150 messages every time
3. Decrypting all 150 messages even when most are cached
4. No prefetching - messages only fetched when session opened

## Solution: Two-Part Approach

### Part A: Incremental Sync

Add `updatedAfter` parameter to message fetching so iOS only requests new/edited messages.

---

#### Server API Change

**Endpoint:**
```
GET /v1/sessions/:sessionId/messages?updatedAfter=<timestamp>&before=<timestamp>&limit=150
```

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `updatedAfter` | timestamp (ms) | Messages updated after this time |
| `before` | timestamp (ms) | Messages created before this time (for history) |
| `limit` | int (1-150) | Max messages to return, default 150 |

**Behavior:**
- `updatedAfter` only: Fetch new/edited messages (incremental sync)
- `before` only: Fetch older history (scroll up)
- Both: Fetch range
- Neither: Last 150 messages (backwards compatible)

**Response:**
```json
{
  "messages": [...],
  "hasMore": true,
  "oldestTimestamp": 1735600000000,
  "newestTimestamp": 1735689999000
}
```

**Server Implementation:**
```typescript
// In sessionRoutes.ts
app.get('/v1/sessions/:sessionId/messages', {
    schema: {
        params: z.object({ sessionId: z.string() }),
        querystring: z.object({
            updatedAfter: z.coerce.number().int().min(0).optional(),
            before: z.coerce.number().int().min(0).optional(),
            limit: z.coerce.number().int().min(1).max(150).default(150)
        }).optional()
    },
    preHandler: app.authenticate
}, async (request, reply) => {
    const { sessionId } = request.params;
    const { updatedAfter, before, limit } = request.query || {};

    const messages = await db.sessionMessage.findMany({
        where: {
            sessionId,
            ...(updatedAfter !== undefined ? { updatedAt: { gt: new Date(updatedAfter) } } : {}),
            ...(before !== undefined ? { createdAt: { lt: new Date(before) } } : {})
        },
        orderBy: updatedAfter !== undefined ? { updatedAt: 'asc' } : { createdAt: 'desc' },
        take: limit || 150,
        select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true }
    });

    return reply.send({
        messages: messages.map(v => ({
            id: v.id,
            seq: v.seq,
            content: v.content,
            localId: v.localId,
            createdAt: v.createdAt.getTime(),
            updatedAt: v.updatedAt.getTime()
        })),
        hasMore: messages.length === (limit || 150),
        ...(messages.length > 0 ? {
            oldestTimestamp: Math.min(...messages.map(m => m.createdAt.getTime())),
            newestTimestamp: Math.max(...messages.map(m => m.createdAt.getTime()))
        } : {})
    });
});
```

**Index Required:**
```prisma
@@index([sessionId, updatedAt])
```

---

#### iOS Changes for Incremental Sync

**Track last sync timestamp:**
```typescript
// In Sync class
private sessionLastSync = new Map<string, number>();

// Persist to AsyncStorage for cold starts
private async loadLastSyncTimes() {
    const stored = await AsyncStorage.getItem('sessionLastSync');
    if (stored) {
        const parsed = JSON.parse(stored);
        Object.entries(parsed).forEach(([id, ts]) =>
            this.sessionLastSync.set(id, ts as number)
        );
    }
}

private async persistLastSyncTimes() {
    const obj = Object.fromEntries(this.sessionLastSync);
    await AsyncStorage.setItem('sessionLastSync', JSON.stringify(obj));
}
```

**Modified fetchMessages:**
```typescript
private fetchMessages = async (sessionId: string) => {
    const encryption = this.encryption.getSessionEncryption(sessionId);
    if (!encryption) {
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const lastSync = this.sessionLastSync.get(sessionId);
    const url = lastSync
        ? `/v1/sessions/${sessionId}/messages?updatedAfter=${lastSync}`
        : `/v1/sessions/${sessionId}/messages`;

    const response = await apiSocket.request(url);
    const data = await response.json();

    // Only decrypt NEW/UPDATED messages (typically 0-5)
    const decrypted = await encryption.decryptMessages(data.messages);

    // Update last sync time using SERVER timestamp (avoids clock skew issues)
    if (data.newestTimestamp) {
        this.sessionLastSync.set(sessionId, data.newestTimestamp);
        this.persistLastSyncTimes();
    }

    this.applyMessages(sessionId, decrypted);
};
```

---

### Part B: Prefetch on App Active

When app becomes active, immediately prefetch messages for recently-active sessions with timeout protection.

**Implementation:**
```typescript
// In constructor, modify AppState handler
AppState.addEventListener('change', (nextAppState) => {
    if (nextAppState === 'active') {
        log.log('App became active');

        // Existing syncs...
        this.sessionsSync.invalidate();
        this.machinesSync.invalidate();
        // ... etc

        // NEW: Prefetch messages for active sessions
        this.prefetchActiveSessionMessages();
    }
});

private prefetchActiveSessionMessages = async () => {
    // Wait for sessions list (with timeout)
    const sessionsReady = Promise.race([
        this.sessionsSync.awaitQueue(),
        delay(3000).then(() => 'timeout')
    ]);

    if (await sessionsReady === 'timeout') {
        log.log('Sessions sync timeout - skipping prefetch');
        return;
    }

    const activeSessions = storage.getState()
        .sessionsData
        ?.filter((s): s is Session => typeof s !== 'string' && s.active)
        .slice(0, 5) ?? [];

    if (activeSessions.length === 0) return;

    log.log(`Prefetching messages for ${activeSessions.length} active sessions`);

    // Prefetch with 5s total timeout
    const prefetchWithTimeout = Promise.race([
        Promise.allSettled(
            activeSessions.map(session => {
                let sync = this.messagesSync.get(session.id);
                if (!sync) {
                    sync = new InvalidateSync(() => this.fetchMessages(session.id));
                    this.messagesSync.set(session.id, sync);
                }
                return sync.invalidateAndAwait();
            })
        ),
        delay(5000).then(() => 'timeout')
    ]);

    const result = await prefetchWithTimeout;
    if (result === 'timeout') {
        log.log('Prefetch timeout - continuing in background');
    } else {
        log.log('Prefetch complete');
    }
};
```

**Timeouts:**
- 3s for sessions list to load
- 5s for all message prefetches combined
- If timeout, prefetches continue in background (don't cancel)

---

## Known Limitations

### Deleted Messages
This design does not handle message deletions. If a message is deleted after sync, the client won't know to remove it. Options for future:
- Soft-delete flag with `deletedAt` timestamp
- Periodic full refresh (e.g., every 24h)
- Separate tombstone endpoint

### Clock Skew Protection
Using server's `newestTimestamp` (not client's `Date.now()`) mitigates most clock skew issues. For additional protection, could subtract a small buffer (5-10s) from `updatedAfter`, but this may cause minor duplicate fetches.

---

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Messages fetched | 150 always | 0-5 typical |
| Decrypt time | 100-500ms | ~10ms |
| HTTP payload | ~50-200KB | ~1-5KB |
| Time to content | 2-7s | <500ms |

---

## Implementation Branches

### Branch: `feat/incremental-message-sync`
**Repos:** `happy-server` + `happy`

1. Server: Add `updatedAfter` and `before` query params
2. Server: Add `@@index([sessionId, updatedAt])` to schema
3. iOS: Add `sessionLastSync` Map + persistence
4. iOS: Modify `fetchMessages` to use `updatedAfter`

### Branch: `feat/prefetch-on-active`
**Repo:** `happy`

1. Add `prefetchActiveSessionMessages` method
2. Call from AppState 'active' handler
3. Add timeout protection (3s sessions, 5s prefetch)

---

## Files to Modify

**Server (`happy-server`):**
- `sources/app/api/routes/sessionRoutes.ts` - add query params
- `prisma/schema.prisma` - add index (if needed)

**iOS (`happy`):**
- `sources/sync/sync.ts` - incremental fetch + prefetch
- `sources/sync/storage.ts` - persist lastSync times (optional)
