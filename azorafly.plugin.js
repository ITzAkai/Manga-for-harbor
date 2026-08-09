// Harbor manga source plugin: AzoraFly / AZORA MANGA (azorafly.com)  v2.0.0
//
// Strategy: mirror what Harbor's JSON-config engine does (which the user
// confirmed WORKS against this site), and use the api subdomain only where
// it is the sole source of data, always with a main-domain fallback:
//   - popular/search: main-domain /api/query (JSON on azorafly.com itself,
//     verified live), falling back to parsing the /series HTML with the
//     exact selectors the working JSON config uses.
//   - detail: series page HTML (og: tags + island props).
//   - chapters: api.azorafly.com full list -> fallback: main-domain page's
//     SSR'd chapter anchors (recent ~20, same rows the JSON config reads).
//   - pages: api.azorafly.com/api/chapter/content is the ONLY place page
//     images exist (the reader HTML has none). If the subdomain is
//     unreachable from this device, pages cannot work and the plugin says
//     so explicitly instead of failing silently.

const BASE = "https://azorafly.com";
const API = "https://api.azorafly.com";

const postIdCache = {};
const coverCache = {};

async function fetchText(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await harbor.http(url, { responseType: "text" });
      if (res && res.ok && res.body) return res.body;
      lastErr = new Error("http " + (res && res.status) + " for " + url);
      if (res && res.status && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("request failed: " + url);
}

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("invalid json from " + where);
  }
}

function abs(url) {
  if (!url) return undefined;
  url = String(url).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.indexOf("/") === 0) return BASE + url;
  return BASE + "/" + url;
}

