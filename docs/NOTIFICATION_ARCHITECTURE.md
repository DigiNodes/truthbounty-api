# Notification & Event Delivery Architecture

## Overview
The Notification & Event Delivery API serves as the central communication backbone for the TruthBounty ecosystem. It handles real-time and asynchronous notifications across all platform modules (claims, verifications, disputes, governance, rewards).

## Core Components

### 1. Event Queue
Built on **BullMQ (Redis)**, ensuring fault-tolerant, asynchronous processing of events.
- **Queue Name**: `notifications`
- **Retry Mechanism**: Exponential backoff (max 5 attempts, delays starting at 2s, 4s, 8s, 16s).

### 2. Preference Engine
Users define their notification preferences (`NotificationPreference` entity):
- **Channels**: `IN_APP`, `EMAIL`, `PUSH`, `WEBHOOK`
- **Categories**: `CLAIM`, `VERIFICATION`, `DISPUTE`, `GOVERNANCE`, `REWARD`, etc.
- **Quiet Hours & Digest Mode**: Settings stored for intelligent delivery windows.

### 3. Delivery Tracking
The `Notification` entity tracks the lifecycle of every generated event:
- `QUEUED`, `DELIVERED`, `FAILED`, `READ`, `DISMISSED`
- Includes retry counts and detailed metadata for auditability.

### 4. Metrics & Monitoring
Accessible via `GET /notifications/metrics` to expose:
- Delivery success rate
- Total processed notifications
- Queued / Failed events

## Future Extensibility
The modular architecture permits drop-in integrations for SMS, Slack, Discord, Telegram, and AI-generated summaries without modifying the core queue processor.
