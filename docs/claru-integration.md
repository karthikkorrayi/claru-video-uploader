# Claru supplier integration — Veda solutions

Everything needed to deliver egocentric video to Claru through our API: your key, the six calls, what to declare, how to capture and package, and exactly what we check. Written for the person or the agent building the integration.

> ⚠️ **This file contains a secret.** The API key below acts as your whole team. Store it the way you store a password, do not commit it, and do not paste it into a ticket.

Contract version **2** (oldest accepted: 1).
Send this version at create. We give at least two weeks’ notice before the oldest accepted version moves.

## What is in contract v2

- The initial contract. There is no earlier version to have integrated against, so nothing here is a change — it is the whole surface.
- Files per submission: `video` always; `inputs` when the project expects motion data, and accepted-if-sent when it does not; `frames` (per-frame timestamps) on a motion-sensor project; `video_right` and `calibration` on stereo projects; `other` optional and repeatable. We never accept `metadata` — it is the capture record we write ourselves.
- `frames` is `frame_index,timestamp_us` — one row per delivered video frame, on the same clock as your `inputs` CSV. The column name states the unit; `timestamp_mono_s`, `timestamp_ns` and `timestamp_unix_s` are also read. Required on any project whose motion checks are at `warn` or `error`, UNLESS your video carries an embedded telemetry track (a GoPro `gpmd` track and its equivalents) — decided from the track we find in your container, never from the camera brand. A submission with neither is refused with `FRAMES_REQUIRED`. On `imu: "off"` projects the part is not accepted at all.
- Why we ask for it: the sync measurement gates DRIFT and only drift. **The offset between your sensor clock and your video clock is measured and shown to your reviewer, and it is never gated — with or without a `frames` file.** What the file changes is that the offset we report becomes a reading rather than an assumption, and that the drift measurement is more accurate: your container’s timestamps are the video’s own clock, so without the file we have to assume your first sensor sample is video t=0.
- A `frames` file we cannot reconcile with your video is never a refusal: unparseable, timestamps going backwards, a row count that is not your frame count, or a drift past 15 ms or 100 ppm, and we keep it, attach it, and stop using it — your reviewer sees a `frames_ignored` note with the numbers.
- Containers: `.mp4` only, no exceptions — checked on the declared filename at create and again at seal against the `ftyp` brand.
- One category code per submission, the leaf’s — we derive the parent.
- The submission API: create a submission, upload its parts to the URLs we hand back, mark each part complete, then seal.
- Two check lists are published per project: the ones that run at the door and refuse a submission, and the machine-QA groups that run after we accept a clip.
- Discovery while activation is pending: `GET /supplier/projects` reports `TEAM_DRAFT` with an empty `projects` list. After activation, request the list again to see projects available to this account; lead status and country requirements can still filter it. Do not cache the empty list or attempt submissions while the team is DRAFT. A SUSPENDED team can receive its project list for diagnostics when the lead account is usable; a paused or held lead receives an empty list.
- Refusals about the submission: `CONSENT_INCOMPLETE`, `CONTAINER_NOT_MP4`, `PART_SIZE_MISMATCH`, `SUBMISSION_EXPIRED` (a submission left unsealed for 14 days — create it again under the same external reference).
- Refusals from the checks: resolution, aspect ratio, frame rate, keyframe interval, frame gaps, rotation tag, HDR, location tags, artist/author tags, clip length, frozen picture and padded frame rate; motion-sensor coverage, rate, monotonicity and clock wrap; stereo frame count, duration and calibration schema. Each one carries a remedy.
- `IMU_TIMESTAMP_UNPARSEABLE`: write motion-sensor timestamps in microseconds from the clip’s first video frame. A timestamp past 2^53 — an epoch nanosecond clock — cannot be held exactly, so we refuse it rather than round it and report sync numbers you did not send.
- `VIDEO_UNREADABLE`: seal could not read the video’s container structure far enough to judge it — usually a truncated upload. Re-upload the file; if it still fails, deliver the camera file rewrapped with a stream copy rather than an editor render. The specific reason is in `details`.
- `IMU_FILE_TOO_LARGE`: the motion-sensor CSV is bigger than we read in one submission. Deliver shorter clips, inside the project’s published length range.
- Nothing is deprecated yet: `minAcceptedContractVersion` is 1.
- `PERFORMER_COUNTRY_NOT_ALLOWED`: on a COUNTRY project, the supplier lead who owns the key must personally have a profile country allowed by the project. This is independent of Team operating coverage. Contact Claru support if the stored profile country is wrong; the oldest accepted contract remains v1.

## Your API key

Send it as the `x-api-key` header on every call. **It is a secret**: it acts as your whole team.

```
<REDACTED-CLARU-API-KEY>
```

Issued on 2026-09-28. Every download of this guide contains this key, so download it again whenever you need it rather than copying it around. Rotate it in the Integration tab if it may have leaked.

Rate limit: 600 calls per minute. Over it you get a 429 with a `Retry-After` header — wait that many seconds and retry. Uploading file parts to S3 does not count against it.

`Retry-After` is not advisory. Obey the number we send rather than a backoff of your own: a client that guesses either crawls or gets throttled harder. The same header rides on a `503 SEAL_TIMEOUT`, and it means the same thing there.

Re-downloading this guide never rotates your key. Read it as often as you like.

Rotating is a separate, deliberate action in the Integration tab. A rotated-away key simply stops working — it answers `401` like any invalid key, with no code that would confirm it ever existed — so rotate between deliveries, not during one.

## Your projects

Team status: **active**.

### Commercial Egocentric Evaluation (RGB Supplier Upload)

- Project id: `92070f8b-acfb-44c2-8e73-1e6d9918a2b6`
- Motion data: not required (a sensor file is still accepted and still checked)
- Stereo: no
- Frame shape: 4:3
- Clip length: 300–1800 seconds
- Files: `video` (required), `inputs` (optional), `other` (optional)

## Start here

Call `GET https://app.claru.ai/api/v1/supplier/projects` with your key before your first submission, and again whenever a submission is refused with a category error. It returns this same list plus the category codes you declare, and it is always current — this document is not.

## How a delivery works

Six calls, in this order, once per clip. One submission is ONE clip — the video, the second eye if your rig is stereo, and its sidecars.

1. **Discover** — `GET /supplier/projects`. Once at startup, and again whenever a category code is refused.
2. **Create** — `POST /supplier/submissions`. You declare the clip and its files; we answer with upload instructions.
3. **Upload** — PUT the bytes to the URLs we hand you. These go straight to storage and do not count against your rate limit.
4. **Complete** — `POST /supplier/submissions/{id}/parts/{partId}/complete`, once per part.
5. **Seal** — `POST /supplier/submissions/{id}/seal`. We run the checks and either refuse the submission or accept the clip.
6. **Poll** — `GET /supplier/submissions` until each clip reaches `approved` or `rejected`.

Base URL: `https://app.claru.ai/api/v1`. Every API call carries `x-api-key: <your key>`; every path below is relative to that base.

The whole flow is idempotent on your own `externalRef`. If your process dies at step 4, run it again from step 2 with the same `externalRef`: you are handed fresh URLs for exactly the parts that have not landed, and nothing you already uploaded is thrown away. Never invent a second reference to retry with — that is how one clip becomes two submissions.

### 1. Discover

What your team may submit to, what each project expects, and — the part that exists nowhere else — the **category codes**. Codes change; this document does not. Read them from this call, never from a copy of it.

```bash
curl -sS -H 'x-api-key: '"$CLARU_KEY" https://app.claru.ai/api/v1/supplier/projects
```

```jsonc
{
  "team":      { "id": "…", "name": "…", "status": "active" },  // or a "blocked" object
  "contract":  { "version": 2, "minAcceptedVersion": 1 },
  "rateLimit": { "requestsPerMinute": 600 },
  "projects": [{
    "id": "92070f8b-acfb-44c2-8e73-1e6d9918a2b6",
    "name": "…",
    "checkGroups": {
      "video":  "error",           // "warn" | "error"
      "imu":    "error",           // "off" | "warn" | "error" — "off" = no sensor file required
      "stereo": "off"              // "off" | "error" — the project is stereo iff this is "error"
    },
    "imuExpected": true,
    "captureAspectRatio": "4_3",
    "expectedFiles": [{ "fileType": "video", "required": true }],
    "clipLength": { "minSeconds": 300, "maxSeconds": 1800 },
    "categories": [{ "code": "…", "name": "…", "parent": { "id": "…", "name": "…" } }],
    "contractVersion": 2
  }]
}
```

