# AI Architecture

## Overview
The AI Assistant Backend API serves as the orchestration layer between TruthBounty's verified protocol data and external language models (LLMs). It centralizes prompt management, RAG (Retrieval-Augmented Generation), and usage tracking.

## Components
1. **Conversation Management**: Handles storing and retrieving conversation history. Ensure continuity across sessions.
2. **RAG Service**: Retrieves context from verified sources (e.g. database claims, governance proposals, protocol docs).
3. **LLM Provider**: Abstracted interface to communicate with OpenAI, Anthropic, or future model providers. Configurable via environment variables.
4. **Security & Validation**: Checks for prompt injections, enforces rate limits, and scopes access to authenticated users.
5. **Usage Tracking**: Monitors token usage, latency, and provider utilization for analytics.

## Data Flow
1. User sends message -> API Gateway -> AI Assistant Controller.
2. AI Assistant Service retrieves conversation history (up to 10 previous messages for short-term memory).
3. RAG Service retrieves relevant protocol context based on user query.
4. System prompt, context, and conversation history are combined.
5. The payload is sent to the LLM Provider Service.
6. The LLM Provider returns the response, which is saved to the database.
7. Usage metrics are logged asynchronously.
8. API response is returned to the client.
