import { z } from "zod";
import { type Fastify } from "../types";
import { log } from "@/utils/log";

/**
 * Voice routes for ElevenLabs Conversational AI integration.
 *
 * Supports two modes:
 * 1. Server credentials (default): Uses ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID env vars
 * 2. User credentials: Client provides customAgentId and customApiKey in the request
 *
 * In development mode (ENV=dev), RevenueCat subscription check is skipped.
 */
export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                revenueCatPublicKey: z.string().optional(),
                // Custom ElevenLabs credentials (when user provides their own)
                customAgentId: z.string().optional(),
                customApiKey: z.string().optional()
            }),
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    token: z.string().optional(),
                    agentId: z.string().optional()
                }),
                400: z.object({
                    allowed: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { revenueCatPublicKey, customAgentId, customApiKey } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ENV === 'dev';

        // Production requires RevenueCat key
        if (!isDevelopment && !revenueCatPublicKey) {
            log({ module: 'voice' }, 'Production environment requires RevenueCat public key');
            return reply.code(400).send({
                allowed: false,
                error: 'RevenueCat public key required'
            });
        }

        // Check subscription in production
        if (!isDevelopment && revenueCatPublicKey) {
            const response = await fetch(
                `https://api.revenuecat.com/v1/subscribers/${userId}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${revenueCatPublicKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                log({ module: 'voice' }, `RevenueCat check failed for user ${userId}: ${response.status}`);
                return reply.send({
                    allowed: false
                });
            }

            const data = await response.json() as any;
            const proEntitlement = data.subscriber?.entitlements?.active?.pro;

            if (!proEntitlement) {
                log({ module: 'voice' }, `User ${userId} does not have active subscription`);
                return reply.send({
                    allowed: false
                });
            }
        }

        // Determine which credentials to use: user-provided or server defaults
        const useCustomCredentials = customAgentId && customApiKey;

        let elevenLabsApiKey: string | undefined;
        let agentId: string | undefined;

        if (useCustomCredentials) {
            // User provided their own ElevenLabs credentials
            log({ module: 'voice' }, `Using custom ElevenLabs credentials for user ${userId}`);
            elevenLabsApiKey = customApiKey;
            agentId = customAgentId;
        } else {
            // Use server's default credentials
            elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
            agentId = process.env.ELEVENLABS_AGENT_ID;

            if (!elevenLabsApiKey) {
                log({ module: 'voice' }, 'Missing ELEVENLABS_API_KEY environment variable');
                return reply.code(400).send({ allowed: false, error: 'Voice not configured on server (missing API key)' });
            }

            if (!agentId) {
                log({ module: 'voice' }, 'Missing ELEVENLABS_AGENT_ID environment variable');
                return reply.code(400).send({ allowed: false, error: 'Voice not configured on server (missing agent ID)' });
            }
        }

        // Get 11Labs conversation token (for WebRTC connections)
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
            const errorText = await response.text();
            log({ module: 'voice' }, `Failed to get 11Labs token: ${response.status} ${errorText}`);

            // Parse error for better user feedback
            let errorDetail = 'Failed to get voice token from ElevenLabs';
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.detail?.message) {
                    errorDetail = errorJson.detail.message;
                } else if (errorJson.detail?.status) {
                    errorDetail = `ElevenLabs error: ${errorJson.detail.status}`;
                }
            } catch {
                // Use default error message
            }

            return reply.code(400).send({
                allowed: false,
                error: errorDetail
            });
        }

        const data = await response.json() as any;
        const token = data.token;

        if (!token) {
            log({ module: 'voice' }, 'ElevenLabs returned empty token');
            return reply.code(400).send({
                allowed: false,
                error: 'ElevenLabs returned invalid response'
            });
        }

        log({ module: 'voice' }, `Voice token issued for user ${userId}`);
        return reply.send({
            allowed: true,
            token,
            agentId
        });
    });
}
