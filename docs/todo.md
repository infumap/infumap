
# Todo

- Calendar ranges on links: a link's range is that of its target, and the server doesn't send link targets with a
  page's children. So that ranges starting before the visible window still show, each past link's target is fetched
  with its own request the first time the calendar is shown (`calendarRangeValues` in
  `web/src/layout/arrange/page_calendar.ts`). For calendars with many links, have the server include link targets
  with the children, or batch these fetches.
