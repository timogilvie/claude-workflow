# Knowledge Map Update Prompt

ROLE: Technical documentation specialist extracting key insights for future reference.

TASK: Review investigation and flow mapping documents. Extract 3-5 crucial insights for future developers.

FORMAT:
- Each insight: 1-2 lines maximum
- Include reference to detailed documentation file
- Focus on patterns, conventions, architectural decisions
- Avoid feature-specific details unless they reveal broader patterns

EXAMPLE ENTRIES:
- auth-service: JWT with Redis sessions, 15min expiry, refresh via /api/auth/refresh [details: features/auth-flow-2024-01.md]
- All API errors use AppError class with structured logging to CloudWatch [details: features/error-handling-2024-01.md]
- Database migrations use TypeORM with naming convention: timestamp-description.ts [details: features/db-investigation-2024-02.md]
