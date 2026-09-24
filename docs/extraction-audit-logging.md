# Extraction audit logging

Apply `supabase/migration_v26_extraction_audit_logs.sql` before deploying the
application code. The same definitions are included in `supabase/complete_schema.sql`
for new environments.

The logger is enabled by default when both `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are present. Set `PIPELINE_DB_LOGGING=false` only
for local development or an emergency rollback. Database logging is best effort:
an extraction never fails because its audit row cannot be written.

## Pricing configuration

`extraction_stage_runs.estimated_cost_usd` is an estimate, never an invoice.
Override model prices when a provider changes pricing:

```env
PIPELINE_MODEL_COST_RATES_JSON={"openai:gpt-4o-mini":{"inputPerMillion":0.15,"outputPerMillion":0.6},"groq:openai/gpt-oss-20b":{"inputPerMillion":0.1,"outputPerMillion":0.5}}
GOOGLE_VISION_TEXT_COST_PER_IMAGE_USD=0.0015
PIPELINE_DB_LOG_TIMEOUT_MS=1500
```

Unknown models and audio operations remain `NULL` for estimated cost instead
of receiving a fabricated price. Token counts come from provider responses
when supplied. Cloud Vision uses image units rather than tokens.

## OCR mode

The default, `OCR_VISION_MODE=all-gpt`, sends every one-second video frame and
every image slide to local Tesseract and batched GPT Vision concurrently. This
maximises on-screen venue and address coverage. Set
`OCR_VISION_MODE=selective` only for deliberate cost reduction; it restores
the prior confidence-based Cloud Vision/GPT Vision fallback path.

GPT Vision uses `gpt-4o-mini` by default. Set `OPENAI_VISION_MODEL` only when
you intentionally need to override that model.

## Useful queries

```sql
-- Latest runs, cost, and extraction quality
select id, platform, input_url, status, duration_ms, estimated_cost_usd,
       accepted_candidate_count, rejected_candidate_count,
       unresolved_candidate_count, save_failed_candidate_count
from public.extraction_run_summary
order by created_at desc
limit 100;

-- Why a particular candidate was rejected or not saved
select candidate_key, name, decision, decision_reason, confidence,
       evidence_ids, location_evidence_ids
from public.extraction_place_candidates
where run_id = '<pipeline-run-uuid>'
order by created_at;

-- Provider failures, fallbacks, and costly operations
select stage, operation, provider, model, attempt, is_fallback, status,
       duration_ms, input_tokens, output_tokens, estimated_cost_usd,
       error_message
from public.extraction_stage_runs
where run_id = '<pipeline-run-uuid>'
order by started_at;
```

Schedule `select public.purge_extraction_audit_logs(interval '90 days');`
nightly with your Supabase scheduler. The base tables contain only capped,
redacted text and structured metadata; raw media, base64 content, API keys,
cookies, and provider payloads are not recorded.