This is the ONE call that still answers while your team is blocked: instead of a 403 you get a 200 carrying `team.blocked = { code, remedy }`, so your agent can stop and tell a human something true. Every other call refuses with the same code.

### 2. Create the submission

Declare everything before you upload a byte. `externalRef` is YOUR clip id, unique inside your team, and it is the only idempotency key on this path — two calls with the same reference are the same submission, from any of your machines.

```bash
curl -sS -X POST \
  -H 'x-api-key: '"$CLARU_KEY" \
  -H 'Content-Type: application/json' \
  https://app.claru.ai/api/v1/supplier/submissions \
  -d '{
    "projectId": "92070f8b-acfb-44c2-8e73-1e6d9918a2b6",
    "externalRef": "kitchen-2026-09-14-0031",
    "contractVersion": 2,
    "declared": {
      "categoryCode": "K-03",
      "country": "PT",
      "collectorId": "collector-114",
      "siteId": "lisbon-kitchen-2",
      "device": "GoPro HERO12 Black",
      "mount": "chest harness",
      "recordedAt": "2026-09-14T09:12:00Z",
      "durationSeconds": 903.4,
      "consent": {
        "worker_consent_obtained": true,
        "site_or_employer_permission_obtained": true,
        "required_consent_or_notice_process_followed": true,
        "footage_unedited": true
      },
      "imu": { "axisConvention": "RDF", "videoStartUs": null }
    },
    "parts": [
      { "fileType": "video",  "fileName": "0031.mp4",     "byteSize": 4831838208 },
      { "fileType": "inputs", "fileName": "0031_imu.csv", "byteSize": 51203344 }
    ]
  }'
```

`200`, not `201`, on purpose: the call may have created the submission, replayed a draft, replaced its part list or reported a sealed one. Branch on `state` in the body, never on the status code.

```jsonc
{
  "id": "…", "externalRef": "kitchen-2026-09-14-0031",
  "state": "draft", "sealed": false, "contractVersion": 2,
  "parts": [{
    "partId": "…", "fileType": "video", "fileName": "0031.mp4",
    "byteSize": 4831838208, "uploadState": "pending",
    "upload": {
      "kind": "multipart",        // or "put" at or under 64 MiB
      "uploadId": "…",            // multipart only
      "partSizeBytes": 67108864,  // split your file by THIS number
      "parts": [{ "partNumber": 1, "url": "https://…" }],
      "headers": {},              // non-empty on a "put" — send them ALL, verbatim
      // e.g. { "x-amz-meta-source": "supplier_upload", "content-type": "video/mp4" }
      "expiresAt": "2026-09-14T15:12:00.000Z"
    }
  }],
  "createdAt": "…", "updatedAt": "…"
}
```

A draft is an empty shell: until you seal it you may call create again with a corrected declaration and we replace the part list in place. After seal, create can only tell you what is already true.

### 3. Upload the parts

The upload shape is OURS to decide and yours to follow. Do not infer it from the file size, do not pick your own part size, and do not start your own multipart upload: split the file by the `partSizeBytes` you were handed and PUT each slice to the URL with the matching `partNumber`.

**`kind: "put"`** — one PUT of the whole file. **Send every entry in `upload.headers` exactly as given, and read the set from the response rather than hard-coding it.** Iterate the object; do not pick out the headers you recognise. The set can grow, and a client that loops over it keeps working when it does.

Two entries are in there today, and they fail differently — which is worth knowing before you decide to skip one:

| Header | Signed? | If you omit it |
| --- | --- | --- |
| `x-amz-meta-source` | **yes** | The PUT fails with `SignatureDoesNotMatch`. Altering the value fails the same way. This is how the stored object is stamped as a supplier upload. |
| `content-type` | no | The PUT succeeds and the object lands as `binary/octet-stream`. Nothing is refused, and nothing tells you — the clip simply does not stream inline for the human reviewing it, and downloads as an opaque blob instead. |

`content-type` is per part ROLE: `video/mp4` for `video` and `video_right`, `text/csv` for `inputs`, `application/json` for `calibration`. An `other` part gets none — we have nothing truthful to say about a sidecar we did not specify — so `upload.headers` simply has no `content-type` entry there. Do not invent one.

Send it even though it is not signed. It is not enforced because the presigner drops it from the signature, not because it does not matter.

```bash
# both entries, exactly as the API returned them
curl -sS -X PUT \
  -H 'x-amz-meta-source: supplier_upload' \
  -H 'content-type: text/csv' \
  --upload-file 0031_imu.csv \
  "$PUT_URL"
```

**`kind: "multipart"`** — one PUT per slice, and `upload.headers` is empty. These URLs are bare: send the bytes and nothing else. Both the source stamp and the content type are applied server-side when we open the upload, so on this shape there is nothing you can get wrong and nothing to send. Keep each response's `ETag` header; you hand them back at complete. Run four to eight in parallel — more only competes with itself.

```bash
# part 3 of N, 64 MiB slices
dd if=0031.mp4 bs=1048576 skip=128 count=64 2>/dev/null | \
  curl -sS -D - -X PUT --data-binary @- "$PART_3_URL" | grep -i ^etag
```

URLs live for six hours. If yours expire mid-delivery, call create again with the same `externalRef`: you get new URLs for the parts that have not landed and the SAME multipart upload id for the one in progress. **Never send a checksum header** (`x-amz-checksum-*`, `x-amz-sdk-checksum-algorithm`) — we never ask for one, and adding one breaks the signature.

### 4. Complete each part

Tells us a part is done, and makes us look: we HEAD the object and compare its size against what you declared. A mismatch is `PART_SIZE_MISMATCH` — your bytes are left exactly where they are and the part stays `pending`.

To recover, call create again with the same `externalRef`. A multipart upload that reached Complete has spent its upload id, so the replay mints a fresh one and hands you new part URLs; upload the whole file again and complete it again. Do not retry the complete call on the old upload id — S3 no longer knows it.

```bash
# single PUT — nothing for you to tell us; the HEAD decides
curl -sS -X POST -H 'x-api-key: '"$CLARU_KEY" \
  -H 'Content-Type: application/json' \
  https://app.claru.ai/api/v1/supplier/submissions/$ID/parts/$PART_ID/complete -d '{}'

# multipart — every part number with the ETag its PUT returned
curl -sS -X POST -H 'x-api-key: '"$CLARU_KEY" \
  -H 'Content-Type: application/json' \
  https://app.claru.ai/api/v1/supplier/submissions/$ID/parts/$PART_ID/complete \
  -d '{ "parts": [{ "partNumber": 1, "etag": "\"a1b2…\"" },
                  { "partNumber": 2, "etag": "\"c3d4…\"" }] }'
```

Idempotent: completing a part that is already `uploaded` answers with the submission and changes nothing.

### 5. Seal

The door. Seal compares what you declared against what landed, reads each file's index and container tags, checks the sensor file, looks for an exact duplicate of these bytes anywhere on the platform, and then either refuses the submission or creates the clip.

```bash
curl -sS -X POST -H 'x-api-key: '"$CLARU_KEY" https://app.claru.ai/api/v1/supplier/submissions/$ID/seal
```

**Seal takes no request body.** Everything it needs was declared at create and uploaded at step 3. Send one anyway and it is ignored.

Synchronous, typically two to five seconds, with a **30-second budget**. A `200` is the ordinary submission body with one extra block — `seal`, the positive half of the verdict:

```jsonc
{
  "id": "…", "externalRef": "kitchen-2026-09-14-0031",
  "state": "processing", "sealed": true,
  "annotationId": "…",               // the clip your submission became
  "seal": {
    "at": "2026-09-14T09:31:02.118Z",
    "warnings": [{ "code": "all_intra", "message": "…" }],
    "duplicateCheck": "clear",       // or "skipped"
    "sensorSetAside": false          // true = your `inputs` file was kept but excluded
  },
  "parts": [ … ], "createdAt": "…", "updatedAt": "…"
}
```

`duplicateCheck` is `"skipped"` when storage handed us no checksum for one of your objects. It is never reported as `"clear"` in that case, because a missing fingerprint must not be readable as a unique one.

`seal.warnings` is a snapshot taken at the moment of sealing, and it never grows afterwards. Warnings do not refuse; they travel with the clip to the human reviewer.

The other answers:

- `422` with a `code` — we will not take this submission. Read `code` and `details.remedy`, fix it, seal again. When more than one check failed, `details.refusals` carries the whole list rather than only the first.
- `403` with a `code` — your team or your project assignment is the problem, not the clip. Retrying identically will not help until someone at Claru changes something.
- `503` with `code: "SEAL_TIMEOUT"` — our problem, not yours. See the budget below.

