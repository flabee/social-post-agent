// Client for the Cloud Run renderer (HTML -> PNG). Builds the /render, /carousel
// and /carousel.zip URLs and posts the resulting images into Chat as draft cards.
//
// Setup: set the Script Property RENDERER_URL to your deployed Cloud Run service
// (e.g. https://your-renderer-xxxxxxxx.run.app).

// Calls the renderer for ONE news slide. Returns { blob } (image/png) or { error }.
function renderNewsSlide_(category, title, body) {
  const base = PropertiesService.getScriptProperties().getProperty('RENDERER_URL');
  if (!base) return { error: 'RENDERER_URL not set in Script Properties' };

  const url = base.replace(/\/+$/, '') + '/render';
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ type: 'news', category: category, title: title, body: body }),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { error: 'Renderer unreachable: ' + (e && e.message ? e.message : e) };
  }

  const code = resp.getResponseCode();
  if (code !== 200) {
    return { error: 'Renderer HTTP ' + code + ': ' + resp.getContentText().slice(0, 200) };
  }
  const blob = resp.getBlob().setName('news.png');
  if (blob.getContentType() !== 'image/png') {
    return { error: 'Renderer: response is not PNG (' + blob.getContentType() + ')' };
  }
  return { blob: blob };
}

// Builds the renderer GET URL for a news slide (used in a Chat card: Chat downloads
// the image directly from this URL). Returns null if RENDERER_URL is missing.
function newsImageUrl_(it) {
  it = it || {};
  return renderUrl_({ type: 'news', category: it.category, title: it.title,
    body: it.body, image: it.image, source: it.source });
}

// Generic /render URL builder from a params object (skips empty values).
function renderUrl_(params) {
  const base = PropertiesService.getScriptProperties().getProperty('RENDERER_URL');
  if (!base) return null;
  const q = Object.keys(params)
    .filter(function(k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function(k) { return k + '=' + encodeURIComponent(params[k]); })
    .join('&');
  return base.replace(/\/+$/, '') + '/render?' + q;
}

// Event/Webinar image URL. f = { title, datetime, speaker, role, speaker2, role2,
// speaker_image?, speaker2_image? }.
function eventImageUrl_(f) {
  f = f || {};
  return renderUrl_({ type: 'event', title: f.title, datetime: f.datetime,
    speaker: f.speaker, role: f.role, speaker2: f.speaker2, role2: f.role2,
    speaker_image: f.speaker_image, speaker2_image: f.speaker2_image });
}

// Hiring image URL (1 or 2 roles).
function hiringImageUrl_(role1, role2) {
  return renderUrl_({ type: 'hiring', role1: role1, role2: role2 });
}

// Carousel cover URL (period field).
function coverImageUrl_(period) {
  const base = PropertiesService.getScriptProperties().getProperty('RENDERER_URL');
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/render?type=cover&period=' + encodeURIComponent(period || '');
}

// URL of the COMPOSITE carousel preview (cover + 5 news in a single image).
// The payload travels as base64url in the `c` query param, to fit a single GET URL.
function carouselUrl_(payload) {
  const base = PropertiesService.getScriptProperties().getProperty('RENDERER_URL');
  if (!base) return null;
  const c = Utilities.base64EncodeWebSafe(JSON.stringify(payload || {}), Utilities.Charset.UTF_8);
  return base.replace(/\/+$/, '') + '/carousel?c=' + encodeURIComponent(c);
}

// URL of the ZIP with all full-resolution slides (download them all with one link).
function carouselZipUrl_(payload) {
  const base = PropertiesService.getScriptProperties().getProperty('RENDERER_URL');
  if (!base) return null;
  const c = Utilities.base64EncodeWebSafe(JSON.stringify(payload || {}), Utilities.Charset.UTF_8);
  return base.replace(/\/+$/, '') + '/carousel.zip?c=' + encodeURIComponent(c);
}

// Posts the whole carousel (cover + news) into chat as a single card.
// Returns { thread_name } or { error }.
function postCarousel_(spaceName, threadName, payload, text) {
  const preview = carouselUrl_(payload);
  if (!preview) return { error: 'RENDERER_URL not set' };

  const zipUrl = carouselZipUrl_(payload);
  // Images in Chat cards don't zoom on tap: we offer a direct link to the preview
  // PNG (opens full-resolution in the browser) plus the ZIP.
  const fullText = (text || '')
    + '\n\n🔍 <' + preview + '|Open the full-screen preview>'
    + '\n📥 <' + zipUrl + '|Download all slides (ZIP)>';

  // Preview = ONE composite image; download = a single ZIP with all full-res slides.
  return postCard_(spaceName, threadName, fullText, preview, 'News carousel preview');
}

// ─── Current chat context + generate_post_* tool handlers ─────────────────────
// runJob_/weeklyProposal_ set the turn's space/thread before runAgentLoop, so the
// tools know where to post the draft.
var CTX_CHAT_ = { space: null, thread: null };

function setChatContext_(space, thread) {
  CTX_CHAT_ = { space: space || null, thread: thread || null };
}

// Tool: generate and post the News carousel (cover + 5 news) into chat.
function generatePostNews_(args) {
  if (!CTX_CHAT_.space) return { error: 'Chat context not available' };
  const payload = { period: (args && args.period) || '', items: (args && args.items) || [] };
  const r = postCarousel_(CTX_CHAT_.space, CTX_CHAT_.thread, payload, 'Draft "News" carousel 👇');
  return r.error ? { error: r.error } : { ok: true, posted: 'news carousel (' + payload.items.length + ' items)' };
}

// Tool: generate and post the Event/Webinar post into chat.
function generatePostEvent_(args) {
  if (!CTX_CHAT_.space) return { error: 'Chat context not available' };
  const url = eventImageUrl_(args || {});
  if (!url) return { error: 'RENDERER_URL not set' };
  const r = postCard_(CTX_CHAT_.space, CTX_CHAT_.thread, 'Draft Event post 👇', url, 'Event');
  return r.error ? { error: r.error } : { ok: true, posted: 'event' };
}

// Tool: generate and post the Hiring post (1 or 2 roles) into chat.
function generatePostHiring_(args) {
  if (!CTX_CHAT_.space) return { error: 'Chat context not available' };
  const url = hiringImageUrl_(args && args.role1, args && args.role2);
  if (!url) return { error: 'RENDERER_URL not set' };
  const r = postCard_(CTX_CHAT_.space, CTX_CHAT_.thread, 'Draft Hiring post 👇', url, 'Hiring');
  return r.error ? { error: r.error } : { ok: true, posted: 'hiring' };
}

// ─── Diagnostics (run manually from the Apps Script editor) ───────────────────

// Diagnostic: calls the renderer and logs the outcome (bytes received).
// Proves the agent (Apps Script) can generate the PNG from the Cloud Run service.
function diag_render_news() {
  const r = renderNewsSlide_(
    'Models',
    'New model tops the reasoning benchmarks',
    'The latest model beats its predecessors on complex reasoning tests, with a clear jump in independent evaluations.'
  );
  if (r.error) {
    Logger.log('diag_render_news ERROR: ' + r.error);
    return;
  }
  Logger.log('diag_render_news OK: PNG ' + r.blob.getBytes().length + ' bytes, type ' + r.blob.getContentType());
}

// Diagnostic: posts an Event card into CHAT_SPACE.
function diag_post_event() {
  const space = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!space) { Logger.log('CHAT_SPACE not set'); return; }
  const url = eventImageUrl_({
    title: 'AI for marketing: practical tools',
    datetime: 'July 15, 2026, 6:00 PM',
    speaker: 'Alex Doe', role: 'Design Lead'
  });
  const r = postCard_(space, null, 'Draft Event post 👇', url, 'Event');
  Logger.log('diag_post_event result: ' + JSON.stringify(r));
}

