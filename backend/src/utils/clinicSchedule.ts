import { env } from '../config/env';

type ClinicDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const clinicFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: env.clinicTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const partsInClinicTimeZone = (date: Date): ClinicDateParts => {
  const parts: Record<string, number> = {};
  for (const part of clinicFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
};

const isValidDateValue = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
};

export const getClinicDate = (date: Date) => {
  const parts = partsInClinicTimeZone(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

export const isValidClinicDate = (value: string) => isValidDateValue(value);

export const clinicDateTimeToDate = (dateValue: string, timeValue: string): Date | null => {
  if (!isValidDateValue(dateValue)) return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour >= 24 || minute >= 60 || minute % 10 !== 0) return null;

  const expectedLocalTime = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = expectedLocalTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = partsInClinicTimeZone(new Date(timestamp));
    const representedLocalTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const adjustment = expectedLocalTime - representedLocalTime;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }

  const result = new Date(timestamp);
  const parts = partsInClinicTimeZone(result);
  if (parts.year !== year || parts.month !== month || parts.day !== day
    || parts.hour !== hour || parts.minute !== minute || parts.second !== 0) {
    return null;
  }
  return result;
};

export const getClinicSlots = (dateValue: string, now = new Date()) => {
  if (!isValidDateValue(dateValue) || dateValue < getClinicDate(now)) return [];

  const slots: { time: string; slot: Date }[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 10) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const slot = clinicDateTimeToDate(dateValue, time);
    if (slot && slot > now) slots.push({ time, slot });
  }
  return slots;
};
