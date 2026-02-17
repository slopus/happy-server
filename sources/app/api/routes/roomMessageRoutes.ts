import { eventRouter } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import type { UpdatePayload } from "@/app/events/eventRouter";

// === EVENT BUILDERS ===

function buildNewRoomMessageUpdate(message: {
    id: string;
    roomId: string;
    accountId: string;
    content: string;
    type: string;
    metadata: unknown;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-room-message',
            messageId: message.id,
            roomId: message.roomId,
            accountId: message.accountId,
            content: message.content,
            messageType: message.type,
            metadata: message.metadata,
            createdAt: message.createdAt.getTime(),
        },
        createdAt: Date.now()
    };
}

// === ROUTES ===

export function roomMessageRoutes(app: Fastify) {

    // List messages in a room (cursor-paginated, newest first)
    app.get('/v1/rooms/:roomId/messages', {
        schema: {
            params: z.object({ roomId: z.string() }),
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().min(1).max(100).default(50),
            }).optional()
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { roomId } = request.params;
        const query = request.query as { cursor?: string; limit?: number } | undefined;
        const limit = query?.limit ?? 50;

        // Verify room belongs to user's account
        const room = await db.room.findFirst({
            where: { id: roomId, accountId: userId }
        });
        if (!room) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        const where: any = { roomId };
        if (query?.cursor) {
            where.createdAt = { lt: new Date(query.cursor) };
        }

        const messages = await db.roomMessage.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit + 1, // Fetch one extra to determine if there's a next page
        });

        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;
        const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

        return reply.send({
            messages: page.map(m => ({
                id: m.id,
                roomId: m.roomId,
                accountId: m.accountId,
                content: m.content,
                type: m.type,
                metadata: m.metadata,
                createdAt: m.createdAt.getTime(),
                updatedAt: m.updatedAt.getTime(),
            })),
            nextCursor,
        });
    });

    // Send message to room
    app.post('/v1/rooms/:roomId/messages', {
        schema: {
            params: z.object({ roomId: z.string() }),
            body: z.object({
                content: z.string().min(1),
                type: z.enum(['user', 'assistant', 'system']).default('user'),
                metadata: z.record(z.unknown()).optional(),
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { roomId } = request.params;
        const { content, type, metadata } = request.body;

        // Verify room belongs to user's account
        const room = await db.room.findFirst({
            where: { id: roomId, accountId: userId }
        });
        if (!room) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        // For machine auth (containers), check RoomContainer assignment and force type to 'assistant'
        let messageType = type;
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer mkt_')) {
            // Machine token — verify container is assigned to room
            const machineToken = await db.machineToken.findFirst({
                where: { accountId: userId },
                include: {
                    ContainerLaunch: {
                        where: { accountId: userId },
                        include: {
                            roomContainers: { where: { roomId } }
                        },
                        take: 1
                    }
                }
            });

            // If token found but no container assigned to room, deny
            if (machineToken && machineToken.ContainerLaunch.length > 0) {
                const container = machineToken.ContainerLaunch[0];
                if (container.roomContainers.length === 0) {
                    return reply.code(403).send({ error: 'Container not assigned to this room' });
                }
            }

            messageType = 'assistant';
        }

        const message = await db.roomMessage.create({
            data: {
                roomId,
                accountId: userId,
                content,
                type: messageType,
                metadata: metadata || undefined,
            }
        });

        log({ module: 'room-message', roomId, userId }, `New message: ${message.id}`);

        // Emit update event to all user connections (including machine-scoped)
        const updSeq = await allocateUserSeq(userId);
        const payload = buildNewRoomMessageUpdate(message, updSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({
            userId,
            payload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });

        return reply.send({
            message: {
                id: message.id,
                roomId: message.roomId,
                accountId: message.accountId,
                content: message.content,
                type: message.type,
                metadata: message.metadata,
                createdAt: message.createdAt.getTime(),
                updatedAt: message.updatedAt.getTime(),
            }
        });
    });

    // Edit message content
    app.patch('/v1/messages/:id', {
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                content: z.string().min(1),
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { content } = request.body;

        const existing = await db.roomMessage.findFirst({
            where: { id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        const updated = await db.roomMessage.update({
            where: { id },
            data: { content }
        });

        log({ module: 'room-message', messageId: id, userId }, `Message edited`);

        return reply.send({
            message: {
                id: updated.id,
                roomId: updated.roomId,
                accountId: updated.accountId,
                content: updated.content,
                type: updated.type,
                metadata: updated.metadata,
                createdAt: updated.createdAt.getTime(),
                updatedAt: updated.updatedAt.getTime(),
            }
        });
    });

    // Delete message
    app.delete('/v1/messages/:id', {
        schema: {
            params: z.object({ id: z.string() })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const existing = await db.roomMessage.findFirst({
            where: { id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        await db.roomMessage.delete({ where: { id } });

        log({ module: 'room-message', messageId: id, userId }, `Message deleted`);

        return reply.send({ success: true });
    });
}
