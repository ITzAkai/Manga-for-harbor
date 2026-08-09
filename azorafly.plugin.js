// Harbor manga source plugin: AzoraFly (azorafly.com)
//
// Astro-built site; browse/detail pages are server-rendered but chapters and
// reader images come from an open JSON API. All endpoints verified (Aug 2026):
//   - list/search: GET https://api.azorafly.com/api/query
//       params: perPage, page, searchTerm, orderBy=latest, genreIds
//       -> { posts: [{id, slug, postTitle, featuredImage, seriesType,
//                     seriesStatus, genres[]}], totalCount }
//   - chapters:    GET https://api.azorafly.com/api/chapters
//       params: postId, skip=0, take=all, order=desc
//       -> { post: { chapters: [{slug, number, title, createdAt, price,
//                                isLocked, isAccessible}] }, totalChapterCount }
//       (postId is read from the series page's astro-island props)
//   - pages:       GET https://api.azorafly.com/api/chapter/content
//       params: mangaslug, chapterslug
//       -> { isAccessible, images: [{url, width, height}] }
//   - detail meta: og: tags + island props on the series page
//
// The origin is flaky (intermittent 502/503), so every request retries.
// Recent chapters are coin-locked server-side: the content API returns
// isAccessible=false with no images for them. The plugin lists them (with
// their real numbers/dates) but their pages are simply empty until the site
// unlocks them - it does not and cannot bypass the lock.

const BASE = "https://azorafly.com";
const API = "https://api.azorafly.com";
const PAGE_SIZE = 30;

// postId cache per series slug (module-level; lives for the session).
const postIdCache = {};

// Retry wrapper: the origin 502/503s intermittently. Retries are IMMEDIATE -
// no setTimeout/sleep - because plugin sandboxes may expose a setTimeout that
// never fires, which would hang the whole source ("did not respond").
// Failing fast is better: Harbor's own "Try again" button is the backoff.
// Always uses responseType "text": with "json", harbor.http returns the parsed
// value directly (no .ok/.status/.body), which breaks retry/error handling.
async function httpRetry(url, tries) {
  tries = tries || 3;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await harbor.http(url, { responseType: "text" });
      if (res && res.ok) return res;
      lastErr = new Error("http " + (res && res.status) + " for " + url);
      // 4xx will not fix itself; only retry server-side failures.
      if (res && res.status && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("request failed: " + url);
}

async function getJson(path) {
  const res = await httpRetry(API + path);
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error("invalid json from " + path);
  }
}

async function getText(path) {
  const res = await httpRetry(BASE + path);
  return res.body;
}

// Series ids are the PLAIN slug (Harbor rejects ids with unusual chars).
// The numeric post id the API gives us is stashed in the session cache as
// browse/search render, so chapters() usually needs no extra request.
function postToSummary(p) {
  if (!p || !p.slug) return null;
  if (p.id != null) postIdCache[p.slug] = String(p.id);
  return {
    id: p.slug,
    title: p.postTitle || p.slug,
    cover: p.featuredImage || undefined,
  };
}

// Accept both plain slugs and legacy "1234~slug" ids from old bookmarks.
function splitId(id) {
  const m = String(id).match(/^(\d+)~(.+)$/);
  return m ? { postId: m[1], slug: m[2] } : { postId: null, slug: String(id) };
}