// Diagnostic: posts a Hiring card (2 roles) into CHAT_SPACE.
function diag_post_hiring() {
  const space = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!space) { Logger.log('CHAT_SPACE not set'); return; }
  const url = hiringImageUrl_('Full-Stack Developer', 'AI Engineer');
  const r = postCard_(space, null, 'Draft Hiring post 👇', url, 'Hiring');
  Logger.log('diag_post_hiring result: ' + JSON.stringify(r));
}

// Diagnostic: posts the full 5-news carousel into CHAT_SPACE.
function diag_post_carousel() {
  const space = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!space) { Logger.log('CHAT_SPACE not set'); return; }

  const payload = {
    period: 'July 2026',
    items: [
      { category: 'Models',     title: 'New model tops reasoning benchmarks', body: 'The latest model beats its predecessors on complex reasoning tests, with a clear jump in independent evaluations.' },
      { category: 'Funding',    title: 'Record round for a European AI startup', body: 'A funding round pushes the valuation past a billion, a sign of confidence in the continent\'s AI market.' },
      { category: 'Regulation', title: 'New EU guidance on generative AI', body: 'The Commission publishes practical guidance for businesses on transparency and model risk management.' },
      { category: 'Talent',     title: 'Senior researchers move to big tech', body: 'The race for AI talent continues, with new hires of leading profiles across the major labs.' },
      { category: 'Products',   title: 'AI assistants land in office tools', body: 'Major productivity suites integrate generative AI features directly into everyday workflows.' }
    ]
  };
  const r = postCarousel_(space, null, payload, 'Draft "News" carousel of the week 👇 (cover + 5 news)');
  Logger.log('diag_post_carousel result: ' + JSON.stringify(r));
}

// End-to-end diagnostic of the loop: runs runAgentLoop with the news request,
// setting the chat context (posts into CHAT_SPACE). Logs everything.
function diag_generate_news_loop() {
  const space = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!space) { Logger.log('CHAT_SPACE not set'); return; }
  setChatContext_(space, null);
  const r = runAgentLoop('Generate the News carousel NOW: search for news with the tool, pick 5 items and immediately call generate_post_news to publish the draft. Do not ask me for confirmation.', []);
  if (r.error) {
    Logger.log('diag_generate_news_loop LOOP ERROR: ' + r.error);
    return;
  }
  Logger.log('diag_generate_news_loop OK. Final text: ' + (r.text || '').slice(0, 500));
}

// Human-in-the-loop two-turn diagnostic: turn 1 proposes (text only), turn 2
// confirms -> must generate. Reproduces the text-only history of the real flow.
function diag_two_turns() {
  const space = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!space) { Logger.log('CHAT_SPACE not set'); return; }
  setChatContext_(space, null);

  const r1 = runAgentLoop('Propose IN WORDS ONLY (do not generate yet) 5 AI news items for this week\'s carousel.', []);
  if (r1.error) { Logger.log('TURN1 ERROR: ' + r1.error); return; }
  Logger.log('TURN1 (proposal): ' + (r1.text || '').slice(0, 200));

  // Simulate the real save: only text turns (tool turns are dropped).
  const histTextOnly = (r1.history || []).filter(function(t) {
    return t && t.parts && t.parts[0] && t.parts[0].text !== undefined;
  });
  Logger.log('History passed to turn 2: ' + histTextOnly.length + ' text turns');

  const r2 = runAgentLoop('Sounds good, generate the carousel.', histTextOnly);
  if (r2.error) { Logger.log('TURN2 ERROR: ' + r2.error); return; }
  Logger.log('TURN2 (after confirmation): ' + (r2.text || '').slice(0, 200));
}
