import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { randomBytes } from "crypto";

// Generate a machine token with mkt_ prefix
function generateMachineToken(): string {
    const bytes = randomBytes(32);
    return `mkt_${bytes.toString('base64url')}`;
}

export function machineTokenRoutes(app: Fastify) {
    // Create a new machine token
    app.post('/v1/machine-tokens', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                name: z.string().min(1).max(100),
                expiresAt: z.string().datetime().optional() // ISO date string
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { name, expiresAt } = request.body;

        log({ module: 'machine-tokens', userId }, `Creating machine token: ${name}`);

        // Generate the actual bearer token using the auth system
        const tokenId = generateMachineToken();
        const bearerToken = await auth.createToken(userId, {
            type: 'machine',
            tokenId,
            name
        });

        // Store token metadata in database
        const machineToken = await db.machineToken.create({
            data: {
                accountId: userId,
                name,
                token: bearerToken,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
            }
        });

        log({ module: 'machine-tokens', userId, tokenId: machineToken.id }, 'Machine token created');

        // Return the full token ONCE - this is the only time it's visible
        return reply.send({
            token: {
                id: machineToken.id,
                name: machineToken.name,
                // Return the full bearer token only on creation
                value: bearerToken,
                expiresAt: machineToken.expiresAt?.toISOString() || null,
                createdAt: machineToken.createdAt.toISOString(),
            }
        });
    });

    // List all machine tokens for the user
    app.get('/v1/machine-tokens', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const tokens = await db.machineToken.findMany({
            where: { accountId: userId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                lastUsedAt: true,
                expiresAt: true,
                createdAt: true,
                updatedAt: true,
                // Never return the actual token value in list
            }
        });

        return reply.send({
            tokens: tokens.map(t => ({
                id: t.id,
                name: t.name,
                lastUsedAt: t.lastUsedAt?.toISOString() || null,
                expiresAt: t.expiresAt?.toISOString() || null,
                createdAt: t.createdAt.toISOString(),
                updatedAt: t.updatedAt.toISOString(),
                // Show only prefix of token for identification
                tokenPrefix: 'mkt_...'
            }))
        });
    });

    // Get a single machine token
    app.get('/v1/machine-tokens/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const token = await db.machineToken.findFirst({
            where: {
                id,
                accountId: userId
            },
            select: {
                id: true,
                name: true,
                lastUsedAt: true,
                expiresAt: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        if (!token) {
            return reply.code(404).send({ error: 'Token not found' });
        }

        return reply.send({
            token: {
                id: token.id,
                name: token.name,
                lastUsedAt: token.lastUsedAt?.toISOString() || null,
                expiresAt: token.expiresAt?.toISOString() || null,
                createdAt: token.createdAt.toISOString(),
                updatedAt: token.updatedAt.toISOString(),
                tokenPrefix: 'mkt_...'
            }
        });
    });

    // Update token name
    app.patch('/v1/machine-tokens/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                name: z.string().min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { name } = request.body;

        const existing = await db.machineToken.findFirst({
            where: {
                id,
                accountId: userId
            }
        });

        if (!existing) {
            return reply.code(404).send({ error: 'Token not found' });
        }

        const updated = await db.machineToken.update({
            where: { id },
            data: { name },
            select: {
                id: true,
                name: true,
                lastUsedAt: true,
                expiresAt: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        log({ module: 'machine-tokens', userId, tokenId: id }, `Token renamed to: ${name}`);

        return reply.send({
            token: {
                id: updated.id,
                name: updated.name,
                lastUsedAt: updated.lastUsedAt?.toISOString() || null,
                expiresAt: updated.expiresAt?.toISOString() || null,
                createdAt: updated.createdAt.toISOString(),
                updatedAt: updated.updatedAt.toISOString(),
                tokenPrefix: 'mkt_...'
            }
        });
    });

    // Delete/revoke a machine token
    app.delete('/v1/machine-tokens/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const existing = await db.machineToken.findFirst({
            where: {
                id,
                accountId: userId
            }
        });

        if (!existing) {
            return reply.code(404).send({ error: 'Token not found' });
        }

        // Invalidate the token in auth cache
        auth.invalidateToken(existing.token);

        // Delete from database
        await db.machineToken.delete({
            where: { id }
        });

        log({ module: 'machine-tokens', userId, tokenId: id }, 'Token revoked');

        return reply.send({ success: true });
    });

    // Rotate/regenerate a machine token
    app.post('/v1/machine-tokens/:id/rotate', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const existing = await db.machineToken.findFirst({
            where: {
                id,
                accountId: userId
            }
        });

        if (!existing) {
            return reply.code(404).send({ error: 'Token not found' });
        }

        // Invalidate old token
        auth.invalidateToken(existing.token);

        // Generate new token
        const tokenId = generateMachineToken();
        const newBearerToken = await auth.createToken(userId, {
            type: 'machine',
            tokenId,
            name: existing.name
        });

        // Update in database
        const updated = await db.machineToken.update({
            where: { id },
            data: {
                token: newBearerToken,
                updatedAt: new Date()
            }
        });

        log({ module: 'machine-tokens', userId, tokenId: id }, 'Token rotated');

        // Return the new token value
        return reply.send({
            token: {
                id: updated.id,
                name: updated.name,
                value: newBearerToken, // New token value
                expiresAt: updated.expiresAt?.toISOString() || null,
                createdAt: updated.createdAt.toISOString(),
                updatedAt: updated.updatedAt.toISOString(),
            }
        });
    });
}