function seriesSlugFromHref(href) {
  const m = String(href || "").match(/\/series\/([^/?#]+)\/?$/);
  return m ? m[1] : null;
}

function summariesFromApi(data) {
  return ((data && data.posts) || [])
    .map((p) => {
      if (!p || !p.slug) return null;
      if (p.id != null) postIdCache[p.slug] = String(p.id);
      if (p.featuredImage) coverCache[p.slug] = p.featuredImage;
      return {
        id: p.slug,
        title: p.postTitle || p.slug,
        cover: p.featuredImage || undefined,
      };
    })
    .filter(Boolean);
}

// Fallback: parse a /series HTML listing with the JSON config's selectors.
function summariesFromHtml(html) {
  const doc = harbor.parseHtml(html);
  return doc
    .querySelectorAll("a.shrink-0[href^='/series/']")
    .map((a) => {
      const slug = seriesSlugFromHref(a.attr("href"));
      if (!slug) return null;
      const img = a.querySelector("img");
      const cover = abs(img?.attr("data-src") || img?.attr("src"));
      if (cover) coverCache[slug] = cover;
      return {
        id: slug,
        title: (a.attr("title") || img?.attr("alt") || slug).trim(),
        cover: cover,
      };
    })
    .filter(Boolean);
}

async function listVia(queryString, htmlPath) {
  // 1) main-domain JSON API (verified working on azorafly.com itself)
  try {
    const t = await fetchText(BASE + "/api/query?" + queryString);
    const out = summariesFromApi(parseJson(t, "/api/query"));
    if (out.length) return out;
  } catch (e) {
    /* fall through */
  }
  // 2) api subdomain
  try {
    const t = await fetchText(API + "/api/query?" + queryString);
    const out = summariesFromApi(parseJson(t, "api./api/query"));
    if (out.length) return out;
  } catch (e) {
    /* fall through */
  }
  // 3) plain HTML listing - the path the JSON config proves works
  const html = await fetchText(BASE + htmlPath);
  return summariesFromHtml(html);
}

const plugin = {
  id: "azorafly",
  name: "AzoraFly",
  version: "2.0.2",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let q = "perPage=30&page=" + page + "&orderBy=latest";
    if (tagId) q += "&genreIds=" + encodeURIComponent(tagId);
    return listVia(q, "/series?page=" + page);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let q =
      "perPage=30&page=" + page + "&searchTerm=" + encodeURIComponent(query);
    if (tagId) q += "&genreIds=" + encodeURIComponent(tagId);
    // HTML fallback cannot really search (server ignores the param), so it
    // only fires if both API hosts fail - better a browse list than nothing.
    return listVia(q, "/series?page=" + page);
  },

  async detail(id) {
    const statusMap = {
      ONGOING: "\u0645\u0633\u062a\u0645\u0631\u0629",
      COMPLETED: "\u0645\u0643\u062a\u0645\u0644\u0629",
      HIATUS: "\u0645\u062a\u0648\u0642\u0641\u0629",
      DROPPED: "\u0645\u062a\u0631\u0648\u0643\u0629",
      CANCELLED: "\u0645\u0644\u063a\u0627\u0629",
    };

    let html = "";
    try {
      html = await fetchText(BASE + "/series/" + id);
    } catch (e) {
      return { id, title: id.replace(/-/g, " ") };
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
    if (foundPostId) postIdCache[id] = foundPostId;

    let description = og("description") || "";
    description = description
      .replace(/&lt;[^&]*&gt;|<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    const statusRaw = grab(/seriesStatus&quot;:\[0,&quot;([^&]+)&quot;/);

    // The og:image is a generated share-card, not the real cover - and the
    // page also contains OTHER series' covers (recommendations), so never
    // take "the first storage URL". Resolve the cover in strict order:
    // 1) session cache from browse/search (always correct)
    // 2) the featuredImage inside THIS series' own props object - anchored
    //    to its slug so a recommendation card can never win
    // 3) look the series up in the query API by its title, match the slug
    // 4) og:image share-card as the absolute last resort
    let cover = coverCache[id];

    if (!cover) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const anchored = html.match(
        new RegExp(
          'slug&quot;:\\[0,&quot;' + esc + '&quot;\\][\\s\\S]{0,3000}?' +
            'featuredImage&quot;:\\[0,&quot;' +
            '(https:\\/\\/storage\\.azorafly\\.com\\/[^&]+)&quot;'
        )
      );
      if (anchored) cover = anchored[1];
    }

    const title = (og("title") || id.replace(/-/g, " ")).replace(/&amp;/g, "&");

    if (!cover && title) {
      try {
        const t = await fetchText(
          BASE + "/api/query?perPage=20&searchTerm=" + encodeURIComponent(title)
        );
        const q = parseJson(t, "cover lookup");
        const exact = (q.posts || []).find((p) => p.slug === id);
        if (exact && exact.featuredImage) {
          cover = exact.featuredImage;
          coverCache[id] = cover;
        }
      } catch (e) {
        /* og fallback below */
      }
    }

    return {
      id,
      title,
      cover: cover || og("image"),
      description: description || undefined,
      status: statusRaw ? statusMap[statusRaw] || statusRaw : undefined,
    };
  },

  async chapters(id) {
    // postId: session cache (filled by browse/search) -> detail HTML.
    let postId = postIdCache[id];
    let html = "";
    if (!postId) {
      try {
        html = await fetchText(BASE + "/series/" + id);
        const m = html.match(/postId&quot;:\[0,(\d+)\]/);
        if (m) {
          postId = m[1];
          postIdCache[id] = postId;
        }
      } catch (e) {
        /* HTML fallback below will refetch if needed */
      }
    }

    // Route 1: full list from the api subdomain.
    if (postId) {
      try {
        const t = await fetchText(
          API + "/api/chapters?postId=" + postId + "&skip=0&take=all&order=desc"
        );
        const data = parseJson(t, "/api/chapters");
        const list = (data && data.post && data.post.chapters) || [];
        const chapters = list
          .map((c) => {
            if (!c || !c.slug) return null;
            const locked = c.isAccessible === false;
            return {
              id: id + "/" + c.slug,
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
        /* fall through */
      }
    }

    // Route 2: SSR'd chapter anchors on the series page (recent ~20).
    if (!html) {
      try {
        html = await fetchText(BASE + "/series/" + id);
      } catch (e) {
        return [];
      }
    }
    const doc = harbor.parseHtml(html);
    const seen = {};
    const out = [];
    doc.querySelectorAll("a[href*='/chapter-']").forEach((a) => {
      const href = a.attr("href") || "";
      const m = href.match(/\/(chapter-[^/?#]+)\/?$/);
      if (!m || seen[m[1]]) return;
      seen[m[1]] = true;
      const numM = m[1].match(/chapter-([\d.-]+)/);
      const time = a.querySelector("time");
      out.push({
        id: id + "/" + m[1],
        chapter: numM ? numM[1].replace(/-/g, ".") : "",
        title:
          "\u0627\u0644\u0641\u0635\u0644 " + (numM ? numM[1] : m[1]),
        volume: null,
        pages: 0,
        language: "en",
        publishAt: time?.attr("datetime") || undefined,
      });
    });
    out.sort(
      (a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0)
    );
    return out;
  },

  async pageUrls(chapterId) {
    let raw = String(chapterId || "");
    if (/%[0-9a-fA-F]{2}/.test(raw)) {
      try {
        raw = decodeURIComponent(raw);
      } catch (e) {}
    }
    raw = raw
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/^\/+/, "")
      .replace(/^series\//, "")
      .replace(/^\d+~/, "");
    const m =
      raw.match(/^(.*?)\/(chapter-[^/]+)\/?$/) ||
      raw.match(/^(.*?)[\/_ ]?(chapter-[\d.-]+)\/?$/);
    if (!m) {
      throw new Error(
        "AZORA PAGES | unparseable chapterId=" + JSON.stringify(chapterId)
      );
    }
    const seriesSlug = m[1].replace(/[\/_ ]+$/, "");
    const chapterSlug = m[2];
    const qs =
      "mangaslug=" +
      encodeURIComponent(seriesSlug) +
      "&chapterslug=" +
      encodeURIComponent(chapterSlug);

    // The content endpoint exists ONLY on the api subdomain (main-domain
    // route verified 404), but try both so a future proxy works automatically.
    let lastErr;
    for (const host of [API, BASE]) {
      try {
        const t = await fetchText(host + "/api/chapter/content?" + qs);
        const data = parseJson(t, "chapter/content");
        const images = (data && data.images) || [];
        return images
          .map((im) =>
            im && im.url ? im.url : typeof im === "string" ? im : null
          )
          .filter(Boolean);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      "AZORA PAGES | api.azorafly.com unreachable from this device: " +
        (lastErr && lastErr.message)
    );
  },

  async tags() {
    const html = await fetchText(BASE + "/series/");
    const seen = {};
    const re =
      /\{&quot;id&quot;:\[0,(\d+)\],&quot;name&quot;:\[0,&quot;([^&]+)&quot;\]/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1] && m[2] && !seen[m[1]]) seen[m[1]] = m[2].trim();
    }
    return Object.keys(seen).map((gid) => ({
      id: gid,
      name: seen[gid],
      group: "\u0627\u0644\u062a\u0635\u0646\u064a\u0641",
    }));
  },
};

return plugin;
