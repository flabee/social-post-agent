# Setup & Deploy Guide

This walks through standing up the Social Post Agent end to end with your own Google
Cloud project, Cloud Run renderer, and Google Chat app. The example brand is "Acme" —
substitute yours throughout. Everything secret lives in Script Properties, never in code.

## 0. Prerequisites

- A **Google Cloud project** with billing enabled. Note its project id.
- A **Google Workspace** account with **Google Chat**.
- Local tools: **Node 18+**, the **`gcloud`** CLI (authenticated: `gcloud auth login`
  and `gcloud config set project <your-gcp-project>`), and
  **[`clasp`](https://github.com/google/clasp)** (`npm i -g @google/clasp`,
  then `clasp login`).

Enable the APIs you'll use:

```bash
gcloud services enable \
  run.googleapis.com \
  aiplatform.googleapis.com \
  chat.googleapis.com \
  iamcredentials.googleapis.com
```

## 1. Deploy the renderer to Cloud Run

```bash
cd renderer
gcloud run deploy social-post-renderer \
  --source . \
  --region <your-region> \
  --allow-unauthenticated \
  --memory 1Gi
```

- `--allow-unauthenticated` is needed because Google Chat downloads the image directly
  from the renderer URL, and the browser opening the "full preview" link is anonymous.
  The renderer serves only rendered images from data you pass it — no secrets.
- 1 GiB memory gives Chromium comfortable headroom.

Copy the **service URL** it prints (e.g. `https://social-post-renderer-xxxx.run.app`).
Verify it: opening the URL should say "Social post renderer running.", and
`.../render?type=cover&period=July%202026` should return a PNG.

## 2. Create the Apps Script project

Create a standalone Apps Script project (script.google.com → New project) and copy its
**Script ID** (Project Settings → IDs).

```bash
cd agent
cp .clasp.json.example .clasp.json
# edit .clasp.json and set "scriptId" to your real Script ID
clasp push
```

`clasp push` uploads all `.gs` files and `appsscript.json`. The manifest already
declares:

- the **cloud-platform** OAuth scope (for Vertex AI) and **chat.bot**;
- the **OAuth2 for Apps Script** library
  (`1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`, symbol `OAuth2`);
- the **Chat** advanced service.

If clasp reports the library/advanced service isn't enabled, open the editor once and
accept the manifest, or add them via Editor → Libraries / Services.

> Optional: set `timeZone` in `appsscript.json` (defaults to `Etc/UTC`) so the weekly
> Monday-08:00 trigger fires at your local time.

## 3. Grant Vertex AI access

The agent calls Gemini through Vertex AI using the **script's own OAuth token** (the
identity that runs the triggers — usually you). That identity needs the **Vertex AI
User** role on the project:

```bash
gcloud projects add-iam-policy-binding <your-gcp-project> \
  --member="user:you@example.com" \
  --role="roles/aiplatform.user"
```

The model is `gemini-2.5-flash` (see `GEMINI_MODEL_` in `agent-loop.gs`); make sure
it's available in your chosen `GCP_LOCATION`.

## 4. Create a service account for posting as the app

The agent posts messages/cards **as the Chat app** using a service account:

```bash
gcloud iam service-accounts create social-post-chat \
  --display-name="Social Post Chat App"

# create and download a JSON key
gcloud iam service-accounts keys create sa-key.json \
  --iam-account=social-post-chat@<your-gcp-project>.iam.gserviceaccount.com
```

You'll paste the **contents** of `sa-key.json` into the `CHAT_SA_CREDENTIALS` Script
Property (step 6). Keep this key out of git.

## 5. Create the Google Chat app

1. In the Cloud Console, go to **Chat API → Configuration**
   (`https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat`).
2. **App name / avatar / description**: your choice (e.g. "Acme Social").
3. **Functionality**: enable "Receive 1:1 messages" and "Join spaces and group
   conversations".
4. **Connection settings**: choose **Apps Script** and paste your **Deployment ID**.
   - Create the deployment first: in the Apps Script editor, Deploy → New deployment →
     type "Web app" (execute as you, access "Anyone"). Use the deployment id here.
   - Alternatively choose "HTTP endpoint" and use the web-app URL.
5. **Visibility**: restrict it to the specific people or group who should use it.
6. Save.

Then **add the app to a space** (or DM it). Get the space resource name
(`spaces/AAAAAAAAAAA`) — you can find it in the space URL or via the Chat API. You'll
put it in `CHAT_SPACE`.

## 6. Set Script Properties

In the Apps Script editor: Project Settings → Script Properties → add:

| Key | Value |
|-----|-------|
| `GCP_PROJECT_ID` | `your-gcp-project` |
| `GCP_LOCATION` | e.g. `europe-west1` |
| `RENDERER_URL` | the Cloud Run URL from step 1 |
| `CHAT_SA_CREDENTIALS` | the full JSON contents of `sa-key.json` (one line) |
| `CHAT_SPACE` | `spaces/AAAAAAAAAAA` |
| `SYSTEM_PROMPT` | *(optional)* override the built-in prompt |
| `GOOGLE_SEARCH_API_KEY` | *(optional)* Custom Search API key |
| `GOOGLE_SEARCH_CX` | *(optional)* Custom Search engine id |

`config.example.gs` documents these and offers a one-shot seeding helper. If you don't
set the Google Custom Search keys, news search falls back to the built-in RSS feeds
(edit `RSS_FALLBACK_FEEDS_` in `tool-handlers.gs` to match your topic).

## 7. Run setup and smoke-test

From the Apps Script editor, run these functions (Run menu; grant the OAuth consent
when prompted) and read the execution log:

- `setupChatApp` — registers the queue worker (every minute) and the weekly proposal
  trigger (Monday 08:00). Run this **once**.
- `diag_render_news` — proves the agent can reach the renderer and get a PNG.
- `diag_post_carousel` — posts a full example carousel into `CHAT_SPACE`.
- `diag_generate_news_loop` — end-to-end: runs the loop, which searches news and posts
  a draft.
- `testWeeklyProposal` — runs the proactive weekly proposal on demand.

The `test_*` functions in `test-tools.gs` / `test-chat.gs` are unit-ish checks you can
run from the editor; those needing live credentials SKIP gracefully.

## 8. Use it

Message the app in the space (or wait for Monday). Ask it to propose a post, iterate in
natural language, and approve with "Approved" when ready. The agent prepares the draft
image + captions and stops — **publishing to LinkedIn/Instagram is manual by design**.

## Troubleshooting

- **"GCP_PROJECT_ID and/or GCP_LOCATION not set"** — set both Script Properties.
- **Gemini HTTP 403 / permission denied** — the running identity lacks `roles/aiplatform.user`,
  or the model isn't available in `GCP_LOCATION`.
- **"CHAT_SA_CREDENTIALS missing or invalid"** — the property isn't set, or the JSON is
  malformed (make sure the `private_key` newlines survived the paste).
- **App doesn't reply** — check the Apps Script executions log; confirm the deployment
  id in the Chat API config matches your latest web-app deployment, and that
  `processQueue_` has a trigger (run `setupChatApp`).
- **Renderer 500 / blank image** — hit the `/render` URL directly in a browser to see
  the error; check Cloud Run logs.
