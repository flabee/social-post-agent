# Renderer

An Express + Puppeteer service that turns social-post data into PNG images
(HTML → headless Chromium → screenshot). It ships with neutral, CSS-only example
templates, so it runs with **no external background image**.

## Run locally

```bash
npm install
npm start            # listens on PORT (default 8080)
```

Then try:

```bash
# a single news slide
open "http://localhost:8080/render?type=news&category=Models&title=Hello&body=World&source=The%20Verge"

# the carousel cover
open "http://localhost:8080/render?type=cover&period=July%202026"

# an event post
open "http://localhost:8080/render?type=event&title=My%20Webinar&datetime=July%2015&speaker=Alex%20Doe&role=Design%20Lead"

# a hiring post
open "http://localhost:8080/render?type=hiring&role1=Full-Stack%20Developer&role2=AI%20Engineer"
```

## Routes

| Route | Returns |
|-------|---------|
| `GET \| POST /render?type=news\|cover\|event\|hiring&...` | one PNG |
| `GET /carousel?c=<base64url JSON {period, items}>` | composite preview grid (cover + up to 5 news) |
| `GET /carousel.zip?c=<base64url JSON>` | ZIP of all full-resolution slides |

Fields per type:

- **cover**: `period`
- **news**: `category`, `title`, `body`, `image?`, `source?`
- **event**: `title`, `datetime`, `speaker`, `role`, `speaker2?`, `role2?`, `speaker_image?`, `speaker2_image?`
- **hiring**: `role1`, `role2?`

## Deploy to Cloud Run

```bash
gcloud run deploy social-post-renderer --source . --region <your-region> \
  --allow-unauthenticated --memory 1Gi
```

The `Dockerfile` is based on the official Puppeteer image, so Chromium and its system
dependencies are already present.

## Engine notes

- **Auto-fit**: text elements with class `fit` and a `data-maxh` attribute are shrunk
  by the browser until they fit their box — long titles never overflow.
- **Image fetching**: `fetchImageDataUri` downloads remote images with a browser
  User-Agent (to defeat hotlink protection) and sniffs the type from magic bytes when
  the content-type header is missing or wrong, then inlines the image as a data URI.
- **Fonts**: Montserrat and Lato are bundled in `assets/` and embedded as data URIs
  (SIL Open Font License — see `../NOTICE`).

## Bring your own brand templates

The templates in `server.js` draw everything in CSS. To use real brand artwork,
follow the inline instructions at the top of `server.js`:

1. Export a clean background PNG at the template's exact pixel size.
2. Put it in `assets/` and load it as a data URI (see the commented `BG` block).
3. Position widgets absolutely over the background in the template's `widgets(f)`.
4. Tune coordinates by hitting `/render` and nudging px values.
5. Mark long text fields `fit` with a `data-maxh`.
