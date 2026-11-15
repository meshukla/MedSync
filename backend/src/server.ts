import { createServer } from 'node:http';
import app from './app';
import { connectDatabase } from './config/db';
import { env } from './config/env';
import mongoose from 'mongoose';
import { closeRedis, connectRedis } from './config/redis';
import { closeNotificationQueue } from './queues/notificationQueue';
import { closeRealtime, initializeRealtime } from './realtime/socket';
import { NotificationWorkerHandle, startNotificationWorker } from './workers/notificationWorker';

const startServer = async () => {
  let worker: NotificationWorkerHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (!shutdownPromise) {
      console.log(`MedSync backend received ${signal}; shutting down.`);
      shutdownPromise = Promise.allSettled([
        ...(worker ? [worker.close()] : []),
      ]).then(async (workerResults) => {
        workerResults.forEach((result) => {
          if (result.status === 'rejected') {
            console.error('Backend shutdown failed:', result.reason);
            process.exitCode = 1;
          }
        });
        const results = await Promise.allSettled([
          closeRealtime(),
          closeRedis(),
          closeNotificationQueue(),
          mongoose.disconnect(),
        ]);
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

  try {
    await connectDatabase();
    await connectRedis();
    worker = await startNotificationWorker();

    const server = createServer(app);
    initializeRealtime(server);
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(env.port);
    });
    console.log(`MedSync backend listening on http://localhost:${env.port}`);

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    console.error('MedSync backend failed to start:', error);
    await shutdown('startup failure');
    process.exitCode = 1;
  }
};

void startServer();
