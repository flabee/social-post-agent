// FunctionDeclarations passed to the Gemini model in the loop.
// The descriptions are operational instructions: they teach the model when and how
// to call each tool. The generate_post_* tools render the image (Cloud Run renderer)
// and POST it into chat as a draft.
const TOOL_DECLARATIONS = [
  {
    name: 'search_news',
    description: 'Search for the MOST RECENT news available for a text query (last few weeks: results are ordered freshest-first). Does NOT return months-old articles: for a periodic post use the freshest news, not a past calendar month. Use this tool when you need news to propose or to verify a fact. If it returns an error or few items, retry with a broader or different query (e.g. in another language). Returns {results: [ {title, url, snippet, source, published_at, image}, ... ]} or {error}. Use source as the outlet name and image (if present) as the article image.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        max_results: { type: 'integer', description: 'Max number of results (default 5, max 10).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Optional but IMPORTANT to avoid duplicates: titles or URLs of items ALREADY proposed/discarded in this conversation. They will be excluded from results, so you get fresh news on each search.' }
      },
      required: ['query']
    }
  },
  {
    name: 'generate_post_news',
    description: 'Generate and PUBLISH IN CHAT as a draft the "News" carousel (one cover + EXACTLY 5 news slides). Use it once the team has agreed on the news. Returns {ok} or {error}. After the call, write the two captions and ask for approval.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Period shown on the cover, e.g. "July 2026".' },
        items: {
          type: 'array',
          description: 'EXACTLY 5 news items.',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'A short category label, e.g. "Models", "Regulation", "Funding", "Products", "Research", "Talent".' },
              title: { type: 'string', description: 'Short, punchy title (~max 48 chars).' },
              body: { type: 'string', description: 'Concise body text (~max 200 chars).' },
              image: { type: 'string', description: 'Article image URL. It MUST be copied VERBATIM from the "image" field of the search_news result for THAT item. NEVER invent, construct or guess an image URL (e.g. from the title or the outlet name): you would produce dead links that 404 and the photo would not appear. If that item has no image field, leave THIS field empty.' },
              source: { type: 'string', description: 'Optional but recommended if you set image: the outlet name (the "source" field), e.g. "The Verge". Shown as "Source: ...".' }
            },
            required: ['category', 'title', 'body']
          }
        }
      },
      required: ['period', 'items']
    }
  },
  {
    name: 'generate_post_event',
    description: 'Generate and PUBLISH IN CHAT as a draft the Event/Webinar post. Returns {ok} or {error}. Afterwards, write the captions and ask for approval.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title.' },
        datetime: { type: 'string', description: 'Date and time, e.g. "July 15, 2026, 6:00 PM".' },
        speaker: { type: 'string', description: 'Name of the speaker/host.' },
        role: { type: 'string', description: 'Speaker role.' },
        speaker2: { type: 'string', description: 'Optional: second speaker.' },
        role2: { type: 'string', description: 'Optional: role of the second speaker.' },
        speaker_image: { type: 'string', description: 'Optional: URL of the first speaker photo (circle at the bottom). Use ONLY a URL provided by the user; NEVER invent URLs. If absent, the slide shows a circle with the initials.' },
        speaker2_image: { type: 'string', description: 'Optional: URL of the second speaker photo. Same rules as speaker_image.' }
      },
      required: ['title', 'datetime', 'speaker']
    }
  },
  {
    name: 'generate_post_hiring',
    description: 'Generate and PUBLISH IN CHAT as a draft the Hiring post (1 or 2 open roles). Returns {ok} or {error}. Afterwards, write the captions and ask for approval.',
    parameters: {
      type: 'object',
      properties: {
        role1: { type: 'string', description: 'First open role.' },
        role2: { type: 'string', description: 'Optional: second open role.' }
      },
      required: ['role1']
    }
  }
];