Three refusals are worth knowing before you build, because none of them is a check you can see coming from the file alone:

- `VIDEO_UNREADABLE` — we could not read the container far enough to judge it at all: no `moov` atom, a sample table claiming an impossible number of samples, a fragment chain that never ends, or an index still incomplete when the ranged reads we budget ran out. It is a refusal and deliberately never a `500`, because it is a property of the bytes you sent; `details.reason` separates a truncated upload from a container we do not accept.
- `IMU_FILE_TOO_LARGE` — the `inputs` object is over **64 MiB**. Seal parses the whole CSV to answer cadence, coverage and monotonicity, so the ceiling is ours to set rather than yours. It applies on **every** project, including one whose motion-sensor checks are off: if you send a sensor file, it has to be one we can read. Deliver shorter clips.
- `STEREO_EYES_IDENTICAL` — the two eyes are byte-identical, which is one file uploaded twice rather than a pair.

#### What a refusal leaves behind

**Nothing is created and nothing is deleted.** There is no clip, no review, nothing to withdraw, and the objects you uploaded are exactly where you left them.

The refusal is recorded on the submission and comes back as `lastRefusal { code, message, at }` on every later read. `details` rides on the HTTP response only — it is not kept, so read it when you get it. Whether the submission MOVES depends on whether we judged your media:

- `PART_NOT_UPLOADED`, `PART_MISSING` and `PART_SIZE_MISMATCH` leave it a **`draft`**. We never read the bytes, so there is no verdict about them. Finish the upload and seal again.
- Every verdict about the media — `VIDEO_UNREADABLE`, `IMU_FILE_TOO_LARGE`, `DUPLICATE_CONTENT`, `STEREO_EYES_IDENTICAL` and every check code — moves it to **`refused`**. Fix the file and seal again, or create again under the SAME `externalRef` if what was wrong was the declaration.

Two are deliberately not recorded at all: `SEAL_TIMEOUT`, and `SUBMISSION_EXPIRED` on a submission that sat unsealed for 14 days. Read the submission after either and you see it untouched, with no `lastRefusal`.

#### The 30-second budget

Over budget you get `503` with `code: "SEAL_TIMEOUT"`, a **`Retry-After: 30`** header, and the same number again in `details.retryAfterSeconds`. **Nothing was created**, we are alerted, and the right response is to retry the same seal call after the stated wait.

The budget is checked **between phases, never inside one**. Seal will not begin a phase it has no time left for, but it never abandons a phase it has already started — a transaction abandoned halfway is exactly the half-created state that "nothing was created" exists to rule out. So one slow read, or the final write, can carry a call past 30 seconds and still return `200`. Set your own client timeout generously, and if you do give up locally, seal again: the retry is safe.

#### Sealing twice

Sealing a submission that is ALREADY sealed — `processing`, `in_review`, `approved` or `rejected` — is a **replay**. You get the current state and the stored `seal` block back, no work is redone, no second clip is created, and no second round of processing is started. An agent whose connection dropped after we committed cannot tell a lost response from a lost seal, and the only safe answer to "seal this again" is the state it is already in.

Sealing after a TIMEOUT or a REFUSAL is not a replay, because neither of those created anything to replay. It runs the whole thing again from the start and answers on what is in the bucket now. That is what makes the retry after a `503` correct — and it is also why re-sealing an unchanged refused submission simply refuses again with the same code.

#### What happens to your sensor file after we accept

The annex CSV is not the format our pipeline reads, so we rewrite it — **after** the `200`, not during seal, because nothing in the seal decision depends on the result and a vendor should not hold a connection open for it.

The conversion re-anchors your timestamps from microseconds on your own clock to seconds from video frame 0 — using the `videoStartUs` you declared, or the first row if you left it `null` — converts acceleration from m/s² to **g**, keeps angular rate in rad/s, and rotates both vectors out of the `axisConvention` you declared into ours. Rows before frame 0 or past the end of the video are dropped. **Your original file is kept exactly as you uploaded it**; the converted one is written alongside.

None of this reaches you. It finishes after your call has returned, and no field of the submission body reflects it — not `state`, not `parts`, and not `seal.warnings`, which was frozen at seal.

One consequence is worth knowing anyway: we do not take the accelerometer sign on trust. We measure it against gravity and flip all three axes if your file is inverted. When the measurement cannot answer — too few rows, a magnitude nowhere near 1 g, or gravity clearly present but spread away from the camera’s up axis because the rig is mounted at an angle — we keep your sign as declared and flag it internally as `imu_accel_sign_unverified` for our reviewer. The last of those three is a note about the mount rather than a fault in your file. Declaring `axisConvention` correctly is what keeps any of it from mattering.

### 6. Poll for the verdict

Acceptance at seal is not approval. A sealed clip goes through the same processing and human review as everything else on the platform, and the outcome shows up here.

```bash
curl -sS -H 'x-api-key: '"$CLARU_KEY" \
  "https://app.claru.ai/api/v1/supplier/submissions?state=rejected&limit=200"

# one submission, by our id
curl -sS -H 'x-api-key: '"$CLARU_KEY" https://app.claru.ai/api/v1/supplier/submissions/$ID
```

Newest first and cursor-paged: pass the response's `nextCursor` back as `?cursor=` and loop until it is absent, which reads everything exactly once. Filters: `state`, `projectId`, `externalRef`. Poll every few minutes, not every few seconds — review is done by people.

A `rejected` row carries `rejection { code, type, reason }`, plus `checks` when a machine check named itself. `code` is the stable value to branch, count and route on; `reason` is the sentence to print. The vocabulary is in **Submission states** below.

The single-submission read carries one thing the list does not: `declared`, the declaration we stored for that clip, verbatim in the snake_case you sent — including the consent block. It is how you check what we recorded against what you meant to send, which is the first question worth asking when a reviewer note disagrees with your paperwork.

A `cursor` that does not name one of YOUR submissions is a `400` with `code: "INVALID_CURSOR"` — start the listing again without one. It is a plain 400 rather than one of the refusal codes below, because it is a mistake about the query rather than a verdict about a submission.

There is no webhook and no callback. Polling this list is the only way to learn a verdict.

### A Python client

Everything above, in one file. `pip install requests`, export `CLARU_KEY`, adapt.

```python
import os, time, requests
from concurrent.futures import ThreadPoolExecutor

BASE = "https://app.claru.ai/api/v1"
HEADERS = {"x-api-key": os.environ["CLARU_KEY"]}
CONTRACT_VERSION = 2
MAX_ATTEMPTS = 6


def call(method, path, **kwargs):
    """Every API call goes through here, so the 429/503 rule is written once.

    Retry-After is the server telling you exactly how long to wait. Obeying it
    is not optional: a client that backs off on a guess of its own either
    crawls or gets throttled harder."""
    for attempt in range(MAX_ATTEMPTS):
        response = requests.request(
            method, BASE + path, headers=HEADERS, timeout=60, **kwargs
        )
        if response.status_code in (429, 503):
            time.sleep(float(response.headers.get("Retry-After", 2 ** attempt)))
            continue
        if response.status_code >= 500:
            time.sleep(2 ** attempt)
            continue
        return response
    raise RuntimeError(f"{method} {path} kept failing")


def put_bytes(url, data, headers=None):
    """Uploads go straight to storage: no API key, and no rate limit."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            response = requests.put(url, data=data, headers=headers or {}, timeout=600)
            if response.status_code < 300:
                return response.headers.get("ETag")
            if response.status_code < 500:
                response.raise_for_status()
        except requests.RequestException:
            if attempt == MAX_ATTEMPTS - 1:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("upload failed")


def upload_part(path, upload):
    """One declared file. The server chose the shape; we follow it."""
    if upload["kind"] == "put":
        with open(path, "rb") as handle:
            # headers are SIGNED — send them exactly, or the PUT is rejected
            put_bytes(upload["url"], handle.read(), upload.get("headers", {}))
        return {}

    size = upload["partSizeBytes"]

    def one(slot):
        with open(path, "rb") as handle:
            handle.seek((slot["partNumber"] - 1) * size)
            chunk = handle.read(size)
        return {
            "partNumber": slot["partNumber"],
            "etag": put_bytes(slot["url"], chunk),
        }

    with ThreadPoolExecutor(max_workers=6) as pool:
        done = list(pool.map(one, upload["parts"]))
    return {"parts": sorted(done, key=lambda item: item["partNumber"])}


def deliver(external_ref, project_id, declared, files):
    """files: {"video": "/path/0031.mp4", "inputs": "/path/0031_imu.csv"}"""
    body = {
        "projectId": project_id,
        "externalRef": external_ref,
        "contractVersion": CONTRACT_VERSION,
        "declared": declared,
        "parts": [
            {
                "fileType": file_type,
                "fileName": os.path.basename(path),
                "byteSize": os.path.getsize(path),
            }
            for file_type, path in files.items()
        ],
    }

    # Idempotent: re-running after a crash picks up where it stopped,
    # because the same externalRef is the same submission.
    submission = call("POST", "/supplier/submissions", json=body).json()
    if submission["state"] != "draft":
        return submission  # sealed, rejected or expired — read `state`

    submission_id = submission["id"]
    for part in submission["parts"]:
        if part["uploadState"] == "uploaded":
            continue  # a replay already has it
        done = upload_part(files[part["fileType"]], part["upload"])
        call(
            "POST",
            f"/supplier/submissions/{submission_id}/parts/{part['partId']}/complete",
            json=done,
        )

    sealed = call("POST", f"/supplier/submissions/{submission_id}/seal")
    if sealed.status_code in (403, 422):
        problem = sealed.json()
        # `code` is stable and always there; `details.remedy` is a
        # sentence you can print. Read it defensively — an envelope
        # without details should not turn a refusal you could have
        # shown into a KeyError.
        remedy = problem.get("details", {}).get("remedy", "")
        raise SystemExit(f"{problem['code']}: {remedy}".strip(': '))
    sealed.raise_for_status()
    return sealed.json()


def poll(state=None):
    """Every submission, newest first. Loop until nextCursor is gone."""
    cursor, out = None, []
    while True:
        params = {"limit": 200}
        if state:
            params["state"] = state
        if cursor:
            params["cursor"] = cursor
        page = call("GET", "/supplier/submissions", params=params).json()
        out.extend(page["items"])
        cursor = page.get("nextCursor")
        if not cursor:
            return out
```

