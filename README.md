# GenGui Core Service

Backend API service for GenGui media generation platform.

## Local Development Setup

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- AWS credentials (for S3 access)

### First-Time Setup

1. **Start infrastructure services:**
   ```bash
   docker compose up -d
   ```
   This starts:
   - PostgreSQL on port 5433
   - Redis on port 6379

2. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` with your AWS credentials:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `S3_BUCKET`

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Run database migrations:**
   ```bash
   npm run db:push
   ```

5. **Start core service:**
   ```bash
   npm run dev
   ```
   Core runs on port 3000 with hot-reload.

### Email Configuration (Optional)

By default, verification URLs are logged to console in development. For full email testing:

**Option 1: Mailhog (recommended)**
```bash
brew install mailhog
mailhog
```
Then add to `.env`:
```
SMTP_HOST=localhost
SMTP_PORT=1025
```
View emails at http://localhost:8025

**Option 2: Console logging (default)**
No configuration needed. Verification URLs appear in terminal output.

**Production:**
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` in `.env`. Optional: `SMTP_USER`, `SMTP_PASSWORD` for auth.

### Subsequent Startups

```bash
# Ensure docker services are running
docker compose up -d

# Start core (in separate terminal)
npm run dev
```

## What's Running

When core starts, it launches these workers in a single Node process:

- **HTTP Server** (Express) - REST API endpoints
- **Generation Listener** - Redis pub/sub for real-time generation events
- **Generation Queue Consumer** - Processes generation status updates (primary fast path)
- **Thumbnail Queue Consumer** - Creates 128px thumbnails for images
- **Job Reconciliation Service** - Every 5s, polls RunPod API for stuck jobs (backup path, RunPod mode only)
- **Redis Reconciliation Job** - Every 2 mins, recovers stuck Redis-based generations (local mode only)

## Project Structure

```
core/
├── src/
│   ├── config/          # Database, middleware setup
│   ├── jobs/            # Cron jobs (reconciliation, etc.)
│   ├── models/          # Database schema (Drizzle ORM)
│   ├── routes/          # API endpoints
│   ├── services/        # Business logic, queue consumers
│   ├── scripts/         # One-off scripts (migrations, backfills)
│   └── utils/           # Helpers, logger, errors
├── docker-compose.yml   # Local postgres & redis
└── drizzle.config.ts    # Database migrations config
```

## Available Commands

```bash
npm run dev              # Start with hot-reload
npm run build            # Compile TypeScript
npm start                # Run production build
npm run db:push          # Push schema changes to DB
npm run db:migrate       # Run migrations
npm run db:seed          # Insert test user

# Docker
npm run docker:up        # Start docker services
npm run docker:down      # Stop docker services
npm run docker:logs      # Stream container logs
```

## Stopping Services

```bash
# Stop core: Ctrl+C in terminal

# Stop docker services
docker compose down

# Stop and remove volumes (DELETES DATA)
docker compose down -v
```

## Troubleshooting

### "Redis connection failed"
- Run `docker ps` - ensure `gengui-redis` is running
- Check `REDIS_URL` in `.env` matches `redis://localhost:6379`
- Try: `docker compose restart redis`

### "Database connection failed"
- Run `docker ps` - ensure `gengui-postgres` is running
- Check `DB_PORT` is `5433` (not 5432)
- Try: `docker compose restart postgres`

### "Thumbnails not generating"
- Redis must be running (thumbnails use Redis queue)
- Check core logs for thumbnail processor errors
- Run backfill script: `npx tsx src/scripts/tmp/backfill-thumbnails.ts`

### "S3 upload failed"
- Verify AWS credentials in `.env` are correct
- Check S3 bucket exists and has proper permissions
- Ensure IAM user has `s3:PutObject` and `s3:GetObject` permissions

### "Job stuck in 'queued' or 'processing'"

**Local Mode (ENABLE_RUNPOD=false):**
- Check worker is running and connected to Redis
- Check Redis logs: `docker compose logs redis`
- Verify worker logs for errors

**RunPod Mode (ENABLE_RUNPOD=true):**
- Check job reconciliation service is running (logs show "Job reconciliation service started")
- Verify RunPod credentials are correct
- Check RunPod dashboard for worker status
- Wait 5-27s for reconciliation service to detect and retry
- Check core logs for reconciliation activity

## Environment Variables

See `.env.example` for all configuration options.

**Required:**
- `REDIS_URL` - Redis connection string
- `DB_*` - Database credentials
- `AWS_*` - AWS credentials and S3 bucket

**Optional:**
- `PORT` - HTTP server port (default: 3000)
- `LOG_LEVEL` - Logging level (default: info)
- `NODE_ENV` - Environment (development/production)

**RunPod Integration (for serverless GPU workers):**
- `ENABLE_RUNPOD` - Set to `true` to use RunPod serverless workers (default: `false`)
- `RUNPOD_API_KEY` - RunPod API key (required if `ENABLE_RUNPOD=true`)
- `RUNPOD_ENDPOINT_ID` - RunPod endpoint ID (required if `ENABLE_RUNPOD=true`)

### Worker Modes

The system supports two worker deployment modes:

**Local Mode** (`ENABLE_RUNPOD=false` or not set):
- Worker runs locally in **polling mode** (continuous process)
- Jobs submitted to Redis queue via `redis.addJob()`
- Redis-based reconciliation recovers stuck jobs
- Use for: Local dev on Mac + Linux PC worker

**RunPod Mode** (`ENABLE_RUNPOD=true`):
- Worker runs on RunPod Serverless in **handler mode** (per-job invocation)
- Jobs submitted to RunPod API with per-job timeout (20s for zit-basic)
- Job reconciliation service polls RunPod API every 5s for failures
- Auto-scaling: 1 worker per queued job (REQUEST_COUNT=1)
- Use for: Remote dev and production

## Production Notes

For production deployment:

1. **Database & Cache:**
   - Use managed Redis (Upstash, ElastiCache, etc.) - Workers need access from RunPod
   - Use managed PostgreSQL (RDS, Supabase, etc.)

2. **Worker Deployment:**
   - Deploy inference worker to RunPod Serverless (see `inference-worker/README.md`)
   - Set `ENABLE_RUNPOD=true` and configure RunPod credentials
   - Configure endpoint: REQUEST_COUNT=1, idle=1s, max workers=10

3. **Security:**
   - Use secrets manager (AWS Secrets Manager) for credentials
   - Enable SSL/TLS for all connections (Redis with `rediss://`, Postgres with SSL)
   - Ensure RunPod workers can access Redis and S3

4. **Monitoring:**
   - Set up application monitoring (CloudWatch, Sentry)
   - Monitor RunPod costs and worker utilization
   - Track reconciliation service metrics (stuck jobs, retries)

5. **Optional Optimizations:**
   - Consider moving thumbnail generation to Lambda
   - Scale Core API horizontally (job reconciliation is safe for multi-instance)
