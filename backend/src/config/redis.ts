import IORedis from 'ioredis';
import { env } from './env';

export const redis = new IORedis(env.redisUrl, {
  lazyConnect: true,
  enableReadyCheck: true,
  maxRetriesPerRequest: 1,
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (error) => {
  console.error('Redis connection error:', error.message);
});

export const createBullMQConnection = () =>
  new IORedis(env.redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  });

export const closeRedisConnection = async (connection: IORedis) => {
  if (connection.status !== 'ready') {
    connection.disconnect();
    return;
  }
  try {
    await connection.quit();
  } catch (error) {
    connection.disconnect();
    throw error;
  }
};

export const connectRedis = async () => {
  const result = await redis.ping();
  if (result !== 'PONG') {
    throw new Error('Redis did not respond to the connectivity check.');
  }
};

export const closeRedis = async () => closeRedisConnection(redis);
