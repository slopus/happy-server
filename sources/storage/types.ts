// Prisma JSON field type mappings
// These types tell Prisma what TypeScript types to use for JSON columns
import type {
    SessionMessageContent as SharedSessionMessageContent,
    UpdateBody as SharedUpdateBody,
    UsageReport as SharedUsageReport
} from 'happy-api-client';

declare global {
    namespace PrismaJson {
        // Direct imports from shared package for Prisma JSON columns
        type SessionMessageContent = SharedSessionMessageContent;
        type UsageReportData = SharedUsageReport;
        type UpdateBody = SharedUpdateBody;
    }
}

// The file MUST be a module! 
export { };