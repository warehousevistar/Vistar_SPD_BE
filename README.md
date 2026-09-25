# VST SPD — Backend API

The API half of **VST SPD — Pre-Packing Process Automation**, the system
specified in `VST_SPD_PrePacking_SRS.docx`. The console that talks to it lives
in [Vistar_SPD_FE](https://github.com/warehousevistar/Vistar_SPD_FE).

The system digitises the SPD pre-packing cycle end to end: the SAP GRN export is
uploaded once, validated column by column and displayed invoice- and
part-number-wise; ID labels are generated and printed from that data; lines are
allocated to packing tables; table members start and submit packing with the
times captured for them; packed and pending quantities reconcile in real time;
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
    ├── labels.js        FR-3 label PDF, QR encoder, Code 128
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
npm test           # end-to-end smoke test against a running server
```

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
| `DELETE /grn/batches/:id` | only while nothing has been packed against it |

### Lines & labels
| | |
|---|---|
| `GET /lines` | invoice/part listing with live packed and pending (FR-2) |
| `GET /lines/:id` | one line with its transactions, exceptions and allocations |
| `GET /labels/:lineId/preview` | the label's fields, QR modules and barcode widths |
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
