# VST SPD — Backend API

The API half of **VST SPD — Pre-Packing Process Automation**, the system
specified in `VST_SPD_PrePacking_SRS.docx`. The console that talks to it lives
in [Vistar_SPD_FE](https://github.com/warehousevistar/Vistar_SPD_FE).

The system digitises the SPD pre-packing cycle end to end: the SAP GRN export is
uploaded once, validated column by column and displayed invoice- and
part-number-wise; ID labels are generated and printed from that data, split by
MOQ where the part has one; lines are allocated to packing tables; table members
start and submit packing with the times captured for them; packed and pending
quantities reconcile in real time;
exceptions are flagged for the Supervisor; hourly reports are generated and
emailed; and the MIS is written automatically the moment the shift is finalised.

Node.js / Express / PostgreSQL. Serves the Flutter console and holds every
business rule in SRS section 10. The application owns its **own PostgreSQL
database** (`vistar_spd`) — it is not a schema inside another product.

## Quick start

Needs Node 20.11+ (tested on 24.15) and PostgreSQL 14+ (tested on 18.3).

```bash
createdb vistar_spd          # or: psql -U postgres -c "CREATE DATABASE vistar_spd;"

cp .env.example .env         # then set DATABASE_URL and JWT_SECRET
npm install
npm run seed                 # loads the approved demo shift; --reset rebuilds it
npm start                    # http://localhost:4100/api
```

The schema is applied automatically on start (`src/db/schema.sql`, every
statement `IF NOT EXISTS`), so there is no separate migration step.

```bash
curl http://localhost:4100/api/health
npm test                     # end-to-end, walks the SRS use cases in order
```

### Demo sign-in

The seed loads the two shifts the approved prototype shows: `Shift A ·
09-Sep-2026` (open, mid-shift, with one deliberate over-pack that produces an
Excess Entry exception) and `Shift A · 08-Sep-2026` (finalised, with its MIS and
a logged resubmission).

| Role | User ID | Credential |
|---|---|---|
| Supervisor | `sup.rmenon` | `vistar@2026` |
| Administrator | `adm.itcell` | `vistar@2026` |
| Management | `mgt.avohra` | `vistar@2026` |
| Table Member | pick from the list | PIN = last 4 of the employee code (e.g. Sandeep Singh → `4412`), or `vistar@2026` |

**These are seed values for review only.** Everything in the seed — the names,
the employee codes, the email addresses — is sample data for demonstrating the
workflow. The first thing a real deployment does is change the credentials
through the Admin console and set a real `JWT_SECRET`.

```
src/
├── config.js            environment, with a minimal .env loader
├── server.js            app assembly, shutdown, the hourly scheduler
├── db/
│   ├── index.js         pg pool, query helpers, tx(), migrate()
│   ├── schema.sql       the SRS section 7 data dictionary, one table per entity
│   └── seed.js          the approved demo shift, reproduced from the prototype's generator
├── lib/
│   ├── compute.js       the reconciliation engine — packed, pending, statuses, stats
│   ├── packing.js       Start / Submit, BR-02, BR-03, the exception rules
│   ├── settings.js      FR-13.2 configuration, defaults merged with app_config
│   ├── audit.js         NFR-3.3 append-only trail
│   └── ids.js           the human-readable id series (TX0107, EX014, AL051…)
├── middleware/
│   ├── auth.js          JWT, roles, the member's table
│   ├── error.js         HttpError, and PostgreSQL violations turned into specific messages
│   └── upload.js        the GRN file, parsed in memory and discarded
├── routes/              one router per module of SRS section 4
└── services/
    ├── grnImport.js     FR-1.2 / FR-1.3 structural and row-level validation
    ├── excelExport.js   FR-12.1 workbook and CSV
    ├── labels.js        FR-3 label PDF, QR encoder
    ├── mailer.js        FR-8.2 SMTP delivery
    └── hourly.js        UC-06 report generation and the scheduler
```

## Commands

```bash
npm install
npm run seed       # load the demo shift (skips if the database already has users)
npm run reset      # wipe the operational tables and seed again
npm start          # serve on PORT (default 4100)
npm run dev        # the same, with --watch

npm run test:unit  # lib/, services/ and the schema — no server needed
npm run test:api   # end-to-end against a running server
npm test           # both
```

`test:unit` covers the logic a shift only reaches occasionally: the GRN import's
rejection paths, the reconciliation precedence, the submission thresholds, CSV
escaping, and the label encoders. The schema tests in it want a PostgreSQL to
talk to and skip themselves with a reason when there is none, so the command
still runs anywhere.

**The QR encoder is checked by decoding it.** `services/labels.js` writes the
bit stream, Reed-Solomon, block interleaving, module placement and masking by
hand, and nothing downstream would notice if that were subtly wrong — the label
prints, it looks like a QR code, and the fault only appears when someone on the
floor points a scanner at it. So `test/labels.test.js` carries a decoder written
from the specification's reading order, proves it against matrices from an
independent implementation (the Dart `qr` package, captured by
`frontend/tool/qr_reference.dart` — one per version), and then reads our own
codes back to their payloads, checking each block's error-correction syndromes
the way a scanner does.

The encoder emits the smallest version that holds the payload and throws if none
does:

| version | modules | payload | module at 56pt | 203dpi dots |
|---|---|---|---|---|
| 2-M | 25×25 | ≤ 26 bytes | 0.790 mm | 6.3 |
| 3-M | 29×29 | ≤ 42 bytes | 0.681 mm | 5.4 |
| 4-M | 33×33 | ≤ 62 bytes | 0.599 mm | 4.8 |

It stops at 4 for ink, not for code. Versions 5 and 6 need nothing the routine
does not already do — the same single alignment pattern at (size-7, size-7), no
version-information blocks until 7, equal-sized Reed-Solomon blocks at level M —
but the label draws the code 56pt square whatever version it is, so the module
shrinks as the payload grows: 0.534 mm at version 5 and 0.482 mm at version 6,
which is 4.3 and 3.9 dots on a 203 dpi head. Below about four dots a module the
printer rounds modules to different widths and the code stops scanning reliably,
so a payload that would need version 5 is refused instead. Adding them back is
two table rows, but the label would have to draw a bigger square first.

Where that limit falls: `PART_RE` caps a part number at 40 characters, which
against a three-digit quantity leaves 17 for the invoice number — `invoice_no`
has no length rule of its own. An ordinary ten-character part number leaves 47.
So the refusal bites only where a maximum-length part meets a long invoice.

The encoder used to be fixed at version 2 and silently cut anything longer, which
produced a valid, scannable code carrying the wrong part number — a legitimate
40-character part number is enough to trigger it. A payload that fits version 2
still produces byte-for-byte the code it always did, so labels already printed
keep scanning; `test/labels.test.js` pins that down against matrices captured
from the previous implementation.

**The constraints are checked by breaking them.** Reading `schema.sql` tells you
what a CHECK is meant to say, not whether PostgreSQL agrees — a subtly wrong
boolean, a partial unique index whose `WHERE` never matches, a foreign key that
cascades where it should refuse all read correctly and none of them bite. So
`test/schema.test.js` hands the database a row that breaks each rule and insists
on a refusal, checking the SQLSTATE *and* the constraint name so a probe cannot
pass because some other rule fired first. It then checks the seed as data:
referentially sound, BR-01 satisfied on all 42 lines, exactly one deliberate
over-pack carrying its Excess Entry, the MIS agreeing with the transactions it
was taken from, and `--reset` reproducing the shift byte for byte. Everything
runs against a scratch `vistar_spd_test` database, which the suite creates and
rebuilds itself; set `SPD_TEST_DB` to change the name, which must end in
`_test`.

## API

All routes are under `/api`. Everything except `/api/health`,
`/api/auth/members` and `/api/auth/login` requires a bearer token.

### Auth
| | |
|---|---|
| `GET /auth/members` | the roster the login picker draws (FR-5.1) — name, employee code, table only |
| `POST /auth/login` | `{userId, password}` or `{userId, pin}` for a Table Member |
| `GET /auth/me` | the signed-in user and their table |
| `POST /auth/logout` | logs the sign-out |

### GRN
| | |
|---|---|
| `GET /shifts` · `POST /shifts` | the shift list; creating one |
| `GET /grn/batches` | import history (FR-1.6) |
| `POST /grn/upload` | multipart `file` + `shiftId`; `confirm=true` + `reason` overrides BR-08 |
| `POST /grn/errors.csv` | the rejected-row list as a downloadable file; post back the `errors` array from an upload response. The console builds this file itself from the rows it already holds, so this exists for other clients. |
| `DELETE /grn/batches/:id` | only while nothing has been packed against it |

### Lines & labels
| | |
|---|---|
| `GET /lines` | invoice/part listing with live packed and pending (FR-2) |
| `GET /lines/:id` | one line with its transactions, exceptions and allocations |
| `GET /labels/:lineId/preview` | every label the line prints (FR-3.5), each with its own quantity and QR modules |
| `POST /labels/:lineId/print` | logs the print; a reprint needs a reason (BR-09) |
| `GET /labels/sheet.pdf` | the printable sheet (FR-3.2) |
| `GET /labels/log` | the print log |

### Floor
| | |
|---|---|
| `GET /tables` | the live status board (FR-4.3) |
| `GET /allocations` · `POST /allocations` · `DELETE /allocations/:id` | FR-4.1, BR-04 |
| `POST /tables` · `PATCH /tables/:tableNo` | the table master |
| `GET /my/queue` | the member's own lines (BR-05) |
| `POST /my/start` · `POST /my/submit` | FR-6.1 – FR-6.4 |
| `GET /my/preview` | the live warning shown as a quantity is typed (FR-7.2) |
| `GET /my/history` | the member's submissions |

### Review, reports, admin
| | |
|---|---|
| `GET /review` | packed/pending, exceptions, table- and member-wise (FR-9.1) |
| `PATCH /exceptions/:id` | remarks, and optionally resolve (FR-9.2) |
| `POST /shifts/:id/finalise` | locks the shift and writes the MIS (FR-9.3, FR-10.1) |
| `POST /shifts/:id/reopen` | needs a reason; logged as a resubmission (BR-06) |
| `GET /dashboard` · `GET /notifications` · `GET /search` · `GET /facets` | FR-11 |
| `GET /hourly` · `GET /hourly/:id` · `POST /hourly/generate` | FR-8 |
| `GET /mis` | `dim` = `line` \| `inv` \| `table` \| `member` (FR-10.2) |
| `GET /export/:key/:fmt` | `key` = `mis` \| `audit` \| `lines` \| `hourly`; `fmt` = `xlsx` \| `csv` |
| `GET /users` · `POST /users` · `PATCH /users/:id` | FR-13.1 |
| `GET /config` · `PUT /config` | FR-13.2 |
| `GET /audit` | NFR-3.3 |

## Notes

- **FR-3.5 — the MOQ label split.** A GRN line is printed as one label per MOQ
  pack plus a remainder: 350 against an MOQ of 300 is a 300 label and a 50
  label, because that is how the material leaves the table. Each label carries
  its own quantity, and therefore its own QR — a scanner pointed at the 50-unit
  pouch has to read 50. The index is deliberately *not* in the payload: two
  packs of the same size are interchangeable, and it is the printed "1 of 2"
  that tells them apart. (It was once a budget question too — the encoder held
  26 bytes and truncated anything longer. It now picks the smallest QR version
  that fits and refuses what will not fit at all, so this is a decision about
  what a scan should mean rather than a limit.)
  The GRN quantity stays on the label beside the pack quantity, so FR-3.1 is
  still satisfied.

  MOQ arrives in the **MOQ** column of the SAP export. It is *optional*
  (`grnColsOptional`, not `grnCols`): making it required would reject every
  export produced before the rule existed, and a line without one prints the
  single whole-quantity label it always did. A value that is present but
  unusable is a row error rather than a silent `null`, because dropping it would
  print one label where two were needed and nobody would know.

  `splitByMoq` arithmetic runs in hundredths. Quantities are `NUMERIC(14,2)`,
  and a decimal MOQ divided in floating point leaves dust in the *remainder* —
  the one label a supervisor is least likely to re-check.

  A mistyped MOQ (1 where 100 was meant) would turn one line into thousands of
  labels and build the sheet a page at a time in memory. The import refuses it
  by row and column, naming how many labels it would have printed, and
  `grn_lines_moq_label_count` is the backstop for anything reaching the table
  another way.

- **NUMERIC and DATE parsing.** `pg` returns `numeric` as a string and `date` as
  a local-midnight `Date`; both are overridden in `db/index.js`. The date one is
  not cosmetic — leaving it as a `Date` named the 9-Sep shift's MIS snapshot
  `MIS-0908` for anyone east of UTC.
- **Transactions.** `tx()` hands the callback a query helper bound to one client.
  Using the pool helpers inside a transaction would silently run on a different
  connection, which is exactly the bug that only appears under the concurrent
  submissions NFR-2.2 asks for.
- **Error messages.** NFR-4.2 wants the exact row, column or limit named. The
  error handler translates the PostgreSQL violations the API can provoke rather
  than letting `duplicate key value violates unique constraint` reach a user.

## Where the business rules live

Every rule in SRS section 10 is enforced **here, on the server**, so it holds
whatever the client does. The console mirrors each one so the user is told
before they are refused, never instead of it.

| Rule | Enforced in |
|---|---|
| BR-01 Pending = GRN − packed | `src/lib/compute.js` — derived from the transactions, never a stored total |
| BR-02 quantity must be a whole number > 0 | `src/lib/packing.js` |
| BR-03 over-pack is flagged and blocks finalisation until annotated | `src/lib/packing.js`, `src/routes/review.routes.js` |
| BR-04 one line, one table — unless explicitly split with a reason | `src/routes/alloc.routes.js` + a unique index on `(line_id, table_no)` |
| BR-05 a member acts only on their own table's lines | `src/routes/packing.routes.js` — the table comes from the token, not the request |
| BR-06 a finalised shift locks member entry; reopening is a logged resubmission | `src/routes/review.routes.js`, `src/lib/packing.js` |
| BR-07 the MIS is provisional until final submission | `src/routes/reports.routes.js` |
| BR-08 a duplicate GRN batch is blocked without a confirmed reason | `src/routes/grn.routes.js` |
| BR-09 label reprints and overrides are logged with a reason | `src/routes/lines.routes.js`, `src/routes/review.routes.js` |
| NFR-7.1 a submitted transaction is immutable | `src/lib/packing.js` — a correction is a new row, never an edit |
| NFR-2.2 concurrent submissions | `SELECT … FOR UPDATE` on the line inside one transaction |

## Notes for deployment

- Put the API behind HTTPS and set `CORS_ORIGIN` to the console's origin rather
  than leaving it `*`.
- `JWT_SECRET` must be changed; the default is a development value.
- Change the seeded credentials through the Admin console before go-live.
- Back the database up on the organisation's schedule (NFR-8.1). Everything the
  application knows is in PostgreSQL — the API keeps no state of its own, so a
  restore of the database is a complete restore.
- The GRN import column mapping is configuration, not code (NFR-6.1). A change
  to the SAP export header is edited in the console's **Masters & Config**
  screen, not in a release.
