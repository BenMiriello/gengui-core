const Redis = require('ioredis');

console.log('Testing Redis connection...');

const client = new Redis('redis://127.0.0.1:6379', {
  enableOfflineQueue: false, // Disable queueing
  lazyConnect: false,
});

client.on('connect', () => console.log('Connected'));
client.on('ready', () => console.log('Ready'));
client.on('error', (err) => console.error('Error:', err));

async function test() {
  console.log('\n=== Running 5 test operations ===\n');

  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      await client.set(`test:${i}`, 'value');
      const elapsed = Date.now() - start;
      console.log(`SET test:${i} - ${elapsed}ms`);
    } catch (err) {
      console.error(`SET test:${i} - ERROR:`, err.message);
    }
  }

  console.log('\n=== Testing xadd ===\n');
  const start = Date.now();
  try {
    await client.xadd('test-stream', '*', 'field', 'value');
    console.log(`XADD - ${Date.now() - start}ms`);
  } catch (err) {
    console.error('XADD ERROR:', err.message);
  }

  await client.quit();
  console.log('\nTest complete');
  process.exit(0);
}

setTimeout(test, 1000);
