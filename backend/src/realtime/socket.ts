import { Server } from 'socket.io';
import { Server as HttpServer } from 'node:http';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { AuthSession } from '../models/AuthSession';
import { Appointment } from '../models/Appointment';
import { Doctor } from '../models/Clinic';
import { Payment } from '../models/Payment';
import { User } from '../models/User';
import { getVideoIceServers } from './videoIceServers';
import { accessCookieName, getTabSessionId } from '../utils/tabSession';
import { notifyUsers } from '../services/userNotifications';

type SocketUser = { id: string; role: string; familyId: string };
type VideoRole = 'patient' | 'doctor';

let io: Server | undefined;
const videoJoinLocks = new Set<string>();

const videoRoom = (appointmentId: string) => `video:appointment:${appointmentId}`;
const appointmentIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const videoOfferSchema = z.object({
  appointmentId: appointmentIdSchema,
  description: z.object({
    type: z.literal('offer'),
    sdp: z.string().min(1).max(100_000),
  }),
});
const videoAnswerSchema = z.object({
  appointmentId: appointmentIdSchema,
  description: z.object({
    type: z.literal('answer'),
    sdp: z.string().min(1).max(100_000),
  }),
});
const videoCandidateSchema = z.object({
  appointmentId: appointmentIdSchema,
  candidate: z.object({
    candidate: z.string().min(1).max(5_000),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().int().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  }),
});