const plugin = {
  id: "azorafly",
  name: "AzoraFly",
  version: "1.1.3",

  // Latest-updated ordering, matching the site's own feed. tagId is a numeric
  // genre id (see tags()); the API filters server-side via genreIds.
  async popular(offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    let path =
      "/api/query?perPage=" + PAGE_SIZE + "&page=" + page + "&orderBy=latest";
    if (tagId) path += "&genreIds=" + encodeURIComponent(tagId);
    const data = await getJson(path);
    return (data && data.posts ? data.posts : [])
      .map(postToSummary)
      .filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    let path =
      "/api/query?perPage=" +
      PAGE_SIZE +
      "&page=" +
      page +
      "&searchTerm=" +
      encodeURIComponent(query);
    if (tagId) path += "&genreIds=" + encodeURIComponent(tagId);
    const data = await getJson(path);
    return (data && data.posts ? data.posts : [])
      .map(postToSummary)
      .filter(Boolean);
  },

  async detail(id) {
    const { postId, slug } = splitId(id);
    if (postId) postIdCache[slug] = postId;

    const statusMap = {
      ONGOING: "\u0645\u0633\u062a\u0645\u0631\u0629",
      COMPLETED: "\u0645\u0643\u062a\u0645\u0644\u0629",
      HIATUS: "\u0645\u062a\u0648\u0642\u0641\u0629",
      DROPPED: "\u0645\u062a\u0631\u0648\u0643\u0629",
      CANCELLED: "\u0645\u0644\u063a\u0627\u0629",
    };

    // Best effort: the main site gives description/status/cover, but the API
    // subdomain is the only hard dependency, so a main-site failure must not
    // kill detail entirely.
    let html = "";
    try {
      html = await getText("/series/" + slug);
    } catch (e) {
      /* degrade to slug-derived basics below */
    }

    const grab = (re) => {
      const m = html.match(re);
      return m ? m[1] : undefined;
    };
    const og = (prop) => {
      const m = html.match(
        new RegExp('<meta property="og:' + prop + '" content="([^"]*)"')
      );
      return m ? m[1] : undefined;
    };

    const foundPostId = grab(/postId&quot;:\[0,(\d+)\]/);
    if (foundPostId) postIdCache[slug] = foundPostId;

    let description = og("description") || "";
    description = description
      .replace(/&lt;[^&]*&gt;|<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    const statusRaw = grab(/seriesStatus&quot;:\[0,&quot;([^&]+)&quot;/);
    const title =
      (og("title") || slug.replace(/-/g, " ")).replace(/&amp;/g, "&");

    return {
      id,
      title,
      cover: og("image"),
      description: description || undefined,
      status: statusRaw ? statusMap[statusRaw] || statusRaw : undefined,
      author: undefined, // the site does not expose an author field
    };
  },

  async chapters(id) {
    const { postId: embedded, slug } = splitId(id);

    // Resolve the numeric postId. Priority: embedded in the id (set by
    // popular/search from the API - no extra request), then the session
    // cache, then a main-site fetch as a last resort for old bare-slug ids.
    let postId = embedded || postIdCache[slug];
    let html = "";
    if (!postId) {
      try {
        html = await getText("/series/" + slug);
        const m = html.match(/postId&quot;:\[0,(\d+)\]/);
        if (m) {
          postId = m[1];
          postIdCache[slug] = postId;
        }
      } catch (e) {
        /* fall through to HTML fallback below */
      }
    }

    // Route 1: the chapters API (full list, pure API subdomain).
    if (postId) {
      try {
        const data = await getJson(
          "/api/chapters?postId=" + postId + "&skip=0&take=all&order=desc"
        );
        const list =
          (data && data.post && data.post.chapters) || data.chapters || [];
        const chapters = list
          .map((c) => {
            if (!c || !c.slug) return null;
            const locked = c.isAccessible === false;
            return {
              // pageUrls needs "series-slug/chapter-slug"
              id: slug + "/" + c.slug,
              chapter: String(c.number != null ? c.number : ""),
              title:
                (c.title && String(c.title).trim()) ||
                "\u0627\u0644\u0641\u0635\u0644 " +
                  c.number +
                  (locked ? " \ud83d\udd12" : ""),
              volume: null,
              pages: 0,
              language: "en",
              publishAt: c.createdAt || undefined,
            };
          })
          .filter(Boolean);
        if (chapters.length) return chapters;
      } catch (e) {
        /* fall through to HTML fallback */
      }
    }

    // Route 2: parse SSR'd chapter anchors from the series page. Partial
    // (the page renders only recent chapters) but better than nothing.
    if (!html) {
      try {
        html = await getText("/series/" + slug);
      } catch (e) {
        return [];
      }
    }
    const seen = {};
    const out = [];
    const re = new RegExp(
      'href="/series/[^"]+/(chapter-[^"/]+)"[\\s\\S]{0,2000}?(?:datetime="([^"]+)")?',
      "g"
    );
    let m;
    while ((m = re.exec(html)) !== null) {
      const chSlug = m[1];
      if (seen[chSlug]) continue;
      seen[chSlug] = true;
      const numM = chSlug.match(/chapter-([\d.-]+)/);
      out.push({
        id: slug + "/" + chSlug,
        chapter: numM ? numM[1].replace(/-/g, ".") : "",
        title: "\u0627\u0644\u0641\u0635\u0644 " + (numM ? numM[1] : chSlug),
        volume: null,
        pages: 0,
        language: "en",
        publishAt: m[2] || undefined,
      });
    }
    out.sort(
      (a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0)
    );
    return out;
  },

  // chapterId is "series-slug/chapter-slug" - but Harbor builds may hand it
  // back mangled (percent-encoded, prefixed with the numeric~ id, a full URL,
  // or with the slash encoded), so normalize aggressively before splitting.
  async pageUrls(chapterId) {
    let raw = String(chapterId || "");

    // Undo percent-encoding if present (%2F, %27, %7E ...).
    if (/%[0-9a-fA-F]{2}/.test(raw)) {
      try {
        raw = decodeURIComponent(raw);
      } catch (e) {
        /* keep raw as-is */
      }
    }
    // Full URL -> path.
    raw = raw.replace(/^https?:\/\/[^/]+/i, "");
    // Leading /series/ or bare leading slashes.
    raw = raw.replace(/^\/+/, "").replace(/^series\//, "");
    // Numeric id prefix ("1234~slug/chapter-x") -> drop the numeric part.
    raw = raw.replace(/^\d+~/, "");

    // Split on the LAST "chapter-" segment.
    const m = raw.match(/^(.*?)\/(chapter-[^/]+)\/?$/);
    let seriesSlug, chapterSlug;
    if (m) {
      seriesSlug = m[1];
      chapterSlug = m[2];
    } else {
      // Slash lost entirely? Try "...slugchapter-x" style recovery.
      const m2 = raw.match(/^(.*?)[\/_ ]?(chapter-[\d.-]+)\/?$/);
      if (!m2) {
        throw new Error("AZORA PAGES DIAG | unparseable chapterId=" +
          JSON.stringify(String(chapterId)));
      }
      seriesSlug = m2[1].replace(/[\/_ ]+$/, "");
      chapterSlug = m2[2];
    }

    const url =
      API +
      "/api/chapter/content?mangaslug=" +
      encodeURIComponent(seriesSlug) +
      "&chapterslug=" +
      encodeURIComponent(chapterSlug);

    let res;
    try {
      res = await harbor.http(url, { responseType: "text" });
    } catch (e) {
      throw new Error("AZORA PAGES DIAG | http threw: " + e.message +
        " | slug=" + seriesSlug + " ch=" + chapterSlug);
    }
    if (!res || !res.ok || !res.body) {
      throw new Error("AZORA PAGES DIAG | http status=" +
        (res && res.status) + " | slug=" + seriesSlug + " ch=" + chapterSlug);
    }

    let data;
    try {
      data = JSON.parse(res.body);
    } catch (e) {
      throw new Error("AZORA PAGES DIAG | bad json: " +
        res.body.slice(0, 80));
    }

    // Locked chapter: legitimately empty - no error, Harbor shows no pages.
    const images = (data && data.images) || [];
    return images
      .map((im) => (im && im.url ? im.url : typeof im === "string" ? im : null))
      .filter(Boolean);
  },

  // Genre map extracted from the browse page's island props (id + name pairs).
  async tags() {
    const html = await getText("/series/");
    const seen = {};
    const re =
      /\{&quot;id&quot;:\[0,(\d+)\],&quot;name&quot;:\[0,&quot;([^&]+)&quot;\]/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const gid = m[1];
      const name = m[2].trim();
      if (gid && name && !seen[gid]) seen[gid] = name;
    }
    return Object.keys(seen).map((gid) => ({
      id: gid,
      name: seen[gid],
      group: "التصنيف",
    }));
  },
};

return plugin;
