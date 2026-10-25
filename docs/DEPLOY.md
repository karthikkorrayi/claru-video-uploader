# Test server on DigitalOcean

One Droplet runs everything: Caddy (HTTPS) → the Node app → PostgreSQL, plus the mock Claru and
mock Graph. It never talks to the real Claru (`ALLOW_REAL_CLARU=no`; the app refuses real Claru
without it, in every environment).

```
browser ──https──▶ Caddy :443 ──▶ /api/*  → Node app 127.0.0.1:8080 ──▶ PostgreSQL (local socket)
                               └─▶ other  → web/dist (built React app)      └──▶ mock Claru :4010, mock Graph :4020
```

| What | Where on the server |
| --- | --- |
| Releases (code) | `/opt/claru/releases/<time>-<sha>`, live one = `/opt/claru/current` |
| Settings + secrets | `/etc/claru/claru.env` (root + app only; generated on the server) |
| Recordings, clips, partial uploads | `/var/lib/claru/work`, `/var/lib/claru/tus` |
| Logs | journald, 14 days / 2 GB: `claru-logs` |
| HTTPS access log | `/var/log/caddy/claru-access.log` |

## D2 — Create the server (billing starts here)

1. DigitalOcean → **Create → Droplets**: region **Bangalore (BLR1)**, image **Ubuntu 24.04 (LTS) x64**,
   Basic → Regular → **$24/mo (2 vCPU, 4 GB, 80 GB)**. Authentication: **SSH key** (add your Mac's
   public key, `~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if you have none).
   Hostname `claru-test`. Turn on **Monitoring** (free). Leave backups off. **Create Droplet.**
   ⚠ From this moment the Droplet costs about $0.036 an hour until it is destroyed.
2. **Networking → Firewalls → Create Firewall** `claru-test-fw` (free):
   - Inbound **SSH TCP 22**: only **your IP** (DigitalOcean offers "My IP"). Nobody else can even try to log in.
   - Inbound **HTTP TCP 80** and **HTTPS TCP 443**: all IPv4/IPv6 (80 is needed for the HTTPS certificate).
   - Outbound: leave the defaults (all).
   - Apply to Droplet `claru-test`.
   If your home IP changes, SSH stops working: edit the rule to your new IP.
3. From your Mac, in the project folder (IP = the Droplet's address):
   ```bash
   scp -r deploy root@IP:/root/claru-deploy
   ssh root@IP 'bash /root/claru-deploy/bootstrap.sh'
   ```

## D3 — First release and accounts

```bash
deploy/push-release.sh IP                      # from your Mac: installs the last commit
ssh -t root@IP 'claru-admin kk Karthik'          # asks the admin password twice (hidden)
```
Open `https://IP-WITH-DASHES.sslip.io` (bootstrap printed it). Users → add a consultant for your
friend; give them the one-time password by phone. The orange banner says it is the test server.

## D4 — Automatic deploys (GitHub Actions)

1. On your Mac, make a key used ONLY for deploys (no passphrase, never reused):
   `ssh-keygen -t ed25519 -N "" -C claru-deploy -f ~/.ssh/claru_deploy`
2. Let it log in as `deploy` (and nothing else):
   `ssh-copy-id -i ~/.ssh/claru_deploy.pub deploy@IP`
3. GitHub → repository → Settings → Secrets and variables → Actions:
   - Secret `DEPLOY_SSH_KEY` = contents of `~/.ssh/claru_deploy` (the private file)
   - Secret `DEPLOY_KNOWN_HOSTS` = output of `ssh-keyscan -t ed25519 IP`
   - Variable `DEPLOY_HOST` = IP; variable `DEPLOY_ENABLED` = `true`
4. Push to `main`: CI runs; when it passes, "Deploy to test server" installs that commit.
   Actions → "Deploy to test server" → Run workflow deploys by hand.

The deploy user can run exactly one command with sudo (`/opt/claru/bin/release.sh`). If the new
release fails its health check, the server switches back to the previous one by itself.

## D5 — Monitoring

- Droplet → Monitoring → **Create alert policy**: CPU > 90 % for 10 min, Memory > 90 % for 10 min,
  Disk > 80 % for 5 min → email. (The free agent is installed when Monitoring was ticked at creation;
  otherwise: `curl -sSL https://repos.insights.digitalocean.com/install.sh | sudo bash`.)
- **Problems** page (admin, in the app): server errors, failed background jobs and errors in your
  friend's browser, with the reference they see on screen. Kept 30 days.

## Logs

```bash
ssh root@IP
claru-logs                 # last 200 lines, readable
claru-logs -f              # live
claru-logs errors          # warnings and errors, last 24 h
claru-logs ref abc123      # one request, by the reference shown to the tester
claru-logs since "2 hours ago"
systemctl status claru-server        # is it running?
```

## Everyday development

Nothing changes on your Mac: `npm run dev` with the mocks and your local `.env`. Commit, push:
CI tests it; from D4 on, `main` is deployed to the test server. Until then: `deploy/push-release.sh IP`.

## Rollback, restart, settings

```bash
ls /opt/claru/releases                               # the 5 most recent releases
sudo ln -sfn /opt/claru/releases/<older> /opt/claru/current && sudo systemctl restart claru-server
sudo nano /etc/claru/claru.env && sudo systemctl restart claru-server
```

## Tear down (stops all charges)

Delete the Droplet (DigitalOcean → Droplet → Destroy). This deletes every recording on it, which is
what you want for a test server. Delete the firewall too (free, but tidy). Remove the GitHub
secrets and set `DEPLOY_ENABLED` to `false`.