export const initializeRealtime = (httpServer: HttpServer) => {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
  });

  io.use(async (socket, next) => {
    const tabSessionId = getTabSessionId(socket.handshake.auth?.tabSessionId);
    if (!tabSessionId) {
      next(new Error('A valid browser-tab session ID is required.'));
      return;
    }
    const accessCookie = accessCookieName(tabSessionId);
    const cookieHeader = socket.handshake.headers.cookie || '';
    const tokenPart = cookieHeader.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${accessCookie}=`));
    const token = tokenPart?.slice(`${accessCookie}=`.length);
    if (!token) {
      next(new Error('Authentication required.'));
      return;
    }

    let payload: { id: string; familyId: string };
    try {
      const decoded = jwt.verify(token, env.jwtAccessSecret);
      if (typeof decoded === 'string' || typeof decoded.id !== 'string' || typeof decoded.familyId !== 'string') {
        next(new Error('Invalid authentication token.'));
        return;
      }
      payload = { id: decoded.id, familyId: decoded.familyId };
    } catch (error) {
      if (error instanceof JsonWebTokenError || error instanceof TokenExpiredError) {
        next(new Error('Invalid or expired authentication token.'));
        return;
      }
      next(error instanceof Error ? error : new Error('Socket authentication failed.'));
      return;
    }

    let user;
    let activeSession;
    try {
      [user, activeSession] = await Promise.all([
        User.findById(payload.id).select('_id role isActive'),
        AuthSession.exists({
          familyId: payload.familyId,
          revokedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        }),
      ]);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Socket authentication failed.'));
      return;
    }
    if (!user || !user.isActive || !activeSession) {
      next(new Error('User account is unavailable.'));
      return;
    }

    socket.data.user = { id: user.id, role: user.role, familyId: payload.familyId } satisfies SocketUser;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as SocketUser;
    socket.join(`user:${user.id}`);
    socket.join(`session:${user.familyId}`);
    socket.join(`role:${user.role}`);

    const leaveVideoRoom = () => {
      const appointmentId = socket.data.videoAppointmentId as string | undefined;
      if (!appointmentId) return;
      socket.to(videoRoom(appointmentId)).emit('video:participant-left');
      socket.leave(videoRoom(appointmentId));
      delete socket.data.videoAppointmentId;
      delete socket.data.videoRole;
    };

    socket.on('video:join', (payload: unknown) => {
      void (async () => {
        try {
          const parsed = z.object({ appointmentId: appointmentIdSchema }).safeParse(payload);
          if (!parsed.success) {
            socket.emit('video:error', { message: 'Select a valid appointment.' });
            return;
          }

          const appointmentId = parsed.data.appointmentId;
          const appointment = await Appointment.findById(appointmentId);
          if (!appointment || appointment.consultationType !== 'ONLINE' || appointment.status !== 'CONFIRMED'
            || appointment.videoConsultationCompletedAt) {
            socket.emit('video:error', { message: 'This online appointment is not confirmed or is no longer available.' });
            return;
          }

          let role: VideoRole | null = null;
          if (appointment.patientId.toString() === user.id && user.role === 'patient') {
            role = 'patient';
          } else if (user.role === 'doctor' && await Doctor.exists({ _id: appointment.doctorId, userId: user.id })) {
            role = 'doctor';
          }
          if (!role) {
            socket.emit('video:error', { message: "Only this appointment's patient and doctor can join." });
            return;
          }

          if (!await Payment.exists({ appointmentId: appointment._id, status: 'CAPTURED' })) {
            socket.emit('video:error', { message: 'The consultation payment must be confirmed before joining.' });
            return;
          }

          const startsAt = appointment.slot.getTime();
          const now = Date.now();
          if (now < startsAt - 15 * 60_000) {
            socket.emit('video:error', { message: 'Video access opens 15 minutes before the appointment.' });
            return;
          }
          if (now > startsAt + 60 * 60_000) {
            socket.emit('video:error', { message: 'The video appointment window has ended. Contact the hospital for help.' });
            return;
          }

          if (videoJoinLocks.has(appointment.id)) {
            socket.emit('video:error', { message: 'Someone is joining this video visit. Please try again in a moment.' });
            return;
          }
          videoJoinLocks.add(appointment.id);
          try {
            const room = videoRoom(appointment.id);
            const participants = await io?.in(room).fetchSockets();
            if (!participants) {
              socket.emit('video:error', { message: 'Video calling is unavailable right now.' });
              return;
            }
            if (participants.some((participant) => (participant.data.user as SocketUser | undefined)?.id === user.id)) {
              socket.emit('video:error', { message: 'This account has already joined the appointment from another tab.' });
              return;
            }
            const peerRole = participants[0]?.data.videoRole as VideoRole | undefined;
            if (participants.length >= 2 || (peerRole && peerRole === role)) {
              socket.emit('video:error', { message: 'The other participant has already joined this appointment.' });
              return;
            }

            leaveVideoRoom();
            await socket.join(room);
            socket.data.videoAppointmentId = appointment.id;
            socket.data.videoRole = role;
            socket.emit('video:joined', {
              appointmentId: appointment.id,
              role,
              peerRole,
              iceServers: getVideoIceServers(user.id),
            });
            socket.to(room).emit('video:participant-joined', { role });
            if (role === 'doctor' && peerRole === 'patient') {
              void notifyUsers([appointment.patientId.toString()], {
                event: 'consultation.started',
                title: 'Doctor started your consultation',
                message: 'Your doctor has joined the video consultation.',
                metadata: { appointmentId: appointment.id },
                dedupeKey: `consultation-started:${appointment.id}:${Date.now()}`,
              }).catch((error: unknown) => {
                console.error('Unable to notify patient that consultation started:', error);
              });
              void notifyUsers([user.id], {
                event: 'consultation.patient-joined',
                title: 'Patient joined video consultation',
                message: 'Your patient has joined the video consultation.',
                metadata: { appointmentId: appointment.id },
                dedupeKey: `consultation-patient-joined:${appointment.id}:${Date.now()}`,
              }).catch((error: unknown) => {
                console.error('Unable to notify doctor that patient joined:', error);
              });
            } else if (role === 'patient' && peerRole === 'doctor') {
              void notifyUsers([appointment.patientId.toString()], {
                event: 'consultation.started',
                title: 'Doctor started your consultation',
                message: 'Your doctor is already in the video consultation.',
                metadata: { appointmentId: appointment.id },
                dedupeKey: `consultation-started:${appointment.id}:${Date.now()}`,
              }).catch((error: unknown) => {
                console.error('Unable to notify patient that consultation started:', error);
              });
              const doctor = await Doctor.findById(appointment.doctorId).select('userId');
              if (doctor) {
                void notifyUsers([doctor.userId.toString()], {
                  event: 'consultation.patient-joined',
                  title: 'Patient joined video consultation',
                  message: 'Your patient has joined the video consultation.',
                  metadata: { appointmentId: appointment.id },
                  dedupeKey: `consultation-patient-joined:${appointment.id}:${Date.now()}`,
                }).catch((error: unknown) => {
                  console.error('Unable to notify doctor that patient joined:', error);
                });
              }
            }
          } finally {
            videoJoinLocks.delete(appointment.id);
          }
        } catch (error) {
          console.error('Video consultation join failed:', error);
          socket.emit('video:error', { message: 'Could not join the video consultation. Please try again.' });
        }
      })();
    });

    const relayVideoSignal = <T extends { appointmentId: string }>(
      event: 'video:offer' | 'video:answer' | 'video:ice-candidate',
      schema: z.ZodType<T>,
      expectedRole?: VideoRole,
    ) => {
      socket.on(event, (payload: unknown) => {
        const parsed = schema.safeParse(payload);
        const appointmentId = socket.data.videoAppointmentId as string | undefined;
        const role = socket.data.videoRole as VideoRole | undefined;
        if (!parsed.success || !appointmentId || parsed.data.appointmentId !== appointmentId || (expectedRole && role !== expectedRole)) {
          socket.emit('video:error', { message: 'Join the authorized appointment before sending call data.' });
          return;
        }
        socket.to(videoRoom(appointmentId)).emit(event, {
          ...parsed.data,
          fromRole: role,
        });
      });
    };

    relayVideoSignal('video:offer', videoOfferSchema, 'doctor');
    relayVideoSignal('video:answer', videoAnswerSchema, 'patient');
    relayVideoSignal('video:ice-candidate', videoCandidateSchema);
    socket.on('video:leave', leaveVideoRoom);
    socket.on('disconnecting', leaveVideoRoom);

    socket.on('video:complete', () => {
      void (async () => {
        try {
          const appointmentId = socket.data.videoAppointmentId as string | undefined;
          if (!appointmentId || socket.data.videoRole !== 'doctor') {
            socket.emit('video:error', { message: 'Only the assigned doctor can complete this video consultation.' });
            return;
          }
          const room = videoRoom(appointmentId);
          const participants = await io?.in(room).fetchSockets();
          if (!participants?.some((participant) => participant.data.videoRole === 'patient')) {
            socket.emit('video:error', { message: 'The patient must be in the call before completing the consultation.' });
            return;
          }

          const currentAppointment = await Appointment.findOne({
            _id: appointmentId,
            status: 'CONFIRMED',
            consultationType: 'ONLINE',
          }).select('doctorId');
          if (!currentAppointment || !await Doctor.exists({ _id: currentAppointment.doctorId, userId: user.id })) {
            socket.emit('video:error', { message: 'This account is not the assigned doctor.' });
            return;
          }
          const completedAt = new Date();
          const appointment = await Appointment.findOneAndUpdate(
            {
              _id: appointmentId,
              status: 'CONFIRMED',
              consultationType: 'ONLINE',
              videoConsultationCompletedAt: { $exists: false },
            },
            { $set: { videoConsultationCompletedAt: completedAt } },
            { new: true },
          );
          if (!appointment) {
            socket.emit('video:error', { message: 'The video appointment is no longer available to complete.' });
            return;
          }

          const event = { appointmentId, status: appointment.status, videoConsultationCompletedAt: completedAt.toISOString() };
          publishUserEvent(appointment.patientId.toString(), 'video.consultation-completed', event);
          publishUserEvent(user.id, 'video.consultation-completed', event);
          publishAdminEvent('video.consultation-completed', event);
          socket.to(room).emit('video:consultation-completed', event);
          socket.emit('video:completed', { appointmentId, completedAt: completedAt.toISOString() });
        } catch (error) {
          console.error('Video consultation completion failed:', error);
          socket.emit('video:error', { message: 'Could not complete the video consultation. Please try again.' });
        }
      })();
    });
  });
};

export const closeRealtime = async () => {
  if (!io) return;
  const realtimeServer = io;
  io = undefined;
  await realtimeServer.close();
};

export const disconnectSessionFamily = (familyId: string) => {
  if (!io) throw new Error('Realtime service has not been initialized.');
  io.in(`session:${familyId}`).disconnectSockets(true);
};

export const publishUserEvent = (userId: string, event: string, payload: Record<string, unknown>) => {
  if (!io) throw new Error('Realtime service has not been initialized.');
  io.to(`user:${userId}`).emit('medsync:event', { event, ...payload });
};

export const publishUserEventIfAvailable = (userId: string, event: string, payload: Record<string, unknown>) => {
  if (io) publishUserEvent(userId, event, payload);
};

export const publishAdminEvent = (event: string, payload: Record<string, unknown>) => {
  if (!io) throw new Error('Realtime service has not been initialized.');
  io.to('role:admin').emit('medsync:event', { event, ...payload });
};

export const publishRoleEvent = (
  role: 'patient' | 'doctor' | 'admin' | 'pharmacist' | 'deliveryBoy',
  event: string,
  payload: Record<string, unknown>,
) => {
  if (!io) throw new Error('Realtime service has not been initialized.');
  io.to(`role:${role}`).emit('medsync:event', { event, ...payload });
};
