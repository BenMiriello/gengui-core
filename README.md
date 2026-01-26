# GenGui Core Service

Backend API service for GenGui media generation platform.

## Local Development Setup

### Prerequisites
- Node.js 20+
- **Native Mac Stack (Recommended):**
  - Postgres.app (https://postgresapp.com)
  - Homebrew Redis (`brew install redis`)
- **OR Docker Stack (Alternative):**
  - Docker & Docker Compose

### Development Stacks

Two setups available - choose one:

#### Option 1: Native Mac Stack (Recommended for Dev)

**Why:** Faster startup, native performance, persistent across restarts

1. **Install Postgres.app:**
   - Download from https://postgresapp.com
   - Open Postgres.app and initialize (creates database on port 5432)

2. **Install and start Redis:**
   ```bash
   brew install redis
   brew services start redis
   ```

3. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` - verify these settings:
   - `DB_PORT=5432`
   - `REDIS_URL=redis://127.0.0.1:6379`
   - Add your AWS credentials

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Run database migrations:**
   ```bash
   npm run db:migrate
   ```

6. **Start core service:**
   ```bash
   npm run dev
   ```
   Core runs on port 3000 with hot-reload.

#### Option 2: Docker Stack (Deployment/Testing)

**Why:** Complete isolated stack, identical to production, good for CI/CD

**Ports:** Uses different ports to avoid conflicts with native setup
- Postgres: 5434 (instead of 5432)
- Redis: 6380 (instead of 6379)
- Core API: 3001 (instead of 3000)

1. **Copy environment file:**
   ```bash
   cp .env.docker.example .env
   ```
   Edit `.env` with your AWS and Gemini credentials.

2. **Start all services:**
   ```bash
   docker-compose up -d
   ```
   This starts Postgres, Redis, AND the Core API in containers.

3. **View logs:**
   ```bash
   docker-compose logs -f core
   ```

4. **Run migrations (first time only):**
   ```bash
   docker-compose exec core npm run db:migrate
   ```

**Access:**
- API: http://localhost:3001
- Postgres: localhost:5434
- Redis: localhost:6380

### GrowthBook (Feature Flags)

GrowthBook provides feature flags and A/B testing. Required for provider switching.

```bash
# Start MongoDB + GrowthBook
docker-compose up -d mongodb growthbook

# Stop
docker-compose down mongodb growthbook
```

**Access:**
- Admin UI: http://localhost:3200
- API: http://localhost:3100

**First run:** First visitor creates admin account. Create SDK Connection, copy client key to `.env`:
```
GROWTHBOOK_API_HOST=http://localhost:3100
GROWTHBOOK_CLIENT_KEY=sdk-...
```

**Current flags:** `image_provider` (gemini/runpod/local)

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

**Native Mac Stack:**
```bash
# Services auto-start on boot (Postgres.app, Redis via brew services)
npm run dev
```

**Docker Stack:**
```bash
docker-compose up -d  # Starts all services including core API
```

## What's Running

When core starts, it launches these workers in a single Node process:

- **HTTP Server** (Express) - REST API endpoints
- **Generation Listener** - Redis pub/sub for real-time generation events
- **Generation Queue Consumer** - Processes generation status updates (primary fast path)
- **Thumbnail Queue Consumer** - Creates 128px thumbnails for images
- **Job Reconciliation Service** - Every 5s, polls RunPod API for stuck jobs (backup path, RunPod mode only)
- **Redis Reconciliation Job** - Every 2 mins, recovers stuck Redis-based generations (local mode only)

## Redis Architecture

**Critical Rule:** Blocking operations (XREADGROUP with BLOCK, Pub/Sub subscribe) MUST use dedicated Redis clients, never the shared client. Blocking the shared client causes 6-8 second delays across the entire application.

### Type-Safe Pattern

The codebase enforces this rule at compile-time:

- **ProducerStreams** - Shared client, NO `consume()` method (add, ack, metrics only)
- **ConsumerStreams** - Dedicated client, HAS `consume()` method
- **BlockingConsumer** - Base class that auto-creates dedicated client

```typescript
// ✅ Producers use shared client
import { redisStreams } from './redis-streams';
await redisStreams.add('my-stream', { data: 'value' });

// ❌ This produces a TypeScript compile error
await redisStreams.consume('my-stream', 'group', 'consumer');
// Error: Property 'consume' does not exist on type 'ProducerStreams'

// ✅ Consumers extend BlockingConsumer
class MyConsumer extends BlockingConsumer {
  constructor() {
    super('my-consumer-name');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('my-stream', 'my-group');
  }

  protected async consumeLoop() {
    while (this.isRunning) {
      const msg = await this.streams.consume('my-stream', 'my-group', 'consumer', { block: 2000 });
      if (msg) {
        await this.handleMessage(msg);
        await this.streams.ack('my-stream', 'my-group', msg.id);
      }
    }
  }
}
```

### Hybrid Pattern (Consume + Produce)

When a consumer also produces messages, use BOTH clients:

```typescript
class MyHybridConsumer extends BlockingConsumer {
  protected async consumeLoop() {
    const msg = await this.streams.consume(...);  // Dedicated client

    // Process message...

    // Produce to another stream using shared client
    await sharedRedisStreams.add('output-stream', { result: 'value' });

    await this.streams.ack(...);  // Dedicated client
  }
}
```

### For Pub/Sub

Use the dedicated subscriber client:

```typescript
import { redis } from './redis';

const subscriber = redis.getSubscriber();  // Dedicated subscriber
await subscriber.psubscribe('my-pattern:*');
subscriber.on('pmessage', (pattern, channel, message) => {
  // Handle message
});
```

**Files:**
- `src/lib/blocking-consumer.ts` - Base class for all consumers
- `src/services/redis-streams.ts` - ProducerStreams / ConsumerStreams split
- `src/services/redis.ts` - Shared client + dedicated subscriber

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
├── docker-compose.yml   # Complete Docker stack (alternative to native)
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

**Native Mac Stack:**
```bash
# Stop core: Ctrl+C in terminal
# Postgres.app and Redis keep running (persistent)

# To stop Redis:
brew services stop redis
```

**Docker Stack:**
```bash
# Stop all services
docker-compose down

# Stop and remove volumes (DELETES DATA)
docker-compose down -v
```

## Troubleshooting

### "Redis connection failed"

**Native Stack:**
- Check if Redis is running: `brew services list | grep redis`
- Start Redis: `brew services start redis`
- Verify `.env` has `REDIS_URL=redis://127.0.0.1:6379`

**Docker Stack:**
- Check containers: `docker-compose ps`
- Restart: `docker-compose restart redis`
- Check logs: `docker-compose logs redis`

### "Database connection failed"

**Native Stack:**
- Check Postgres.app is running (elephant icon in menu bar)
- Verify `.env` has `DB_PORT=5432`
- Test connection: `psql -h localhost -p 5432 -U gengui -d gengui_media`

**Docker Stack:**
- Check containers: `docker-compose ps`
- Restart: `docker-compose restart postgres`
- Check logs: `docker-compose logs postgres`

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

**Database Pool (tune for prod):**
- `DB_POOL_MAX` - Max connections (default: 5 dev, 10 prod)
- `DB_IDLE_TIMEOUT` - Close idle connections after N seconds (default: 20)
- `DB_CONNECT_TIMEOUT` - Connection timeout seconds (default: 10 dev, 5 prod)

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
