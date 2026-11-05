export const USD_SCALE = 1_000_000;

type DecimalUsd = { units: bigint; exponent: number };

function decimalUsd(value: number): DecimalUsd {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('A finite nonnegative dollar amount is required.');
  const [decimal, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = decimal.split('.');
  return { units: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
}

function scaled(value: DecimalUsd, exponent: number) {
  return value.units * 10n ** BigInt(value.exponent - exponent);
}

function totalUsd(values: readonly number[]): DecimalUsd {
  const parts = values.map(decimalUsd);
  const exponent = parts.reduce((minimum, part) => Math.min(minimum, part.exponent), 0);
  return { units: parts.reduce((total, part) => total + scaled(part, exponent), 0n), exponent };
}

function dollarNumber(value: DecimalUsd): number {
  const amount = Number(`${value.units}e${value.exponent}`);
  if (!Number.isFinite(amount)) throw new RangeError('The dollar total is too large.');
  return amount;
}

function quantizedMicros(value: DecimalUsd, rounding: 'floor' | 'ceil'): bigint {
  const shift = 6 + value.exponent;
  if (shift >= 0) return value.units * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (value.units + (rounding === 'ceil' ? divisor - 1n : 0n)) / divisor;
}

/** Preserve reported decimal costs when accumulating receipts, including sub-micro-dollar charges. */
export function sumUsd(values: readonly number[]): number {
  return dollarNumber(totalUsd(values));
}

/** Token counts multiply a decimal price before the result becomes a JSON number. */
export function multiplyUsd(price: number, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('A nonnegative whole quantity is required.');
  const value = decimalUsd(price);
  return dollarNumber({ ...value, units: value.units * BigInt(quantity) });
}

/** Compare the original decimal approval and all costs without an overspend tolerance. */
export function withinUsdBudget(budget: number, costs: readonly number[]): boolean {
  const limit = decimalUsd(budget), total = totalUsd(costs);
  const exponent = Math.min(limit.exponent, total.exponent);
  return scaled(total, exponent) <= scaled(limit, exponent);
}

/** A reusable approval is rounded down only after subtracting all committed costs exactly. */
export function remainingUsd(budget: number, costs: readonly number[]): number {
  const limit = decimalUsd(budget), total = totalUsd(costs);
  const exponent = Math.min(limit.exponent, total.exponent);
  const units = scaled(limit, exponent) - scaled(total, exponent);
  if (units <= 0n) return 0;
  const micros = quantizedMicros({ units, exponent }, 'floor');
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('The dollar allowance is too large.');
  return Number(micros) / USD_SCALE;
}

/** Interpret the decimal amount sent over JSON before rounding to billing precision.
 * Binary multiplication plus an epsilon can authorize more than the user's limit.
 * Approvals floor; estimated costs ceil so allocation cannot underfund a quote.
 */
export function usdMicros(value: number, rounding: 'floor' | 'ceil'): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const micros = quantizedMicros(decimalUsd(value), rounding);
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}