## What you declare with each clip

The `declared` object on create. It is a DECLARATION, not a measurement: where it disagrees with the file, the file wins for anything we gate on and the contradiction becomes a note to the human reviewing your clip. A mismatch never refuses a submission — so declare what is true rather than what you think will pass.

| Field | What it is |
| --- | --- |
| `categoryCode` | The LEAF category code, one per clip — we derive the parent. See below. |
| `country` | ISO 3166-1 alpha-2 country of capture, e.g. `PT`. |
| `collectorId` | Your own id for the person who recorded. Opaque to us. |
| `siteId` | Your own id for the place. Opaque to us. |
| `device` | Camera make and model, as you would write it on a packing list. |
| `mount` | How it was worn or mounted — `chest harness`, `head strap`, `helmet`. |
| `recordedAt` | ISO 8601 capture instant. THE source of truth for capture date. |
| `durationSeconds` | Clip length as you measured it. |
| `consent` | The four statements below. All four `true`, or the submission fails. |
| `imu` | Required whenever you declare an `inputs` part; see below. |
| `batchRef` | Optional. Your own batch label; we store it and never parse it. |

Several people uploading under one key are ONE identity to us — the key belongs to your team lead. `collectorId`, `siteId`, `device` and `mount` are the only attribution we get, so they are worth filling in properly.

We do not read capture date from the container. `creation_time` is EXPORT time on any hand-processed file — on one vendor sample, 23 of 28 files were stamped with the day they were exported — so `recordedAt` is the only capture date we have and we never cross-check it against the file.

### Category codes

One code per clip, and it is the **leaf** — the bottom of the tree. We resolve the parent ourselves. Codes are uppercase letters, digits and dashes, and they are per project.

**The codes are not in this document, on purpose.** They come from `GET /supplier/projects`, under each project's `categories`, and that call is always current while a downloaded file is not. Read them at startup, cache them for a run, and refresh when a create is refused with `CATEGORY_UNKNOWN` (the code is not on this project — refresh the list) or `CATEGORY_DISABLED` (we retired that category — pick another).

A project whose `categories` list is empty does not take a category. That is an answer, not a failure to load.

The code is checked at CREATE and never again: not at seal, not on an idempotent replay. A category retired after your submission was created stays valid for that clip.

### The consent block

Four booleans, per clip. **All four must be `true`** — there is no partial consent, and a `false` is `CONSENT_INCOMPLETE` rather than a validation error, because the fix is to go and obtain the consent, not to correct your JSON.

```json
"consent": {
  "worker_consent_obtained": true,
  "site_or_employer_permission_obtained": true,
  "required_consent_or_notice_process_followed": true,
  "footage_unedited": true
}
```

The key names are the wording. They are not renamed, re-cased or abbreviated anywhere — not in the request, not in what we store, not in what we would show if anyone ever had to demonstrate what was affirmed for a given clip.

`footage_unedited` is the one that needs spelling out: it **permits** splitting ONE recording on keyframes with a stream copy, and it **forbids** re-encoding, filtering, trimming content, and joining separate recordings. Splitting a long recording into deliverable clips is expected and fine. Anything that puts frames through an editor is not.

**A "chunk" is a piece of ONE continuous recording**, cut either by the camera itself — a GoPro chaptering a long take into file-size pieces — or by you, with a stream copy. That is the word this guide uses everywhere, and it is what separates the two cases this statement is about: rejoining the chunks of one recording is inside what `footage_unedited` permits, while joining two independent recordings into one clip is not, however short either of them is. **We cannot detect a join.** Nothing in the file says where one recording ended and another began, so this declaration is the only thing standing behind it — which is why a clip you could not honestly declare `footage_unedited: true` for is a clip you do not deliver.

**That is the declaration's view of a rejoin, and only the declaration's.** `footage_unedited` permitting one does not make the rejoined file deliverable: whether you may actually join a given pair of chunks is decided by the telemetry rule under **Clip length and splitting**, which is stricter, and chunks that each carry telemetry are never joined.

### Declaring motion data

Whenever you declare an `inputs` part you must also send `declared.imu`:

| Field | Required | What it is |
| --- | --- | --- |
| `axisConvention` | yes | Where the sensor's +X, +Y, +Z point in the CAMERA's frame. |
| `videoStartUs` | no | Where video frame 0 sits on the SENSOR's clock, in microseconds. |

We convert your CSV into our own format, and the conversion is a unit scale plus a **signed axis permutation**. There is no way to infer the permutation from the numbers — a rig lying on its side and a rig with a differently-mounted sensor give the same gravity vector — so it is declared rather than guessed. Getting it wrong fails nothing and silently delivers motion data pointing the wrong way, which is why we ask.

Three letters, naming in order where the sensor's **+X**, **+Y** and **+Z** point in the camera's frame:

| Letter | Direction in the camera frame |
| --- | --- |
| `R` / `L` | right / left |
| `U` / `D` | up / down |
| `F` / `B` | forward, out of the lens / back |

`RDF` — sensor +X is camera right, +Y is camera down, +Z points out of the lens. The convention most vision rigs publish. `FLU` is the ROS/robotics one. The three letters must name three different axes, which makes the accepted set exactly these:

```
BDL  BDR  BLD  BLU  BRD  BRU  BUL  BUR  DBL  DBR  DFL  DFR
DLB  DLF  DRB  DRF  FDL  FDR  FLD  FLU  FRD  FRU  FUL  FUR
LBD  LBU  LDB  LDF  LFD  LFU  LUB  LUF  RBD  RBU  RDB  RDF
RFD  RFU  RUB  RUF  UBL  UBR  UFL  UFR  ULB  ULF  URB  URF
```

Case-insensitive on the way in; `rdf` is stored as `RDF`. Anything not in this list is a `400`.

`videoStartUs` is optional and most rigs do not need it: **absent means the first CSV row IS video frame 0**, which is what the stereo packaging procedure below produces. Send it when your sensor clock and your video start at different instants, as a signed microsecond offset of frame 0 on the sensor's clock. We use it as the alignment anchor for the coverage check; we never re-time your rows by it.

`declared.imu.videoStartUs` is the one spelling of this field: it is what you send, what an `IMU_COVERAGE` refusal names in its remedy, and what that refusal echoes back in `details.videoStartUs`.

The CSV itself is the order-form annex format: `timestamp` in microseconds (int64), `ax ay az` in m/s², `gx gy gz` in rad/s. A header row is fine.

