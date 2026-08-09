// Harbor manga source plugin: مانجا اون لاين (onma.me)  - fixed build
//
// MMRCMS-style site, fully server-rendered. All selectors verified live:
//   - popular:  /filterList?page=N&sortBy=views&asc=false (18/page)
//   - search:   /search?query=... -> {suggestions:[{value,data}]} JSON
//   - detail:   /manga/{slug} - h3 label rows (markup is malformed nested
//               h3s, so label matching must be anchored to the row start)
//   - chapters: ul.chapters > li (full list in one page, e.g. 961 for
//               One Piece), dates in .date-chapter-title-rtl
//   - pages:    #all img, lazy-loaded via data-src (values contain stray
//               spaces, handled by abs())
//
// Fixes over the original draft:
//   1. `return plugin;` added - without it this Harbor never loads the file.
//   2. `version` field added so updates are not ignored as downgrades.
//   3. Removed custom headers/timeoutMs http options (unsupported options
//      have broken plugins in this runtime before); plain requests + retry.
//   4. JSON fetched as text + JSON.parse (responseType "json" returns the
//      bare value with no .ok/.status, which breaks error handling).
//   5. Detail label matching anchored (^المؤلف / ^الحالة) so the malformed
//      wrapper row can never poison author/status.
//   6. Search results get the site's predictable cover URL instead of none.
//   7. Titles normalized (curly quotes -> ASCII) for Harbor's cross-source
//      matching.

const BASE = "https://onma.me";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normTitle(t) {
  return cleanText(t)
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ");
}

