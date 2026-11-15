import { randomUUID } from 'node:crypto';

const testRedis = async () => {
  let closeRedis: (() => Promise<void>) | undefined;
  try {
    const redisConfig = await import('../config/redis');
    closeRedis = redisConfig.closeRedis;
    const key = `medsync:test:${randomUUID()}`;
    await redisConfig.redis.set(key, 'Redis Connected', 'EX', 60);
    const result = await redisConfig.redis.get(key);
    if (result !== 'Redis Connected') {
      throw new Error('Redis SET/GET check returned an unexpected value.');
    }
    console.log('Redis test result:', result);
  } catch (error) {
    console.error('Redis test failed:', error);
    process.exitCode = 1;
  } finally {
    if (closeRedis) {
      try {
        await closeRedis();
      } catch (error) {
        console.error('Unable to close Redis test connection:', error);
        process.exitCode = 1;
      }
    }
  }
};

void testRedis();
