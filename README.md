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
npm run dev     # server :8080, web :5173, mock Claru :4010, mock Graph :4020
npm run check   # typecheck + lint + tests
```

Open http://127.0.0.1:5173.

## Rules

- `.env` holds secrets and is never committed. `.env.example` lists every setting.
- Development talks to the mocks. Real Claru needs `ALLOW_REAL_CLARU=yes` and is used
  only in the controlled test.
- Each phase is applied by a script and committed as one Git commit.
