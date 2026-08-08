// Harbor manga source plugin: Team-X (olympustaff.com)
//
// All selectors verified against the live site (Aug 2026):
//   - popular:  homepage grid ".uta" (40/page, ?page=N),
//               or "/series?genre=..." (10/page) when a tag filter is active
//   - search:   /ajax/search server-rendered HTML fragment (no paging)
//   - detail:   /series/{slug}
//   - chapters: /series/{slug}?page=N, ".chapter-card" with clean
//               data-number / data-date attributes; last page read from the
//               paginator, remaining pages fetched in parallel batches
//   - pages:    reader ".image_list img"
//   - tags:     the genre <select> on /series (genre id = its Arabic value)

const BASE = "https://olympustaff.com";

async function getDoc(path) {
  const res = await harbor.http(BASE + path, { responseType: "text" });
  if (!res.ok) throw new Error("http " + res.status + " for " + path);
  return harbor.parseHtml(res.body);
}

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

// "https://olympustaff.com/series/martial-peak" -> "martial-peak"
function seriesIdFromHref(href) {
  const m = (href || "").match(/\/series\/([^/?#]+)/);
  return m ? m[1] : null;
}

// "https://olympustaff.com/series/martial-peak/61.5" -> "martial-peak/61.5"
function chapterIdFromHref(href) {
  const m = (href || "").match(/\/series\/([^/?#]+\/[^/?#]+)/);
  return m ? m[1] : null;
}

// Homepage "latest" card: <div class="uta"><div class="imgu"><a><img></a></div>
//                         <div class="info"><a><h3>Title</h3></a>...</div></div>
function utaToSummary(el) {
  const link = el.querySelector(".imgu a");
  if (!link) return null;
  const id = seriesIdFromHref(link.attr("href"));
  if (!id) return null;
  const img = el.querySelector("img");
  return {
    id,
    title: (el.querySelector(".info h3")?.text() || "").trim() || id,
    cover: abs(img?.attr("data-src") || img?.attr("src")),
  };
}

// /series browse card: <div class="bs"><div class="bsx"><a title="Title">
//                      ...<img>...<div class="tt">Title</div></a></div></div>
function bsToSummary(el) {
  const link = el.querySelector("a");
  if (!link) return null;
  const id = seriesIdFromHref(link.attr("href"));
  if (!id) return null;
  const img = el.querySelector("img");
  return {
    id,
    title:
      (link.attr("title") || el.querySelector(".tt")?.text() || "").trim() ||
      id,
    cover: abs(img?.attr("data-src") || img?.attr("src")),
  };
}

const plugin = {
  id: "team-x",
  name: "Team-X",

  // Homepage: 40 items/page. Genre-filtered /series listing: 10 items/page.
  async popular(offset, tagId) {
    if (tagId) {
      const page = Math.floor(offset / 10) + 1;
      const doc = await getDoc(
        "/series?genre=" + encodeURIComponent(tagId) + "&page=" + page
      );
      return doc.querySelectorAll(".bs").map(bsToSummary).filter(Boolean);
    }
    const page = Math.floor(offset / 40) + 1;
    const doc = await getDoc(page === 1 ? "/" : "/?page=" + page);
    return doc.querySelectorAll(".box .uta").map(utaToSummary).filter(Boolean);
  },

  // /ajax/search returns a server-rendered fragment of result anchors.
  // It is not paginated, so only the first offset returns anything.
  async search(query, offset, tagId) {
    if (offset > 0) return [];
    const doc = await getDoc(
      "/ajax/search?keyword=" + encodeURIComponent(query)
    );
    let results = doc
      .querySelectorAll("a")
      .map((a) => {
        const id = seriesIdFromHref(a.attr("href"));
        if (!id) return null; // skips the "view all results" footer link
        const img = a.querySelector("img");
        return {
          id,
          title: (a.querySelector("h4")?.text() || "").trim() || id,
          cover: abs(img?.attr("data-src") || img?.attr("src")),
        };
      })
      .filter(Boolean);

    // The endpoint ignores genres, so apply the tag filter client-side by
    // checking each result's detail page would be too slow; instead just
    // return unfiltered results (tag filters apply to browse only).
    return results;
  },

  async detail(id) {
    const doc = await getDoc("/series/" + id);
    const title = doc.querySelector("h1")?.text()?.trim();
    if (!title) return null;

    // Metadata rows: <div class="full-list-info"><small>label</small>
    //                <small><a ...>value</a></small></div>
    // Status link href contains "status="; artist link is href="#".
    let status;
    let author;
    doc.querySelectorAll(".full-list-info a").forEach((a) => {
      const href = a.attr("href") || "";
      if (href.includes("status=")) status = a.text()?.trim();
      else if (href === "#" && !author) author = a.text()?.trim();
    });

    return {
      id,
      title,
      cover: abs(doc.querySelector("img.shadow-sm")?.attr("src")),
      description: doc.querySelector(".review-content p")?.text()?.trim(),
      status,
      author,
      lastChapter: doc.querySelector(".chapter-card .chapter-number")
        ?.text()
        ?.trim(),
    };
  },

  // Series page shows 40 chapters/page. Page 1 also carries the paginator,
  // whose highest "?page=N" link is the last page. Out-of-range pages return
  // zero cards (verified), but we never request past lastPage anyway.
  async chapters(id) {
    const seen = new Set();
    const chapters = [];

    const parseCards = (doc) => {
      doc.querySelectorAll(".chapter-card").forEach((card) => {
        const link = card.querySelector(".chapter-link");
        if (!link) return;

        const href = link.attr("href") || "";
        const chapId = chapterIdFromHref(href);
        if (!chapId || seen.has(chapId)) return;
        seen.add(chapId);

        const ts = parseInt(card.attr("data-date"), 10);

        chapters.push({
          id: chapId,
          chapter: card.attr("data-number") || null,
          title: card.querySelector(".chapter-title")?.text()?.trim(),
          volume: null,
          pages: 0,
          language: "ar",
          publishAt: isNaN(ts)
            ? undefined
            : new Date(ts * 1000).toISOString(),
        });
      });
    };

    const first = await getDoc("/series/" + id);
    parseCards(first);

    let lastPage = 1;
    first.querySelectorAll(".pagination a.page-link").forEach((a) => {
      const m = (a.attr("href") || "").match(/[?&]page=(\d+)/);
      if (m) lastPage = Math.max(lastPage, parseInt(m[1], 10));
    });

    const BATCH = 5;
    for (let start = 2; start <= lastPage; start += BATCH) {
      const end = Math.min(start + BATCH - 1, lastPage);
      const docs = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) =>
          getDoc("/series/" + id + "?page=" + (start + i))
        )
      );
      docs.forEach(parseCards);
    }

    // Newest first; parseFloat handles decimal chapters like 61.5.
    chapters.sort(
      (a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0)
    );

    return chapters;
  },

  // chapterId is "slug/number"; the reader is server-rendered plain <img> tags.
  async pageUrls(chapterId) {
    const doc = await getDoc("/series/" + chapterId);
    return doc
      .querySelectorAll(".image_list img")
      .map((img) => abs(img.attr("data-src") || img.attr("src")))
      .filter(Boolean);
  },

  // Genre list from the filter <select name="genre"> on /series.
  // The option's value doubles as the query parameter, so it is the tag id.
  async tags() {
    const doc = await getDoc("/series");
    return doc
      .querySelectorAll("select[name='genre'] option")
      .map((o) => {
        const v = (o.attr("value") || "").trim();
        if (!v) return null; // skips the "تصنيف المانجا" placeholder
        return { id: v, name: v, group: "التصنيف" };
      })
      .filter(Boolean);
  },
};