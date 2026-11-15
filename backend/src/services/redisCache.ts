import { redis } from '../config/redis';

export const cacheKeys = {
  departments: 'medsync:v1:cache:departments',
  doctors: 'medsync:v1:cache:doctors',
  doctorAvailability: (doctorId: string) => `medsync:v1:cache:doctor-availability:${doctorId}`,
  pharmacyInventory: 'medsync:v1:cache:pharmacy-inventory',
  deliveryStaff: 'medsync:v1:cache:delivery-staff',
};

export const getOrLoadCache = async <T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> => {
  const cached = await redis.get(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch (error) {
      console.error(`Invalid Redis cache entry for ${key}:`, error);
      await redis.del(key);
    }
  }

  const value = await load();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
};

export const invalidateCache = async (...keys: string[]) => {
  if (keys.length > 0) await redis.del(...keys);
};
