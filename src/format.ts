/** Display formatting shared by every view, so one fact never reads two ways on screen. */
export const percent = (value: number | null) =>
  value === null ? "No data" : value.toFixed(1) + "%";

export const shortDate = (value: string | number | Date) =>
  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const dateTime = (value: string | number | Date) =>
  new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Recent events read relatively; older ones show their date so a list stays scannable. */
export function relativeTime(value: string | number | Date, now = Date.now()) {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "Yesterday" : days + " days ago";
  return dateTime(value);
}

/** A change between two rates, in points, worded without implying cause. */
export function pointChange(points: number | null) {
  if (points === null) return null;
  const rounded = Math.round(points * 10) / 10;
  if (rounded === 0) return { direction: "flat" as const, label: "No change" };
  return { direction: rounded > 0 ? "up" as const : "down" as const, label: (rounded > 0 ? "+" : "") + rounded.toFixed(1) + " points" };
}

const dollarAmount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });
/** Preserve the billing precision in prices and limits; a positive charge must not look free. */
export const usd = (value: number, digits?: number) => {
  if (digits !== undefined) return '$' + value.toFixed(digits);
  if (value !== 0 && Math.abs(value) < 0.000001) return value > 0 ? '<$0.000001' : '>-$0.000001';
  return '$' + dollarAmount.format(value);
};
