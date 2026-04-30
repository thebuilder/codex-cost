import type { UsageEvent } from "./types.ts";

export type DateRangePreset = "all" | "1d" | "1w" | "1m";

export type DateRange = {
  label: string;
  start: Date | null;
  end: Date | null;
};

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

export function dateRangeLabel(preset: DateRangePreset): string {
  return dateRangeFromPreset(preset).label;
}

export function dateRangeFromPreset(preset: DateRangePreset, now = new Date()): DateRange {
  if (preset === "1d") return { label: "Past 1 day", start: shiftDate(now, { days: -1 }), end: null };
  if (preset === "1w") return { label: "Past 1 week", start: shiftDate(now, { days: -7 }), end: null };
  if (preset === "1m") return { label: "Past 1 month", start: shiftDate(now, { months: -1 }), end: null };
  return { label: "All time", start: null, end: null };
}

export function parseDateRange(input: string | undefined, now = new Date()): DateRange {
  const normalized = input?.trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "all-time" || normalized === "all time") {
    return dateRangeFromPreset("all", now);
  }
  if (["1d", "day", "1 day", "past 1 day"].includes(normalized)) return dateRangeFromPreset("1d", now);
  if (["1w", "week", "1 week", "past 1 week"].includes(normalized)) return dateRangeFromPreset("1w", now);
  if (["1m", "month", "1 month", "past 1 month"].includes(normalized)) return dateRangeFromPreset("1m", now);

  const monthIndex = monthNames.findIndex((month) => month.startsWith(normalized));
  if (monthIndex !== -1) return dateRangeForNearestPastMonth(monthIndex, now);

  throw new Error(`Unsupported date range: ${input}. Use all, 1d, 1w, 1m, or a month name.`);
}

export function dateRangeForNearestPastMonth(monthIndex: number, now = new Date()): DateRange {
  const currentMonth = now.getUTCMonth();
  const currentYear = now.getUTCFullYear();
  const year = monthIndex <= currentMonth ? currentYear : currentYear - 1;
  const start = new Date(now);
  start.setUTCFullYear(year, monthIndex, 1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { label: `${capitalize(monthNames[monthIndex])} ${year}`, start, end };
}

export function filterEventsByDateRange(events: UsageEvent[], range: DateRange | DateRangePreset, now = new Date()): UsageEvent[] {
  const resolved = typeof range === "string" ? dateRangeFromPreset(range, now) : range;
  const startTime = resolved.start?.getTime() ?? null;
  const endTime = resolved.end?.getTime() ?? null;
  if (startTime === null && endTime === null) return events;
  return events.filter((event) => {
    const eventTime = new Date(event.timestamp).getTime();
    return Number.isFinite(eventTime) && (startTime === null || eventTime >= startTime) && (endTime === null || eventTime < endTime);
  });
}

function shiftDate(date: Date, shift: { days?: number; months?: number }): Date {
  const shifted = new Date(date);
  if (shift.days) shifted.setDate(shifted.getDate() + shift.days);
  if (shift.months) shifted.setMonth(shifted.getMonth() + shift.months);
  return shifted;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
