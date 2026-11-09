import { AppError } from '../src/common/errors/app-error';
import {
  MAX_SCHEDULE_AHEAD_MS,
  MIN_RECURRENCE_MINUTES,
  assertSchedulable,
  fromInstant,
  isValidTimezone,
  nextOccurrence,
  parseRecurrence,
  toInstant,
} from '../src/modules/reminders/time';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isQuiet,
  parseNotificationPreferences,
} from '../src/modules/notifications/notification-preferences';

/**
 * Time, zones and recurrence.
 *
 * The most fiddly part of this chunk and the one with the least forgiving
 * failure mode: a mistake here is an alarm at the wrong hour. Every
 * daylight-saving assertion below uses a real transition date in a real
 * zone rather than an offset arithmetic fixture.
 */
describe('time, zones and recurrence', () => {
  describe('zone validation', () => {
    it('accepts real IANA zones', () => {
      for (const zone of ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'UTC']) {
        expect(isValidTimezone(zone)).toBe(true);
      }
    });

    it('rejects anything that is not a zone', () => {
      for (const zone of ['GMT+5:30', 'Mars/Olympus', '', 'Asia/Atlantis', 'Kolkata']) {
        expect(isValidTimezone(zone)).toBe(false);
      }
    });

    it('accepts the tz database’s legacy abbreviation entries', () => {
      // `EST` and `IST` are real entries rather than typos, so they are
      // accepted. Worth knowing what that means: `EST` is a *fixed* -05:00
      // with no daylight saving, so it is not a synonym for
      // America/New_York and a reminder stored against it will not move in
      // summer. Rejecting them would be wrong — a client asking for a
      // fixed offset should get one — but a client meaning "New York"
      // should say America/New_York.
      expect(isValidTimezone('EST')).toBe(true);

      const summer = fromInstant(new Date('2026-07-01T12:00:00.000Z'), 'EST');
      const winter = fromInstant(new Date('2026-01-01T12:00:00.000Z'), 'EST');
      expect(summer.offsetMinutes).toBe(-300);
      expect(winter.offsetMinutes).toBe(-300);

      // Whereas the named zone does observe it.
      expect(fromInstant(new Date('2026-07-01T12:00:00.000Z'), 'America/New_York').offsetMinutes)
        .toBe(-240);
    });

    it('refuses an unknown zone rather than quietly substituting one', () => {
      const result = toInstant('2026-11-10T08:00', 'Mars/Olympus');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_zone');
    });
  });

  describe('wall-clock to instant', () => {
    it('reads a wall-clock time in the stated zone', () => {
      const kolkata = toInstant('2026-11-10T08:00', 'Asia/Kolkata');
      expect(kolkata.ok).toBe(true);
      if (!kolkata.ok) return;
      // 08:00 +05:30 is 02:30 UTC.
      expect(kolkata.instant.toISOString()).toBe('2026-11-10T02:30:00.000Z');
      expect(kolkata.adjusted).toBeNull();
    });

    it('gives a different instant for the same reading in a different zone', () => {
      // The whole reason a zone is stored alongside the instant.
      const kolkata = toInstant('2026-11-10T08:00', 'Asia/Kolkata');
      const london = toInstant('2026-11-10T08:00', 'Europe/London');
      expect(kolkata.ok && london.ok).toBe(true);
      if (!kolkata.ok || !london.ok) return;
      expect(kolkata.instant.getTime()).not.toBe(london.instant.getTime());
    });

    it('rejects an unreadable date', () => {
      const result = toInstant('not-a-date', 'Asia/Kolkata');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_time');
    });
  });

  describe('daylight saving: a time that does not exist', () => {
    it('resolves forward and says so, for London', () => {
      // Clocks go forward 2026-03-29 01:00 → 02:00, so 01:30 never happens.
      const result = toInstant('2026-03-29T01:30', 'Europe/London');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.adjusted).not.toBeNull();
      expect(result.adjusted!.reason).toBe('skipped');
      expect(result.adjusted!.requested).toBe('2026-03-29T01:30');
      expect(result.adjusted!.resolved).toBe('2026-03-29T02:30');
      expect(result.adjusted!.detail).toContain('does not exist');
      // Later, not earlier: a 01:30 alarm fires after the hour it was meant
      // for rather than before it.
      expect(result.instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    });

    it('resolves forward and says so, for New York', () => {
      // Clocks go forward 2026-03-08 02:00 → 03:00.
      const result = toInstant('2026-03-08T02:30', 'America/New_York');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.adjusted!.reason).toBe('skipped');
      expect(result.adjusted!.resolved).toBe('2026-03-08T03:30');
    });

    it('does not report an adjustment for an ordinary time on a transition day', () => {
      const result = toInstant('2026-03-29T09:00', 'Europe/London');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.adjusted).toBeNull();
    });
  });

  describe('daylight saving: a time that happens twice', () => {
    it('picks the earlier of the two, for New York, and says so', () => {
      // Clocks go back 2026-11-01 02:00 EDT → 01:00 EST, so 01:30 happens
      // once at -04:00 and again at -05:00.
      const result = toInstant('2026-11-01T01:30', 'America/New_York');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.adjusted).not.toBeNull();
      expect(result.adjusted!.reason).toBe('ambiguous');
      expect(result.adjusted!.detail).toContain('happens twice');

      // The earlier instant: 01:30 EDT, which is 05:30 UTC. Luxon's own
      // default is the *later* one, so this is a deliberate choice — a
      // reminder an hour early is a smaller wrong than one an hour late.
      expect(result.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    });

    it('picks the earlier of the two, for London', () => {
      // Clocks go back 2026-10-25 02:00 BST → 01:00 GMT.
      const result = toInstant('2026-10-25T01:30', 'Europe/London');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.adjusted!.reason).toBe('ambiguous');
      // 01:30 BST is 00:30 UTC.
      expect(result.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    });

    it('reports nothing unusual in a zone with no daylight saving', () => {
      // India does not observe it, so neither date is special there.
      for (const iso of ['2026-11-01T01:30', '2026-03-29T01:30']) {
        const result = toInstant(iso, 'Asia/Kolkata');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.adjusted).toBeNull();
      }
    });
  });

  describe('instant to local reading', () => {
    it('presents an instant as it reads on a clock in the zone', () => {
      const instant = new Date('2026-11-10T02:30:00.000Z');

      const kolkata = fromInstant(instant, 'Asia/Kolkata');
      expect(kolkata.local).toBe('2026-11-10T08:00:00.000+05:30');
      expect(kolkata.display).toBe('Tue, 10 Nov 2026, 08:00');
      expect(kolkata.offsetMinutes).toBe(330);

      const london = fromInstant(instant, 'Europe/London');
      expect(london.display).toBe('Tue, 10 Nov 2026, 02:30');
      expect(london.offsetMinutes).toBe(0);
    });

    it('falls back to UTC for a zone it cannot read, rather than throwing', () => {
      // A display helper must not be the thing that fails a response.
      const reading = fromInstant(new Date('2026-11-10T02:30:00.000Z'), 'Mars/Olympus');
      expect(reading.zone).toBe('UTC');
    });
  });

  describe('recurrence rules', () => {
    const start = new Date('2026-11-09T03:30:00.000Z'); // Mon 09:00 Kolkata

    it('accepts an ordinary weekly rule and describes it', () => {
      const info = parseRecurrence('FREQ=WEEKLY;BYDAY=MO', start, 'Asia/Kolkata');
      expect(info.rrule).toContain('FREQ=WEEKLY');
      expect(info.description.toLowerCase()).toContain('week');
      expect(info.minIntervalMinutes).toBe(7 * 24 * 60);
    });

    it('accepts a daily rule', () => {
      const info = parseRecurrence('FREQ=DAILY', start, 'Asia/Kolkata');
      expect(info.minIntervalMinutes).toBe(24 * 60);
    });

    it('accepts an RRULE: prefix as well as a bare rule', () => {
      expect(parseRecurrence('RRULE:FREQ=DAILY', start, 'UTC').rrule).toContain('FREQ=DAILY');
    });

    it('refuses a rule that repeats too often', () => {
      // A reminder every minute is a scheduling problem, not a preference.
      expect(() => parseRecurrence('FREQ=MINUTELY', start, 'UTC')).toThrow(AppError);
      expect(() => parseRecurrence('FREQ=SECONDLY', start, 'UTC')).toThrow(AppError);
      expect(() => parseRecurrence('FREQ=MINUTELY;INTERVAL=5', start, 'UTC')).toThrow(AppError);
      // At the boundary it is allowed.
      expect(
        parseRecurrence(`FREQ=MINUTELY;INTERVAL=${MIN_RECURRENCE_MINUTES}`, start, 'UTC')
          .minIntervalMinutes,
      ).toBe(MIN_RECURRENCE_MINUTES);
    });

    it('refuses a rule that never produces an occurrence', () => {
      expect(() => parseRecurrence('FREQ=YEARLY;COUNT=0', start, 'UTC')).toThrow(AppError);
    });

    it('refuses an unreadable or oversized rule', () => {
      expect(() => parseRecurrence('', start, 'UTC')).toThrow(AppError);
      expect(() => parseRecurrence('NONSENSE', start, 'UTC')).toThrow(AppError);
      expect(() => parseRecurrence('FREQ=DAILY'.padEnd(250, ';X=1'), start, 'UTC')).toThrow(AppError);
    });
  });

  describe('recurrence across a daylight-saving change', () => {
    it('keeps the wall-clock hour, moving the instant instead', () => {
      // A weekly 09:00 London reminder, starting in summer time.
      const firstMonday = toInstant('2026-10-19T09:00', 'Europe/London');
      expect(firstMonday.ok).toBe(true);
      if (!firstMonday.ok) return;
      // 09:00 BST is 08:00 UTC.
      expect(firstMonday.instant.toISOString()).toBe('2026-10-19T08:00:00.000Z');

      // The next occurrence falls after the clocks go back on 25 October.
      const next = nextOccurrence(
        'FREQ=WEEKLY;BYDAY=MO',
        firstMonday.instant,
        'Europe/London',
        firstMonday.instant,
      );
      expect(next).not.toBeNull();

      // Still 09:00 on the wall, so now 09:00 GMT — a *different* instant.
      // Without the zone round trip it would have drifted to 08:00 local.
      expect(fromInstant(next!, 'Europe/London').display).toBe('Mon, 26 Oct 2026, 09:00');
      expect(next!.toISOString()).toBe('2026-10-26T09:00:00.000Z');
    });

    it('keeps the hour across a spring-forward change too', () => {
      const before = toInstant('2026-03-23T09:00', 'Europe/London');
      expect(before.ok).toBe(true);
      if (!before.ok) return;

      const next = nextOccurrence(
        'FREQ=WEEKLY;BYDAY=MO',
        before.instant,
        'Europe/London',
        before.instant,
      );
      expect(fromInstant(next!, 'Europe/London').display).toBe('Mon, 30 Mar 2026, 09:00');
      // 09:00 BST once the clocks have gone forward.
      expect(next!.toISOString()).toBe('2026-03-30T08:00:00.000Z');
    });

    it('does not drift in a zone with no daylight saving', () => {
      const start = toInstant('2026-10-19T09:00', 'Asia/Kolkata');
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      let cursor = start.instant;
      for (let week = 0; week < 6; week += 1) {
        const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', start.instant, 'Asia/Kolkata', cursor);
        expect(next).not.toBeNull();
        expect(fromInstant(next!, 'Asia/Kolkata').display).toContain('09:00');
        cursor = next!;
      }
    });

    it('returns nothing once a bounded series has ended', () => {
      const start = new Date('2026-11-09T03:30:00.000Z');
      const second = nextOccurrence('FREQ=DAILY;COUNT=2', start, 'UTC', start);
      expect(second).not.toBeNull();
      expect(nextOccurrence('FREQ=DAILY;COUNT=2', start, 'UTC', second!)).toBeNull();
    });

    it('returns nothing for a rule it cannot read', () => {
      expect(nextOccurrence('NONSENSE', new Date(), 'UTC', new Date())).toBeNull();
    });
  });

  describe('the schedulable window', () => {
    it('accepts a time in the near future', () => {
      expect(() => assertSchedulable(new Date(Date.now() + 60_000))).not.toThrow();
    });

    it('refuses the past', () => {
      expect(() => assertSchedulable(new Date(Date.now() - 1_000))).toThrow(AppError);
    });

    it('refuses something absurdly far ahead', () => {
      // Almost certainly a parsing mistake — a model reading 2026 as 2126 —
      // rather than a plan.
      expect(() =>
        assertSchedulable(new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS + 86_400_000)),
      ).toThrow(AppError);
    });

    it('refuses an unreadable instant', () => {
      expect(() => assertSchedulable(new Date('nonsense'))).toThrow(AppError);
    });
  });

  describe('notification preferences', () => {
    it('are on by default, with no quiet hours', () => {
      expect(DEFAULT_NOTIFICATION_PREFERENCES.enabled).toBe(true);
      expect(DEFAULT_NOTIFICATION_PREFERENCES.mutedTypes).toEqual([]);
      expect(DEFAULT_NOTIFICATION_PREFERENCES.quietFromMinute).toBeNull();
    });

    it('salvage the valid parts of a malformed document', () => {
      const parsed = parseNotificationPreferences({
        enabled: false,
        mutedTypes: ['reminder.due'],
        quietFromMinute: 'midnight',
      });
      expect(parsed.enabled).toBe(false);
      expect(parsed.mutedTypes).toEqual(['reminder.due']);
      expect(parsed.quietFromMinute).toBeNull();
      expect(parseNotificationPreferences('nonsense').enabled).toBe(true);
    });

    it('handle a quiet window that crosses midnight', () => {
      // 22:00 to 07:00 is the common case and the one a naive comparison
      // gets backwards.
      const overnight = parseNotificationPreferences({
        quietFromMinute: 22 * 60,
        quietToMinute: 7 * 60,
      });
      expect(isQuiet(overnight, 23 * 60)).toBe(true);
      expect(isQuiet(overnight, 2 * 60)).toBe(true);
      expect(isQuiet(overnight, 6 * 60 + 59)).toBe(true);
      expect(isQuiet(overnight, 7 * 60)).toBe(false);
      expect(isQuiet(overnight, 12 * 60)).toBe(false);
    });

    it('handle a quiet window inside one day', () => {
      const daytime = parseNotificationPreferences({
        quietFromMinute: 9 * 60,
        quietToMinute: 17 * 60,
      });
      expect(isQuiet(daytime, 10 * 60)).toBe(true);
      expect(isQuiet(daytime, 17 * 60)).toBe(false);
      expect(isQuiet(daytime, 3 * 60)).toBe(false);
    });

    it('treat an absent or degenerate window as no quiet hours', () => {
      expect(isQuiet(DEFAULT_NOTIFICATION_PREFERENCES, 3 * 60)).toBe(false);
      const degenerate = parseNotificationPreferences({
        quietFromMinute: 600,
        quietToMinute: 600,
      });
      expect(isQuiet(degenerate, 600)).toBe(false);
    });
  });
});
