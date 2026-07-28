# PR Summary: Implement AI Assistant Backend API (BE-018)

## Overview
This PR implements the server-side infrastructure that powers TruthBounty's intelligent assistant, acting as the orchestration layer between protocol data and external Large Language Models (LLMs). It centralizes prompt management, RAG (Retrieval-Augmented Generation), and usage tracking.

## What Changed
- **Conversation Management:** Added `Conversation` and `Message` models to `prisma/schema.prisma` and implemented CRUD API endpoints in `AiAssistantController`.
- **RAG Integration:** Introduced `RagService` for retrieving verified protocol context.
- **LLM Provider Abstraction:** Created `LlmProviderService` to support multiple providers (OpenAI, Anthropic).
- **Security & Memory:** Added session tracking via JWT scopes and integrated short-term conversation memory limits.
- **Usage Tracking:** Implemented the `AiUsageMetric` model to track token usage and request latency across providers.
- **Documentation:** Added `docs/AI_ARCHITECTURE.md` and `docs/PROMPT_ENGINEERING_GUIDE.md` for AI developers.
- **Refactoring & Cleanup:** 
  - Fixed Prisma V7 datasource configuration URL issue in `schema.prisma`.
  - Fixed syntax compilation errors in `src/jobs/jobs.service.ts`.
  - Removed deprecated `src/modules` folder and updated legacy import paths.

## Testing
- Implemented unit tests in `src/ai-assistant/ai-assistant.service.spec.ts` covering conversation creation and messaging orchestration.
- Verified local Prisma client generation successfully works.

## Closes
- Closes #289
