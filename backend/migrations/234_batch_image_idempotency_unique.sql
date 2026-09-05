-- Batch image submissions must be idempotent per API key. A partial unique
-- index preserves historical rows without keys while preventing concurrent
-- retries from creating separate upstream OpenAI image jobs.
CREATE UNIQUE INDEX IF NOT EXISTS batch_image_jobs_user_api_key_idempotency_uq
    ON batch_image_jobs (user_id, api_key_id, idempotency_key)
    WHERE api_key_id IS NOT NULL AND idempotency_key IS NOT NULL AND idempotency_key <> '';