The per-frame timestamps are a separate part, and on a project whose motion checks are at `warn` or `error` we require them: send a `frames` part alongside this CSV — `frame_index,timestamp_us`, one row per delivered video frame, on the same clock — unless your video carries an embedded telemetry track, and a submission with neither is refused with `FRAMES_REQUIRED`. They are what pairs each frame with your sensor rows, which is what makes the video/sensor offset we report meaningful and the drift measurement more accurate; on an `imu: "off"` project there is no second clock for them to be on, so the part is not accepted at all. The format, the exemption and what we do with the file are under **The per-frame timestamps** below.

## How to capture

These are settings on the camera, decided before anyone presses record. Nothing below can be fixed afterwards, and we do not fix it for you.

| Setting | Rule |
| --- | --- |
| Frame rate | 29.97, 30, 59.94 or 60. **PAL rates (25/50/100) are refused**, including footage already shot, with no exception mechanism. On a GoPro: Preferences › General › Anti-Flicker → 60Hz. |
| HDR | Off. 10-bit standard colour is fine; HLG and PQ are not. |
| Location | Off at capture. We refuse a clip that carries coordinates and we never strip them for you. |
| Mount | Upright. |
| Audio | Recorded. |
| Codec | HEVC or H.264, 8- or 10-bit standard colour. Bitrate is not restricted. |
| Resolution | At least 1080 pixels tall, in 4:3 or 16:9. |
| Field of view | 110° or wider. Checked by a human on your sample batch, not per file. |

Phones: shoot 4:3 on the ultra-wide lens. The stock iPhone Camera app cannot do this — it needs a custom capture app. 16:9 phone footage is accepted with a warning.

**Suppliers never re-encode.** The one exception is audio when you package a stereo rig, described below.

Your project asks for 4:3.

## Clip length and splitting

Your project accepts clips of **300–1800 seconds**. The platform floor of 30 seconds applies underneath, and `GET /supplier/projects` always carries the current bounds under `clipLength`.

Outside the range is refused at seal with `CLIP_LENGTH`. How you get inside it — where you cut a long recording, and which pieces you deliver — is yours to decide and we take no position on it, except for the one rule below. A "chunk" means what **What you declare with each clip** says it means: a piece of one continuous recording. Joining separate recordings into one clip is forbidden by `footage_unedited`, we cannot detect a join, and your declaration is what we rely on.

The rule, and it is the same rule whatever the pieces are called: **joining footage that carries sensor data breaks sync. Never join two files that each carry telemetry** — an embedded track, or sensor rows of their own. **That includes the chapters of one recording**: a camera that chapters a long take writes its telemetry into every piece, so deliver those pieces as separate clips, each inside the length range above, rather than concatenating them back together. Splitting is what `footage_unedited` permits and **Splitting a GoPro file** below is how to do it without losing the track.

Rejoining chunks with a stream copy is fine only where the chunks carry no telemetry of their own — video-only pieces of one recording, or pieces whose motion data all lives in the single `inputs` CSV you deliver — and the `inputs` rows must then cover the whole joined span.

When you split, split with a stream copy and never with an editor. Keep the video, the audio and the telemetry track; the sensor rows must cover the same stretch as the video piece.

### Splitting a GoPro file

Use this, not the obvious form. Tested on real footage from all four generations HERO10–HERO13:

```bash
GP=$(ffprobe -v error -select_streams d -show_entries stream=index,codec_tag_string -of csv=p=0 IN.MP4 | awk -F, '$2=="gpmd"{print $1}')
ffmpeg -ss <start> -i IN.MP4 -t <len> -map 0:v -map 0:a -map 0:$GP -c copy OUT.MP4
```

Why the lookup by codec tag instead of something shorter:

- `-map 0 -c copy` **fails on every GoPro** — it trips over the `tmcd` timecode track.
- Selecting the telemetry stream by handler name (`-map 0:m:handler_name:"GoPro MET"`) works on HERO12 and HERO13 and **fails on HERO10 and HERO11**, whose older firmware writes a length-prefixed, space-padded handler string.
- Looking the stream up by its codec tag (`gpmd`) and then mapping it by index works on all four. Verified: telemetry retained, every stream starts at 0, codec untouched. ffmpeg regenerates a harmless `tmcd` track of its own.

We do not check that your pieces tile the original recording. Trimming content out of the middle is forbidden by `footage_unedited`, and that commitment is what we rely on.

## Containers: `.mp4` only

`.mp4`, for everyone, no exceptions. `.mov` is refused even though the order form allows it — the filename is checked at create and the `ftyp` major brand is checked again at seal, because a `.mov` renamed to `.mp4` is still a QuickTime file.

Rewrapping is a stream copy and costs nothing:

```bash
ffmpeg -i IN.MOV -map 0:v:0 -map 0:a? -c copy OUT.mp4
```

Naming the streams rather than taking `-map 0`: a QuickTime file from an iPhone carries `mebx` metadata tracks, and often a `tmcd` timecode track, which the mp4 muxer cannot write — mapping everything makes the command fail on exactly the files this recipe is for. `0:a?` is a question mark on purpose, so a silent recording rewraps instead of erroring on a missing audio stream.

**Know what this costs you, because it is not nothing.** A stream-copy rewrap into mp4 drops the QuickTime-only container tags on the way through — Apple writes location as `com.apple.quicktime.location.ISO6709`, and the mp4 muxer has nowhere to put that key, so it does not survive. The author/artist tag goes the same way. **A rewrapped iPhone file therefore passes `LOCATION_PRESENT` and `AUTHOR_TAG_PRESENT` even when the original would not have.**

That is a side effect of the container change, not permission. **Turn location off at capture.** We refuse any file that reaches us carrying coordinates and we never strip them for you — the rewrap did that, we did not, and the check can only judge what arrives. A clip recorded with location on is one you should not be delivering, whether or not the packaging step happened to hide it.

Do not re-encode to change container.

## Preserve the original frame timing

We do not ask you to report dropped frames — we cannot verify a self-report, so we measure instead. What we need from you is that the timing survives packaging, so a real drop is still visible in the file:

- Camera files: stream copy. The timestamps come along.
- Rigs that mux from raw streams: use the **capture timestamps as presentation times**. Do not force a constant frame rate — that is exactly what hides a drop.

A single dropped frame (about 66 ms) is below our gap rule and is accepted. A forced-CFR mux that papers over a half-second dropout is not, and it is the kind of thing the padded-frame-rate check finds.

## Stereo rigs: splitting your container into our files

None of your projects is stereo today, so you can skip this. It is here because the same guide serves every supplier, and because a project can be switched to stereo with notice.

**We do not accept MCAP, or any other all-in-one container.** You split it into our files before upload, losslessly. The procedure below was smoke-tested end to end on a full 35-minute stereo session (17 chunks → two ~17.6-minute clips); all four outputs passed every check and were byte-identical across runs.

1. **Concatenate each camera across chunks on the elementary stream**, then mux: `-c:v copy -tag:v hvc1`. The `hvc1` tag is required — without it Safari and QuickTime will not play the result.
2. **Cut both cameras at the same keyframe index**, on the elementary stream, before muxing. Not at the same timestamp: the same index. This is what makes the eyes match.
3. **Audio is the one permitted re-encode**: AAC-LC at 128 kb/s. (Raw PCM in MP4 only works in ffmpeg ≥ 6 and is four times the bytes.) **You drop the 50 ms audio pre-roll** so the A/V lag is zero — we never touch your audio or your video.
4. **Mux deterministically**: `-map_metadata -1 -fflags +bitexact -max_interleave_delta 0`. This also strips `creation_time` and encoder tags, so no incidental personal data rides along in the output.
5. **Keep the capture timestamps as presentation times** when muxing from raw streams, rather than forcing a constant frame rate, so genuine drops stay visible.
6. **Write the IMU CSV in microseconds from the clip's first delivered frame.** Rows before frame 0 are dropped. Do NOT correct them by your stated time offset — that offset lives in the calibration file, with its sign.
7. **Write the `frames` CSV on the SAME clock as the IMU CSV** — `frame_index,timestamp_us`, one row per delivered frame of the LEFT eye, microseconds from that clip's first frame. An MCAP's frame messages already carry these timestamps, so this falls out of the split you are already doing; do not regenerate them from a frame rate. The rig's `time_offset_to_cam0_s` in the calibration is additional evidence about the same pairing, never a substitute for this file.
8. **Ship the calibration as `claru.stereo_calibration/v1`**, below.

What we then check is structural only: the right eye is present, the frame counts match within one, the durations match within one frame, and the calibration parses. Shape problems refuse at seal; there is no warn level for stereo.

