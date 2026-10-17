# Runtime configuration reference

Generated from `src/config/runtime-schema.ts`; run `npm run config:generate`.

Staging/production require explicitly supplied deployment settings. All supplied values are validated; empty values and simultaneous aliases are errors. Runtime values are snapshotted once before Nest bootstrap. Restart after configuration changes.

A release file must match `CONTRACT_RELEASE_SHA256`, `CONTRACT_RELEASE_ID`, `CHAIN_ID` and `CONTRACT_RELEASE_DEPLOYMENT_BLOCK`. This boundary pins metadata; the prerequisite canonical-manifest validator owns ABI/event/freshness and network verification.

Legacy `RELEASE_MANIFEST_MAX_AGE_MS` must migrate to `CONTRACT_RELEASE_MAX_AGE_DAYS`; downstream milliseconds are derived. Same-key file precedence is process environment > `.env.local` > `.env`; duplicate assignments inside either file are rejected.

| Variable | Type | Default | Required explicitly when deployed | Aliases (use only one) |
| --- | --- | --- | --- | --- |
| APP_VERSION | non-empty string | dev | no | npm_package_version |
| NODE_ENV | local / development / test / staging / production | development | no | - |
| LOCAL_DEV_MODE | true or false | false | no | STAB_LOCAL_MODE |
| SIWE_ALLOWED_ORIGINS | comma-separated non-empty values | (unset) | no | - |
| CAPABILITY_TOKEN_SIGNING_KEY | non-empty string | (unset) | yes | - |
| ADMIN_AUDIT_RETENTION_DAYS | integer 1..3650 | 365 | no | - |
| SIWE_ALLOWED_DOMAINS | comma-separated non-empty values | (unset) | no | - |
| SIWE_EXPECTED_STATEMENT | non-empty string | (unset) | no | - |
| SIWE_SUPPORTED_CHAIN_IDS | comma-separated Optimism chain IDs | (unset) | no | - |
| OPERATIONS_AUDIT_MAX | integer 1..9007199254740991 | 10000 | no | - |
| INDEXER_MAX_FINALIZED_LAG_BLOCKS | integer 0..9007199254740991 | 150 | no | - |
| INDEXER_MAX_HEAD_AGE_SECONDS | integer 0..9007199254740991 | 120 | no | - |
| INDEXER_RELEASE_ID | non-empty string | (unset) | no | - |
| INDEXER_DEPLOYMENT_BLOCK | non-negative safe integer | (unset) | no | - |
| INDEXER_ARTIFACT_CHECKSUM | 64-character lowercase SHA-256 | (unset) | no | - |
| PUBLIC_STATUS_CACHE_TTL_SECONDS | integer 1..9007199254740991 | 15 | no | - |
| PUBLIC_STATUS_STALE_AFTER_SECONDS | integer 1..9007199254740991 | 120 | no | - |
| PUBLIC_STATUS_WEB_HEALTH_URL | URL (https:, http:) | (unset) | no | - |
| PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS | integer 1..9007199254740991 | 2000 | no | - |
| PUBLIC_STATUS_RATE_LIMIT | integer 1..9007199254740991 | 60 | no | - |
| PUBLIC_STATUS_RATE_WINDOW_SECONDS | integer 1..9007199254740991 | 60 | no | - |
| ABUSE_SIGNALS_ENABLED | true or false | true | no | - |
| ABUSE_SIGNALS_ENFORCEMENT_ENABLED | true or false | false | no | - |
| ABUSE_SIGNALS_SUBJECT_SALT | secret of at least 32 characters | (unset) | no | - |
| ABUSE_SIGNALS_WINDOW_SECONDS | integer 1..9007199254740991 | 300 | no | - |
| ABUSE_SIGNALS_MAX_ACTION_SECONDS | integer 1..9007199254740991 | 900 | no | - |
| ABUSE_SIGNALS_MAX_ACTIONS_PER_SUBJECT | integer 1..9007199254740991 | 3 | no | - |
| ABUSE_SIGNALS_TRUSTED_PROXY_HOPS | integer 0..9007199254740991 | 0 | no | - |
| ABUSE_SIGNALS_SCRAPE_MAX_READS | integer 1..9007199254740991 | 600 | no | - |
| ABUSE_SIGNALS_SCRAPE_MAX_ROUTES | integer 1..9007199254740991 | 40 | no | - |
| ABUSE_SIGNALS_STUFFING_MAX_FAILURES | integer 1..9007199254740991 | 20 | no | - |
| ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_CREDENTIALS | integer 1..9007199254740991 | 5 | no | - |
| ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_SUBJECTS | integer 1..9007199254740991 | 10 | no | - |
| ABUSE_SIGNALS_SPAM_MAX_WRITES | integer 1..9007199254740991 | 30 | no | - |
| ABUSE_SIGNALS_SPAM_MAX_DUPLICATE_PAYLOADS | integer 1..9007199254740991 | 10 | no | - |
| ABUSE_SIGNALS_WEBHOOK_MAX_ENDPOINT_WRITES | integer 1..9007199254740991 | 15 | no | - |
| ABUSE_SIGNALS_WEBHOOK_MAX_SECRET_ROTATIONS | integer 1..9007199254740991 | 5 | no | - |
| ABUSE_SIGNALS_WEBHOOK_MAX_DELIVERIES | integer 1..9007199254740991 | 200 | no | - |
| ABUSE_SIGNALS_STREAM_MAX_CONNECTIONS | integer 1..9007199254740991 | 25 | no | - |
| ABUSE_SIGNALS_STREAM_MAX_SUBSCRIBE_OPS | integer 1..9007199254740991 | 60 | no | - |
| ABUSE_SIGNALS_STREAM_MAX_MESSAGES | integer 1..9007199254740991 | 300 | no | - |
| ABUSE_SIGNALS_SUPPORT_MAX_REQUESTS | integer 1..9007199254740991 | 30 | no | - |
| ABUSE_SIGNALS_SUPPORT_MAX_DUPLICATE_REQUESTS | integer 1..9007199254740991 | 20 | no | - |
| ABUSE_SIGNALS_SUPPORT_MAX_DISTINCT_CONTACTS | integer 1..9007199254740991 | 25 | no | - |
| PORT | integer 1..65535 | 3000 | no | - |
| ALLOWED_ORIGINS | comma-separated non-empty values | (unset) | yes | - |
| TRUSTED_PROXIES | comma-separated non-empty values | (unset) | no | - |
| MAX_PROXY_HOPS | integer 0..16 | 1 | no | - |
| HSTS_MAX_AGE | integer 1..9007199254740991 | 31536000 | no | - |
| DATABASE_URL | URL (postgres:, postgresql:) | (unset) | yes | - |
| DB_HOST | hostname or IP address (without scheme, credentials or port) | localhost | no | DATABASE_HOST |
| DB_PORT | integer 1..65535 | 5432 | no | DATABASE_PORT |
| DB_USERNAME | non-empty string | postgres | no | DATABASE_USER |
| DB_PASSWORD | non-empty string | (unset) | no | DATABASE_PASSWORD |
| DB_DATABASE | non-empty string | truthbounty | no | DB_NAME, DATABASE_NAME |
| DB_SSL | true or false | false | no | DATABASE_SSL |
| DATABASE_SSL_REJECT_UNAUTHORIZED | true or false | true | no | - |
| DATABASE_SYNCHRONIZE | true or false | false | no | - |
| DATABASE_LOGGING | true or false | false | no | - |
| SQLITE_PATH | non-empty string | database.sqlite | no | DATABASE_PATH |
| DB_POOL_MAX | integer 1..1000 | 20 | no | - |
| DB_POOL_IDLE_TIMEOUT | integer 1..9007199254740991 | 30000 | no | - |
| DB_POOL_ACQUIRE_TIMEOUT | integer 1..9007199254740991 | 60000 | no | - |
| DB_POOL_RETRIES | integer 0..100 | 3 | no | - |
| DB_POOL_RETRY_DELAY | integer 1..9007199254740991 | 1000 | no | - |
| REDIS_ENABLED | true or false | true | no | - |
| REDIS_HOST | hostname or IP address (without scheme, credentials or port) | localhost | yes | - |
| REDIS_PORT | integer 1..65535 | 6379 | no | - |
| REDIS_PASSWORD | non-empty string | (unset) | yes | - |
| REDIS_DB | integer 0..15 | 0 | no | - |
| REDIS_TLS | true or false | false | no | - |
| CHAIN_ID | integer 1..9007199254740991 | 11155420 | yes | BLOCKCHAIN_CHAIN_ID, CONTRACT_RELEASE_CHAIN_ID |
| RPC_URL | URL (https:, http:, wss:, ws:) | (unset) | yes | BLOCKCHAIN_RPC_URL, OPTIMISM_RPC_URL |
| BLOCKCHAIN_FALLBACK_RPC_URLS | comma-separated non-empty values | (unset) | no | - |
| BLOCKCHAIN_RPC_TIMEOUT_MS | integer 1..9007199254740991 | 10000 | no | - |
| BLOCKCHAIN_STARTUP_VALIDATION | true or false | true | no | - |
| BLOCKCHAIN_STARTUP_RPC_CHECK | true or false | true | no | - |
| START_BLOCK | integer 0..9007199254740991 | 0 | no | - |
| FINALITY_SAFE_CONFIRMATIONS | integer 1..9007199254740991 | 6 | no | CONFIRMATIONS_SAFE, BLOCKCHAIN_CONFIRMATION_DEPTH |
| FINALITY_FINALIZED_CONFIRMATIONS | integer 1..9007199254740991 | 12 | no | CONFIRMATIONS_FINALIZED, CONFIRMATIONS_REQUIRED, REQUIRED_CONFIRMATIONS |
| CONFIRMATIONS_FULL | integer 1..9007199254740991 | 64 | no | - |
| FINALITY_ALLOWED_CHAIN_IDS | comma-separated non-empty values | 10,11155420 | no | - |
| BLOCKCHAIN_MAX_BLOCKS | integer 1..9007199254740991 | 10000 | no | - |
| BLOCKCHAIN_MAX_EVENTS | integer 1..9007199254740991 | 50000 | no | - |
| BLOCKCHAIN_MAX_REORG_HISTORY | integer 1..9007199254740991 | 1000 | no | - |
| BLOCK_RANGE_PER_BATCH | integer 1..9007199254740991 | 5000 | no | - |
| MAX_RETRY_ATTEMPTS | integer 0..100 | 3 | no | - |
| POLLING_INTERVAL_MS | integer 1..9007199254740991 | 12000 | no | - |
| MIN_BATCH_SIZE_FLOOR | integer 1..9007199254740991 | 1 | no | - |
| ADAPTIVE_FILL_THRESHOLD_BLOCKS | integer 1..9007199254740991 | 10000 | no | - |
| CONTRACT_RELEASE_MANIFEST_PATH | non-empty string | (unset) | yes | - |
| CONTRACT_RELEASE_ID | non-empty string | (unset) | yes | RELEASE_ID |
| CONTRACT_RELEASE_SHA256 | 64-character lowercase SHA-256 | (unset) | yes | - |
| CONTRACT_RELEASE_DEPLOYMENT_BLOCK | integer 0..9007199254740991 | 0 | yes | - |
| CONTRACT_RELEASE_MAX_AGE_DAYS | integer 1..365 | 90 | no | MANIFEST_MAX_AGE_DAYS |
| CONTRACT_RELEASE_STRICT | true or false | true | no | - |
| IPFS_PROVIDER | local / pinata / web3storage | local | no | - |
| IPFS_LOCAL_STORAGE_PATH | non-empty string | data/ipfs | no | - |
| IPFS_GATEWAY_URL | URL (https:, http:) | (unset) | yes | - |
| IPFS_API_URL | URL (https:, http:) | (unset) | yes | - |
| SMTP_HOST | hostname or IP address (without scheme, credentials or port) | (unset) | yes | - |
| SMTP_PORT | integer 1..65535 | 587 | no | - |
| SMTP_USER | non-empty string | (unset) | yes | - |
| SMTP_PASSWORD | non-empty string | (unset) | yes | SMTP_PASS |
| SMTP_FROM | non-empty string | (unset) | yes | EMAIL_FROM, NOTIFICATION_EMAIL_FROM |
| NOTIFICATION_QUEUE_DELAY | integer 0..9007199254740991 | 0 | no | - |
| NOTIFICATION_MAX_RETRIES | integer 0..100 | 5 | no | - |
| NOTIFICATION_RETRY_DELAY | integer 1..9007199254740991 | 2000 | no | - |
| AI_PROVIDER | openai / mock | mock | no | - |
| DEFAULT_LLM_PROVIDER | openai / anthropic | openai | no | - |
| OPENAI_API_KEY | non-empty string | (unset) | no | - |
| ANTHROPIC_API_KEY | non-empty string | (unset) | no | - |
| OPENAI_BASE_URL | URL (https:, http:) | https://api.openai.com/v1 | no | - |
| OPENAI_MODEL | non-empty string | gpt-4o-mini | no | - |
| AI_MAX_PROMPT_LENGTH | integer 1..9007199254740991 | 4000 | no | - |
| AI_MEMORY_WINDOW_MESSAGES | integer 1..9007199254740991 | 10 | no | - |
| AI_MEMORY_WINDOW_TOKEN_BUDGET | integer 1..9007199254740991 | 3000 | no | - |
| AI_CONTEXT_TOP_N | integer 1..9007199254740991 | 5 | no | - |
| AI_CONTEXT_CACHE_TTL | integer 1..9007199254740991 | 900 | no | - |
| AI_CONVO_WINDOW_CACHE_TTL | integer 1..9007199254740991 | 120 | no | - |
| AI_PROVIDER_AVAILABILITY_CACHE_TTL | integer 1..9007199254740991 | 30 | no | - |
| AI_REDACT_BEFORE_STORE | true or false | true | no | - |
| LOG_LEVEL | trace / debug / info / warn / error / fatal / silent | info | no | - |
| METRICS_TOKEN | non-empty string | (unset) | yes | - |
| LOG_REDACT_RPC_URLS | true or false | true | no | - |
| JWT_SECRET | non-empty string | (unset) | yes | - |
| JWT_EXPIRATION | positive duration with s, m, h or d unit | 15m | no | - |
| REFRESH_TOKEN_EXPIRATION | positive duration with s, m, h or d unit | 7d | no | - |
| SIWE_DOMAIN | non-empty string | (unset) | yes | - |
| IDEMPOTENCY_ENABLED | true or false | true | no | - |
| IDEMPOTENCY_TTL | integer 1..9007199254740991 | 86400 | no | - |
| IDEMPOTENCY_KEY_LENGTH | integer 16..256 | 32 | no | - |
| RATE_LIMIT_CLAIMS_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_CLAIMS_LIMIT | integer 1..9007199254740991 | 5 | no | - |
| RATE_LIMIT_VOTES_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_VOTES_LIMIT | integer 1..9007199254740991 | 20 | no | - |
| RATE_LIMIT_DISPUTES_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_DISPUTES_LIMIT | integer 1..9007199254740991 | 3 | no | - |
| RATE_LIMIT_AUTH_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_AUTH_LIMIT | integer 1..9007199254740991 | 5 | no | - |
| RATE_LIMIT_AI_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_AI_LIMIT | integer 1..9007199254740991 | 10 | no | - |
| RATE_LIMIT_AI_STREAM_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_AI_STREAM_LIMIT | integer 1..9007199254740991 | 3 | no | - |
| RATE_LIMIT_DEFAULT_TTL | integer 1..9007199254740991 | 60 | no | - |
| RATE_LIMIT_DEFAULT_LIMIT | integer 1..9007199254740991 | 10 | no | - |
| REALTIME_POLL_INTERVAL_MS | integer 1..9007199254740991 | 1000 | no | - |
| REALTIME_MAX_PUBLISH_BATCH | integer 1..9007199254740991 | 100 | no | - |
| REALTIME_HEARTBEAT_INTERVAL_MS | integer 1..9007199254740991 | 15000 | no | - |
| REALTIME_MAX_BACKLOG | integer 1..9007199254740991 | 1000 | no | - |
| REALTIME_MAX_REPLAY_ROWS | integer 1..9007199254740991 | 5000 | no | - |
| RATE_LIMIT_CLAIMS_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_VOTES_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_DISPUTES_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_AUTH_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_AI_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_AI_STREAM_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| RATE_LIMIT_DEFAULT_BLOCK_DURATION | integer 1..9007199254740991 | (unset) | no | - |
| SYBIL_MIN_CLAIMS_FOR_ACCURACY_SCORE | integer 1..9007199254740991 | 5 | no | - |
| CACHE_CLAIMS_TTL | integer 1..9007199254740991 | 300 | no | - |
| CACHE_GOVERNANCE_TTL | integer 1..9007199254740991 | 3600 | no | - |
| CACHE_REPUTATION_TTL | integer 1..9007199254740991 | 3600 | no | - |
| CACHE_VERSION | non-empty string | v1 | no | - |
| AUTH_NONCE_TTL_MS | integer 1..9007199254740991 | 300000 | no | - |
| SIWE_ORIGIN | URL (https:, http:) | (unset) | no | - |
| SERVICE_API_KEY | non-empty string | (unset) | no | - |
| ADMIN_WALLETS | comma-separated non-empty values | (unset) | no | - |
| DATABASE_SEED | true or false | false | no | - |
| FINALITY_POLICY_STARTUP_VALIDATION | true or false | true | no | - |
| MANIFEST_VALIDATION | true or false | true | no | - |
| CONTRACT_ADDRESS_MANIFEST | non-empty string | (unset) | no | - |
| REWARD_CONTRACT_ADDRESS | non-zero 20-byte EVM address | (unset) | no | - |
| CONTRACT_ADDRESS | non-zero 20-byte EVM address | (unset) | no | - |
| TREASURY_ADDRESS | non-zero 20-byte EVM address | (unset) | no | - |
| VERIFIER_ADDRESS | non-zero 20-byte EVM address | (unset) | no | - |
| FEE_RECIPIENT | non-zero 20-byte EVM address | (unset) | no | - |
| INDEXED_CONTRACTS | JSON array of indexer contracts | [] | no | - |
| NOTIFICATION_EMAIL_PROVIDER | smtp / sendgrid / mailgun | smtp | no | - |
| SENDGRID_API_KEY | non-empty string | (unset) | no | - |
| MAILGUN_API_KEY | non-empty string | (unset) | no | - |
| MAILGUN_DOMAIN | non-empty string | (unset) | no | - |
| FCM_PROJECT_ID | non-empty string | (unset) | no | - |
| FCM_SERVER_KEY | non-empty string | (unset) | no | - |
| WEBHOOK_REQUIRE_HTTPS | true or false | true | no | - |
| WEBHOOK_TIMEOUT_MS | integer 1..9007199254740991 | 10000 | no | - |
| AUDIT_HASH_SECRET | non-empty string | (unset) | yes | - |
| AUDIT_ARCHIVAL_BUCKET | non-empty string | audit-archive | no | - |
| AUDIT_ARCHIVAL_ENABLED | true or false | false | no | - |
| AUDIT_ASYNC_WRITES_ENABLED | true or false | true | no | - |
| AUDIT_BATCH_SIZE | integer 1..9007199254740991 | 50 | no | - |
| AUDIT_LOG_RETENTION_CRON | non-empty string | (unset) | no | - |
| AUDIT_LOG_RETENTION_DAYS | integer 1..9007199254740991 | 365 | no | - |
| AUDIT_PII_RETENTION_DAYS | integer 1..9007199254740991 | 30 | no | - |
| AUDIT_MAX_BATCH_WAIT_MS | integer 1..9007199254740991 | 1000 | no | - |
| AUDIT_METRIC_PREFIX | non-empty string | audit | no | - |
| AUDIT_MAX_API_CALLS | integer 1..9007199254740991 | 100 | no | - |
| AUDIT_MAX_FAILED_LOGINS | integer 1..9007199254740991 | 5 | no | - |
| AUDIT_MAX_PERMISSION_CHANGES | integer 1..9007199254740991 | 3 | no | - |
| AUDIT_SUSPICIOUS_WINDOW_MINUTES | integer 1..9007199254740991 | 15 | no | - |
| BACKUP_STORAGE_DIR | non-empty string | /var/backups/truthbounty-v2 | no | - |
| REBUILD_SCHEMA | non-empty string | (unset) | no | - |
| MAINTENANCE_WINDOW_START | 24-hour HH:mm time | 02:00 | no | - |
| MAINTENANCE_WINDOW_END | 24-hour HH:mm time | 04:00 | no | - |
| WORLDCOIN_ACTION | non-empty string | (unset) | no | - |
| WORLDCOIN_APP_ID | non-empty string | (unset) | no | - |
| WORLDCOIN_VERIFY_BASE_URL | URL (https:, http:) | (unset) | no | - |
| CB_FAILURE_THRESHOLD_DATABASE | integer 1..9007199254740991 | 5 | no | - |
| CB_FAILURE_THRESHOLD_REDIS | integer 1..9007199254740991 | 5 | no | - |
| CB_FAILURE_THRESHOLD_RPC | integer 1..9007199254740991 | 5 | no | - |
| CB_FAILURE_THRESHOLD_IPFS | integer 1..9007199254740991 | 5 | no | - |
| CB_FAILURE_THRESHOLD_QUEUE | integer 1..9007199254740991 | 5 | no | - |
| CB_RESET_MS_DATABASE | integer 1..9007199254740991 | 30000 | no | - |
| CB_RESET_MS_REDIS | integer 1..9007199254740991 | 30000 | no | - |
| CB_RESET_MS_RPC | integer 1..9007199254740991 | 30000 | no | - |
| CB_RESET_MS_IPFS | integer 1..9007199254740991 | 30000 | no | - |
| CB_RESET_MS_QUEUE | integer 1..9007199254740991 | 30000 | no | - |
| DEPENDENCY_TIMEOUT_DATABASE | integer 0..9007199254740991 | 5000 | no | - |
| DEPENDENCY_TIMEOUT_REDIS | integer 0..9007199254740991 | 2000 | no | - |
| DEPENDENCY_TIMEOUT_RPC | integer 0..9007199254740991 | 10000 | no | - |
| DEPENDENCY_TIMEOUT_IPFS | integer 0..9007199254740991 | 15000 | no | - |
| DEPENDENCY_TIMEOUT_QUEUE | integer 0..9007199254740991 | 5000 | no | - |
