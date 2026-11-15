import { InventoryItem } from '../models/Clinic';
import type { Types } from 'mongoose';
import type { PharmacyOrderDocument } from '../models/PharmacyOrder';
import { notifyRole } from './userNotifications';
import { cacheKeys, invalidateCache } from './redisCache';

type DeductionResult = { success: true } | { success: false; message: string };

const rollbackDeductions = async (deductions: { inventoryId: string; quantity: number; orderId: string }[]) => {
  for (const deduction of deductions.reverse()) {
    await InventoryItem.updateOne(
      { _id: deduction.inventoryId, deductedOrderIds: deduction.orderId },
      { $inc: { stock: deduction.quantity }, $pull: { deductedOrderIds: deduction.orderId } },
    );
  }
  if (deductions.length > 0) await invalidateCache(cacheKeys.pharmacyInventory);
};

export const deductOrderInventory = async (order: PharmacyOrderDocument): Promise<DeductionResult> => {
  const orderId = order._id.toString();
  const requiredByMedicine = new Map<string, number>();
  for (const item of order.items) {
    const key = item.name.trim().toLowerCase();
    requiredByMedicine.set(key, (requiredByMedicine.get(key) || 0) + item.quantity);
  }

  const inventory = await InventoryItem.find()
    .select('medicine stock lowStockThreshold deductedOrderIds')
    .lean();
  const newlyDeducted: { inventoryId: string; quantity: number; orderId: string }[] = [];
  const lowStock: { medicine: string; stock: number; threshold: number }[] = [];

  for (const [medicine, required] of requiredByMedicine) {
    const matches = inventory.filter((item) => item.medicine.trim().toLowerCase() === medicine);
    if (matches.length !== 1) {
      await rollbackDeductions(newlyDeducted);
      return {
        success: false,
        message: matches.length ? `Inventory has duplicate entries for ${medicine}.` : `${medicine} is not listed in pharmacy inventory.`,
      };
    }

    const item = matches[0];
    if ((item.deductedOrderIds || []).some((id: Types.ObjectId) => id.toString() === orderId)) continue;
    const updated = await InventoryItem.updateOne(
      { _id: item._id, stock: { $gte: required }, deductedOrderIds: { $ne: order._id } },
      { $inc: { stock: -required }, $addToSet: { deductedOrderIds: order._id } },
    );
    if (updated.modifiedCount === 1) {
      newlyDeducted.push({ inventoryId: item._id.toString(), quantity: required, orderId });
      const nextStock = item.stock - required;
      if (item.stock > item.lowStockThreshold && nextStock <= item.lowStockThreshold) {
        lowStock.push({ medicine: item.medicine, stock: nextStock, threshold: item.lowStockThreshold });
      }
      continue;
    }

    const currentItem = await InventoryItem.findById(item._id).select('stock deductedOrderIds').lean();
    if ((currentItem?.deductedOrderIds || []).some((id: Types.ObjectId) => id.toString() === orderId)) continue;
    await rollbackDeductions(newlyDeducted);
    return {
      success: false,
      message: currentItem ? `Insufficient stock for ${medicine}.` : `Inventory item for ${medicine} was removed.`,
    };
  }

  if (newlyDeducted.length > 0) await invalidateCache(cacheKeys.pharmacyInventory);
  for (const item of lowStock) {
    await notifyRole('admin', {
      event: 'inventory.low-stock',
      title: 'Low medicine stock',
      message: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.threshold}).`,
      metadata: item,
      email: {
        subject: 'MedSync low medicine stock alert',
        text: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.threshold}).`,
      },
    });
  }

  return { success: true };
};

export const clearOrderInventoryDeductions = async (orderId: string) => {
  const result = await InventoryItem.updateMany(
    { deductedOrderIds: orderId },
    { $pull: { deductedOrderIds: orderId } },
  );
  if (result.modifiedCount > 0) await invalidateCache(cacheKeys.pharmacyInventory);
};
