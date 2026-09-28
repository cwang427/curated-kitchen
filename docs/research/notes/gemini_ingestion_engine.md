# Gemini API as the recipe-import ingestion/extraction engine (state as of 2026-09-28)

Scope note: everything below was checked against live pages on 2026-09-28 unless a different date is given. Google's docs are now split into two API surfaces — the legacy `generateContent` API (camelCase fields, `generationConfig`, `url_context_metadata`) and the newer **Interactions API** (`POST /v1beta/interactions`, snake_case, `response_format`, `usage.tool_use_input_tokens`). Both are documented side by side and field names differ; each finding says which surface it refers to. Prices carry an explicit "through 12/31/26" promotional window in several cases — re-check before budgeting for 2027.

---

## Q1. URL context tool — how it retrieves pages, its limits, billing, statuses, fetcher identity

### Takeaway
URL context is a first-class Gemini tool (`tools: [{url_context: {}}]` on generateContent; `{type: "url_context"}` on Interactions) that first serves a page from an internal index cache and only live-fetches on a miss; it accepts up to 20 URLs and 34 MB per URL, bills the fetched page as ordinary input tokens (reported in `usage_metadata.tool_use_prompt_token_count` / `usage.tool_use_input_tokens`), and reports a per-URL status (`SUCCESS`, `ERROR`, `PAYWALL`, `UNSAFE`). Google does **not** document which user agent or IP range performs the live fetch, so whether a bot-blocking recipe site lets it through is empirically unknowable from the docs alone.

### Cited Findings

