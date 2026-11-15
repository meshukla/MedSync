import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { Notification } from '../models/Notification';
import { successResponse } from '../utils/response';

const router = Router();

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ recipientId: req.user?.id })
      .select('-emailSubject -emailText')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    Notification.countDocuments({ recipientId: req.user?.id, readAt: { $exists: false } }),
  ]);
  return res.json(successResponse('Notifications loaded.', { notifications, unreadCount }));
});

router.patch('/:id/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid notification.' });
  }
  const notification = await Notification.findOneAndUpdate(
    { _id: parsed.data, recipientId: req.user?.id },
    { $set: { readAt: new Date() } },
    { new: true },
  ).select('-emailSubject -emailText').lean();
  if (!notification) {
    return res.status(404).json({ success: false, message: 'Notification not found.' });
  }
  return res.json(successResponse('Notification marked as read.', notification));
});

router.patch('/read-all', requireAuth, async (req: AuthenticatedRequest, res) => {
  await Notification.updateMany(
    { recipientId: req.user?.id, readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  return res.json(successResponse('Notifications marked as read.'));
});

export default router;
