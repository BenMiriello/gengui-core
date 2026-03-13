/**
 * Isolated test to identify event loop blocking during server startup.
 *
 * Run each test individually to identify the blocking operation:
 *   npx tsx tools/test-blocking.ts redis-single
 *   npx tsx tools/test-blocking.ts redis-parallel
 *   npx tsx tools/test-blocking.ts worker-start
 *   npx tsx tools/test-blocking.ts sync-orphaned
 *   npx tsx tools/test-blocking.ts all
 */

import { Redis } from 'ioredis';
import { detect } from 'async-sema';

const BLOCK_THRESHOLD_MS = 100;

async function monitorBlocking(testName: string, testFn: () => Promise<void>) {
  console.log(`\n=== Running: ${testName} ===`);

  const detector = detect();
  const blocks: Array<{ lagMs: number; timestamp: number }> = [];

  detector.on('block', (lagMs) => {
    blocks.push({ lagMs, timestamp: Date.now() });
    console.log(`⚠️  BLOCKED for ${lagMs}ms`);
  });

  const start = Date.now();
  await testFn();
  const duration = Date.now() - start;

  detector.clear();

  console.log(`✓ Completed in ${duration}ms`);

  if (blocks.length > 0) {
    console.log(`\n🔴 ${blocks.length} blocking event(s) detected:`);
    blocks.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.lagMs}ms at +${b.timestamp - start}ms`);
    });
  } else {
    console.log('✅ No blocking detected');
  }

  return { blocks, duration };
}

async function testRedisSingle() {
  let subscriber: Redis | null = null;

  try {
    await monitorBlocking('Single Redis Subscriber', async () => {
      subscriber = new Redis(process.env.REDIS_URL!);
      await subscriber.subscribe('test:blocking:channel');
    });
  } finally {
    if (subscriber) {
      await subscriber.quit();
    }
  }
}

async function testRedisParallel() {
  const subscribers: Redis[] = [];

  try {
    await monitorBlocking('5 Parallel Redis Subscribers', async () => {
      const channels = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5'];

      await Promise.all(
        channels.map(async (channel) => {
          const sub = new Redis(process.env.REDIS_URL!);
          subscribers.push(sub);
          await sub.subscribe(`test:blocking:${channel}`);
        })
      );
    });
  } finally {
    await Promise.all(subscribers.map(s => s.quit()));
  }
}

async function testWorkerStart() {
  try {
    await monitorBlocking('Worker Start Sequence', async () => {
      const { documentAnalysisWorker } = await import('../src/jobs/workers/document-analysis.js');
      await documentAnalysisWorker.start();
      await documentAnalysisWorker.stop();
    });
  } catch (error) {
    console.error('Worker start failed:', error);
  }
}

async function testSyncOrphanedActivities() {
  try {
    await monitorBlocking('syncOrphanedActivities DB Query', async () => {
      const { activityService } = await import('../src/services/activity.service.js');
      await activityService.syncOrphanedActivities();
    });
  } catch (error) {
    console.error('syncOrphanedActivities failed:', error);
  }
}

async function testAllSequential() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Running ALL tests sequentially to identify blocker     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await testRedisSingle();
  await new Promise(r => setTimeout(r, 500));

  await testRedisParallel();
  await new Promise(r => setTimeout(r, 500));

  await testWorkerStart();
  await new Promise(r => setTimeout(r, 500));

  await testSyncOrphanedActivities();

  console.log('\n=== All tests completed ===');
}

const testMap: Record<string, () => Promise<void>> = {
  'redis-single': testRedisSingle,
  'redis-parallel': testRedisParallel,
  'worker-start': testWorkerStart,
  'sync-orphaned': testSyncOrphanedActivities,
  'all': testAllSequential,
};

const testName = process.argv[2] || 'all';
const testFn = testMap[testName];

if (!testFn) {
  console.error(`Unknown test: ${testName}`);
  console.log('Available tests:', Object.keys(testMap).join(', '));
  process.exit(1);
}

testFn()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
