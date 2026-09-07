# Planckian Hot Desk Booking

A tiny standalone static site to see and book hot desks for **today**, the
**day after**, or the **day after tomorrow** (visitor's choice, the two
forward options skip weekends). Room A (4 desks, desk 1 permanently held by
Alessio), Room B (4 desks), and 3 overflow "extra" spots.

The page is the only thing people interact with. Behind the scenes it uses a
Google Form as the write path and a published Google Sheet (as CSV) as the read
path — no server, no third-party account beyond Google, free.

## 1. The Google Form (already set up)

The form ("Booking a table" / "these desks are hot") already exists with 5
questions: `Name` (short answer), `When` (multiple choice: Morning /
Afternoon / Whole day), `Room` (multiple choice: Room A / Room B / Extra),
`Date` (native date question), `Desk` (short answer, free text like `A2`,
`B3`, `X1`). Nobody fills this form in directly — the site submits to it
silently in the background.

`js/config.js` already has the real `FORM_ACTION_URL` and all 5
`ENTRY_IDS` wired in. You only need step 2 below (`CSV_URL`) to finish setup.
If the form's questions are ever rebuilt from scratch, the entry IDs will
change — get the new ones by opening the form's `viewform` URL, running
`JSON.stringify(window.FB_PUBLIC_LOAD_DATA_)` in the browser console, and
reading off each question's id from that structure (or send me the link and
I'll do it).

## 2. The response Sheet (already set up)

The response Sheet's current sharing setting already allows link-based
access, so `js/config.js` reads it directly via Google's CSV export endpoint:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv
```

No "Publish to web" step needed *as long as that sharing stays as-is*. If
someone later tightens the Sheet's sharing (e.g. restricts it to specific
people), this export URL will start failing — in that case, use
**File → Share → Publish to web** on the Sheet instead (pick the response
tab, format CSV, Publish) and swap the resulting `.../pub?output=csv` URL
into `CSV_URL`.

Setup is otherwise complete — done by whoever owns the Google account this
lives under (a shared/company account is best so it isn't tied to one
person).

## 3. Deploy to GitHub Pages

1. Push this folder as a new repo (or into an existing one) on GitHub.
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → branch
   `main`, folder `/ (root)` → Save.
3. GitHub gives you a URL like `https://<org>.github.io/<repo>/` — share that
   with the office.

## Notes / limitations

- **Booking date is a picker, not fixed.** A dropdown at the top lets the
  visitor choose **today**, **day after**, or **day after tomorrow**. "Today"
  is the plain current date (so you can see who's actually in the office
  right now); the two forward options are *business days* (Saturday/Sunday
  skipped entirely), so from a Friday they resolve to Monday and Tuesday.
  Defaults to "day after" on first load. Computed fresh in the visitor's
  browser on every load/refresh; no daily reset needed. See
  `targetDateOptions()` / `addBusinessDays()` / `DEFAULT_OPTION_LABEL` in
  `js/app.js` to change the offsets, the default, or add more options.
- **Alessio's desk (Room A, Desk 1)** is hard-coded in `js/app.js` — it never
  reads from the sheet and can't be booked through the UI. Edit the
  `fixedOccupant` field there if this ever changes.
- **Half-day splitting.** If a desk is booked for only "Morning" or only
  "Afternoon", its card splits in two — the booked half shows the occupant,
  the free half gets its own small "Book" button that locks straight to that
  half (no Morning/Afternoon/Whole day choice needed, since only one option
  is actually free). A "Whole day" booking always occupies both halves, same
  as before splitting existed.
- **Update lag:** Google's "Publish to web" CSV can take up to a minute or two
  to reflect a brand-new form response for *other* visitors. The person who
  just booked sees their own booking immediately (optimistic local state);
  everyone else sees it once the Sheet republishes and the page's periodic
  refresh (default: every 60s) picks it up.
- **No login, no double-booking lock.** This is meant for a small, trusted
  office. Two people booking the same desk within the same refresh window is
  possible in theory; if it happens, sort it out in person (or edit the Sheet
  by hand to remove the duplicate row).
- **Canceling a booking** isn't exposed in the UI. To free up a desk someone
  booked by mistake, delete that row directly in the Google Sheet.
- **Date column parsing:** the `Date` question is Google's native date-picker
  type, so the Sheet shows it as locale-formatted text (e.g. `4/9/2026`)
  rather than ISO. The site parses this defensively (`parseSheetDateToIso` in
  `js/app.js`) and assumes day-before-month when a date is ambiguous (e.g.
  `4/9`), which matches most locales outside the US. If desks ever seem to
  show up on the wrong day, check the Sheet's actual date format and adjust
  that function.
- All styling is plain CSS in `css/style.css`, no build step, no dependencies.
