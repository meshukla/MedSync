import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import authRoutes from './routes/auth';
import patientRoutes from './routes/patients';
import adminRoutes from './routes/admin';
import pharmacyRoutes from './routes/pharmacy';
import deliveryRoutes from './routes/delivery';
import doctorRoutes from './routes/doctors';
import paymentRoutes from './routes/payments';
import notificationRoutes from './routes/notifications';
import { notifyCriticalIssue } from './services/userNotifications';

const app = express();

app.use(cors({ origin: env.clientUrl, credentials: true }));
app.use(helmet());
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan('dev'));

app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'MedSync backend is running.', timestamp: new Date().toISOString() });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/patients', patientRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/doctors', doctorRoutes);
app.use('/api/v1/pharmacy', pharmacyRoutes);
app.use('/api/v1/delivery', deliveryRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/notifications', notificationRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled app error:', err);
  void notifyCriticalIssue('api').catch((notificationError: unknown) => {
    console.error('Unable to alert administrators about a backend error:', notificationError);
  });
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

export default app;
