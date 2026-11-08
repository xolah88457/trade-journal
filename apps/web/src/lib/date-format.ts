const mediumShort = new Map<string, Intl.DateTimeFormat>();

/** A cached "Jan 2, 2026, 10:00 AM" formatter for the given IANA time zone. */
export function mediumShortDateTime(timeZone: string): Intl.DateTimeFormat {
  let format = mediumShort.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en", { timeZone, dateStyle: "medium", timeStyle: "short" });
    mediumShort.set(timeZone, format);
  }
  return format;
}
