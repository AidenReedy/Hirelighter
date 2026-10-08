# Hirelighter

[![CI](https://github.com/AidenReedy/hirelighter/actions/workflows/ci.yml/badge.svg)](https://github.com/AidenReedy/hirelighter/actions/workflows/ci.yml)

A self-hosted resume builder and job tracker with a highlighter-and-marker look.

- **One bank of everything.** Jobs, projects, bullets and skills live in one place. Add a bullet once and every resume can use it.
- **Tailored versions in a few clicks.** Check, uncheck and drag bullets per resume ("SOC", "Pentest", "Company X") with a live preview, then download a PDF (default), Word file, or the LaTeX source. Downloads are named `First_Last.pdf`.
- **Pixel-faithful PDFs.** Built with `pdflatex` from [Jake's Resume](https://github.com/jakegut/resume) template, the same one many people use on Overleaf.
- **Job tracker.** After a download you can log the application (or skip). Track status and interview counts, keep the exact file you sent, and see your search as a Sankey diagram.
- **Rejections from Gmail (optional).** Reads one Gmail label and marks jobs rejected when the email is clear, with Undo. Anything unclear waits for you to review.
- **Easy setup.** Download the blank template, fill it in, upload it. Or upload a resume you already have in Jake's format.
- **Private by design.** Runs on your own machine. No accounts, no cloud, no tracking.

## Quick start (Docker)

You need Docker. Make a folder with these two files from this repo: [`docker-compose.yml`](docker-compose.yml) and [`.env.example`](.env.example) (renamed to `.env`).

```bash
cp .env.example .env        # set APP_PASSWORD and TZ (see below)
docker compose up -d
```

Open `http://<this machine's IP>:8080` (LAN or Tailscale) and follow the setup screen:

1. **Download the blank template** and fill it in (any text editor, or Overleaf).
2. **Upload it.** You'll see what was found before anything is saved.
3. Or **start from scratch** and type everything in the Content tab.

The image (`ghcr.io/aidenreedy/hirelighter`) runs on x86-64 and ARM64 (Raspberry Pi, Apple Silicon). It's about 1 GB, mostly TeX Live.

### Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `BIND_IP` | all IPs | Leave blank to listen on every IP the machine has (LAN and Tailscale). Set one address to restrict it, e.g. `127.0.0.1` (this computer only) or your Tailscale IP. |
| `PORT` | `8080` | Port to listen on. |
| `TZ` | `UTC` | Timezone for dates the server fills in, e.g. `America/New_York`. |
| `MAX_BULLET_CHARS` | `107` | Bullets longer than this are flagged in the Builder's hints. 107 fits one line in the default template. |
| `APP_USER` / `APP_PASSWORD` | `admin` / empty | Login prompt for the whole app (HTTP basic auth). **Recommended.** Empty password = off. |

### Updating

```bash
docker compose pull && docker compose up -d
```

Or turn on automatic updates with Watchtower (checks every 6 hours):

```bash
docker compose --profile autoupdate up -d
```

Watchtower needs access to the Docker socket, which is root-level access to the host. Skip it if that's not OK for your setup.

### Backups

Click **Backup** in the top bar. You get a zip with `app.db` (everything) and `sent/` (the exact files you sent). To restore:

```bash
docker compose cp app.db hirelighter:/data/app.db && docker compose restart
```

## Gmail rejection tracking (optional)

A separate service reads one Gmail label and updates the Jobs tab:

- **Application received** emails are linked to the job, so later emails from the same sender match it more reliably.
- **Clear rejections** ("we've decided to move forward with other candidates") change **Applied** to **Rejected**, and **Interviewing** to **Rejected after interview**. Each change can be undone for 14 days and shows "(from email)" in the job's history.
- **Unclear emails** ("unfortunately, the role is on hold"), rejections that don't clearly match one job, and anything for a job in another status wait in **Jobs > Email > To review**, where you pick the job or dismiss it.

Setup:

1. Turn on [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification) for your Google account, then create an [app password](https://myaccount.google.com/apppasswords) named "Hirelighter".
2. In Gmail, create a label called `Jobs` and a filter that applies it to application emails (for example, from `greenhouse.io`, `lever.co`, `myworkday.com`, or containing "your application"). Only this label is read.
3. Add `GMAIL_USER` and `GMAIL_APP_PASSWORD` to `.env` (see `.env.example`), then run `chmod 600 .env`.
4. Start it:

   ```bash
   docker compose --profile mail up -d
   ```

5. Watch the first check to confirm it signs in and finds the label:

   ```bash
   docker compose logs -f hirelighter-mail
   ```

   Errors also show in **Jobs > Email**.

Tip: start with `MAIL_AUTO_APPLY=0` for a week or two. Every match then waits for you in **To review**, so you can see how well it matches your emails before letting it change statuses on its own. Switch to `1` and run `docker compose --profile mail up -d` again once you trust it.

| Variable | Default | What it does |
|---|---|---|
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | empty | The account and its app password. `GMAIL_APP_PASSWORD_FILE` can point at a file (e.g. a Docker secret) instead. |
| `GMAIL_LABEL` | `Jobs` | The only label that's read. |
| `MAIL_CHECK_MINUTES` | `15` | How often to check. **Check now** in the Jobs tab checks within 30 s. |
| `MAIL_AUTO_APPLY` | `1` | `0` sends every match to review instead of changing statuses on its own. |

How it handles your mail:

- An app password can read your whole mailbox, so the watcher runs in its own container and only it gets the password. It's never stored in the database (which goes into backups) or logged.
- The label is opened read-only over TLS: nothing is deleted, moved, or marked as read.
- Unrelated emails leave only their Message-ID behind (so they aren't read twice). For application emails, only the sender, subject, date and a short excerpt are kept. HTML is never displayed, and images and links are never loaded.
- Revoke access any time by deleting the app password in your Google account.
- Set `APP_PASSWORD` too, or anyone who can reach Hirelighter can read the excerpts. The Jobs tab warns you if it's off.

## Security

Hirelighter has no user accounts and is meant for **one person on a private network**.

- Don't expose it to the internet: no port forwarding, no public reverse proxy. Reach it over a VPN like Tailscale.
- It listens on all of the machine's IPs by default, so anything that can reach the machine can reach the app. Set `APP_PASSWORD`, or set `BIND_IP` to limit it to one address.
- If you also host public services, keep them on a separate machine or VLAN that can't reach this one.
- Gmail tracking is off unless you start the `mail` profile. When on, the only outbound connection is to `imap.gmail.com:993`. See [Gmail rejection tracking](#gmail-rejection-tracking-optional).
- The container is read-only, runs as a non-root user with all capabilities dropped, and is limited to 512 MB and 1 CPU. LaTeX runs with `-no-shell-escape` and a 20 s timeout, and all text is escaped before it reaches LaTeX.

## Importing from the command line

Instead of the setup screen, you can load a resume before first start:

```bash
docker compose run --rm -v "$PWD:/import:ro" hirelighter python -m app.seed /import/main.tex
```

It accepts a Jake's-template `.tex` or the app's own `.json` format, and only runs on an empty database. Once there's content, use **Content > Import .tex**, which replaces the content bank and keeps your jobs.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt pytest     # Windows: .venv\Scripts\pip
.venv/bin/python -m app                              # http://127.0.0.1:8080
.venv/bin/python -m pytest
GMAIL_USER=... GMAIL_APP_PASSWORD=... .venv/bin/python -m app.mailwatch   # optional, alongside the app
```

PDF output needs `pdflatex` (TeX Live, MacTeX, or MiKTeX). Without it, Word export and everything else still work.

To build the image from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Keep personal files in `private/`, which git ignores. If `private/main.tex` exists, the tests also check that it round-trips exactly.

### CI/CD

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the tests on every push and pull request. Pushes to `main` and `v*` tags build a multi-arch image (the build compiles a test resume, so broken LaTeX fails it) and publish to GHCR as `latest`, the version, and the commit SHA.

## Credits

The PDF layout is [Jake's Resume](https://github.com/jakegut/resume) by Jake Gutierrez (MIT), based on [sb2nov/resume](https://github.com/sb2nov/resume). The Permanent Marker font is licensed under the SIL Open Font License; see `app/static/vendor/permanent-marker-LICENSE.txt`.
