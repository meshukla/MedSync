import { createServer } from 'node:http';
import app from './app';
import { connectDatabase } from './config/db';
import { env } from './config/env';
import mongoose from 'mongoose';
import { initializeRealtime } from './realtime/socket';

const startServer = async () => {
  await connectDatabase();
  const server = createServer(app);
  initializeRealtime(server);
  server.listen(env.port, () => {
    console.log(`MedSync backend listening on http://localhost:${env.port}`);
  });
};

void startServer().catch((error: unknown) => {
  console.error('MedSync backend failed to start:', error);
  return mongoose.disconnect().catch((disconnectError: unknown) => {
    console.error('Unable to close MongoDB after startup failure:', disconnectError);
  }).then(() => {
    process.exitCode = 1;
  });
});
