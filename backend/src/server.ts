import { createServer } from 'node:http';
import app from './app';
import { connectDatabase } from './config/db';
import { env } from './config/env';
import mongoose from 'mongoose';
import { closeRedis, connectRedis } from './config/redis';
import { closeNotificationQueue } from './queues/notificationQueue';
import { closeRealtime, initializeRealtime } from './realtime/socket';

const startServer = async () => {
  await connectDatabase();
  await connectRedis();
  const server = createServer(app);
  initializeRealtime(server);
  server.listen(env.port, () => {
    console.log(`MedSync backend listening on http://localhost:${env.port}`);
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (!shutdownPromise) {
      console.log(`MedSync backend received ${signal}; shutting down.`);
      shutdownPromise = Promise.allSettled([
        closeRealtime(),
        closeRedis(),
        closeNotificationQueue(),
        mongoose.disconnect(),
      ]).then((results) => {
        results.forEach((result) => {
          if (result.status === 'rejected') {
            console.error('Backend shutdown failed:', result.reason);
            process.exitCode = 1;
          }
        });
      });
    }
    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
};

void startServer().catch((error: unknown) => {
  console.error('MedSync backend failed to start:', error);
  return Promise.allSettled([
    mongoose.disconnect(),
    closeRedis(),
    closeNotificationQueue(),
  ]).then((results) => {
    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('Unable to clean up after startup failure:', result.reason);
      }
    });
    process.exitCode = 1;
  });
});
