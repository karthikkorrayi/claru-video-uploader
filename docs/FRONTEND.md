# Dashboard development

The UI uses the existing React/Vite workspaces and state-based page navigation.
API calls, session cookies, CSRF protection, server validation, and admin/consultant
authorization remain in the existing modules. Upload stays mounted when navigating
away so active tus transfers can finish.

## Commands

Use Node 22, installed npm dependencies, PostgreSQL, and ffmpeg/ffprobe as described
in the main README. In the prepared cloud environment, start the retained database
with the saved environment startup instructions before starting development.

From the repository root:

```bash
./scripts/frontend.sh dev
```

In a second terminal:

```bash
./scripts/frontend.sh check
```

The check command runs all workspace type checks, lint, and tests, then the web
production build and Git whitespace check. Server tests reset the configured
`TEST_DATABASE_URL` database, which must have a name ending in `_test`; never point
it at the development database. Use `./scripts/frontend.sh build` for just the web
build. The script resolves its own working directory and uses the prepared cloud
Node 22 installation when present. It does not install or rewrite dependencies.

## UI conventions

- Design tokens and responsive layouts live in `web/src/styles.css`.
- `web/src/components/UI.tsx` provides SVG icons, loading and empty states.
- Theme selection defaults to the system preference and is saved as `cvu.theme`.
  Sidebar collapse is saved as `cvu.sidebar`. Both still function when storage is
  unavailable. Uppy receives theme updates without recreating its upload instance.
- Desktop uses a collapsible sidebar. At 900px and below, navigation uses a native
  modal dialog with keyboard focus containment, Escape dismissal, a close button,
  and focus restoration. Wide tables scroll inside labelled keyboard-accessible
  regions rather than widening the page.
- Overview metrics and recent recordings come from the existing role-scoped
  recordings endpoint. There are no synthetic metrics, search, or notification
  controls. The service indicator uses the existing health endpoint.

When changing the shell, verify both roles, forced password changes, logout,
light/dark preference persistence, mobile drawer keyboard behavior, and an upload
that continues while navigating. Check all pages at desktop, tablet, and narrow
mobile widths, including recording details and declaration consent fields.
