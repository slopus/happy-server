import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import EmailPassword from "supertokens-node/recipe/emailpassword";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

export function initSuperTokens() {
    const connectionUri = process.env.SUPERTOKENS_CONNECTION_URI || "https://auth-api.dev.ai-armory.com";
    const apiDomain = process.env.API_DOMAIN || "https://happy-api.dev.ai-armory.com";
    const websiteDomain = process.env.WEBSITE_DOMAIN || "http://15.204.94.200:5175";

    log({ module: 'supertokens' }, `Initializing SuperTokens with:
        - connectionUri: ${connectionUri}
        - apiDomain: ${apiDomain}
        - websiteDomain: ${websiteDomain}
    `);

    supertokens.init({
        framework: "fastify",
        supertokens: {
            connectionURI: connectionUri,
            apiKey: process.env.SUPERTOKENS_API_KEY,
        },
        appInfo: {
            appName: "Happy Server",
            apiDomain,
            websiteDomain,
            apiBasePath: "/auth",
            websiteBasePath: "/auth",
        },
        recipeList: [
            // Third-party (Google OAuth)
            ThirdParty.init({
                signInAndUpFeature: {
                    providers: [
                        {
                            config: {
                                thirdPartyId: "google",
                                clients: [{
                                    clientId: process.env.GOOGLE_CLIENT_ID || "",
                                    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
                                }],
                            },
                        },
                    ],
                },
                override: {
                    functions: (originalImplementation) => {
                        return {
                            ...originalImplementation,
                            signInUp: async function(input) {
                                const response = await originalImplementation.signInUp(input);

                                if (response.status === "OK") {
                                    const { id: supertokensUserId, thirdParty, emails } = response.user;
                                    const email = emails[0] || null;
                                    const authProvider = thirdParty?.[0]?.id || "thirdparty";

                                    log({ module: 'supertokens' }, `Third party sign in/up: ${email}, provider: ${authProvider}`);

                                    // Find or create account
                                    let account = await db.account.findFirst({
                                        where: { supertokensUserId }
                                    });

                                    if (!account && email) {
                                        // Check if account exists with this email
                                        account = await db.account.findFirst({
                                            where: { email }
                                        });

                                        if (account) {
                                            // Link existing account
                                            await db.account.update({
                                                where: { id: account.id },
                                                data: { supertokensUserId, authProvider }
                                            });
                                        }
                                    }

                                    if (!account) {
                                        // Create new account - generate a placeholder publicKey
                                        const crypto = await import("crypto");
                                        const placeholderPublicKey = crypto.randomBytes(32).toString('hex');

                                        account = await db.account.create({
                                            data: {
                                                publicKey: placeholderPublicKey,
                                                supertokensUserId,
                                                email,
                                                authProvider,
                                            }
                                        });

                                        log({ module: 'supertokens' }, `Created new account: ${account.id}`);
                                    }
                                }

                                return response;
                            },
                        };
                    },
                },
            }),

            // Email/Password
            EmailPassword.init({
                override: {
                    functions: (originalImplementation) => {
                        return {
                            ...originalImplementation,
                            signUp: async function(input) {
                                const response = await originalImplementation.signUp(input);

                                if (response.status === "OK") {
                                    const { id: supertokensUserId, emails } = response.user;
                                    const email = emails[0] || null;

                                    log({ module: 'supertokens' }, `Email password sign up: ${email}`);

                                    // Create new account
                                    const crypto = await import("crypto");
                                    const placeholderPublicKey = crypto.randomBytes(32).toString('hex');

                                    await db.account.create({
                                        data: {
                                            publicKey: placeholderPublicKey,
                                            supertokensUserId,
                                            email,
                                            authProvider: "emailpassword",
                                        }
                                    });

                                    log({ module: 'supertokens' }, `Created account for email: ${email}`);
                                }

                                return response;
                            },
                        };
                    },
                },
            }),

            // Session management
            Session.init({
                override: {
                    functions: (originalImplementation) => {
                        return {
                            ...originalImplementation,
                            createNewSession: async function(input) {
                                // Get the account ID linked to this SuperTokens user
                                const account = await db.account.findFirst({
                                    where: { supertokensUserId: input.userId }
                                });

                                // Store account ID in session payload for easy access
                                if (account) {
                                    input.accessTokenPayload = {
                                        ...input.accessTokenPayload,
                                        accountId: account.id,
                                    };
                                }

                                return originalImplementation.createNewSession(input);
                            },
                        };
                    },
                },
            }),
        ],
    });

    log({ module: 'supertokens' }, 'SuperTokens initialized successfully');
}

export { supertokens, Session, ThirdParty, EmailPassword };
