import { eventRouter } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewRoomUpdate, buildUpdateRoomUpdate, buildDeleteRoomUpdate } from "@/app/events/projectEvents";

const RoomStatusEnum = z.enum(['active', 'archived', 'locked']);

export function roomRoutes(app: Fastify) {

    // List rooms in a project
    app.get('/v1/projects/:projectId/rooms', {
        schema: {
            params: z.object({
                projectId: z.string()
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;

        // Verify project exists and belongs to user
        const project = await db.project.findFirst({
            where: { id: projectId, accountId: userId }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        const rooms = await db.room.findMany({
            where: { projectId },
            orderBy: { name: 'asc' },
            select: {
                id: true,
                projectId: true,
                name: true,
                description: true,
                metadata: true,
                status: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        return reply.send({
            rooms: rooms.map((r) => ({
                id: r.id,
                accountId: userId,
                projectId: r.projectId,
                name: r.name,
                description: r.description,
                metadata: r.metadata,
                status: r.status,
                createdAt: r.createdAt.getTime(),
                updatedAt: r.updatedAt.getTime(),
            }))
        });
    });

    // Get room details
    app.get('/v1/rooms/:id', {
        schema: {
            params: z.object({
                id: z.string()
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const room = await db.room.findFirst({
            where: { id, accountId: userId },
            include: {
                project: {
                    select: {
                        id: true,
                        name: true,
                        path: true,
                    }
                },
                roomSessions: {
                    include: {
                        session: {
                            select: {
                                id: true,
                                metadata: true,
                                active: true,
                                lastActiveAt: true,
                            }
                        }
                    }
                }
            }
        });

        if (!room) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        return reply.send({
            room: {
                id: room.id,
                accountId: userId,
                projectId: room.projectId,
                name: room.name,
                description: room.description,
                metadata: room.metadata,
                status: room.status,
                createdAt: room.createdAt.getTime(),
                updatedAt: room.updatedAt.getTime(),
                project: {
                    id: room.project.id,
                    name: room.project.name,
                    path: room.project.path,
                },
                sessions: room.roomSessions.map(rs => ({
                    id: rs.session.id,
                    role: rs.role,
                    joinedAt: rs.joinedAt.getTime(),
                    metadata: rs.session.metadata,
                    active: rs.session.active,
                    lastActiveAt: rs.session.lastActiveAt.getTime(),
                }))
            }
        });
    });

    // Create room
    app.post('/v1/projects/:projectId/rooms', {
        schema: {
            params: z.object({
                projectId: z.string()
            }),
            body: z.object({
                name: z.string().min(1).max(255),
                description: z.string().max(1000).optional(),
                metadata: z.record(z.unknown()).optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const { name, description, metadata } = request.body;

        // Verify project exists and belongs to user
        const project = await db.project.findFirst({
            where: { id: projectId, accountId: userId }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Check for duplicate name in project
        const existing = await db.room.findFirst({
            where: { projectId, name }
        });

        if (existing) {
            return reply.code(409).send({ error: 'A room with this name already exists in this project' });
        }

        const room = await db.room.create({
            data: {
                accountId: userId,
                projectId,
                name,
                description,
                metadata,
            }
        });

        log({ module: 'room-create', roomId: room.id, projectId, userId }, `Created room: ${room.id}`);

        // Emit new room event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildNewRoomUpdate({
            id: room.id,
            accountId: userId,
            projectId: room.projectId,
            name: room.name,
            description: room.description,
            metadata: room.metadata,
            status: room.status,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt,
        }, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            room: {
                id: room.id,
                accountId: userId,
                projectId: room.projectId,
                name: room.name,
                description: room.description,
                metadata: room.metadata,
                status: room.status,
                createdAt: room.createdAt.getTime(),
                updatedAt: room.updatedAt.getTime(),
            }
        });
    });

    // Update room
    app.patch('/v1/rooms/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                name: z.string().min(1).max(255).optional(),
                description: z.string().max(1000).nullable().optional(),
                metadata: z.record(z.unknown()).optional(),
                status: RoomStatusEnum.optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { name, description, metadata, status } = request.body;

        // Verify room exists and belongs to user
        const existing = await db.room.findFirst({
            where: { id, accountId: userId }
        });

        if (!existing) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        // Check for duplicate name if name is being changed
        if (name && name !== existing.name) {
            const duplicate = await db.room.findFirst({
                where: {
                    projectId: existing.projectId,
                    name: name,
                    id: { not: id }
                }
            });

            if (duplicate) {
                return reply.code(409).send({ error: 'A room with this name already exists in this project' });
            }
        }

        const room = await db.room.update({
            where: { id },
            data: {
                name: name ?? undefined,
                description: description !== undefined ? description : undefined,
                metadata: metadata ?? undefined,
                status: status ?? undefined,
            }
        });

        log({ module: 'room-update', roomId: id, userId }, `Updated room: ${id}`);

        // Emit update event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildUpdateRoomUpdate(id, existing.projectId, updSeq, randomKeyNaked(12), {
            name,
            description: description !== undefined ? description : undefined,
            metadata,
            status,
        });

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            room: {
                id: room.id,
                accountId: userId,
                projectId: room.projectId,
                name: room.name,
                description: room.description,
                metadata: room.metadata,
                status: room.status,
                createdAt: room.createdAt.getTime(),
                updatedAt: room.updatedAt.getTime(),
            }
        });
    });

    // Delete room
    app.delete('/v1/rooms/:id', {
        schema: {
            params: z.object({
                id: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        // Verify room exists and belongs to user
        const room = await db.room.findFirst({
            where: { id, accountId: userId },
            select: { id: true, projectId: true }
        });

        if (!room) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        // Delete room
        await db.room.delete({
            where: { id }
        });

        log({ module: 'room-delete', roomId: id, userId }, `Deleted room: ${id}`);

        // Emit delete event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildDeleteRoomUpdate(id, room.projectId, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });
}