Face blur cannot be enabled on a stereo project today.

### `claru.stereo_calibration/v1`

Required keys: `cameras[]` with `{width, height, distortion_model, D, K, R, P, frame_id}`; `transforms.cam0_to_cam1` and `transforms.cam0_to_imu0`, each `{parent_frame_id, child_frame_id, translation_m, rotation_quaternion_xyzw}`; `imu` with `{accel_noise_density, gyro_noise_density, update_rate_hz, time_offset_to_cam0_s}`; and `notes` with `{transform_convention, imu_csv_clock}`.

A real one, trimmed to one camera for length — yours carries two:

```json
{
  "schema": "claru.stereo_calibration/v1",
  "session_id": "wd_sample_2",
  "cameras": [
    {
      "width": 1920,
      "height": 1080,
      "distortion_model": "kannala_brandt",
      "D": [-0.03398551, 0.00205389, -0.00200864, 0.00026377],
      "K": [745.73370, 0.0, 986.98203, 0.0, 745.64087, 557.83719, 0.0, 0.0, 1.0],
      "R": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
      "P": [745.73370, 0.0, 986.98203, 0.0, 0.0, 745.64087, 557.83719, 0.0, 0.0, 0.0, 1.0, 0.0],
      "frame_id": "cam0"
    }
  ],
  "transforms": {
    "cam0_to_cam1": {
      "parent_frame_id": "cam0",
      "child_frame_id": "cam1",
      "translation_m": [-0.06285011, -0.00019906, -0.00000649],
      "rotation_quaternion_xyzw": [0.00123730, -0.00317851, 0.00151140, 0.99999304]
    },
    "cam0_to_imu0": {
      "parent_frame_id": "cam0",
      "child_frame_id": "imu0",
      "translation_m": [-0.01525835, 0.01952989, -0.02093672],
      "rotation_quaternion_xyzw": [-0.70488394, 0.70930800, -0.00084144, -0.00447954]
    }
  },
  "imu": {
    "accel_noise_density": 0.00147,
    "gyro_noise_density": 0.000244,
    "update_rate_hz": 476.1904761904762,
    "time_offset_to_cam0_s": -0.0014065919779372663
  },
  "notes": {
    "transform_convention": "FrameTransform maps a point in child_frame_id into parent_frame_id: p_parent = R(q) * p_child + t.",
    "imu_csv_clock": "IMU CSV timestamps are on the delivered video timeline, microseconds from that clip's first video frame. They are NOT corrected by imu.time_offset_to_cam0_s; apply it downstream if needed."
  }
}
```

We check the shape, not the quality: nothing here re-projects a point, checks that the quaternion is a unit, or compares the baseline against your rig. A file that does not parse is `CALIBRATION_INVALID`, and the refusal lists every problem at once rather than the first one.

## What we check when you seal

Almost everything is read from the **file index** — the container's own table of frame sizes, offsets and timestamps — plus the metadata atoms. That is about half a megabyte of a twelve-gigabyte file, which is why a check this thorough finishes in seconds and why none of it needs you to upload anything extra.

These checks refuse **regardless of a project's check-group levels**. The levels govern what happens to a clip AFTER we accept it; this list is the door. A refusal means nothing was created: there is no clip, no review, and nothing to withdraw.

### The video

Container is `.mp4`. Display height at least 1080, in 4:3 or 16:9. Average frame rate in 29.5–30.5 or 59–61. A keyframe at least once a second. No presentation gap over 100 ms. No rotation tag. No HDR transfer function. No location in any of four places. No artist/author tag. Duration inside the project's bounds. And two statistics that catch files an editor has been through: a **frozen picture** and a **padded frame rate**.

The frozen and padded tests have a grey band in the middle. A clip that lands in it is not refused — it is accepted and then measured properly by decoding the exact stretch we flagged, inside the processing every clip already goes through.

Neither can be measured at all on an ALL-INTRA file, where every frame is a keyframe: both scores compare ordinary frames against keyframes, and there are no ordinary frames. Such a file is accepted with a reviewer-visible `all_intra` warning rather than being scored on numbers that do not exist — but all-intra is an editor export tell, and the artist/author and padded checks still apply.

### The motion data

Timestamps increase, the clock has not wrapped through 32 bits, the median cadence is at least 97 Hz, and the rows cover the whole video: starting no more than 500 ms after the first frame and ending no earlier than 500 ms before the last. Rows beyond either end are fine — we drop them when we convert.

What a sensor DEFECT does depends on the project:

- **`imu: "error"`** — the sensor file is required and defects refuse the submission.
- **`imu: "warn"`** — the sensor file is required; a defect is accepted and flagged to the human reviewer.
- **`imu: "off"`** — no sensor file is expected. Send one anyway and we still check it: it passes and we keep it, or it fails and we set it aside with a note to the reviewer. **A sensor defect never fails your video on such a project.**

### The per-frame timestamps

On a project whose motion checks are at `warn` or `error`, send a **`frames`** part alongside the sensor CSV: two columns, `frame_index,timestamp_us`, one row per delivered video frame, on the **same clock as your `inputs` CSV**. The column name states the unit — `timestamp_us` (microseconds, matching the annex) is the one to use; `timestamp_mono_s`, `timestamp_ns` and `timestamp_unix_s` are also read.

```
frame_index,timestamp_us
0,0
1,33367
2,66733
```

**Why we need it.** Your container's timestamps are the video's own clock and say nothing about the sensor's, so without this file the sync measurement below has to assume your first sensor sample is video t=0. With it, the offset we report is a reading of where the two clocks actually sit rather than that assumption, and the drift measurement — the one thing that measurement gates, either way — is more accurate. Any capture app that writes an IMU stream already knows when it handed each frame to the encoder; this is that.

**The one exemption.** A video that carries its own **embedded telemetry track** — a GoPro `gpmd` track and its equivalents — already pairs the two clocks inside the container, so no sidecar is needed. We decide this from **the track we find in your file**, not from the camera brand and not from anything you declare. A submission with neither is refused with `FRAMES_REQUIRED`.

**A `frames` file we cannot reconcile with your video is never a refusal.** Unparseable, timestamps going backwards, a row count that is not your frame count, or a drift against your own container past 15 ms or 100 ppm (the same bar the sync measurement below uses, with a 15 ms floor so a short clip is not judged on timestamp rounding): we keep the file, attach it, and stop using it. The sync measurement falls back to the container clock and your reviewer sees a `frames_ignored` note with the numbers.

The video/sensor sync measurement is separate and happens later, after we accept the clip, so **it never refuses a submission** — there is always a clip. It **warns by default**: a disagreement is recorded on the clip and shown to the human reviewer, and nothing is rejected. **A project may set it to reject**, and on one that has, a confident disagreement fails the clip at review. The measurement is stored either way.

What it measures is clock DRIFT — whether your sensor clock and your video clock run at the same rate over the clip — not the offset between them. **The offset between your sensor clock and your video clock is measured and shown to your reviewer, and it is never gated — with or without a `frames` file.** We correct for it and move on; a `frames` file makes that number a reading rather than an assumption, and it never becomes a verdict either way. There is **one bar and no middle tier**: a clip fails the measurement at **15 ms or 100 parts per million** of drift across the measured span, whichever it reaches first, and only when the correlation between the two signals is strong enough to trust the number. Anything under the bar passes. When a clip is over it but the correlation is too weak to stand behind, we record that we could not measure the clip reliably and your reviewer sees that — we do not call it clean. The millisecond half is what bites on a long clip and the ppm half on a short one, where there is not enough time to accumulate milliseconds. Honest capture measures well under 2 ppm, so this bar is not close to what a working rig produces.

### The stereo pair

Right eye present, frame counts equal within one, durations equal within one frame, calibration parses against schema v1. Structural only — shape problems refuse at seal and there is no warning level.

### What can refuse your projects

**Commercial Egocentric Evaluation (RGB Supplier Upload)** — 13 checks at the door:

`CONTAINER_NOT_MP4`, `RESOLUTION_TOO_LOW`, `ASPECT_RATIO`, `FRAME_RATE`, `KEYFRAME_INTERVAL`, `FRAME_GAP`, `ROTATION_TAG`, `HDR`, `LOCATION_PRESENT`, `AUTHOR_TAG_PRESENT`, `CLIP_LENGTH`, `FROZEN`, `PADDED_FRAME_RATE`

