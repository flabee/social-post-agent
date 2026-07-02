// ─── search_news ──────────────────────────────────────────────────────────────
// Live news search. Tries the Google Custom Search API first (if configured via
// Script Properties), then falls back to a set of public RSS feeds.
//
// Customize RSS_FALLBACK_FEEDS_ to fit your brand's topic. The defaults below are
// general AI/tech feeds — swap them for feeds relevant to what you post about.

var RSS_FALLBACK_FEEDS_ = [
  { name: 'The Verge AI',    url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml' },
  { name: 'TechCrunch AI',   url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
  { name: 'VentureBeat AI',  url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Ars Technica AI', url: 'https://arstechnica.com/ai/feed/' },
  { name: 'Google AI Blog',  url: 'https://blog.google/technology/ai/rss/' }
];

// Window (in days) within which an article is considered "fresh". Beyond this we
// discard articles that are too old (RSS feeds sometimes include stale tails).
var RSS_FRESHNESS_DAYS_ = 45;

function searchNews(args) {
  const query = args.query;
  const maxResults = args.max_results || 5;
  const exclude = Array.isArray(args.exclude) ? args.exclude : [];

  // Try the Custom Search API first (only if both keys are configured)
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_SEARCH_API_KEY');
    const cx     = PropertiesService.getScriptProperties().getProperty('GOOGLE_SEARCH_CX');

    if (apiKey && cx) {
      const url = 'https://www.googleapis.com/customsearch/v1'
        + '?key=' + encodeURIComponent(apiKey)
        + '&cx='  + encodeURIComponent(cx)
        + '&q='   + encodeURIComponent(query)
        + '&num=' + Math.min(maxResults, 10)
        + '&dateRestrict=m1';  // last month

      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const data = JSON.parse(resp.getContentText());

      if (resp.getResponseCode() === 200 && data.items && data.items.length > 0) {
        var mapped = data.items.map(function(item) {
          return {
            title:        item.title,
            url:          item.link,
            snippet:      item.snippet || '',
            source:       item.displayLink || '',
            image:        (item.pagemap && item.pagemap.cse_image && item.pagemap.cse_image[0] && item.pagemap.cse_image[0].src)
                          || (item.pagemap && item.pagemap.metatags && item.pagemap.metatags[0] && item.pagemap.metatags[0]['og:image'])
                          || '',
            published_at: (item.pagemap && item.pagemap.metatags && item.pagemap.metatags[0]
                           && item.pagemap.metatags[0]['article:published_time'])
                          ? item.pagemap.metatags[0]['article:published_time'].slice(0, 10)
                          : new Date().toISOString().slice(0, 10)
          };
        });
        return filterExcluded_(mapped, exclude);
      }
    }
  } catch (e) {
    Logger.log('Custom Search failed: ' + e.message);
  }

  // Fallback: RSS feeds
  return searchNewsRss_(query, maxResults, exclude);
}

// Removes items whose url or title appears in the exclusion list (case-insensitive:
// an item is excluded if an `exclude` term is a substring of its url/title, or vice
// versa). Robust to small formatting differences.
function filterExcluded_(items, exclude) {
  if (!exclude || exclude.length === 0) return items;
  var norm = function(s){ return String(s || '').toLowerCase().trim(); };
  var ex = exclude.map(norm).filter(function(s){ return s.length >= 6; });
  if (ex.length === 0) return items;
  return items.filter(function(v) {
    var u = norm(v.url), t = norm(v.title);
    for (var i = 0; i < ex.length; i++) {
      var e = ex[i];
      if (u && (u.indexOf(e) !== -1 || e.indexOf(u) !== -1)) return false;
      if (t && (t.indexOf(e) !== -1 || (e.length >= 12 && e.indexOf(t) !== -1))) return false;
    }
    return true;
  });
}

function searchNewsRss_(query, maxResults, exclude) {
  // Significant query keywords (>=4 letters), for a "soft" match.
  const words = (query || '').toLowerCase().split(/[^a-zà-ù0-9]+/).filter(function(w) { return w.length >= 4; });

  const all = [];  // every item collected, with a relevance score

  for (const feed of RSS_FALLBACK_FEEDS_) {
    try {
      const resp = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) continue;

      const doc  = XmlService.parse(resp.getContentText());
      const root = doc.getRootElement();
      const entries = extractFeedItems_(root);  // {title, url, snippet, published_at} normalized

      for (const entry of entries) {
        const text = (entry.title + ' ' + entry.snippet).toLowerCase();
        let score = 0;
        for (const p of words) { if (text.indexOf(p) !== -1) score++; }
        all.push({
          title:        entry.title,
          url:          entry.url,
          snippet:      entry.snippet,
          source:       feed.name,
          published_at: entry.published_at,
          image:        entry.image || '',
          _score:       score
        });
      }
    } catch (e) {
      Logger.log('Feed ' + feed.name + ' failed: ' + e.message);
    }
  }

  if (all.length === 0) {
    return { error: 'No feed reachable for: ' + query };
  }

  // Prefer relevant items; ties broken by recency.
  all.sort(function(a, b) {
    if (b._score !== a._score) return b._score - a._score;
    return (b.published_at || '').localeCompare(a.published_at || '');
  });

  // Drop articles that are too old (stale feed tails), as long as enough fresh
  // items remain; otherwise keep everything (better something than nothing).
  const freshnessLimit = new Date(Date.now() - RSS_FRESHNESS_DAYS_ * 86400000).toISOString().slice(0, 10);
  const fresh = all.filter(function(r) { return (r.published_at || '') >= freshnessLimit; });
  const recent = (fresh.length >= maxResults) ? fresh : all;

  // Remove already-proposed/discarded items (exclude parameter).
  const available = filterExcluded_(recent, exclude);

  // If at least one item is relevant, keep only relevant ones; otherwise return the
  // most recent, so the agent always has fresh material.
  const relevant = available.filter(function(r) { return r._score > 0; });
  const base = (relevant.length > 0 ? relevant : available);

  if (base.length === 0) {
    return { error: 'No new news found for: ' + query + ' (all already proposed or too old). Try a different query.' };
  }

  // Work on a WIDER pool than needed: resolve images for all of them, then pick,
  // preferring (at equal relevance) items that actually have an image. This avoids
  // ending up with images-less news when relevant alternatives WITH a photo existed.
  const pool = base.slice(0, Math.max(maxResults * 3, 12));
  resolveOgImage_(pool);

  // Partition keeping the order (already by relevance+date): items with an image
  // first, then those without. Fill with image-less ones only if needed.
  const withImg    = pool.filter(function(r) { return r.image; });
  const withoutImg = pool.filter(function(r) { return !r.image; });
  const chosen     = withImg.concat(withoutImg).slice(0, maxResults);

  return chosen.map(function(r) {
    return { title: r.title, url: r.url, snippet: r.snippet, source: r.source, published_at: r.published_at, image: r.image || '' };
  });
}

// For items without an image, download the article page and extract the social
// image (og:image / twitter:image / link image_src / JSON-LD). Resolves relative or
// protocol-relative URLs against the article URL, and discards logos/pixels.
function resolveOgImage_(items) {
  var missing = items.filter(function(r){ return !r.image && r.url; });
  if (missing.length === 0) return;
  var reqs = missing.map(function(r){
    return {
      url: r.url,
      muteHttpExceptions: true,
      followRedirects: true,
      // Some sites only serve <meta og:image> to a "browser" user-agent.
      headers: { 'User-Agent': 'SocialPostAgent/1.0' }
    };
  });
  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { return; }
  resps.forEach(function(resp, i){
    try {
      if (resp.getResponseCode() !== 200) return;
      var html = resp.getContentText();
      var head = html.slice(0, 120000);  // social meta live in the <head>
      var url = extractSocialImage_(head);
      if (url) missing[i].image = absolutizeUrl_(url, missing[i].url);
    } catch (e) {}
  });
}

// Extracts the "social" image URL from an HTML page. Tries, in order:
// og:image(:secure_url), twitter:image(:src), <link rel=image_src>, JSON-LD image.
// Returns '' if nothing plausible is found.
function extractSocialImage_(html) {
  var patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
  ];
  for (var p = 0; p < patterns.length; p++) {
    var m = html.match(patterns[p]);
    if (m && m[1] && !imageToDiscard_(m[1])) return m[1];
  }
  // JSON-LD: "image":"..." or "image":["...","..."] or {"url":"..."}
  var ld = html.match(/"image"\s*:\s*"([^"]+)"/i)
        || html.match(/"image"\s*:\s*\[\s*"([^"]+)"/i)
        || html.match(/"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/i);
  if (ld && ld[1] && !imageToDiscard_(ld[1])) return ld[1].replace(/\\\//g, '/');
  return '';
}

// Discards URLs that clearly are not the article photo (logo, sprite, pixel,
// placeholder, data URI). Heuristic filter, deliberately conservative.
function imageToDiscard_(u) {
  return /^data:/i.test(u) || /(sprite|logo|placeholder|default|blank|spacer|1x1|pixel|favicon|avatar)/i.test(u);
}

// Turns a relative or protocol-relative URL into an absolute one, using the page
// URL as base. If already absolute (http/https) it is returned unchanged.
function absolutizeUrl_(u, pageUrl) {
  if (/^https?:\/\//i.test(u)) return u;
  var m = (pageUrl || '').match(/^(https?:)\/\/([^\/]+)/i);
  if (!m) return /^https?:\/\//i.test(u) ? u : '';
  var scheme = m[1], host = m[2];
  if (/^\/\//.test(u)) return scheme + u;              // //cdn.host/img.jpg
  if (/^\//.test(u))   return scheme + '//' + host + u; // /img/foo.jpg
  return scheme + '//' + host + '/' + u;                // foo.jpg (rare)
}

// Extracts an image URL from a feed item (media:content/thumbnail, enclosure).
function extractFeedImage_(el) {
  if (!el) return '';
  var media = XmlService.getNamespace('http://search.yahoo.com/mrss/');
  var img = '';
  try {
    var nodes = [el].concat(el.getChildren('group', media));
    for (var g = 0; g < nodes.length && !img; g++) {
      var contents = nodes[g].getChildren('content', media);
      for (var i = 0; i < contents.length && !img; i++) {
        var t = contents[i].getAttribute('type');
        var m = contents[i].getAttribute('medium');
        var u = contents[i].getAttribute('url');
        var isImg = (m && m.getValue() === 'image') || (t && /image/.test(t.getValue())) || (!t && !m);
        if (u && isImg) img = u.getValue();
      }
      if (!img) {
        var thumb = nodes[g].getChild('thumbnail', media);
        if (thumb && thumb.getAttribute('url')) img = thumb.getAttribute('url').getValue();
      }
    }
  } catch (e) {}
  if (!img) {
    try {
      var enc = el.getChild('enclosure', el.getNamespace());
      if (enc && enc.getAttribute('url')) {
        var et = enc.getAttribute('type');
        if (!et || /image/.test(et.getValue())) img = enc.getAttribute('url').getValue();
      }
    } catch (e) {}
  }
  if (!img) {
    try {
      var ns = el.getNamespace();
      var content = XmlService.getNamespace('http://purl.org/rss/1.0/modules/content/');
      var html = (el.getChildText('description', ns) || '') + ' ' + (el.getChildText('encoded', content) || '');
      var m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) img = m[1];
    } catch (e) {}
  }
  return img || '';
}

// Normalizes items from an RSS 2.0 or Atom feed into {title, url, snippet, published_at, image}.
function extractFeedItems_(root) {
  const rootName = root.getName().toLowerCase();
  const out = [];

  if (rootName === 'feed') {
    // Atom
    const ns = root.getNamespace();
    const entries = root.getChildren('entry', ns);
    for (const entry of entries) {
      const linkEl = entry.getChild('link', ns);
      const href   = linkEl ? linkEl.getAttribute('href') : null;
      out.push({
        title:        entry.getChildText('title', ns) || '',
        url:          href ? href.getValue() : (entry.getChildText('id', ns) || ''),
        snippet:      entry.getChildText('summary', ns) || entry.getChildText('content', ns) || '',
        published_at: parsePubDate_(entry.getChildText('published', ns) || entry.getChildText('updated', ns)),
        image:        extractFeedImage_(entry)
      });
    }
  } else {
    // RSS 2.0: root -> channel -> item (elements in no-namespace)
    const ns      = root.getNamespace();
    const channel = root.getChild('channel', ns) || root;
    const items   = channel.getChildren('item', ns);
    for (const item of items) {
      out.push({
        title:        item.getChildText('title', ns) || '',
        url:          item.getChildText('link', ns) || '',
        snippet:      item.getChildText('description', ns) || '',
        published_at: parsePubDate_(item.getChildText('pubDate', ns)),
        image:        extractFeedImage_(item)
      });
    }
  }

  return out;
}

function parsePubDate_(pubDateStr) {
  if (!pubDateStr) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(pubDateStr).toISOString().slice(0, 10);
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
