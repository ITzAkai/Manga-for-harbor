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

function sleep(ms) {
  // The sandbox may not provide setTimeout; degrade to no delay.
  if (typeof setTimeout !== "function") return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// Retry wrapper: the origin 502/503s intermittently but recovers in seconds.
// Always uses responseType "text": with "json", harbor.http returns the parsed
// value directly (no .ok/.status/.body), which breaks retry/error handling.
async function httpRetry(url, tries) {
  tries = tries || 4;
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
    await sleep(1500 * (i + 1));
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

function postToSummary(p) {
  if (!p || !p.slug) return null;
  return {
    id: p.slug,
    title: p.postTitle || p.slug,
    cover: p.featuredImage || undefined,
  };
}

const plugin = {
  id: "azorafly",
  name: "AzoraFly",
  version: "1.0.1",

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
    const html = await getText("/series/" + id);

    // Astro island props are HTML-entity-escaped JSON: &quot;key&quot;:[0,value]
    const grab = (re) => {
      const m = html.match(re);
      return m ? m[1] : undefined;
    };

    const postId = grab(/postId&quot;:\[0,(\d+)\]/);
    if (postId) postIdCache[id] = postId;

    const og = (prop) => {
      const m = html.match(
        new RegExp('<meta property="og:' + prop + '" content="([^"]*)"')
      );
      return m ? m[1] : undefined;
    };

    // og:description carries the synopsis as escaped HTML; strip tags/entities.
    let description = og("description") || "";
    description = description
      .replace(/&lt;[^&]*&gt;|<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    const statusRaw = grab(/seriesStatus&quot;:\[0,&quot;([^&]+)&quot;/);
    const statusMap = {
      ONGOING: "مستمرة",
      COMPLETED: "مكتملة",
      HIATUS: "متوقفة مؤقتاً",
      DROPPED: "متروكة",
      CANCELLED: "ملغاة",
    };

    // Cover: the query API has the real storage URL; og:image is a generated
    // card. Prefer the API, fall back to og:image.
    let cover;
    try {
      const q = await getJson(
        "/api/query?perPage=5&searchTerm=" + encodeURIComponent(id)
      );
      const exact = (q.posts || []).find((p) => p.slug === id);
      if (exact) cover = exact.featuredImage;
    } catch (e) {
      /* og fallback below */
    }

    const title = (og("title") || id).replace(/&amp;/g, "&");

    return {
      id,
      title,
      cover: cover || og("image"),
      description: description || undefined,
      status: statusRaw ? statusMap[statusRaw] || statusRaw : undefined,
      author: undefined, // the site does not expose an author field
    };
  },

  async chapters(id) {
    // Need the numeric postId; use the cached one from detail() or fetch it.
    let postId = postIdCache[id];
    if (!postId) {
      const html = await getText("/series/" + id);
      const m = html.match(/postId&quot;:\[0,(\d+)\]/);
      if (!m) return [];
      postId = m[1];
      postIdCache[id] = postId;
    }

    const data = await getJson(
      "/api/chapters?postId=" + postId + "&skip=0&take=all&order=desc"
    );
    const list =
      (data && data.post && data.post.chapters) || data.chapters || [];

    return list
      .map((c) => {
        if (!c || !c.slug) return null;
        const locked = c.isAccessible === false;
        return {
          // pageUrls needs both slugs: "series-slug/chapter-slug"
          id: id + "/" + c.slug,
          chapter: String(c.number != null ? c.number : ""),
          title:
            (c.title && String(c.title).trim()) ||
            "الفصل " + c.number + (locked ? " 🔒" : ""),
          volume: null,
          pages: 0,
          language: "en",
          publishAt: c.createdAt || undefined,
        };
      })
      .filter(Boolean);
  },

  // chapterId is "series-slug/chapter-slug".
  async pageUrls(chapterId) {
    const idx = chapterId.indexOf("/");
    if (idx < 0) return [];
    const seriesSlug = chapterId.slice(0, idx);
    const chapterSlug = chapterId.slice(idx + 1);

    const data = await getJson(
      "/api/chapter/content?mangaslug=" +
        encodeURIComponent(seriesSlug) +
        "&chapterslug=" +
        encodeURIComponent(chapterSlug)
    );

    // Locked chapters return isAccessible:false with an empty images array;
    // return [] and let Harbor show the chapter as having no pages.
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