Plus the shape refusals every project shares: `PART_MISSING`, `PART_UNDECLARED`, `PART_NOT_UPLOADED`, `PART_DUPLICATE_TYPE`, `PART_SIZE_MISMATCH`, `CONSENT_INCOMPLETE`, `DUPLICATE_CONTENT`.

## Exact duplicates

We fingerprint every video file — both eyes on a stereo submission — with the checksum storage computes for us, and look it up across **every project on the platform**, not just yours.

An exact match refuses the submission at seal with `422 DUPLICATE_CONTENT`. The earlier clip stays; yours is the one that does not land, including when the twin is still waiting for review. If the twin belongs to your own team we name it (`submissionId`, `externalRef`) so you can find it; if it belongs to someone else you are told only that the bytes are already on the platform.

Two eyes that are byte-identical to each other are `STEREO_EYES_IDENTICAL` — the same file uploaded twice rather than a real pair.

What this does NOT block:

- **A rejected clip is invisible to the check.** If a clip of yours was rejected and you re-record or re-package it, send it again; being refused as a duplicate of your own rejected clip cannot happen.
- **Re-uploading a truncated or corrupt file.** That is the same submission, replayed — not a new one.

Near-duplicates are out of scope. We compare bytes, so a re-encode of the same footage is a different file to us and will be judged on its own merits — which is not an invitation to send one.

## Submission states

`state` on every submission body. The line is `draft → processing → in_review → approved | rejected`, with two states off it.

| State | What it means | What you do |
| --- | --- | --- |
| `draft` | Created, not sealed. Files may be uploaded and the declaration may still be corrected. | Upload, complete, seal. |
| `processing` | Sealed and accepted. The clip is being processed. | Poll. |
| `in_review` | Waiting for a human. | Poll. |
| `approved` | Accepted. | Nothing. |
| `rejected` | A person or a machine check rejected the clip. `rejection.code` is the stable code, `rejection.reason` carries the reason verbatim, and `rejection.type` says whether a human or a machine wrote it. | Fix the clip and send it under a **new `externalRef`**. |
| `refused` | Seal said no; nothing was created. `lastRefusal` carries the code, the message and when. | Fix what the code names and create again under the SAME `externalRef`. |
| `expired` | Created and never sealed within 14 days. | Create again under the same `externalRef`; the row resets to `draft`. |

**`refused` and `rejected` are not the same thing, and the difference decides what you do next.** A refusal happened at the door: no clip exists, so the same reference can be reused once you have fixed the file. A rejection happened to a clip that does exist and is permanently attached to that reference — so a corrected re-upload is a NEW submission with a NEW `externalRef`. The API says so itself, in `hint`.

### Rejection codes

A rejected submission carries a `rejection` block with something to branch on next to the sentence to print:

```jsonc
{
  "state": "rejected",
  "rejection": {
    "code": "QA_IMU_VIDEO_SYNC",        // stable; branch on this
    "checks": ["imu_video_sync", "frozen"],  // every failed check, in order
    "type": "machine",                  // or "human"
    "reason": "Your video needs 2 fixes before it can be reviewed:\n• …"
  },
  "hint": "resubmit the corrected clip under a new externalRef"
}
```

| Code | When | What it means |
| --- | --- | --- |
| `QA_<CHECK_KEY>` | `type: "machine"` | An automated check rejected the clip, named by the FIRST check that failed: the check’s own stable key, upper-cased. `QA_FROZEN`, `QA_UPSIDE_DOWN`, `QA_IMU_VIDEO_SYNC`. |
| `MACHINE_QA_REJECTED` | `type: "machine"` | An automated check rejected it and we cannot name which — an older clip, or one an internal reprocess has rewritten. `reason` still says what to fix. |
| `REVIEW_REJECTED` | `type: "human"` | A person rejected it, with a reason from the project’s own list. There is one code for all of them: the list is editable per project and is not a contract. |

`checks` is present only on a `QA_*` rejection and lists **every** failed check key, in the order they were recorded. Group your own reporting on `checks` rather than on `code` alone — a clip usually fails more than one, and `code` names whichever came first.

`QA_` is an OPEN prefix: a check added later produces a code you have not seen. Match on the prefix and fall back to showing `reason`, rather than exhausting a list of codes and crashing on the one that is new.

**Not every machine-QA result can reject, so not every check key can become a code.** Some are notes to the human reviewer, fixed at warn severity in code with no level to raise — `imu_set_aside` (your sensor file did not line up on a project that does not require one, so it was set aside and the video was judged on its own merits) and `declared_activity_mismatch` (you declared one activity and our classifier did not find it). A declaration never gates anything, and a classifier's opinion is not a verdict, so neither of those can ever appear as a `QA_*` code or fail a clip. If a clip of yours is approved and you are told about one of these anyway, that is the note working as intended.

**`rejection.reason` is unchanged and still verbatim**: the composed prose for a machine rejection, the reviewer’s selected reason for a human one. The code is an addition beside it, not a replacement for it, and it is what you should count and route on.

These codes are NOT refusal codes and will never appear in the refusal table below, nor a refusal code here. The two vocabularies answer opposite questions — a refusal means nothing was created and the same `externalRef` can be reused; a rejection means a clip exists and cannot be replaced under that reference.

## Every refusal code

The `code` field in the error body, with the same `details.remedy` sentence the API returns. Codes may be added; an existing one is never renamed or repurposed without a contract version bump and a CHANGELOG line, so it is safe to branch on them.

```jsonc
{
  "statusCode": 422,                               // the HTTP status, repeated
  "message": "…",
  "code": "FRAME_RATE",
  "details": { "remedy": "…", "measured": 25.0 }   // details vary by code
}
```

Four fields, and only two of them are always there. `statusCode` is on EVERY error this API returns, including the ones with no `code` at all — a 401, a 404, a validation 400 — and it is simply the HTTP status written into the body a second time. It is there because the whole platform answers that way, not because it tells you anything the response line did not. **Do not branch on it in place of `code`:** `422` covers every verdict about a submission and `403` covers every verdict about your team, so it separates two families and nothing finer.

`code` and `details` are present on the refusals below and absent on anything else — an ordinary 404, a malformed body. Read them defensively: an envelope with no `details` must not turn a message you could have shown into a crash.

