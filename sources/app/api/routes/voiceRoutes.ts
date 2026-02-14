import { z } from "zod";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { db } from "@/storage/db";

// RevenueCat v2 GET /customers/{id}/subscriptions responses:
// Success: { items: [{ status: 'active', gives_access: true }] }
// No sub:  { items: [] }
// Not found (404): { type: 'resource_missing', message: '...' }

const DEFAULT_FREE_TRIAL_LIMIT = parseInt(process.env.VOICE_FREE_TRIAL_LIMIT || '3');

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string()
            }),
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    token: z.string().optional(),
                    agentId: z.string().optional(),
                    freeTrialsRemaining: z.number().optional()
                }),
                400: z.object({
                    allowed: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        // Get user's current voice conversation count
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { voiceConversationCount: true, voiceConversationFreeLimitOverride: true }
        });

        if (!account) {
            log({ module: 'voice' }, `User ${userId} not found`);
            return reply.code(400).send({ allowed: false, error: 'User not found' });
        }

        const limit = account.voiceConversationFreeLimitOverride ?? DEFAULT_FREE_TRIAL_LIMIT;
        const count = account.voiceConversationCount ?? 0;
        const hasFreeTrial = count < limit;

        log({ module: 'voice' }, `User ${userId} voice usage: ${count}/${limit}, hasFreeTrial: ${hasFreeTrial}`);

        // If user has free trials, allow without checking subscription
        if (hasFreeTrial) {
            log({ module: 'voice' }, `User ${userId} has free trial remaining (${count}/${limit})`);
        } else if (process.env.VOICE_REQUIRE_SUBSCRIPTION !== 'false') {
            // No free trials left, check subscription
            const revenueCatSecretKey = process.env.REVENUECAT_API_KEY;
            const revenueCatProjectId = process.env.REVENUECAT_PROJECT;

            if (!revenueCatSecretKey || !revenueCatProjectId) {
                log({ module: 'voice' }, `Missing RevenueCat config - secretKey: ${!!revenueCatSecretKey}, projectId: ${!!revenueCatProjectId}`);
                return reply.code(400).send({
                    allowed: false,
                    error: 'RevenueCat not configured'
                });
            }

            const revenueCatUrl = `https://api.revenuecat.com/v2/projects/${revenueCatProjectId}/customers/${userId}/subscriptions`;
            log({ module: 'voice' }, `Checking RevenueCat subscription: ${revenueCatUrl}`);

            const revenueCatSubscriptionCheckResponse = await fetch(revenueCatUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${revenueCatSecretKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const responseText = await revenueCatSubscriptionCheckResponse.text();
            log({ module: 'voice' }, `RevenueCat response status: ${revenueCatSubscriptionCheckResponse.status}, body: ${responseText}`);

            if (!revenueCatSubscriptionCheckResponse.ok) {
                log({ module: 'voice' }, `RevenueCat check failed for user ${userId}: ${revenueCatSubscriptionCheckResponse.status}`);
                return reply.send({
                    allowed: false,
                    agentId
                });
            }

            const revenueCatData = JSON.parse(responseText) as any;
            const hasActiveSubscription = revenueCatData.items?.some((sub: any) => sub.status === 'active');

            if (!hasActiveSubscription) {
                log({ module: 'voice' }, `User ${userId} does not have active subscription and no free trials left`);
                return reply.send({
                    allowed: false,
                    agentId
                });
            }

            log({ module: 'voice' }, `User ${userId} has active subscription`);
        } else {
            log({ module: 'voice' }, `Bypassing subscription check - VOICE_REQUIRE_SUBSCRIPTION=false`);
        }

        // Check if 11Labs API key is configured
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            log({ module: 'voice' }, 'Missing 11Labs API key');
            return reply.code(400).send({ allowed: false, error: 'Missing 11Labs API key on the server' });
        }

        // Get 11Labs conversation token
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
            {
                method: 'GET',
                headers: {
                    'xi-api-key': elevenLabsApiKey,
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.ok) {
            log({ module: 'voice' }, `Failed to get 11Labs token for user ${userId}`);
            return reply.code(400).send({
                allowed: false,
                error: `Failed to get 11Labs token for user ${userId}`
            });
        }

        const elevenLabsData = await response.json() as any;
        const elevenLabsToken = elevenLabsData.token;

        // Increment voice conversation count
        await db.account.update({
            where: { id: userId },
            data: { voiceConversationCount: { increment: 1 } }
        });

        log({ module: 'voice' }, `Voice token issued for user ${userId}`);
        return reply.send({
            allowed: true,
            token: elevenLabsToken,
            agentId,
            freeTrialsRemaining: hasFreeTrial ? limit - count - 1 : undefined
        });
    });
}