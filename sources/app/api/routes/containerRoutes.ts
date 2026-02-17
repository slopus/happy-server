import { eventRouter } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { log, warn } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { auth } from "@/app/auth/auth";
import { wapClient } from "@/app/wap/wapClient";
import { syncContainers, syncTemplates } from "@/app/wap/wapSync";
import {
    buildNewContainerLaunchUpdate,
    buildContainerStatusUpdate,
    buildDeleteContainerLaunchUpdate,
    buildContainerRoomAssignedUpdate,
    buildContainerRoomRemovedUpdate,
} from "@/app/events/containerEvents";
import { randomBytes } from "crypto";

function generateMachineId(): string {
    return randomBytes(16).toString('hex');
}

function generateContainerName(name: string, id: string): string {
    // Sanitize name for Docker: lowercase, alphanumeric + hyphens
    const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const shortId = id.slice(0, 8);
    return `forge-${sanitized}-${shortId}`;
}

export function containerRoutes(app: Fastify) {

    // ==========================================
    // WAP Template Endpoints (read-only, from cache)
    // ==========================================

    // List available WAP templates
    app.get('/v1/wap-templates', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const templates = await db.wapTemplateCache.findMany({
            orderBy: [{ isForgeReady: 'desc' }, { name: 'asc' }],
        });

        return reply.send({
            templates: templates.map(t => ({
                id: t.id,
                wapTemplateId: t.wapTemplateId,
                name: t.name,
                description: t.description,
                image: t.image,
                tag: t.tag,
                config: t.config,
                category: t.category,
                isForgeReady: t.isForgeReady,
                lastSyncedAt: t.lastSyncedAt.getTime(),
            }))
        });
    });

    // Get WAP template details
    app.get('/v1/wap-templates/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const { id } = request.params;

        const template = await db.wapTemplateCache.findUnique({ where: { id } });
        if (!template) {
            return reply.code(404).send({ error: 'Template not found' });
        }

        return reply.send({
            template: {
                id: template.id,
                wapTemplateId: template.wapTemplateId,
                name: template.name,
                description: template.description,
                image: template.image,
                tag: template.tag,
                config: template.config,
                category: template.category,
                isForgeReady: template.isForgeReady,
                lastSyncedAt: template.lastSyncedAt.getTime(),
            }
        });
    });

    // Trigger manual template sync
    app.post('/v1/wap-templates/sync', {
        preHandler: app.authenticate,
    }, async (_request, reply) => {
        await syncTemplates();
        return reply.send({ success: true });
    });

    // ==========================================
    // Container Launch & Lifecycle Endpoints
    // ==========================================

    // Launch a new container
    app.post('/v1/containers/launch', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                name: z.string().min(1).max(200),
                projectId: z.string(),
                // Image source: either wapTemplateId or direct image
                wapTemplateId: z.string().optional(),
                image: z.string().optional(),
                tag: z.string().optional(),
                // Agent identity
                containerType: z.string().default('forge-agent'),
                agentType: z.string().optional(),
                projectRole: z.string().optional(),
                agentVersion: z.string().optional(),
                // Container config overrides
                config: z.object({
                    env: z.record(z.string()).optional(),
                    ports: z.array(z.object({
                        containerPort: z.number(),
                        hostPort: z.number().optional(),
                        protocol: z.string().default('tcp'),
                    })).optional(),
                    volumes: z.array(z.string()).optional(),
                    resources: z.object({
                        cpuLimit: z.number().optional(),
                        memoryLimit: z.string().optional(),
                    }).optional(),
                    restartPolicy: z.string().optional(),
                }).optional(),
                // Room assignment
                roomIds: z.array(z.string()).optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body;

        // Validate project exists and belongs to user
        const project = await db.project.findFirst({
            where: { id: body.projectId, accountId: userId },
            include: { rooms: { select: { id: true }, take: 1 } }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Resolve image from template or direct input
        let image: string;
        let tag: string;
        let templateConfig: any = {};

        if (body.wapTemplateId) {
            const template = await db.wapTemplateCache.findFirst({
                where: { wapTemplateId: body.wapTemplateId }
            });
            if (!template) {
                return reply.code(404).send({ error: 'WAP template not found' });
            }
            image = template.image;
            tag = body.tag || template.tag;
            templateConfig = template.config || {};
        } else if (body.image) {
            image = body.image;
            tag = body.tag || 'latest';
        } else {
            return reply.code(400).send({ error: 'Either wapTemplateId or image is required' });
        }

        // 1. Create machine token for the container
        const machineId = generateMachineId();
        const bearerToken = await auth.createToken(userId, {
            type: 'machine',
            tokenId: `mkt_container_${machineId}`,
            name: `Container: ${body.name}`,
        });

        const machineToken = await db.machineToken.create({
            data: {
                accountId: userId,
                name: `Container: ${body.name}`,
                token: bearerToken,
            }
        });

        // 2. Create ContainerLaunch record
        const containerName = generateContainerName(body.name, machineId);
        const forgeServerUrl = process.env.FORGE_SERVER_PUBLIC_URL || process.env.WEBSITE_DOMAIN || 'http://localhost:3005';

        const launch = await db.containerLaunch.create({
            data: {
                accountId: userId,
                name: body.name,
                containerName,
                image,
                tag,
                config: body.config || {},
                containerType: body.containerType,
                agentType: body.agentType || null,
                projectRole: body.projectRole || null,
                agentVersion: body.agentVersion || null,
                projectId: body.projectId,
                status: 'pending',
                machineId,
                machineTokenId: machineToken.id,
            }
        });

        // 3. Build WAP create request
        // Merge env vars: template defaults + user config + forge injected
        const userEnv = body.config?.env || {};
        const templateEnv: Record<string, string> = {};
        if (Array.isArray(templateConfig.env)) {
            for (const e of templateConfig.env) {
                const [k, ...vParts] = (e as string).split('=');
                if (k) templateEnv[k] = vParts.join('=');
            }
        }

        const mergedEnv: Record<string, string> = {
            ...templateEnv,
            ...userEnv,
            // Forge injected env vars (override everything)
            FORGE_MACHINE_TOKEN: bearerToken,
            FORGE_SERVER_URL: forgeServerUrl,
            FORGE_SOCKET_URL: forgeServerUrl,
            FORGE_MACHINE_ID: machineId,
            // Backwards compat
            HAPPY_MACHINE_TOKEN: bearerToken,
            HAPPY_SERVER_URL: forgeServerUrl,
            HAPPY_SOCKET_URL: forgeServerUrl,
            HAPPY_MACHINE_ID: machineId,
        };
        if (process.env.ANTHROPIC_API_KEY) {
            mergedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        }
        if (body.agentType) {
            mergedEnv.AGENT_TYPE = body.agentType;
        }
        if (body.projectRole) {
            mergedEnv.AGENT_USE_CASE = body.projectRole;
        }

        const envArray = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);

        const labels: Record<string, string> = {
            'forge.launch.id': launch.id,
            'forge.project.id': body.projectId,
            'forge.container.type': body.containerType,
        };
        if (body.agentType) {
            labels['forge.agent.type'] = body.agentType;
        }

        // 4. Call WAP to create container
        try {
            await db.containerLaunch.update({
                where: { id: launch.id },
                data: { status: 'creating' }
            });

            const wapResponse = await wapClient.createContainer({
                name: containerName,
                image: `${image}:${tag}`,
                env: envArray,
                network: 't3_proxy',
                labels,
                restartPolicy: body.config?.restartPolicy || templateConfig.restartPolicy || 'unless-stopped',
                resources: body.config?.resources || templateConfig.resources,
                ports: body.config?.ports || templateConfig.ports,
                volumes: body.config?.volumes || templateConfig.volumes,
            });

            await db.containerLaunch.update({
                where: { id: launch.id },
                data: {
                    wapContainerId: wapResponse.id,
                    status: 'creating',
                }
            });

            // 5. Start the container
            await db.containerLaunch.update({
                where: { id: launch.id },
                data: { status: 'starting' }
            });

            await wapClient.startContainer(wapResponse.id);

            await db.containerLaunch.update({
                where: { id: launch.id },
                data: {
                    status: 'starting',
                    startedAt: new Date(),
                }
            });
        } catch (err) {
            // Mark as failed
            await db.containerLaunch.update({
                where: { id: launch.id },
                data: {
                    status: 'failed',
                    statusMessage: `${err}`,
                }
            });
            warn({ module: 'container-launch', launchId: launch.id }, `Container launch failed: ${err}`);
            // Still return the record so user can see the error
        }

        // 6. Auto-assign to rooms
        const roomIds = body.roomIds || (project.rooms.length > 0 ? [project.rooms[0].id] : []);
        for (const roomId of roomIds) {
            try {
                await db.roomContainer.create({
                    data: {
                        roomId,
                        containerId: launch.id,
                        role: 'member',
                    }
                });
            } catch {
                // Ignore duplicate or invalid room
            }
        }

        // 7. Emit new-container-launch event
        const updatedLaunch = await db.containerLaunch.findUnique({ where: { id: launch.id } });
        if (updatedLaunch) {
            const updSeq = await allocateUserSeq(userId);
            const payload = buildNewContainerLaunchUpdate(updatedLaunch, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        log({ module: 'container-launch', launchId: launch.id, userId }, `Launched container: ${body.name}`);

        return reply.send({
            launch: {
                id: launch.id,
                name: body.name,
                containerName,
                image,
                tag,
                status: updatedLaunch?.status || launch.status,
                statusMessage: updatedLaunch?.statusMessage || null,
                containerType: body.containerType,
                agentType: body.agentType || null,
                projectRole: body.projectRole || null,
                agentVersion: body.agentVersion || null,
                projectId: body.projectId,
                wapContainerId: updatedLaunch?.wapContainerId || null,
                machineId,
                machineTokenId: machineToken.id,
                // Return token value ONCE
                machineTokenValue: bearerToken,
                createdAt: launch.createdAt.getTime(),
            }
        });
    });

    // List user's containers
    app.get('/v1/containers', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                status: z.string().optional(),
                projectId: z.string().optional(),
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const query = request.query as { status?: string; projectId?: string } | undefined;

        const where: any = { accountId: userId };
        if (query?.status) {
            where.status = query.status;
        }
        if (query?.projectId) {
            where.projectId = query.projectId;
        }

        const containers = await db.containerLaunch.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                roomContainers: {
                    select: { roomId: true, role: true, assignedAt: true }
                }
            }
        });

        return reply.send({
            containers: containers.map(c => ({
                id: c.id,
                name: c.name,
                containerName: c.containerName,
                image: c.image,
                tag: c.tag,
                containerType: c.containerType,
                agentType: c.agentType,
                projectRole: c.projectRole,
                agentVersion: c.agentVersion,
                projectId: c.projectId,
                status: c.status,
                statusMessage: c.statusMessage,
                machineId: c.machineId,
                wapContainerId: c.wapContainerId,
                lastSeenAt: c.lastSeenAt?.getTime() || null,
                startedAt: c.startedAt?.getTime() || null,
                stoppedAt: c.stoppedAt?.getTime() || null,
                createdAt: c.createdAt.getTime(),
                updatedAt: c.updatedAt.getTime(),
                rooms: c.roomContainers.map(rc => ({
                    roomId: rc.roomId,
                    role: rc.role,
                    assignedAt: rc.assignedAt.getTime(),
                })),
            }))
        });
    });

    // Get container details
    app.get('/v1/containers/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId },
            include: {
                roomContainers: {
                    include: {
                        room: { select: { id: true, name: true, projectId: true } }
                    }
                },
                project: { select: { id: true, name: true } },
            }
        });

        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }

        return reply.send({
            container: {
                id: container.id,
                name: container.name,
                containerName: container.containerName,
                image: container.image,
                tag: container.tag,
                config: container.config,
                containerType: container.containerType,
                agentType: container.agentType,
                projectRole: container.projectRole,
                agentVersion: container.agentVersion,
                projectId: container.projectId,
                project: container.project ? { id: container.project.id, name: container.project.name } : null,
                status: container.status,
                statusMessage: container.statusMessage,
                machineId: container.machineId,
                wapContainerId: container.wapContainerId,
                lastSeenAt: container.lastSeenAt?.getTime() || null,
                startedAt: container.startedAt?.getTime() || null,
                stoppedAt: container.stoppedAt?.getTime() || null,
                createdAt: container.createdAt.getTime(),
                updatedAt: container.updatedAt.getTime(),
                rooms: container.roomContainers.map(rc => ({
                    roomId: rc.room.id,
                    roomName: rc.room.name,
                    role: rc.role,
                    assignedAt: rc.assignedAt.getTime(),
                })),
            }
        });
    });

    // Update container metadata
    app.patch('/v1/containers/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                name: z.string().min(1).max(200).optional(),
                agentType: z.string().optional(),
                projectRole: z.string().optional(),
                agentVersion: z.string().optional(),
                containerType: z.string().optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const body = request.body;

        const existing = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Container not found' });
        }

        const updated = await db.containerLaunch.update({
            where: { id },
            data: {
                name: body.name ?? undefined,
                agentType: body.agentType !== undefined ? body.agentType : undefined,
                projectRole: body.projectRole !== undefined ? body.projectRole : undefined,
                agentVersion: body.agentVersion !== undefined ? body.agentVersion : undefined,
                containerType: body.containerType ?? undefined,
            }
        });

        log({ module: 'container-update', launchId: id, userId }, 'Container metadata updated');

        return reply.send({
            container: {
                id: updated.id,
                name: updated.name,
                agentType: updated.agentType,
                projectRole: updated.projectRole,
                agentVersion: updated.agentVersion,
                containerType: updated.containerType,
                updatedAt: updated.updatedAt.getTime(),
            }
        });
    });

    // Stop container
    app.post('/v1/containers/:id/stop', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }
        if (!container.wapContainerId) {
            return reply.code(400).send({ error: 'Container has no WAP ID (not yet created)' });
        }

        await db.containerLaunch.update({
            where: { id },
            data: { status: 'stopping' }
        });

        try {
            await wapClient.stopContainer(container.wapContainerId);
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'stopped', stoppedAt: new Date() }
            });
        } catch (err) {
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'error', statusMessage: `Stop failed: ${err}` }
            });
        }

        const updSeq = await allocateUserSeq(userId);
        const updatedContainer = await db.containerLaunch.findUnique({ where: { id } });
        const payload = buildContainerStatusUpdate(
            id, updatedContainer!.status, updatedContainer!.statusMessage || null,
            container.wapContainerId, container.machineId,
            updSeq, randomKeyNaked(12)
        );
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });

        return reply.send({ success: true, status: updatedContainer!.status });
    });

    // Start stopped container
    app.post('/v1/containers/:id/start', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }
        if (!container.wapContainerId) {
            return reply.code(400).send({ error: 'Container has no WAP ID' });
        }

        await db.containerLaunch.update({
            where: { id },
            data: { status: 'starting' }
        });

        try {
            await wapClient.startContainer(container.wapContainerId);
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'starting', startedAt: new Date() }
            });
        } catch (err) {
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'error', statusMessage: `Start failed: ${err}` }
            });
        }

        const updSeq = await allocateUserSeq(userId);
        const updatedContainer = await db.containerLaunch.findUnique({ where: { id } });
        const payload = buildContainerStatusUpdate(
            id, updatedContainer!.status, updatedContainer!.statusMessage || null,
            container.wapContainerId, container.machineId,
            updSeq, randomKeyNaked(12)
        );
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });

        return reply.send({ success: true, status: updatedContainer!.status });
    });

    // Restart container
    app.post('/v1/containers/:id/restart', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }
        if (!container.wapContainerId) {
            return reply.code(400).send({ error: 'Container has no WAP ID' });
        }

        try {
            await wapClient.restartContainer(container.wapContainerId);
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'starting', startedAt: new Date() }
            });
        } catch (err) {
            await db.containerLaunch.update({
                where: { id },
                data: { status: 'error', statusMessage: `Restart failed: ${err}` }
            });
        }

        const updSeq = await allocateUserSeq(userId);
        const updatedContainer = await db.containerLaunch.findUnique({ where: { id } });
        const payload = buildContainerStatusUpdate(
            id, updatedContainer!.status, updatedContainer!.statusMessage || null,
            container.wapContainerId, container.machineId,
            updSeq, randomKeyNaked(12)
        );
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });

        return reply.send({ success: true, status: updatedContainer!.status });
    });

    // Delete container + revoke token
    app.delete('/v1/containers/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId },
            include: { machineToken: true }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }

        // Try to remove from WAP if it has a WAP ID
        if (container.wapContainerId) {
            try {
                await wapClient.stopContainer(container.wapContainerId);
            } catch {
                // Ignore stop errors
            }
            try {
                await wapClient.removeContainer(container.wapContainerId);
            } catch {
                // Ignore remove errors
            }
        }

        // Revoke machine token
        if (container.machineToken) {
            auth.invalidateToken(container.machineToken.token);
            await db.machineToken.delete({ where: { id: container.machineToken.id } });
        }

        // Delete container record (cascades to RoomContainer)
        await db.containerLaunch.delete({ where: { id } });

        // Emit delete event
        const updSeq = await allocateUserSeq(userId);
        const payload = buildDeleteContainerLaunchUpdate(id, updSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });

        log({ module: 'container-delete', launchId: id, userId }, 'Container deleted');

        return reply.send({ success: true });
    });

    // Trigger manual container sync
    app.post('/v1/containers/sync', {
        preHandler: app.authenticate,
    }, async (_request, reply) => {
        await syncContainers();
        return reply.send({ success: true });
    });

    // ==========================================
    // Room Assignment Endpoints
    // ==========================================

    // Assign container to rooms
    app.post('/v1/containers/:id/rooms', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                roomIds: z.array(z.string()).min(1),
                role: z.enum(['primary', 'member', 'observer']).optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { roomIds, role } = request.body;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }

        const assigned: Array<{ roomId: string; role: string }> = [];

        for (const roomId of roomIds) {
            // Verify room belongs to user
            const room = await db.room.findFirst({
                where: { id: roomId, accountId: userId }
            });
            if (!room) continue;

            try {
                await db.roomContainer.create({
                    data: {
                        roomId,
                        containerId: id,
                        role: role || 'member',
                    }
                });
                assigned.push({ roomId, role: role || 'member' });

                // Emit room assignment event
                const updSeq = await allocateUserSeq(userId);
                const payload = buildContainerRoomAssignedUpdate(id, roomId, role || 'member', updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });
            } catch {
                // Duplicate assignment, skip
            }
        }

        return reply.send({ assigned });
    });

    // Remove container from room
    app.delete('/v1/containers/:id/rooms/:roomId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
                roomId: z.string(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, roomId } = request.params;

        const container = await db.containerLaunch.findFirst({
            where: { id, accountId: userId }
        });
        if (!container) {
            return reply.code(404).send({ error: 'Container not found' });
        }

        const assignment = await db.roomContainer.findUnique({
            where: { roomId_containerId: { roomId, containerId: id } }
        });
        if (!assignment) {
            return reply.code(404).send({ error: 'Container not assigned to this room' });
        }

        await db.roomContainer.delete({
            where: { id: assignment.id }
        });

        // Emit room removal event
        const updSeq = await allocateUserSeq(userId);
        const payload = buildContainerRoomRemovedUpdate(id, roomId, updSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });

        return reply.send({ success: true });
    });

    // List containers in a room (with status)
    app.get('/v1/rooms/:id/containers', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        // Verify room belongs to user
        const room = await db.room.findFirst({
            where: { id, accountId: userId }
        });
        if (!room) {
            return reply.code(404).send({ error: 'Room not found' });
        }

        const roomContainers = await db.roomContainer.findMany({
            where: { roomId: id },
            include: {
                container: true
            },
            orderBy: { assignedAt: 'asc' }
        });

        return reply.send({
            containers: roomContainers.map(rc => ({
                id: rc.container.id,
                name: rc.container.name,
                containerType: rc.container.containerType,
                agentType: rc.container.agentType,
                projectRole: rc.container.projectRole,
                agentVersion: rc.container.agentVersion,
                status: rc.container.status,
                statusMessage: rc.container.statusMessage,
                machineId: rc.container.machineId,
                image: rc.container.image,
                tag: rc.container.tag,
                lastSeenAt: rc.container.lastSeenAt?.getTime() || null,
                assignedAt: rc.assignedAt.getTime(),
                role: rc.role,
            }))
        });
    });

    // List all containers for a project
    app.get('/v1/projects/:id/containers', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        // Verify project belongs to user
        const project = await db.project.findFirst({
            where: { id, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        const containers = await db.containerLaunch.findMany({
            where: { projectId: id, accountId: userId },
            orderBy: { createdAt: 'desc' },
            include: {
                roomContainers: {
                    select: { roomId: true, role: true, assignedAt: true }
                }
            }
        });

        return reply.send({
            containers: containers.map(c => ({
                id: c.id,
                name: c.name,
                containerName: c.containerName,
                image: c.image,
                tag: c.tag,
                containerType: c.containerType,
                agentType: c.agentType,
                projectRole: c.projectRole,
                agentVersion: c.agentVersion,
                status: c.status,
                statusMessage: c.statusMessage,
                machineId: c.machineId,
                wapContainerId: c.wapContainerId,
                lastSeenAt: c.lastSeenAt?.getTime() || null,
                startedAt: c.startedAt?.getTime() || null,
                stoppedAt: c.stoppedAt?.getTime() || null,
                createdAt: c.createdAt.getTime(),
                updatedAt: c.updatedAt.getTime(),
                rooms: c.roomContainers.map(rc => ({
                    roomId: rc.roomId,
                    role: rc.role,
                    assignedAt: rc.assignedAt.getTime(),
                })),
            }))
        });
    });
}