| Code | What happened | What to do |
| --- | --- | --- |
| `TEAM_DRAFT` | Your team exists but has not been activated yet. | Your supplier team has not been activated yet. Ask your Claru contact to activate it. |
| `TEAM_SUSPENDED` | Your team is suspended. | Your supplier team is suspended. Ask your Claru contact to lift the suspension; uploads already in flight are kept. |
| `TEAM_CLOSED` | Your team is closed. | Your supplier team is closed. Contact Claru if you believe this is wrong. |
| `LEAD_PAUSED` | The account this key belongs to is no longer an active supplier lead. | The account this key belongs to is no longer an active supplier lead. Ask your Claru contact to reinstate it. |
| `PROJECT_NOT_ASSIGNED` | That project is not assigned to your team, or it does not take API uploads. | Your team is not assigned to that project. Call GET /supplier/projects for the list you may submit to. |
| `PERFORMER_COUNTRY_NOT_ALLOWED` | The supplier lead who owns this key has a profile country outside the COUNTRY project’s allowed countries. | The supplier lead’s profile country does not meet this project’s requirement. Contact Claru support if the stored country is wrong. |
| `CATEGORY_UNKNOWN` | The leaf category code you declared is not on this project. | That category code is not on this project. Refresh the project list with GET /supplier/projects. |
| `CATEGORY_DISABLED` | That category code exists but has been retired. | That category has been retired. Pick another code from GET /supplier/projects. |
| `PART_MISSING` | A file the project marks `required` was never declared. | Declare and upload every file the project lists as required. |
| `PART_UNDECLARED` | You declared a file type this project does not take — a `video_right` on a mono project, a `frames` part on an `imu: "off"` project, or `metadata`, which we write ourselves and never accept from a supplier. | Send only the file types the project lists. Remove the extra part and seal again. |
| `PART_NOT_UPLOADED` | A declared part is not in the bucket. "Not yet" and "never" look the same to us. | Finish uploading every declared part, then seal again. |
| `PART_DUPLICATE_TYPE` | You declared the same file type twice. Only `other` may repeat. | Only `other` may repeat. Send one part per file type. |
| `DUPLICATE_CONTENT` | These exact bytes are already on the platform, in any project. | These bytes are already on the platform. Send a different clip. |
| `STEREO_EYES_IDENTICAL` | The two eyes are byte-identical — the same file sent twice, not a pair. | The two eyes are byte-identical. Upload the right-eye video, not a second copy of the left. |
| `SEAL_TIMEOUT` | Seal ran out of its 30-second budget. Our problem, not yours; nothing was created. | Seal did not finish in time. Retry the same seal call; nothing was created. |
| `CONTRACT_VERSION_TOO_OLD` | The `contractVersion` you sent is below the oldest one we still accept. | Your integration is below the accepted contract version. Re-download the integration guide. |
| `CONSENT_INCOMPLETE` | One of the four consent statements was not `true`. | All four consent statements must be true for every clip. Do not submit footage you cannot affirm them for. |
| `CONTAINER_NOT_MP4` | The video is not an `.mp4` — either by filename at create, or by `ftyp` major brand at seal. | Rewrap the video as .mp4 with a stream copy — `ffmpeg -i IN.MOV -map 0:v:0 -map 0:a? -c copy OUT.mp4`. Do not re-encode. |
| `PART_SIZE_MISMATCH` | The object that landed is not the size the part declared. Usually a truncated upload. | The uploaded object is not the size you declared. Upload the whole file again; your bytes were left in place. |
| `SUBMISSION_EXPIRED` | The submission sat unsealed for 14 days. | This submission sat unsealed for 14 days. Create it again under the same external reference to start over. |
| `VIDEO_UNREADABLE` | The container could not be read far enough to judge it at all — no `moov` atom, a sample table claiming an impossible number of samples, a fragment chain that never ends, or an index still incomplete when the ranged reads ran out. Nothing was measured, so no other code applies. | We could not read this file’s structure. Re-upload it — a truncated transfer is the usual cause — and deliver the camera file rewrapped with a stream copy, never an editor render. |
| `IMU_FILE_TOO_LARGE` | The `inputs` CSV is over 64 MiB. Seal parses the whole file to answer cadence, coverage and monotonicity, so the ceiling is ours to set; the real worst case, a half-hour clip at 476 Hz, is about 50 MB. | The motion-sensor CSV is larger than we read in one submission. Deliver the recording as shorter clips, inside the project’s published length range. |
| `RESOLUTION_TOO_LOW` | Display height is under 1080 pixels, measured after the rotation tag is applied. | Record at least 1080 pixels tall, in 4:3 or 16:9. |
| `ASPECT_RATIO` | The displayed frame is neither 4:3 nor 16:9 (±1%). | Record in 4:3 or 16:9. Other aspect ratios are not accepted. |
| `FRAME_RATE` | The average frame rate is outside 29.5–30.5 and 59–61. PAL rates land here. | Set the camera to 29.97, 30, 59.94 or 60 fps. PAL rates (25/50/100) are not accepted; on a GoPro set Preferences › General › Anti-Flicker to 60Hz. |
| `KEYFRAME_INTERVAL` | More than a second between keyframes, measured on the delivered file's own timeline with a 5% tolerance. | The camera must write a keyframe at least once per second. Do not re-encode with a longer GOP. |
| `FRAME_GAP` | A presentation gap over 100 ms — a real dropout. One dropped frame (~66 ms) is fine. | The video has a gap longer than 100 ms. Deliver the recording without dropouts, and preserve the original frame timing when packaging. |
| `ROTATION_TAG` | The video carries a rotation tag. We judge the tag and the stored dimensions together, so a portrait-stored clip that displays landscape is fine. | Mount the camera upright and deliver a file with no rotation tag. Do not rotate in an editor — re-mux without the tag. |
| `HDR` | HLG or PQ transfer, or a Dolby Vision configuration record. Bit depth is not the criterion — 10-bit bt709 passes. | Turn HDR off at capture. 10-bit standard colour is fine; HLG and PQ are not. |
| `LOCATION_PRESENT` | The file carries capture coordinates. We read four places: GoPro `GPS5`/`GPS9` telemetry, the Apple `ISO6709` keys entry, the QuickTime `©xyz` atom, and the 3GPP `loci` atom that a plain remux rewrites `©xyz` into. | Turn location off at capture. We refuse a clip that carries coordinates and never strip them for you. |
| `AUTHOR_TAG_PRESENT` | A non-empty artist/author tag, which means the file went through a consumer editor. | The file carries an artist/author tag, which means it went through an editor. Deliver the camera file, stream-copied. |
| `CLIP_LENGTH` | Duration outside the project's published `clipLength` bounds. | Split the recording into clips inside the project’s published length range, with a stream copy on keyframes. |
| `FROZEN` | The picture stops changing for part of the clip. Measured from the file index over a sliding 30-second window; splitting the recording does not hide it. | The picture stops changing for part of this clip. Check the camera and re-record; splitting the same recording does not fix it. |
| `PADDED_FRAME_RATE` | The file claims a frame rate it does not deliver — repeated frames from an editor export. | This file reports a frame rate it does not deliver — repeated frames from an editor export. Deliver the camera file, stream-copied, never an editor render. |
| `IMU_MISSING` | No `inputs` file on a project whose motion-sensor checks are on. Refuses whether that project warns or errors on sensor defects. | This project requires a motion-sensor file. Send the annex CSV as the `inputs` part. |
| `FRAMES_REQUIRED` | No `frames` file on a project whose motion-sensor checks are on, and no embedded telemetry track in the video to recover the frame timestamps from. The exemption is decided by the track we find in your container, never by camera brand. | Send a `frames` part: `frame_index,timestamp_us`, one row per delivered frame, on the same clock as your `inputs` CSV. Your capture app can export per-frame timestamps and we need them to pair each frame with your sensor rows. Not needed if your camera writes an embedded telemetry track (GoPro `gpmd`). |
| `IMU_NOT_MONOTONIC` | Sensor timestamps go backwards somewhere a 32-bit wrap does not explain. | Sensor timestamps must increase. Sort the rows on the sensor clock before writing the CSV; do not interleave two sources. |
| `IMU_TIMESTAMP_UNPARSEABLE` | A sensor timestamp too large to hold exactly — an epoch-nanosecond clock, in practice. Past 2^53 not every integer has a name, so the cadence and the gaps would be measured on numbers your file never contained. | Write sensor timestamps in microseconds from the clip’s first video frame, not on an epoch nanosecond clock — we cannot hold those exactly. |
| `IMU_CLOCK_WRAPPED` | The sensor clock rolled over through 32 bits. We flag it; we never repair it. | The sensor clock wrapped through 32 bits. Write timestamps as unwrapped int64 microseconds. |
| `IMU_RATE_TOO_LOW` | Median gyro cadence below the 97 Hz gate. | Sample the gyroscope at 100 Hz or more; we gate at 97 Hz. |
| `IMU_COVERAGE` | The sensor rows do not span the whole video — they start more than 500 ms late or end more than 500 ms early. Longer than the video is fine; we trim the excess. | The sensor rows must span the whole video. Extra at either end is fine — a short one is not; state `declared.imu.videoStartUs` if row 0 is not video frame 0. |
| `STEREO_FRAME_COUNT` | The two eyes hold frame counts differing by more than one. | The two eyes must hold the same number of frames. Cut both cameras at the same keyframe index before muxing. |
| `STEREO_DURATION` | The two eyes differ in length by more than one frame. | The two eyes must be the same length to within one frame. Cut both cameras at the same keyframe index before muxing. |
| `CALIBRATION_INVALID` | The calibration JSON does not parse against `claru.stereo_calibration/v1`. | The calibration file does not match `claru.stereo_calibration/v1`. Check it against the sample in the integration guide. |

Two things are deliberately NOT in this list. Machine-QA outcomes on a clip we already accepted are REJECTION codes, a separate vocabulary in **Submission states** above (`QA_*`, `MACHINE_QA_REJECTED`, `REVIEW_REJECTED`) — they reach you on `rejection.code`, never on a refusal, because by then a clip exists. Infrastructure failures are never exposed at all: if you get a bare 500, retry, and tell us if it persists.

## Getting help

Talk to the Claru contact who set your team up, and quote three things: your team name, the submission's `externalRef`, and the `code` from the response. Support inbox: `<CLARU_SUPPLIER_SUPPORT_EMAIL>` — a placeholder until we publish a real one; your Claru contact is the reliable route today.

Two things worth checking before you ask:

- A 401 on every call usually means the key was rotated or revoked. There is no code that confirms a key once existed — a dead key is simply an invalid key. Download the guide again from the Integration tab to see the current key metadata, or rotate to mint a new one.
- A 403 with a `TEAM_*` or `LEAD_PAUSED` code is about your team, not your clip. Uploads already in flight are not lost; they just cannot be sealed until someone at Claru lifts it.