function stripHtml(value) {
  return cleanText(
    String(value || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}

function abs(base, value) {
  if (!value) return undefined;
  const url = cleanText(value).split(/\s+/)[0];
  if (!url || url.indexOf("data:") === 0) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.indexOf("/") === 0) return BASE + url;
  return BASE + "/" + url;
}

function imageUrl(base, el) {
  if (!el) return undefined;
  const srcset = el.attr("srcset");
  return abs(
    base,
    el.attr("data-cfsrc") ||
      el.attr("data-src") ||
      el.attr("data-lazy-src") ||
      (srcset ? srcset.split(",").pop().trim().split(/\s+/)[0] : "") ||
      el.attr("src")
  );
}

function uniq(items, keyFn) {
  const seen = {};
  const out = [];
  for (const item of items || []) {
    if (!item) continue;
    const key = keyFn ? keyFn(item) : item;
    if (!key || seen[key]) continue;
    seen[key] = true;
    out.push(item);
  }
  return out;
}

async function fetchText(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await harbor.http(url, { responseType: "text" });
      if (res && res.ok && res.body) return res.body;
      lastErr = new Error("HTTP " + (res && res.status) + " for " + url);
      if (res && res.status && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("request failed: " + url);
}

async function doc(url) {
  return harbor.parseHtml(await fetchText(url));
}

async function jsonGet(url) {
  const body = await fetchText(url);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("invalid json from " + url);
  }
}

function parseStatus(value) {
  const s = cleanText(value).toLowerCase();
  if (!s) return undefined;
  if (/complete|finished|مكتمل|منتهي/.test(s)) return "مكتملة";
  if (/hiatus|pause|متوقف|معلق/.test(s)) return "متوقفة";
  if (/cancel|dropped|متروك|ملغي/.test(s)) return "ملغاة";
  if (/ongoing|publishing|مستمر|قادم/.test(s)) return "مستمرة";
  return cleanText(value);
}

function numericChapter(value) {
  const t = cleanText(value);
  const m =
    t.match(/(?:chapter|chap|ch\.?|الفصل|حلقة|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i) ||
    t.match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? m[1] : null;
}

function rows(document, base) {
  const out = [];
  for (const el of document.querySelectorAll(
    "div.chapter-container, div.media"
  )) {
    const a =
      el.querySelector(".media-heading a") ||
      el.querySelector(".manga-heading a") ||
      el.querySelector("a");
    if (!a) continue;
    const id = abs(base, a.attr("href"));
    const title = normTitle(a.text());
    if (!id || !title) continue;
    out.push({ id, title, cover: imageUrl(base, el.querySelector("img")) });
  }
  return uniq(out, (x) => x.id);
}

const plugin = {
  id: "manga-online-ar",
  name: "\u0645\u0627\u0646\u062c\u0627 \u0627\u0648\u0646 \u0644\u0627\u064a\u0646",
  version: "1.0.0",

  async popular(offset) {
    const page = Math.floor((Number(offset) || 0) / 18) + 1;
    const url = BASE + "/filterList?page=" + page + "&sortBy=views&asc=false";
    return rows(await doc(url), url);
  },

  async search(query, offset) {
    if (!query) return plugin.popular(offset);
    // Suggestions are the site's only search; not paginated server-side.
    if ((Number(offset) || 0) > 0) return [];
    const data = await jsonGet(
      BASE + "/search?query=" + encodeURIComponent(query)
    );
    return ((data && data.suggestions) || [])
      .map((x) => {
        if (!x || !x.data) return null;
        return {
          id: BASE + "/manga/" + x.data,
          title: normTitle(x.value) || x.data,
          // Predictable MMRCMS cover path (verified on live cards).
          cover:
            BASE + "/uploads/manga/" + x.data + "/cover/cover_250x350.jpg",
        };
      })
      .filter(Boolean);
  },

  async detail(id) {
    const document = await doc(id);
    const titleEl =
      document.querySelector(".panel-heading") || document.querySelector("h1");
    const coverEl =
      document.querySelector(".row img.img-responsive") ||
      document.querySelector("img.img-responsive");

    // Description: the longest .well block.
    const wells = document
      .querySelectorAll(".row .well")
      .map((x) => cleanText(x.text()))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    // The metadata h3s are malformed nested markup: depending on the parser,
    // the first "h3" can contain ALL rows concatenated. Anchor each label to
    // the START of the row text so the wrapper can never win.
    let author;
    let status;
    for (const h3 of document.querySelectorAll(".panel-body h3")) {
      const all = cleanText(h3.text());
      const valueEl = h3.querySelector("div.text");
      const value = cleanText(
        valueEl ? valueEl.text() : all.replace(/^[^:]+:\s*/, "")
      );
      if (/^(?:\u0627\u0644\u0645\u0624\u0644\u0641|author)\s*:/i.test(all) && !author) {
        author = value;
      }
      if (/^(?:\u0627\u0644\u062d\u0627\u0644\u0629|status)\s*:/i.test(all) && !status) {
        status = parseStatus(value);
      }
    }

    return {
      id,
      title: normTitle(titleEl ? titleEl.text() : "") || id,
      cover: imageUrl(id, coverEl),
      description: wells[0] ? stripHtml(wells[0]) : undefined,
      author,
      status,
    };
  },

  async chapters(id) {
    const document = await doc(id);
    const seriesTitle = normTitle(
      document.querySelector(".panel-heading")?.text()
    );
    const out = [];
    for (const li of document.querySelectorAll("ul.chapters > li")) {
      if (/\bbtn\b/.test(li.attr("class") || "")) continue;
      const wrap = li.querySelector(".chapter-title-rtl") || li;
      const a = wrap.querySelector("a");
      if (!a) continue;
      const cid = abs(id, a.attr("href"));
      if (!cid) continue;
      let chTitle = cleanText(wrap.text());
      if (seriesTitle && chTitle.indexOf(seriesTitle) === 0) {
        chTitle = cleanText(chTitle.slice(seriesTitle.length));
      }
      const date = li.querySelector(".date-chapter-title-rtl");
      out.push({
        id: cid,
        chapter: numericChapter(chTitle),
        title: chTitle,
        volume: null,
        pages: 0,
        language: "en",
        publishAt: date ? cleanText(date.text()) : undefined,
      });
    }
    return uniq(out, (x) => x.id);
  },

  async pageUrls(chapterId) {
    // Ids are full URLs; tolerate mangled forms anyway.
    let url = cleanText(chapterId);
    if (/%[0-9a-fA-F]{2}/.test(url)) {
      try {
        url = decodeURIComponent(url);
      } catch (e) {}
    }
    if (!/^https?:\/\//i.test(url)) {
      url = BASE + "/" + url.replace(/^\/+/, "");
    }
    const document = await doc(url);
    return uniq(
      document
        .querySelectorAll("#all img")
        .map((x) => imageUrl(url, x))
        .filter(Boolean)
    );
  },
};

return plugin;
