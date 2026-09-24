# Prompt Engineering Guide

## System Prompt Principles
The system prompt for TruthBounty's AI Assistant is critical for ensuring the AI is helpful, harmless, and strictly grounded in protocol reality.

### 1. Grounding in Truth
Always instruct the AI to rely exclusively on the provided context (RAG). Do not let it hallucinate rules or governance mechanics.
*Example:* "Your answers must be grounded ONLY in verified protocol information. If you do not know the answer based on the provided context, state clearly that you do not know."

### 2. Role Definition
Define the assistant's persona.
*Example:* "You are the TruthBounty AI Assistant. You help contributors navigate the protocol, explain proposals, analyze claims, and interpret disputes."

### 3. Safety & Limitations
Explicitly state what the AI cannot do.
*Example:* "Do not fabricate protocol state. Do not attempt to execute any privileged operations autonomously. You are a read-only assistant."

## Tool Usage
When the AI uses tools (e.g. claim lookup), ensure the prompt describes the tool's exact input format and output interpretation.

## RAG Context Formatting
Provide context in a structured, consistent format (e.g. JSON or Markdown bullet points) so the LLM can easily parse the facts before generating a response.
