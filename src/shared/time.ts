export const DISPLAY_TIME_ZONE = "Asia/Shanghai";
export const DISPLAY_TIME_ZONE_OFFSET = "+08:00";
export const MISSING_TIME_DISPLAY = "—";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ABSOLUTE_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(?:(\d{2})(?:\.(\d{1,3}))?)(Z|[+-]\d{2}:\d{2})$/;
const SHANGHAI_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function parseAbsoluteInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = ABSOLUTE_INSTANT_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return null;

  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function shanghaiParts(value: string | null | undefined): Record<string, string> | null {
  const date = parseAbsoluteInstant(value);
  if (!date) return null;
  return Object.fromEntries(SHANGHAI_DATE_TIME_FORMATTER.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
}

export function formatInstantDateTime(value: string | null | undefined): string {
  const parts = shanghaiParts(value);
  if (!parts) return MISSING_TIME_DISPLAY;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatInstantTime(value: string | null | undefined): string {
  const parts = shanghaiParts(value);
  if (!parts) return MISSING_TIME_DISPLAY;
  return `${parts.hour}:${parts.minute}`;
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return MISSING_TIME_DISPLAY;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : MISSING_TIME_DISPLAY;
}

export function formatInstantAsShanghaiIso(value: string | null | undefined): string {
  const date = parseAbsoluteInstant(value);
  if (!date) return MISSING_TIME_DISPLAY;
  const localIso = new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString();
  return `${localIso.slice(0, -1)}${DISPLAY_TIME_ZONE_OFFSET}`;
}
