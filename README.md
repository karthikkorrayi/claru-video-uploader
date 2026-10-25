# Claru Video Uploader

Private web app that receives MP4 recordings, delivers them to Claru through its
supplier API (contract v2), tracks Claru's review, and backs originals up to OneDrive.

## Layout

| Folder    | What it is                                                        |
| --------- | ----------------------------------------------------------------- |
| `server/` | Node 22 + Express API, background jobs (later), PostgreSQL access |
| `web/`    | React + Vite front end                                            |
| `shared/` | Types and constants used by server, web and mocks                 |
| `mocks/`  | Local stand-ins for Claru (port 4010) and Microsoft Graph (4020)  |
| `docs/`   | Claru integration guide (API key redacted) and phase notes        |

## Daily commands

```bash
npm run dev                         # server :8080, web :5173, mock Claru :4010, mock Graph :4020
npm run check                       # typecheck + lint + tests
npm run db:migrate -w @cvu/server   # apply database migrations (the server also does this at start)
```

Create an admin (there is no web page for this, on purpose). The password is read from standard input:

```bash
read -r -s -p "Admin password: " PW; echo
printf '%s' "$PW" | npm run -s admin:create -w @cvu/server -- --username kk --display-name "Karthik" --password-stdin
unset PW
```

Open http://127.0.0.1:5173.

## Uploads (L2)

- Upload page → add MP4 files → Upload. Received files land in `WORK_DIR/<recording id>/original.mp4`.
- Interrupted? Add the same file again; only the missing part is sent.
- `MAX_UPLOAD_GB`, `DISK_RESERVE_GB` and `UPLOAD_ABANDON_HOURS` in `.env` tune the limits.
- Partial uploads live in `TUS_DIR`; keep `TUS_DIR` and `WORK_DIR` on the same disk.

## Checks, clips, declaration (L3)

- After an upload the server checks the file the way Claru will and cuts it into clips
  (`WORK_DIR/<id>/clips/`). Needs `ffmpeg` / `ffprobe` (Homebrew).
- Recordings page → Declare: shared fields once, then capture time and the four consents per recording.
- Clip rules come from `.env` (`CLIP_MIN_SECONDS`, `CLIP_MAX_SECONDS`, `CAPTURE_ASPECT`) and must match Claru's.

## Test server (D1–D5)

`docs/DEPLOY.md`: one DigitalOcean Droplet with HTTPS, mock Claru only. `deploy/` holds the setup and
release scripts; `.github/workflows/` runs the tests on every push and (once switched on) deploys `main`.
Admin → Problems lists server errors, failed jobs and testers' browser errors.

## Rules

- `.env` holds secrets and is never committed. `.env.example` lists every setting.
- Development talks to the mocks. Real Claru needs `ALLOW_REAL_CLARU=yes` and is used
  only in the controlled test.
- Each phase is applied by a script and committed as one Git commit.
- Only the consultant who declared a recording may send its bytes (`server/src/uploads/tus.ts`).
- Consultants see only their own records: every query for owned data goes through
  `ownerScope()` in `server/src/access.ts`, and the tests try to break it.
