import { DateTime, IANAZone } from 'luxon';
import { RRule, rrulestr } from 'rrule';
import { AppError } from '../../common/errors/app-error';

/**
 * Time, zones and recurrence.
 *
 * Every instant in the database is UTC. A zone is stored alongside it, not
 * instead of it, because the two answer different questions: the instant
 * says when to fire, and the zone says what wall-clock time the user meant.
 * A recurring reminder needs both — "every Monday at 9am" is a statement
 * about wall-clock time, and across a daylight-saving boundary that is a
 * different instant each side.
 *
 * Nothing here assumes a zone. The user's own `timezone` is read from their
 * account and travels with each reminder.
 */

/** The outcome of interpreting a wall-clock time in a zone. */
export type ZonedResult =
  | { readonly ok: true; readonly instant: Date; readonly adjusted: null }
  | {
      readonly ok: true;
      readonly instant: Date;
      /**
       * Set when the stated wall-clock time does not exist, or exists
       * twice, and a documented choice was made. The caller shows this to
       * the user rather than silently moving their alarm.
       */
      readonly adjusted: {
        readonly reason: 'skipped' | 'ambiguous';
        readonly requested: string;
        readonly resolved: string;
        readonly detail: string;
      };
    }
  | { readonly ok: false; readonly code: 'invalid_zone' | 'invalid_time'; readonly detail: string };

export function isValidTimezone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/**
 * Turns a wall-clock time in a zone into an instant.
 *
 * Two cases that a naive conversion gets wrong, and that a reminder service
 * must not get wrong because the result is an alarm at the wrong hour:
 *
 * **Spring forward: the time does not exist.** At 02:30 on the night the
 * clocks go forward, there is no such moment. Luxon reports the gap; this
 * resolves to the same instant the clock jumps to — 03:30 local — and says
 * so. Choosing *later* rather than earlier means a 02:30 alarm fires after
 * the hour it was meant for, never before it.
 *
 * **Autumn back: the time exists twice.** 01:30 happens once before the
 * clocks change and once after. Luxon resolves such a reading to the
 * *later* instant — standard time — which was worth checking rather than
 * assuming. This deliberately picks the **earlier** one instead, so a
 * reminder is early rather than an hour late, and says that it did.
 *
 * Neither case is silently absorbed, because a user whose 2:30am alarm moved
 * deserves to be told.
 */
export function toInstant(wallClockIso: string, zone: string): ZonedResult {
  if (!isValidTimezone(zone)) {
    return { ok: false, code: 'invalid_zone', detail: `"${zone}" is not a known time zone.` };
  }

  // Parsed as a local wall-clock reading in that zone. An offset in the
  // string would make the zone irrelevant, so one is rejected: the caller
  // should use `fromInstant` for an absolute time.
  const parsed = DateTime.fromISO(wallClockIso, { zone, setZone: true });
  if (!parsed.isValid) {
    return {
      ok: false,
      code: 'invalid_time',
      detail: parsed.invalidExplanation ?? 'That date and time could not be read.',
    };
  }

  // Luxon marks a nonexistent local time by shifting it; comparing the
  // reading back is how the gap is detected.
  const roundTrip = parsed.toFormat("yyyy-MM-dd'T'HH:mm");
  const requested = wallClockIso.slice(0, 16);

  if (roundTrip !== requested) {
    return {
      ok: true,
      instant: parsed.toJSDate(),
      adjusted: {
        reason: 'skipped',
        requested,
        resolved: roundTrip,
        detail:
          `${requested.replace('T', ' ')} does not exist in ${zone} — the clocks ` +
          `go forward. Using ${roundTrip.replace('T', ' ')} instead.`,
      },
    };
  }

  // An ambiguous local time maps to two instants an hour apart. Luxon gives
  // the later of the two, so the test is whether an hour *earlier* reads as
  // the same wall-clock time under a different offset.
  const earlier = parsed.minus({ hours: 1 });
  const ambiguous =
    earlier.toFormat("yyyy-MM-dd'T'HH:mm") === roundTrip && earlier.offset !== parsed.offset;

  if (ambiguous) {
    return {
      ok: true,
      // The earlier of the two. A reminder that fires an hour early is a
      // smaller wrong than one that fires an hour late.
      instant: earlier.toJSDate(),
      adjusted: {
        reason: 'ambiguous',
        requested,
        resolved: earlier.toISO(),
        detail:
          `${requested.replace('T', ' ')} happens twice in ${zone} — the clocks ` +
          'go back. Using the first one, so the reminder is not late.',
      },
    };
  }

  return { ok: true, instant: parsed.toJSDate(), adjusted: null };
}

/** An instant, as it reads on a clock in a zone. */
export function fromInstant(instant: Date, zone: string) {
  const dt = DateTime.fromJSDate(instant, { zone: isValidTimezone(zone) ? zone : 'UTC' });
  return {
    /** ISO-8601 with the zone's offset, e.g. `2026-11-10T08:00:00+05:30`. */
    local: dt.toISO()!,
    /** For display: `Tue, 10 Nov 2026, 08:00`. */
    display: dt.toFormat('EEE, dd LLL yyyy, HH:mm'),
    zone: dt.zoneName ?? 'UTC',
    offsetMinutes: dt.offset,
  };
}

/**
 * Validates a recurrence rule and reports what it means.
 *
 * Rules are **parsed, not trusted**: an rrule is a small language, and one
 * that expands to a firing every second would be a scheduling problem rather
 * than a user preference. The minimum interval below is what stops that.
 */
export interface RecurrenceInfo {
  readonly rrule: string;
  readonly description: string;
  /** Smallest gap between two occurrences, in minutes. */
  readonly minIntervalMinutes: number;
}