**Enabling and response shape**
- generateContent surface: add `{"url_context": {}}` to the `tools` array; the response carries a `url_context_metadata` object with a `url_metadata` array whose entries have `retrieved_url` and `url_retrieval_status`; fetched-page tokens are reported in `usage_metadata.tool_use_prompt_token_count` with a per-modality breakdown in `tool_use_prompt_tokens_details` — [Google AI: URL context (Generate Content API, legacy)](https://ai.google.dev/gemini-api/docs/generate-content/url-context)
- Interactions surface: tools are declared as `{"type": "url_context"}`; each retrieval appears in the `outputs` array as a `url_context_call` / `url_context_result` step carrying `status` and the retrieved URL; usage example shows `'input_tokens': 27, 'tool_use_input_tokens': 10309, 'output_tokens': 45, 'thoughts_tokens': 31, 'total_tokens': 10412`, i.e. the fetched page dominated the bill; responses also carry inline `url_citation` annotations with `start_index`/`end_index` — [Google AI: URL context (Interactions API)](https://ai.google.dev/gemini-api/docs/interactions/url-context.md.txt)
- The Interactions URL-context page says the Interactions API "is currently in Beta" and that for stable deployments developers should "continue to use the `generateContent` API"; it uses REST endpoint `https://generativelanguage.googleapis.com/v1beta/interactions` with an `API-Revision: 2026-05-20` header — [Google AI: URL context (Interactions API)](https://ai.google.dev/gemini-api/docs/interactions/url-context.md.txt); contradicted by the Interactions overview, which says that as of June 2026 the Interactions API is "Generally Available and recommended for all new projects" while `generateContent` remains "fully supported" — [Google AI: Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions)
- Complete `UrlRetrievalStatus` enum (from the official JS SDK source): `URL_RETRIEVAL_STATUS_UNSPECIFIED` ("Default value. This value is unused."), `URL_RETRIEVAL_STATUS_SUCCESS`, `URL_RETRIEVAL_STATUS_ERROR` ("The URL retrieval failed."), `URL_RETRIEVAL_STATUS_PAYWALL` ("content is behind paywall"), `URL_RETRIEVAL_STATUS_UNSAFE` ("content is unsafe") — [googleapis/js-genai src/types.ts](https://raw.githubusercontent.com/googleapis/js-genai/main/src/types.ts)
- The same enum exists in the Vertex AI Java SDK (`com.google.cloud.vertexai.api.UrlMetadata.UrlRetrievalStatus`), which is evidence the tool and its metadata are exposed on the Vertex/Google Cloud surface as well — [Google Cloud Java reference: UrlMetadata.UrlRetrievalStatus](https://docs.cloud.google.com/java/docs/reference/google-cloud-vertexai/latest/com.google.cloud.vertexai.api.UrlMetadata.UrlRetrievalStatus)
- Google Cloud publishes a URL-context page under the renamed "Gemini Enterprise Agent Platform" (formerly Vertex AI) docs; the page body is JavaScript-rendered and could not be read by my fetcher — [Google Cloud: URL context (Gemini Enterprise Agent Platform)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/url-context)

**Retrieval mechanics**
- The tool "employs a two-step retrieval process": it "first attempts to fetch the content from an internal index cache" ("a highly optimized cache" for speed and cost), and if the URL is not there (e.g. newly published content) it "automatically falls back to do a live fetch" — [Google AI: URL context (Generate Content API)](https://ai.google.dev/gemini-api/docs/generate-content/url-context); same wording on [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context)
- You explicitly supply the URLs in the prompt; the model does not autonomously choose URLs unless combined with Google Search, in which case it can "find relevant information online and then use the URL context tool to get a more in-depth understanding" — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context.md.txt)
- The GA announcement (2025-08-18) states: "You are charged for the added input tokens to context, based on the standard rate for the model" — no per-request fee; supported content at GA: PDFs, images (PNG, JPEG, BMP, WebP), HTML, JSON/XML/CSV, plain text/RTF/CSS/JavaScript — [Google Developers Blog: URL context tool now GA](https://developers.googleblog.com/url-context-tool-for-gemini-api-now-generally-available/)

**Limits and content types (current docs)**
- "The tool can process up to 20 URLs per request"; "The maximum size for content retrieved from a single URL is 34MB"; URLs must be publicly accessible — localhost, private networks and tunnelling services (ngrok, pinggy) are unsupported — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context)
- Supported: text (HTML, JSON, plain text, XML, CSS, JavaScript, CSV, RTF), images (PNG, JPEG, BMP, WebP), PDF. Not supported: paywalled content, YouTube videos, Google Workspace files (Docs, Sheets), video and audio files — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context)
- Pricing: "Price per token depends on the model used" — no separate URL fee on the developer API — [Google AI: URL context (Interactions API)](https://ai.google.dev/gemini-api/docs/interactions/url-context.md.txt)
- Models: "All Gemini 3.x and 2.5 series models support URL context" — [Google AI: URL context (Generate Content API)](https://ai.google.dev/gemini-api/docs/generate-content/url-context); the current page lists Gemini 3.8/3.7/3.6 Flash, 3.5 Flash variants, 3.1 Pro Preview and 2.5 Pro/Flash — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context)
- Tool combinations on the legacy surface: works with Google Search grounding, but the legacy page states "Tool use with function calling is currently unsupported" — [Google AI: URL context (Generate Content API)](https://ai.google.dev/gemini-api/docs/generate-content/url-context); contradicted for Gemini 3 on the Interactions surface, where an example combines `google_search`, `url_context` and a `response_format` JSON schema and the doc states combining tools with structured outputs "is supported in Gemini 3 series models" — [Google AI: Structured output](https://ai.google.dev/gemini-api/docs/structured-output)

**Fetcher identity / robots.txt (the key gap)**
- Google's official user-triggered-fetchers list (updated 2026-08-19) includes `Google-Agent` (mobile and desktop UA strings of the form `Mozilla/5.0 (...) Chrome/W.X.Y.Z ... (compatible; Google-Agent; +https://...)`, described as serving "Agents on Google infrastructure") and `Google-GeminiNotebook` (Gemini Notebook user-provided source URLs; legacy token `Google-NotebookLM` deprecated until August 2026). The page states: "Because the fetch was requested by a user, these fetchers generally ignore robots.txt rules." IP ranges are published as `user-triggered-fetchers.json`, `user-triggered-fetchers-google.json` and `user-triggered-agents.json` — [Google: User-triggered fetchers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers)
- Google-Agent's IP list lives at `https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json`; Google is "experimenting with the `web-bot-auth` protocol, using the `https://agent.bot.goog` identity" — [No Hacks: AI User-Agent Landscape 2026 (Apr 2026, updated Sep 2026)](https://nohacks.co/blog/ai-user-agents-landscape-2026)
- `Google-Extended` is a robots.txt product token, not a crawler; it controls "whether content Google crawls from their sites may be used for training future generations of Gemini models" and for grounding in Gemini Apps and Vertex AI APIs, and "does not impact a site's inclusion in Google Search nor is it used as a ranking signal" (page updated 2026-07-14) — [Google: Common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers)
- `Google-CloudVertexBot` crawls sites at the site owner's request for "building Vertex AI Agents" (uses common-crawlers.json IP ranges, honours `Google-CloudVertexBot` or `Googlebot` robots tokens); `GoogleOther` is a generic crawler "used by various product teams for fetching publicly accessible content" — [Google: Common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers)
- None of the Google URL-context pages mention a user agent, robots.txt, or webmaster controls — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context.md.txt); [Google Developers Blog GA post](https://developers.googleblog.com/url-context-tool-for-gemini-api-now-generally-available/)
- HN discussion (2025-09-15) on why publishers keep Google unblocked: "you need to show up in their search results or else you are a nobody"; blocking Google-Extended affects "both training and RAG while still allowing search engine indexing" — [Hacker News thread](https://news.ycombinator.com/item?id=45245449)

**Developer reports / reliability**
- Forum report: a Reuters article URL returned `URL_RETRIEVAL_STATUS_ERROR` with the model saying it was "unable to access the content of the provided URL" citing "paywalls, login requirements, or other access restrictions"; poster confirmed other AI tools also failed on that URL (May 30 – Jun 2, 2025) — [Google AI Developers Forum](https://discuss.ai.google.dev/t/error-from-testing-url-context-tool/86102)
- A practical test (2025-06-26) on a GitHub page got `URL_RETRIEVAL_STATUS_SUCCESS` and reported 162 tokens with the tool vs 42,911 tokens when the page was pasted manually; the test covered one HTML page only, no PDFs/redirects/UA experiments — [tanaikech gist](https://gist.github.com/tanaikech/6cd666838572f478d69ec8ae660968d9)
- No official reliability/success-rate figures for URL context retrieval were found in any Google page fetched.

### Inferences
- The "internal index cache" is almost certainly Google's own crawl/index infrastructure (the same corpus that powers Search grounding), which means a popular recipe page that Googlebot has crawled will usually be served from cache **without any live request to the site at all** — the site's bot blocking is irrelevant on a cache hit. The live-fetch path is the uncertain one.
- The most plausible live-fetch identity is `Google-Agent` ("agents on Google infrastructure", user-triggered, generally ignores robots.txt, published IP list), but Google never states this. The engineer can settle it empirically in an hour: point URL context at a URL on a server he controls, and read the UA/IP from the access log; then compare against `user-triggered-agents.json` and `user-triggered-fetchers-google.json`.
- Because user-triggered fetchers ignore robots.txt, a robots.txt block alone will not stop a live fetch; a Cloudflare/WAF challenge or IP block would. `Google-Extended` disallow could in principle remove a site from the grounding corpus, so a site that disallows Google-Extended might be served only via live fetch.
- The gist's "162 tokens" (June 2025) predates the `tool_use_prompt_token_count` field; the current docs and the GA post make clear retrieved content is billed as input tokens, so treat that figure as a reporting artefact, not a cost advantage. Expect a typical recipe page to bill in the ~5k–15k token range via URL context (the Interactions example shows 10,309 tool-use tokens for one page), and to be pre-cleaned by Google's extractor, not raw HTML.
- Status handling for the import pipeline: `SUCCESS` → proceed; `PAYWALL`/`UNSAFE` → don't retry; `ERROR` → fall back to your own fetch (or another fetch strategy covered by the other researchers) and pass content inline.

### Gaps
- Google does not document the user agent, IP ranges, JavaScript rendering, redirect handling, cache freshness/TTL, or robots.txt behaviour of the URL-context fetcher; the Google Cloud (Vertex/Enterprise) URL-context page could not be read (JS-rendered), so any Vertex-specific quotas (e.g. requests/day) are unverified.
- No published measurements of URL-context success rates on bot-hostile recipe sites were found.

---

## Q2. Google Search grounding, Deep Research agents, Computer Use as ways to find/read a recipe page

### Takeaway
Search grounding lets the model discover a page (billed per executed search query on Gemini 3: 5,000 free/month shared across 3.x models, then $14 per 1,000) and pairs naturally with URL context to read it; the Deep Research agents and the Computer Use model exist on the API but are multi-minute, multi-step tools that are overkill for single-page recipe import.

### Cited Findings
- Enable with `"tools": [{"type": "google_search"}]`; mechanics: the model decides whether to search, generates one or more queries, executes them, synthesises, and returns text with inline citations; response steps include `google_search_call` (queries executed) and `google_search_result` (with `search_suggestions` HTML for the mandated UI rendering); citations arrive as `url_citation` annotations — [Google AI: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- Billing: "With Gemini 3 models, billing occurs per executed search query"; multiple searches in one call count separately; empty queries excluded; 2.5 and older bill per prompt — [Google AI: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- Price: Google Search grounding "5,000 free monthly (shared across Gemini 3.x), then $14/1,000 requests" — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Combines with URL context, code execution, Google Maps grounding (3.5 Flash and later) and custom function calling (Gemini 3 only); older models used `google_search_retrieval` — [Google AI: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- The grounding page does not state whether the model reads full pages or only snippets — [Google AI: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- Deep Research agents `deep-research-preview-04-2026` and `deep-research-max-preview-04-2026` run only via the Interactions API with `background=True`, polled via `interactions.get()` or streamed; "can take several minutes to complete"; token-based billing; include the URL Context tool by default — [Google AI: Deep Research](https://ai.google.dev/gemini-api/docs/deep-research)
- The models catalogue lists `gemini-2.5-computer-use-preview-10-2025` (UI automation, screen input) and a managed agent `antigravity-preview-09-2026`; the 3.8 Flash card lists "Computer use (Preview)" as a capability — [Google AI: Models](https://ai.google.dev/gemini-api/docs/models); [Gemini 3.8 Flash model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)

### Inferences
- For "user pastes a URL" import, Search grounding adds cost and non-determinism without benefit; its real use is "user types a dish name / partial title" → find the page → URL context reads it. Even then, the model decides whether to search, so results are not guaranteed to include a search step.
- The search-suggestions display requirement in the ToS is a UI obligation the app would inherit whenever grounding is on.

### Gaps
- Whether grounded search reads full page content vs snippets is undocumented; per-model rate limits for grounded requests are not published on the docs page.

---

## Q3. Structured output / JSON schema for a Recipe object (and function calling as an alternative)

### Takeaway
Use JSON-schema structured output (`responseMimeType: "application/json"` + `responseJsonSchema` on generateContent; `response_format: {type:"text", mime_type:"application/json", schema}` on Interactions). The supported subset covers everything a recipe needs — nested objects, arrays, `required`, `additionalProperties`, `enum`, `minItems`/`maxItems`, `anyOf`, `$ref` recursion, `format: date-time` — but not `oneOf`/`allOf`/`pattern`/`propertyOrdering`; the schema itself costs input tokens, deeply nested schemas can be rejected, and only *syntactic* validity is guaranteed, so validate semantically afterwards.

### Cited Findings
- Interactions surface request: `response_format={"type": "text", "mime_type": "application/json", "schema": <JSON Schema>}`; Python/JS SDKs accept Pydantic and Zod models — [Google AI: Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- Supported JSON Schema features: types `string, number, integer, boolean, object, array, null`; object `properties`, `required`, `additionalProperties`, `title`, `description`; string `enum`, `format` (`date-time`, `date`, `time`); array `items`, `prefixItems`, `minItems`, `maxItems`; number `enum`, `minimum`, `maximum`; `anyOf`; recursion via `"$ref": "#"`; nested objects/arrays. Explicitly unsupported: `oneOf`, `allOf`, `not`, `pattern`, `propertyNames`, `patternProperties`, `propertyOrdering` — [Google AI: Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- Limitations stated: "very large or deeply nested schemas may be rejected"; schema tokens count against input tokens; syntactically correct JSON is guaranteed but application-level semantic validation is recommended; combining tools (Google Search, URL context, code execution, file search, function calling) with structured outputs "is supported in Gemini 3 series models" — [Google AI: Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- generateContent-style surface (documented via Firebase AI Logic, which wraps the same API): `generationConfig: { responseMimeType: "application/json", responseSchema }`; `responseSchema` is an OpenAPI-3.0 subset (`enum`, `items`, `maxItems`, `nullable`, `properties`, `required`); "If you use an unsupported field, the model can still handle your request, but it ignores the field"; "The size of the response schema counts towards the input token limit"; enum-only classification via `responseMimeType: "text/x.enum"` — [Firebase AI Logic: Generate structured output](https://firebase.google.com/docs/ai-logic/generate-structured-output)
- A third-party project switched from `responseSchema` to `responseJsonSchema` to send a full JSON Schema to Gemini (PR title: "send Gemini schema via responseJsonSchema") — [im-tnyx/tio-world PR #299](https://github.com/im-tnyx/tio-world/pull/299)
- The generateContent API reference documents `responseMimeType` and `responseSchema` in `GenerationConfig`, and `UsageMetadata` with `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount`, `totalTokenCount` plus per-modality `*TokensDetails[]` arrays — [Google AI: generateContent reference](https://ai.google.dev/api/generate-content.md.txt)
- `FinishReason` enum (JS SDK) includes `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, and image-specific values — [googleapis/js-genai src/types.ts](https://raw.githubusercontent.com/googleapis/js-genai/main/src/types.ts)
- Function calling via the OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`, `Authorization: Bearer GEMINI_API_KEY`) supports `tools` with `tool_choice`, `response_format` structured outputs (`client.beta.chat.completions.parse()` with Pydantic / Zod), base64 `image_url` input, and Gemini-only tools through `extra_body` (e.g. `"tools": [{"google_search": {}}]`, `cached_content`, `thinking_config`, `safety_settings`) — [Google AI: OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- Real-world recipe schema example (Nov 17, 2025): top-level `author`, `recipe` (title), `spec`, `tags`, `servings` (number), `prelude.description`, `steps[]` each with `description` and `ingredients[]` of `{item, amount (number), unit}`, `metadata.originalUrl`; author notes Gemini returns JSON "matching that schema (most of the time)" and that testing a non-deterministic extractor is hard — [Nick Felker, Medium](https://fleker.medium.com/gemini-api-and-structured-outputs-turning-tiktok-recipes-into-a-database-of-recipes-ab203fd48679)
- Mealie's approach to the schema question: it asks the LLM for **schema.org JSON-LD**, wraps the result back into HTML with `ld_json_to_html()`, and re-parses it with the same deterministic `recipe-scrapers` path it uses for normal pages — [Mealie scraper_strategies.py](https://github.com/mealie-recipes/mealie/blob/mealie-next/mealie/services/scraper/scraper_strategies.py)
- Third-party observation on LLM extraction generally: "extraction quality degrades with schema nesting depth" and "hallucination risk increases when over-marking fields as required" — [fastCRW: Firecrawl Extract deep dive (Jun 2026)](https://fastcrw.com/blog/firecrawl-extract-endpoint-deep-dive)

### Inferences
- Model recipe sections with a two-level shape that stays within the supported subset — illustrative (not from a source):
  ```json
  {"type":"object","required":["title","ingredientGroups","instructionGroups"],
   "additionalProperties":false,
   "properties":{
     "title":{"type":"string"},
     "description":{"type":["string","null"]},
     "yield":{"type":["string","null"],"description":"as written, e.g. '4 servings' or 'one 9-inch pie'"},
     "prepTimeMinutes":{"type":["integer","null"]},
     "cookTimeMinutes":{"type":["integer","null"]},
     "totalTimeMinutes":{"type":["integer","null"]},
     "imageUrls":{"type":"array","items":{"type":"string"},"maxItems":5},
     "ingredientGroups":{"type":"array","items":{"type":"object","required":["items"],
        "properties":{"heading":{"type":["string","null"]},
          "items":{"type":"array","items":{"type":"object","required":["raw"],
            "properties":{"raw":{"type":"string"},"quantity":{"type":["number","null"]},
              "quantityMax":{"type":["number","null"]},"unit":{"type":["string","null"]},
              "name":{"type":["string","null"]},"note":{"type":["string","null"]}}}}}}},
     "instructionGroups":{"type":"array","items":{"type":"object","required":["steps"],
        "properties":{"heading":{"type":["string","null"]},"steps":{"type":"array","items":{"type":"string"}}}}}}}
  ```
  Keep `raw` (verbatim line) alongside the parsed split so a bad split is recoverable; use `["type","null"]` unions rather than `nullable` on the JSON-Schema path; avoid `pattern` and `oneOf` (unsupported); keep `minutes` as integers rather than ISO-8601 duration strings (no `pattern` support means the model can't be constrained to `PT30M` anyway).
- Asking for schema.org/Recipe JSON directly is what Mealie does; it is convenient when you already have a schema.org parser downstream, but schema.org's `recipeIngredient` is a flat string list and has no section/group concept, so you lose ingredient-group headings unless you add a non-standard field. A house schema with groups, validated and then *converted* to schema.org for storage/export, is the better fit for the stated goals.
- Function calling is no longer needed as a workaround for "structured output + tools" on Gemini 3 (the docs say the combination is supported), though the legacy generateContent URL-context page still says function calling can't be combined with URL context — so if the pipeline uses generateContent + URL context, use `responseJsonSchema`, not a function declaration.
- Because `additionalProperties:false` and `required` are honoured, put "unknown → null" instructions in the system prompt and make everything except title/ingredients/steps nullable, per the third-party note that over-marking fields required raises hallucination risk.

### Gaps
- The exact schema-size ceiling ("schema too complex" thresholds) is not published; the docs only say very large/deeply nested schemas may be rejected.
- The Firebase page covers `responseSchema` only; the precise support matrix of `responseJsonSchema` per model on the legacy surface was not found in a fetchable Google page (the current structured-output page documents the Interactions `response_format` form).

---

## Q4. Token economics: raw HTML vs cleaned text, pre-processing, caching, context limits and 2026 prices

### Takeaway
Raw page HTML costs a median ~7× (up to ~48×) more tokens than the extracted text of the same page, so stripping boilerplate or sending only the JSON-LD block is the single biggest cost lever; at Sept-2026 prices a cleaned recipe page on Gemini 3.5 Flash-Lite costs on the order of a cent, and implicit caching only kicks in above 4,096 tokens on the 3.x Flash models.

### Cited Findings

**Tokenisation and measurement**
- Gemini text rule of thumb: "1 token is equivalent to about 4 characters. 100 tokens is equal to about 60-80 English words"; `models/{model}:countTokens` endpoint exists — [Google AI: Tokens](https://ai.google.dev/gemini-api/docs/tokens)
- Measured on 10 real pages with the `cl100k_base` tokenizer (2026-05-28): raw HTML vs extracted text — Wikipedia 48,975→6,658 (7.4×), Python docs 32,245→6,271 (5.1×), Hacker News 11,794→1,150 (10.3×), MDN 62,411→4,649 (13.4×), BBC News 112,721→2,356 (47.8×); median 7.4×, range 1.1×–47.8×; additionally decomposing `script, style, nav, header, footer, aside, noscript, svg, form` before `get_text` cut a further 6% (Wikipedia), 32% (BBC), 42% (MDN); "Modern, ad-heavy, JavaScript-state-dumped" pages reach double-digit multipliers — [Spinov, DEV Community](https://dev.to/0012303/feeding-raw-html-to-your-llm-is-a-token-tax-i-measured-it-on-10-real-pages-median-74x-and-it-gcd)
- Mealie's LLM path pre-cleans with BeautifulSoup `get_text(separator="\n", strip=True)` and separately extracts all `<script type="application/ld+json">` blocks (`extract_json_ld_data_from_html()`), sending text rather than raw HTML; per-request scrape timeout `SCRAPER_TIMEOUT = 15` seconds — [Mealie scraper_strategies.py](https://github.com/mealie-recipes/mealie/blob/mealie-next/mealie/services/scraper/scraper_strategies.py); Mealie docs say it "tries to keep token counts conservative" — [Mealie docs: OpenAI](https://docs.mealie.io/documentation/getting-started/installation/open-ai/)

**Caching**
- Implicit caching is on by default for 2.5+; minimum prompt size for a hit: 4,096 tokens for Gemini 3.8/3.7/3.6/3.5 Flash and 3.1 Pro Preview, 2,048 for 2.5 Flash/Pro; put the stable, repeated content at the *beginning* of the prompt and send similar requests close together; hits show up as `usage.total_cached_tokens`; "We automatically pass on cost savings if your request hits caches" — [Google AI: Context caching](https://ai.google.dev/gemini-api/docs/caching)
- Explicit caching (`cachedContents`) is not available on the Interactions API — "The Interactions API only supports implicit caching"; switch to generateContent for explicit caches — [Google AI: Context caching](https://ai.google.dev/gemini-api/docs/caching)
- Cached-token price is 10% of the input price on the current pricing page (e.g. 3.8 Flash input $0.75 vs context caching $0.075; 3.5 Flash-Lite $0.30 vs $0.03), plus cache storage $0.50–$1.00 per 1M tokens per hour depending on model — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)

**Context windows**
- `gemini-3.8-flash`: input 1,048,576 tokens, output 65,536; inputs text/image/video/audio/PDF; structured outputs, function calling, URL context, search grounding, caching, thinking (low/medium/high; no "minimal"), Batch, Flex, Priority, code execution, file search; "Latest update: September 2026" — [Gemini 3.8 Flash model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- `gemini-3.5-flash-lite`: input 1,048,576, output 65,536; inputs text/image/video/audio/PDF; structured outputs, function calling, URL context, search grounding, caching, thinking, Batch; released July 2026; positioned for "high-volume agentic workflows, simple data extraction" — [Gemini 3.5 Flash-Lite model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)

**Prices (Gemini Developer API, paid tier, per 1M tokens; page read 2026-09-28)**
- Gemini 3.8 Flash (also 3.7 and 3.6 Flash): input $0.75 / output $3.75 **through 12/31/26**, rising to $1.50 / $7.50 from 1/1/27; context-cache read $0.075 (→$0.15); Batch and Flex 50% off; Priority $1.35 / $6.75 (→$2.70 / $13.50) — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3.5 Flash: $1.50 / $9.00; caching $0.15; Batch/Flex $0.75 / $4.50 — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3.5 Flash-Lite: $0.30 / $2.50; caching $0.03; Batch/Flex $0.15 / $1.25 — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3.1 Flash-Lite: $0.25 (text/image/video; $0.50 audio) / $1.50; Batch/Flex $0.125 / $0.75 — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3.1 Pro Preview: $2.00 / $12.00 for prompts ≤200k tokens, $4.00 / $18.00 above 200k; Batch/Flex half — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3 Flash Preview: $0.50 (text/image/video; $1.00 audio) / $3.00 — [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 2.5 Flash / Flash-Lite / Pro no longer appear on the pricing page as fetched; the models page says Google is "limiting access to the 2.5 models to users who have actively used them in the past" and recommends "3.5 Flash-Lite or 3.8 Flash" for new projects; `gemini-2.0-flash` and `gemini-2.0-flash-lite` are shut down — [Google AI: Models](https://ai.google.dev/gemini-api/docs/models)

### Inferences
- Worked cost at these prices (my arithmetic): a pre-cleaned recipe page of ~30k tokens + ~1.5k tokens of JSON output on 3.5 Flash-Lite ≈ 30k×$0.30/1M + 1.5k×$2.50/1M ≈ **$0.009 + $0.004 ≈ $0.013**; the same on 3.8 Flash (promo price) ≈ $0.0225 + $0.0056 ≈ $0.028. A raw 200k-token HTML dump of the same page on Flash-Lite ≈ $0.06 input alone — 5–7× the cleaned cost, with more room for the model to get lost in ad/script noise. If the page has JSON-LD, sending only that block (typically low single-digit thousands of tokens) gets input cost to well under a tenth of a cent.
- Cheapest robust ordering: (1) if JSON-LD `Recipe` present → send only JSON-LD (+ maybe the visible ingredient/instruction text as a cross-check) to the LLM as a *normaliser*; (2) else send Readability-style main content or `get_text` with boilerplate tags removed; (3) only as a last resort send truncated raw HTML — and never the raw 500k-character page.
- Implicit caching is realistically only useful if the fixed prefix (system prompt + few-shot examples + schema) exceeds 4,096 tokens on 3.x Flash; a ~1k-token instruction block gets no cache benefit. If you deliberately build a ≥4,096-token stable prefix (e.g. rich few-shot examples), the 90% cache discount applies to that prefix on hits.
- The token multiplier study used an OpenAI tokenizer, not Gemini's; the ratio (not the absolute counts) is what transfers. Use `countTokens` on a sample of real recipe pages to calibrate.

### Gaps
- No recipe-site-specific HTML-vs-text token measurements were found; the 10-page study contains no recipe pages.
- No fetchable page documented Gemini's per-page PDF token cost.

---

## Q5. Multimodal options (page screenshots, recipe photos, cookbook pages, social video) — roadmap

### Takeaway
Images are cheap (258 tokens per 768×768 tile, or 258 flat for images ≤384 px) and can be passed inline (whole request ≤20 MB) or by public URL through URL context; video is ~300 tokens/s at default resolution, YouTube public URLs are supported natively, but Instagram/TikTok URLs are not — social imports need your own download or a text/caption scrape.

### Cited Findings
- Image tokens: images with both dimensions ≤384 px cost 258 tokens; larger images are tiled into 768×768 tiles at 258 tokens each (crop unit ≈ `floor(min(w,h)/1.5)`; e.g. 960×540 → 6 tiles); whole inline request (prompt + system + base64) must be ≤20 MB, use the Files API above that or for reuse; MIME types PNG, JPEG, WEBP, HEIC, HEIF; max 3,600 image files per request; `media_resolution` sets the max tokens per image/frame — [Google AI: Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)
- URL context can fetch images (PNG, JPEG, BMP, WebP) and PDFs directly by URL — [Google AI: URL context](https://ai.google.dev/gemini-api/docs/url-context)
- Video: inline for files under 100 MB, Files API for larger/longer (10+ min), Files API storage 20 GB paid / 2 GB free; YouTube URLs work for public videos only ("not private or unlisted"), free tier capped at 8 hours of YouTube per day, up to 10 videos per request on 2.5+; default ≈300 tokens/s (258 tokens/frame at 1 fps + 32 audio tokens/s), low resolution ≈100 tokens/s (66/frame + 32 audio); up to 1 hour high-res or 3 hours low-res in a 1M context; Instagram/TikTok URLs are not mentioned — [Google AI: Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- Audio costs 32 tokens per second — [Google AI: Tokens](https://ai.google.dev/gemini-api/docs/tokens)
- A TikTok-to-recipe project did not feed the video to Gemini; it scraped the "hidden text descriptions from the video webpage" and sent that text with a structured-output schema — [Nick Felker, Medium](https://fleker.medium.com/gemini-api-and-structured-outputs-turning-tiktok-recipes-into-a-database-of-recipes-ab203fd48679)
- Mealie's image import (v1.12.0) sends a photo of a hand-written or typed recipe to the LLM, with optional translation; `OPENAI_ENABLE_IMAGE_SERVICES` toggles it for cost — [Mealie docs: OpenAI](https://docs.mealie.io/documentation/getting-started/installation/open-ai/)
- Consumer apps already ship this: Honeydew imports "from social videos, screenshots, photos, notes" (Instagram Reels, Facebook, TikTok, YouTube); Recipe Keeper has "strong scanning" with PDF/OCR; Samsung Food limits free scans behind Food+; Crouton's photo/PDF import is in its Plus tier ($24.99 one-time) — [Honeydew: best recipe apps (2026-08-24)](https://honeydewcook.com/guides/best-recipe-apps)

### Inferences
- A cookbook-page photo at phone resolution (say 3000×4000) is on the order of 20–30 tiles → ~5–8k tokens: cheaper than a raw HTML page. Downscaling to ~1500 px on the long side before upload cuts that by ~4× with little OCR loss.
- For "screenshot of a recipe page" imports the same schema and prompt can be reused; the only change is the input part. A screenshot is also a viable fallback when the HTML is unfetchable but the user has the page open.
- Social-video import is roadmap-feasible with Gemini video understanding but requires you to obtain the media (download or user upload); a 60-second Reel is ~18k tokens at default resolution or ~6k at low resolution.

### Gaps
- Exact token counts per `media_resolution` level for Gemini 3 models were not on the fetched image page.
- Files API retention window (historically 48 hours) was not confirmed on the pages fetched.

---

## Q6. Quotas, rate limits, tiers, 429 behaviour and data-usage terms

### Takeaway
Numeric RPM/TPM/RPD tables have moved out of the public docs into the logged-in AI Studio rate-limit page; the public page now documents only the tier ladder (Free → Tier 1 with billing and a $250 spend cap → Tier 2 after $100 + 3 days → Tier 3 after $1,000 + 30 days), per-project enforcement, midnight-Pacific daily resets and `429 RESOURCE_EXHAUSTED`. Third-party snapshots put the free tier at only 20 requests/day for 3.x Flash and 500/day for Flash-Lite, and free-tier prompts may be used to improve Google products — a real concern for users' private recipes.

### Cited Findings
- Tiers: Free (active project or free trial); Tier 1 (billing account linked; $250 spend cap); Tier 2 ("$100 + 3 days from first successful payment"; $2,000 cap); Tier 3 ("$1,000 + 30 days"; $20,000–$100,000+ cap); "Rate limits are applied per project, not per API key. Requests per day (RPD) quotas reset at midnight Pacific time"; exceeding a limit returns `429 RESOURCE_EXHAUSTED`; "Specified rate limits are not guaranteed and actual capacity may vary"; numeric limits are viewed at `https://aistudio.google.com/rate-limit` — [Google AI: Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- Third-party snapshot (states it reflects AI Studio in September 2026): Free-tier RPD — Gemini 3.8/3.7/3.6/3.5 Flash 20 RPD each; 3.5 Flash-Lite and 3.1 Flash-Lite 500 RPD; RPM/TPM not listed — [ScriptByAI](https://www.scriptbyai.com/gemini-api-free-tier-limits/)
- Third-party retry guidance (page dated 2026-06-27, but its model table is stale/2.5-era): the 429 body's `message` identifies which limit fired; RPM → exponential backoff from ~60 s; RPD → fail fast until the daily reset; TPM → wait for the minute window; linking billing moves the key to Tier 1 immediately — [AI Prompt Generator Hub](https://aipromptshub.co/blog/gemini-api-free-tier-rate-limits)
- Terms (effective 2026-03-23): Unpaid Services — Google uses content to "provide, improve, and develop Google products and services and machine learning technologies", "Human reviewers may read, annotate, and process your API input and output" (disconnected from account/API key first), and "Do not submit sensitive, confidential, or personal information to the Unpaid Services". Paid Services — content is not used to improve products; logged "solely for detecting and preventing violations" for "a limited period of time"; DPA applies. "Paid" = a Cloud project with an active billing account (or AI Studio with billing / Workspace enterprise). For EU/Switzerland/UK users the paid-tier data terms apply "to all Services, including Google AI Studio and unpaid quota". Users must be 18+; the API is "for developers building with Google AI models for professional or business purposes, not for consumer use"; paid services required in EEA/CH/UK — [Google AI: Gemini API Terms](https://ai.google.dev/gemini-api/terms)
- Interactions API stores interactions by default (`store=true`): retention 55 days on paid tier, 1 day on free tier; paid users can set 7/14/28/55-day windows in AI Studio; `store=false` disables storage but also disables `previous_interaction_id` chaining and background execution — [Google AI: Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions)
- Interactions API is missing Batch API, explicit caching, custom safety settings and Python automatic function calling vs generateContent — [Google AI: Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions)

### Inferences
- At 20 RPD the free tier on 3.x Flash cannot serve even a demo with real users; Flash-Lite's 500 RPD is workable for a private beta. Any production traffic implies Tier 1 (link billing), which also flips the data-use terms to the paid ("not used to improve products") regime — the cleanest answer to "users import private recipes".
- Because a linked billing account makes *all* project usage "paid", the same key/project should be used for everything; do not keep a separate free-tier project "for testing" with real user data.
- If using the Interactions API, pass `store=false` on import calls so user page content is not retained 55 days server-side; use generateContent if you need Batch (50% off) for backfills.
- Rate-limit strategy for a Worker: respect `429` with jittered exponential backoff on RPM/TPM, surface RPD exhaustion as a user-facing "try later", and prefer Flash-Lite as the default extractor with 3.8 Flash as an escalation path for pages where Flash-Lite's output fails validation.

### Gaps
- Official per-model RPM/TPM/RPD tables for paid tiers are only visible after login in AI Studio; I could not retrieve them, and the third-party free-tier numbers (20 RPD / 500 RPD) are unverified against Google's page.
- The retention period for paid-tier abuse logs is "a limited period" — not quantified.

---

## Q7. Calling Gemini from Cloudflare Workers (REST vs SDK, AI Gateway, time limits, secrets)

### Takeaway
Plain `fetch` to `generativelanguage.googleapis.com` is the zero-risk path; `@google/genai` targets Node 20+/browsers and has no documented Workers support, though it is configurable to route through Cloudflare AI Gateway via `httpOptions.baseUrl`. Workers on the paid plan have no wall-clock limit for HTTP requests while the client is connected and fetch-wait time does not count as CPU, so a 10–30 s Gemini call is fine without Queues; the AI Gateway `google-ai-studio` provider adds logging, caching, key storage and an OpenAI-compatible route.

### Cited Findings
- AI Gateway Google AI Studio provider base URL: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/google-ai-studio`, appending the normal Google path (`v1/models/{model}:{resource}`), e.g. `.../google-ai-studio/v1/models/gemini-2.5-flash:generateContent`; auth via `x-goog-api-key: {key}` or `cf-aig-authorization: Bearer {CF_AIG_TOKEN}` for stored keys (BYOK/unified billing); SDK use: `new GoogleGenAI({ apiKey, httpOptions: { baseUrl: "https://gateway.ai.cloudflare.com/v1/${account_id}/${gateway_name}/google-ai-studio" } })`; OpenAI-compatible alternative at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions` with model `"google-ai-studio/{model}"` — [Cloudflare AI Gateway: Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)
- `@google/genai` README: supports Node.js and browser; Node 20+ required now, 22+ planned for SDK 3.0.0; Developer API via `apiKey`, Enterprise/Vertex via `enterprise: true` + `project` + `location`; `apiVersion` supports `v1` and `v1alpha` with beta default; "Avoid exposing API keys in client-side code"; no mention of Cloudflare Workers, Deno, Bun or edge runtimes — [googleapis/js-genai README](https://github.com/googleapis/js-genai)
- Sentry publishes a Cloudflare-specific integration page for Google Gen AI, which implies the SDK is being run inside Workers in practice — [Sentry: Google Gen AI integration for Cloudflare](https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/integrations/google-genai/)
- Workers limits (page updated 2026-09-05): CPU time 10 ms/request on Free, 5 min default on Paid (configurable up to 300,000 ms via `limits.cpu_ms`); "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time"; HTTP requests have no enforced wall-clock limit while the client remains connected; Cron triggers, Queue consumers and Durable Object alarms max 15 minutes; subrequests 50/invocation Free, 10,000 Paid; 128 MB memory; 6 simultaneous outgoing connections; script size 64 MiB — [Cloudflare Workers: Limits](https://developers.cloudflare.com/workers/platform/limits/)
- Gemini's OpenAI-compatible endpoint (`/v1beta/openai/`) accepts Bearer auth, `response_format` structured outputs, tools, base64 image input and Gemini extras via `extra_body` — usable through AI Gateway's OpenAI-compatible route — [Google AI: OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

### Inferences
- REST `fetch` is the safest choice on Workers: the request body is small JSON (`contents`, `tools`, `generationConfig` with `responseMimeType`/`responseJsonSchema`), the response is JSON, and there is nothing the SDK adds that a 30-line wrapper does not — while the SDK's Node-20+ target and lack of a Workers statement is a compatibility risk on upgrades.
- Latency budget: a cleaned-page extraction (tens of k input tokens, ~1–2k output) on Flash-Lite/Flash is typically several seconds to a few tens of seconds; on a paid Worker that is within limits without streaming or Queues as long as the browser keeps the request open. Use streaming (`streamGenerateContent`/SSE) only for UX; use Queues/Workflows only for batch backfills or if you add multi-minute Deep Research calls.
- The 6-simultaneous-connections cap matters if one import fans out (fetch page + fetch images + Gemini call); serialise or cap concurrency.
- Put the key in a Worker secret (not `vars`), and consider AI Gateway's stored-key mode so the key never sits in Worker code at all; AI Gateway also gives per-request logs with token counts, which is the easiest way to watch `tool_use_prompt_token_count` drift when URL context is used.

### Gaps
- No Cloudflare or Google page fetched explicitly states `@google/genai` runs on Workers (or under `nodejs_compat`); the evidence is indirect (Sentry integration). AI Gateway's caching/rate-limiting/retry semantics for the Google provider were not on the fetched page. Wrangler secrets mechanics were not fetched (well-known, but unsourced here).

---

## Q8. Extraction quality: prompt patterns, JSON-LD-as-ground-truth, validation, and how other apps use LLMs

### Takeaway
The best-documented open-source pattern (Mealie) is "deterministic scraper first; LLM only as fallback, fed cleaned text plus any JSON-LD, asked to emit schema.org JSON-LD that is re-parsed by the same deterministic code" — i.e. the LLM is a normaliser and gap-filler, not the sole extractor. No published benchmark of LLM recipe extraction from HTML was found; practitioner reports say schema compliance is "most of the time", nesting depth and over-required fields raise hallucination risk, and repeated-sampling agreement is a usable confidence signal.

### Cited Findings
- Mealie's LLM features by version: OpenAI ingredient parser (v1.7.0), URL-import fallback when the scraper fails — "the webpage contents will be parsed by OpenAI" (v1.9.0), image import of hand-written/typed recipes with optional translation (v1.12.0); configured via `OPENAI_API_KEY`, `OPENAI_BASE_URL` (any OpenAI-compatible API, Ollama documented), `OPENAI_ENABLE_IMAGE_SERVICES`; "OpenAI has a free tier, it's not sufficiently capable for Mealie" — [Mealie docs: OpenAI](https://docs.mealie.io/documentation/getting-started/installation/open-ai/)
- Mealie's `RecipeScraperOpenAI` (extends `RecipeScraperPackage`): `format_html_to_text()` → BeautifulSoup `get_text(separator="\n", strip=True)`; `extract_json_ld_data_from_html()` concatenates all `application/ld+json` blocks; `find_image()` prefers `og:image` else the largest image by pixel dimensions; prompt `recipes.scrape-recipe` with `response_schema=OpenAIText`; the LLM's JSON-LD output is wrapped via `ld_json_to_html()` and parsed by the normal `recipe-scrapers` path; on exception it logs and returns an empty string so the parent returns `None`; `can_scrape()` gates on AI settings being enabled — [Mealie scraper_strategies.py](https://github.com/mealie-recipes/mealie/blob/mealie-next/mealie/services/scraper/scraper_strategies.py)
- Nick Felker's TikTok pipeline: per-step ingredient lists with numeric `amount` and `unit`; output matches the schema "most of the time"; hard to test "a technology which is inherently non-deterministic"; not deployed because "Gemini API is even costlier" than his database — [Nick Felker, Medium (2025-11-17)](https://fleker.medium.com/gemini-api-and-structured-outputs-turning-tiktok-recipes-into-a-database-of-recipes-ab203fd48679)
- LLM data-collection paper (Izzard, Eshkiki, Caraffini, July 2026, GPT-4 mini only): repeated sampling (5–20 queries per attribute), median-absolute-deviation point estimates, majority vote for booleans, stopping threshold τ=0.90; "tight agreement reflects stable model belief but does not guarantee accuracy"; 98.4% exact-match on nutrient flags; ≈$1 per ingredient — [arXiv 2607.23273](https://arxiv.org/html/2607.23273v1)
- Third-party observations on LLM extraction: quality degrades with schema nesting depth; hallucination risk rises when fields are over-marked as required; accuracy varies by page type with "degradation on hardened e-commerce/social and heavily dynamic apps" — [fastCRW (2026-06-24)](https://fastcrw.com/blog/firecrawl-extract-endpoint-deep-dive)
- Structured-output guidance from Google: use clear `description` fields, strong typing over generic schemas, application-level validation, and error handling for "schema-compliant but semantically incorrect outputs" — [Google AI: Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- App landscape (article dated 2026-08-24): Paprika 3 uses "natural-language processing for plain-English recipes" and manual clipping when auto-capture fails, "not the social-video and screenshot workflows"; Plan to Eat documents Instagram/Facebook/TikTok/Pinterest/YouTube import (subscription); Flavorish caps image/social imports on free tier; Recipe Keeper does OCR/PDF scanning (Pro per platform); Samsung Food scans behind Food+ ($6.99/mo or $59.99/yr); Crouton photo/PDF import in Plus ($24.99 one-time); Pestle Pro ($24.99/yr) for scanning/PDF; Honeydew AI import "Claude and ChatGPT compatible" — [Honeydew: best recipe apps](https://honeydewcook.com/guides/best-recipe-apps)
- Mealie's ingredient-parser documentation exists as a separate contributor guide (CRF/NLP parser vs OpenAI parser) — [Mealie: Improving Ingredient Parser](https://mealie.io/contributors/guides/ingredient-parser/); the `ingredient-parser` CRF library (v2.4.0) is the common open-source deterministic alternative — [ingredient-parser docs](https://ingredient-parser.readthedocs.io/en/stable/resources/index.html)

### Inferences
- Prompt pattern that follows from the sources (unsourced synthesis): system prompt states (a) "extract only what is on the page; if a field is absent output null; never invent steps or quantities"; (b) rules for ingredient splitting — keep `raw` verbatim, parse `quantity` as a decimal (convert unicode fractions ½ → 0.5, ranges "2-3" → quantity 2 / quantityMax 3), `unit` normalised to a fixed enum plus `null`, `name`, `note` (e.g. "divided", "softened"); "1 (14 oz) can black beans" → quantity 1, unit "can", name "black beans", note "14 oz"; (c) preserve section headings for both ingredients and steps as `heading`; (d) steps as clean imperative sentences, one step per list entry, no numbering prefixes; (e) yield verbatim as written plus a parsed integer where obvious; (f) times as integer minutes. Add 2–3 short few-shot examples; if the prefix crosses 4,096 tokens on 3.x Flash it becomes cacheable.
- "LLM as normaliser" concretely: when JSON-LD `Recipe` exists, pass the JSON-LD block as the primary source and the visible text as secondary, and instruct the model to prefer JSON-LD values, using visible text only to add section headings and fix obviously broken fields (e.g. instructions collapsed into one string, HTML entities, `recipeYield` arrays). Post-validate with checks that need no LLM: every parsed ingredient's `raw` must appear in the source text; step count within ±1 of `HowToStep` count when JSON-LD exists; `quantity` ≤ some sanity bound; no ingredient names absent from the page text (guards against hallucination on truncated input); total time ≈ prep + cook when all three present.
- Truncation guard: if you must cut input, cut *after* the instruction list, and tell the model the content may be truncated so it must not invent a finish; check `finishReason === "MAX_TOKENS"` and re-run with a larger `maxOutputTokens` rather than accepting a truncated JSON.
- Confidence via agreement (from the arXiv paper's method): for high-value fields (yield, times) a second cheap Flash-Lite pass at temperature 0 that must agree with the first is a low-cost way to flag suspicious extractions for user review.

### Gaps
- No published, quantitative benchmark of LLM-based recipe extraction from web pages (field-level precision/recall vs schema.org ground truth) was found; the only numbers are from adjacent tasks (nutrient attributes). Mealie's actual prompt text could not be fetched (404 on the guessed path). Details on Crouton/Samsung Food/Paprika/Recipe Keeper's internal LLM providers are not public.

---

## Q9. Alternatives positioned against Gemini (Workers AI, Browser Rendering `/json`, Firecrawl/Jina)

### Takeaway
All three alternatives are viable extractors but weaker fits than Gemini for this app: Workers AI JSON mode cannot guarantee schema validity and lacks streaming; Browser Rendering's `/json` endpoint bundles headless rendering with a Workers-AI Llama extractor (BYO keys only for Anthropic/OpenAI, not Google); Firecrawl's extract is a separately metered add-on on top of per-page credits.

### Cited Findings
- Workers AI JSON mode: `response_format: { type: "json_schema", json_schema: {...} }`; supported models include `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/meta/llama-3-8b-instruct`, `@cf/meta/llama-3.1-8b-instruct`, `@hf/nousresearch/hermes-2-pro-mistral-7b`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`; Cloudflare "can't guarantee that the model responds according to the requested JSON Schema" and returns "JSON Mode couldn't be met" on failure; "JSON Mode currently doesn't support streaming" (page metadata Sep 14, 2026) — [Cloudflare Workers AI: JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- Browser Rendering (now "Browser Run") `/json`: `POST https://api.cloudflare.com/client/v4/accounts/<accountId>/browser-run/json` with `url` or `html`, plus `prompt` and/or `response_format` (`type: "json_schema"`); optional `custom_ai` (bring-your-own model/API key for `anthropic`, `openai`, `workers-ai` providers), `gotoOptions.waitUntil`, `authenticate`, `cookies`, `userAgent`, `rejectResourceTypes`; default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; usage incurs Workers AI costs; requires a token with "Browser Rendering - Edit" or a Worker binding — [Cloudflare Browser Rendering: /json endpoint](https://developers.cloudflare.com/browser-rendering/rest-api/json-endpoint/)
- Firecrawl extraction: schema-driven (JSON Schema) or prompt-driven, via `/scrape` with `"formats": ["json"]` and `jsonOptions`; extraction is billed on a separate token-based subscription (~$89/month add-on on top of an $83–99/month plan, ≈$172–188/month combined minimum, pricing verified 2026-05-18 by a third party) — [fastCRW (2026-06-24)](https://fastcrw.com/blog/firecrawl-extract-endpoint-deep-dive)
- Gemini's own Cloudflare-side alternative for the *fetch* step: the OpenAI-compatible route through AI Gateway with model `google-ai-studio/{model}` — [Cloudflare AI Gateway: Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)

### Inferences
- Browser Rendering `/json` is attractive precisely where Gemini URL context is weakest — JavaScript-rendered pages and sites that need a real browser — but it swaps Gemini for Llama-3.3-70B unless you BYO an Anthropic/OpenAI key; a hybrid is "Browser Rendering fetches/renders → Gemini extracts from the returned HTML/text", which keeps the Gemini schema guarantees.
- Workers AI is worth considering only for a zero-egress, on-platform fallback; the lack of schema guarantees means you would still need the same validation layer.
- Firecrawl/Jina make sense if you want a single vendor to handle fetching, cleaning (markdown) and extraction; for a Workers app already paying per-token to Gemini, they duplicate the extraction spend.

### Gaps
- Jina Reader/extract pricing and behaviour were not verified from a primary source. Workers AI per-model pricing (neurons) and context windows were not on the fetched page.

---

## Cross-cutting flags for the report writer
- **Model lineup churn:** the 2.5 family the user may be on is now restricted to prior users; Google's stated defaults for new projects are `gemini-3.5-flash-lite` (cheap, "simple data extraction") and `gemini-3.8-flash` (1M context, tools + structured output). 3.8 Flash pricing is promotional through 2026-12-31 and doubles on 2027-01-01 — [Google AI: Models](https://ai.google.dev/gemini-api/docs/models); [Google AI: Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- **Two API surfaces with different field names** (generateContent: `url_context_metadata`, `usage_metadata.tool_use_prompt_token_count`, `generationConfig.responseJsonSchema`; Interactions: `url_context_result` steps, `usage.tool_use_input_tokens`, `response_format`); Google's own tokens page lists yet another spelling (`total_tool_use_tokens`, `total_input_tokens`) for `interaction.usage` — [Google AI: Tokens](https://ai.google.dev/gemini-api/docs/tokens) vs [Google AI: URL context (Interactions API)](https://ai.google.dev/gemini-api/docs/interactions/url-context.md.txt). Treat exact Interactions usage field names as unstable and read them from a live response.
- **Interactions API status conflict:** "Beta, use generateContent for stable deployments" on the URL-context page vs "GA since June 2026, recommended for all new projects" on the overview — [Interactions URL context](https://ai.google.dev/gemini-api/docs/interactions/url-context.md.txt); [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions).
