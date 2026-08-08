// Harbor manga source plugin: مانجا العاشق / 3asq (3asq.online)
//
// This is a Madara WordPress theme. All selectors + endpoints verified against
// the live site (Aug 2026):
//   - popular:  /manga/page/N/?m_orderby=latest (latest-updated first) ; genre archive
//               /manga-genre/{slug}/page/N/ when a tag filter is active
//   - search:   /page/N/?s={query}&post_type=wp-manga (paginated)
//   - detail:   /manga/{slug}/
//   - chapters: POST /manga/{slug}/ajax/chapters/  (returns full list as HTML;
//               the series page itself loads chapters via AJAX, so this is the
//               only way to get them)
//   - pages:    reader ".reading-content img" (plain <img src>, no lazy-load)
//   - tags:     genre taxonomy, id = the english slug used in the archive URL

const BASE = "https://3asq.online";

async function getDoc(path) {
  const res = await harbor.http(BASE + path, { responseType: "text" });
  if (!res.ok) throw new Error("http " + res.status + " for " + path);
  return harbor.parseHtml(res.body);
}

// POST helper. Different harbor.http builds accept different option shapes,
// so try each until one returns a body; throw only if all fail.
async function postDoc(path, body) {
  const url = BASE + path;
  const shapes = [
    {
      method: "POST",
      body: body,
      responseType: "text",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
    },
    { method: "POST", body: body, responseType: "text" },
    { method: "POST", data: body, responseType: "text" },
    { method: "post", body: body, responseType: "text" },
  ];
  let lastErr;
  for (const opts of shapes) {
    try {
      const res = await harbor.http(url, opts);
      if (res && res.ok && res.body) return harbor.parseHtml(res.body);
      lastErr = new Error("http " + (res && res.status) + " for " + path);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("POST failed for " + path);
}

function abs(url) {
  if (!url) return undefined;
  url = url.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

// "https://3asq.online/manga/one-piece/" -> "one-piece"
function seriesIdFromHref(href) {
  const m = (href || "").match(/\/manga\/([^/?#]+)/);
  return m ? m[1] : null;
}

// "https://3asq.online/manga/one-piece/1190/" -> "one-piece/1190"
function chapterIdFromHref(href) {
  const m = (href || "").match(/\/manga\/([^/?#]+\/[^/?#]+)/);
  return m ? m[1] : null;
}

// Madara covers use data-src (lazy) then src; strip srcset by taking the base.
function coverFrom(img) {
  if (!img) return undefined;
  return abs(
    img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("src")
  );
}

// A .page-item-detail card (browse + genre archive share this markup).
// IMPORTANT: many cards put a translator-team badge <a> (external URL) BEFORE
// the manga link inside .post-title, so always filter anchors by /manga/ href.
function cardToSummary(el) {
  const a = el.querySelector('.post-title a[href*="/manga/"]') ||
    el.querySelector('a[href*="/manga/"]');
  if (!a) return null;
  const id = seriesIdFromHref(a.attr("href"));
  if (!id) return null;
  return {
    id,
    title: (a.text() || "").trim() || id,
    cover: coverFrom(el.querySelector(".item-thumb img") || el.querySelector("img")),
  };
}

const plugin = {
  id: "3asq",
  name: "مانجا العاشق (3asq)",
  version: "1.2.1",

  // Madara lists 21 items/page. Popular = order by views. When a genre tag is
  // active, use the genre archive (same card markup, same page size).
  async popular(offset, tagId) {
    const page = Math.floor(offset / 21) + 1;
    let path;
    if (tagId) {
      path =
        "/manga-genre/" +
        tagId +
        (page > 1 ? "/page/" + page + "/" : "/");
    } else {
      path =
        (page > 1 ? "/manga/page/" + page + "/" : "/manga/") +
        "?m_orderby=latest";
    }
    const doc = await getDoc(path);
    return doc
      .querySelectorAll(".page-item-detail")
      .map(cardToSummary)
      .filter(Boolean);
  },

  // Madara search: /page/N/?s=...&post_type=wp-manga . Result rows are
  // .c-tabs-item__content (21/page).
  async search(query, offset, tagId) {
    const page = Math.floor(offset / 21) + 1;
    const path =
      (page > 1 ? "/page/" + page + "/" : "/") +
      "?s=" +
      encodeURIComponent(query) +
      "&post_type=wp-manga";
    const doc = await getDoc(path);
    return doc
      .querySelectorAll(".c-tabs-item__content")
      .map((el) => {
        // Same badge trap as browse cards: only accept /manga/ links.
        const a =
          el.querySelector('.post-title a[href*="/manga/"]') ||
          el.querySelector('.tab-thumb a[href*="/manga/"]') ||
          el.querySelector('a[href*="/manga/"]');
        if (!a) return null;
        const id = seriesIdFromHref(a.attr("href"));
        if (!id) return null;
        return {
          id,
          title: (a.text() || "").trim() || id,
          cover: coverFrom(el.querySelector("img")),
        };
      })
      .filter(Boolean);
  },

  async detail(id) {
    const doc = await getDoc("/manga/" + id + "/");

    // Title: .post-title h1 may contain a team-badge <span>; drop children.
    let title = id;
    const h1 = doc.querySelector(".post-title h1");
    if (h1) {
      const badge = h1.querySelector("span");
      if (badge) badge.remove?.();
      title = (h1.text() || "").trim() || id;
    }

    // Metadata rows: .post-content_item > .summary-heading / .summary-content
    const row = (label) => {
      let out;
      doc.querySelectorAll(".post-content_item").forEach((r) => {
        if (out) return;
        const h = r.querySelector(".summary-heading");
        const c = r.querySelector(".summary-content");
        if (h && c && h.text().includes(label)) out = c.text()?.trim();
      });
      return out;
    };

    const desc =
      doc.querySelector(".description-summary .summary__content")?.text() ||
      doc.querySelector(".summary__content")?.text() ||
      doc.querySelector(".manga-excerpt")?.text();

    return {
      id,
      title,
      cover: coverFrom(doc.querySelector(".summary_image img")),
      description: desc?.trim(),
      status: row("الحالة"), // "مستمرة" / "مكتملة"
      author: row("الكاتب"),
    };
  },

  // Madara loads chapters via AJAX, not in the main /manga/ page HTML.
  // Try the endpoints in order until one returns rows.
  async chapters(id) {
    const parseChapters = (doc) =>
      doc
        .querySelectorAll("li.wp-manga-chapter")
        .map((li) => {
          const a = li.querySelector("a");
          if (!a) return null;
          const chapId = chapterIdFromHref(a.attr("href"));
          if (!chapId) return null;

          // Link text is like "1190 - title"; keep the leading number token.
          const raw = (a.text() || "").trim();
          const numMatch = raw.match(/(\d+(?:\.\d+)?)/);

          // Date lives in .timediff (relative) or an <a title="..."> with the
          // absolute date. The sibling .views span is NOT the date.
          const rel = li.querySelector(".chapter-release-date .timediff");
          const absDate = li.querySelector(".chapter-release-date a");
          const date =
            absDate?.attr("title")?.trim() || rel?.text()?.trim() || undefined;

          return {
            id: chapId,
            chapter: numMatch ? numMatch[1] : raw,
            title: raw,
            volume: null,
            pages: 0,
            language: "en",
            publishAt: date,
          };
        })
        .filter(Boolean);

    // 1) Modern Madara: POST to the manga page's ajax sub-path.
    //    (Verified working on 3asq; returns the full list, newest first.)
    try {
      const doc = await postDoc("/manga/" + id + "/ajax/chapters/", "");
      const ch = parseChapters(doc);
      if (ch.length) return ch;
    } catch (e) {
      /* fall through */
    }

    // 2) Older Madara: admin-ajax with action=manga_get_chapters.
    //    Needs the numeric post id, read from the page. (Disabled on 3asq -
    //    returns 400 - but kept for portability to other Madara sites.)
    try {
      const page = await getDoc("/manga/" + id + "/");
      const dataId =
        page.querySelector(".rating-post-id")?.attr("value") ||
        page.querySelector("#manga-chapters-holder")?.attr("data-id") ||
        page.querySelector("input.rating-post-id")?.attr("value");
      if (dataId) {
        const body =
          "action=manga_get_chapters&manga=" + encodeURIComponent(dataId);
        const doc = await postDoc("/wp-admin/admin-ajax.php", body);
        const ch = parseChapters(doc);
        if (ch.length) return ch;
      }
    } catch (e) {
      /* fall through */
    }

    // 3) Last resort: chapters already inline in the main page HTML.
    //    (Empty on 3asq's Madara build, but harmless and free to check.)
    const doc = await getDoc("/manga/" + id + "/");
    return parseChapters(doc);
  },

  // chapterId is "slug/number"; reader images are plain <img> in .reading-content.
  async pageUrls(chapterId) {
    const doc = await getDoc("/manga/" + chapterId + "/");
    return doc
      .querySelectorAll(".reading-content img")
      .map((img) =>
        abs(img.attr("data-src") || img.attr("data-lazy-src") || img.attr("src"))
      )
      .filter(Boolean);
  },

  // Genre taxonomy. id = english slug used in /manga-genre/{slug}/, which is
  // what popular() consumes as tagId. Names are the site's Arabic labels.
  async tags() {
    const doc = await getDoc("/?s=&post_type=wp-manga");
    const seen = {};
    doc.querySelectorAll('a[href*="manga-genre"]').forEach((a) => {
      const href = a.attr("href") || "";
      const slug = href.split("/manga-genre/")[1]?.replace(/\/.*$/, "");
      const name = (a.text() || "").trim();
      // Keep only clean ascii slugs; skip percent-encoded duplicates.
      if (slug && name && !/%/.test(slug) && !seen[slug]) {
        seen[slug] = name;
      }
    });
    return Object.keys(seen).map((slug) => ({
      id: slug,
      name: seen[slug],
      group: "التصنيف",
    }));
  },
};

return plugin;