/** No reminder may repeat more often than this. */
export const MIN_RECURRENCE_MINUTES = 15;

/**
 * Extracts just the RRULE portion of a rule string.
 *
 * `RRule.toString()` emits a two-line iCalendar fragment — a `DTSTART:` line
 * and an `RRULE:` line — and feeding that back to `rrulestr` prefixed with
 * `RRULE:` produces `Unknown RRULE property 'DTSTART:...'`. Storing the
 * whole thing therefore made every recurring reminder stop recurring after
 * its first firing, which is the sort of thing that only shows up a week
 * later. The start instant lives on the reminder row, so the rule text does
 * not need to carry it.
 *
 * Tolerant of what it is given, because a row written by an earlier build
 * may still hold the two-line form.
 */
export function normaliseRuleText(rule: string): string {
  const trimmed = rule.trim();
  if (!trimmed) return '';

  const ruleLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toUpperCase().startsWith('RRULE:') || !line.includes(':'));

  return (ruleLine ?? trimmed).replace(/^RRULE:/i, '');
}

export function parseRecurrence(rule: string, dtstart: Date, zone: string): RecurrenceInfo {
  const trimmed = rule.trim();
  if (!trimmed) throw AppError.validation('The recurrence rule is empty.');
  if (trimmed.length > 200) throw AppError.validation('That recurrence rule is too long.');

  let parsed: RRule;
  try {
    const result = rrulestr(`RRULE:${normaliseRuleText(trimmed)}`, {
      dtstart,
    });
    // `rrulestr` can return a set; only a single rule is accepted, because a
    // set's expansion is unbounded in ways a single rule's is not.
    if (!(result instanceof RRule)) {
      throw AppError.validation('Only a single recurrence rule is supported.');
    }
    parsed = result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.validation('That recurrence rule could not be read.');
  }

  // The first few occurrences, to measure the interval. Bounded, so a rule
  // that generates nothing or everything cannot hang this.
  const sample = parsed.all((_date, index) => index < 3);
  if (sample.length === 0) {
    throw AppError.validation('That recurrence rule never produces an occurrence.');
  }

  let minIntervalMinutes = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sample.length; i += 1) {
    const gap = (sample[i].getTime() - sample[i - 1].getTime()) / 60_000;
    if (gap > 0) minIntervalMinutes = Math.min(minIntervalMinutes, gap);
  }
  if (!Number.isFinite(minIntervalMinutes)) minIntervalMinutes = Number.MAX_SAFE_INTEGER;

  if (minIntervalMinutes < MIN_RECURRENCE_MINUTES) {
    throw AppError.validation(
      `A reminder cannot repeat more often than every ${MIN_RECURRENCE_MINUTES} minutes.`,
    );
  }

  return {
    // Only the rule. `toString()` would also give a DTSTART line, which is
    // not valid inside an RRULE and which the row already holds anyway.
    rrule: normaliseRuleText(parsed.toString()),
    description: describeRecurrence(parsed, zone),
    minIntervalMinutes,
  };
}

/**
 * The next occurrence strictly after a moment.
 *
 * Wall-clock stability across a DST change is handled by re-reading the
 * local time from `dtstart` and rebuilding the instant in the zone: the
 * rrule works in local terms, and the conversion back is where the offset
 * is applied. Without that, a weekly 9am reminder drifts to 8am or 10am for
 * half the year.
 */
export function nextOccurrence(
  rule: string,
  dtstart: Date,
  zone: string,
  after: Date,
): Date | null {
  const local = DateTime.fromJSDate(dtstart, { zone });
  if (!local.isValid) return null;

  // The rule is expanded in "floating" local time, so the hour stays the
  // hour the user asked for.
  const floatingStart = new Date(
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    ),
  );
  const floatingAfter = (() => {
    const a = DateTime.fromJSDate(after, { zone });
    return new Date(
      Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second),
    );
  })();

  const ruleText = normaliseRuleText(rule);
  if (!ruleText) return null;

  let parsed: RRule;
  try {
    const result = rrulestr(`RRULE:${ruleText}`, { dtstart: floatingStart });
    if (!(result instanceof RRule)) return null;
    parsed = result;
  } catch {
    return null;
  }

  const next = parsed.after(floatingAfter, false);
  if (!next) return null;

  // Back into the zone, which is where the current offset is applied — so
  // the wall-clock hour is preserved and the instant moves instead.
  const resolved = DateTime.fromObject(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: next.getUTCHours(),
      minute: next.getUTCMinutes(),
      second: next.getUTCSeconds(),
    },
    { zone },
  );

  return resolved.isValid ? resolved.toJSDate() : null;
}

/** A readable summary of a rule, for a confirmation or a list. */
function describeRecurrence(rule: RRule, zone: string): string {
  try {
    const text = rule.toText();
    const time = DateTime.fromJSDate(rule.options.dtstart, { zone });
    return time.isValid ? `${text} at ${time.toFormat('HH:mm')}` : text;
  } catch {
    return 'Repeats on a custom schedule.';
  }
}

/**
 * The window a reminder may be scheduled in.
 *
 * A reminder in the past would never fire, and one a century out is almost
 * certainly a parsing mistake rather than a plan — a model that read "2026"
 * as "2126", say. Both are refused rather than stored.
 */
export const MAX_SCHEDULE_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export function assertSchedulable(instant: Date, now = new Date()): void {
  if (!Number.isFinite(instant.getTime())) {
    throw AppError.validation('That date and time could not be read.');
  }
  if (instant.getTime() <= now.getTime()) {
    throw AppError.validation('That time has already passed.');
  }
  if (instant.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) {
    throw AppError.validation('That is too far in the future to schedule.');
  }
}
