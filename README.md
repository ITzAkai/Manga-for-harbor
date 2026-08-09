# Arabic Scans — Harbor Manga Repo | مستودع مانجا عربي لتطبيق Harbor

**Harbor manga sources for Arabic scanlation sites** — Team-X (olympustaff), مانجا العاشق (3asq), and AzoraFly (ازورا مانجا). Browse, search, and read Arabic manga, manhwa, and manhua with full chapter lists and genre filters.

مستودع إضافات عربي لتطبيق **Harbor** لقراءة المانجا والمانهوا المترجمة للعربية — يدعم فرق Team-X ومانجا العاشق وازورا مانجا، مع قوائم فصول كاملة وبحث وتصنيفات.

## 📥 Installation | التثبيت

Add this URL as a repo inside Harbor:

أضف هذا الرابط كمستودع داخل تطبيق Harbor:

```
https://raw.githubusercontent.com/ITzAkai/Manga-for-harbor/refs/heads/main/repo.json
```

**Harbor → Sources → Add Repo → paste the URL above**

## 📚 Sources | المصادر

| Source | Site | Language | Notes |
|---|---|---|---|
| **Team-X** | [olympustaff.com](https://olympustaff.com) | العربية | Full chapter lists, genre filter, latest-updates browsing |
| **مانجا العاشق (3asq)** | [3asq.online](https://3asq.online) | العربية | Madara-based; full chapter lists via AJAX, genre filter |
| **AzoraFly** | [azorafly.com](https://azorafly.com) | العربية | API-driven; genre filter, latest-updates ordering |

## ✨ Features | المميزات

- **Full chapter lists** — all chapters, not just the latest few, including on series with thousands of chapters
- **Latest-updates ordering** — the browse tab mirrors each site's own update feed
- **Genre filtering** — browse by التصنيف on every source
- **Search** — server-side search on every source
- **Proper metadata** — chapter numbers (including decimals like 61.5), release dates, covers, status, and descriptions

## ⚠️ Notes | ملاحظات

- **Coin-locked chapters** (Team-X, AzoraFly): some sites lock their newest chapters behind paid coins. These chapters appear in the list (marked 🔒 on AzoraFly) but their pages stay empty until the site itself unlocks them. The plugins do **not** bypass any lock, login, or paywall.
- **AzoraFly server hiccups**: azorafly.com occasionally returns 502/503 errors. The plugin retries automatically, but if a load fails, just try again a few seconds later.
- **Updating**: when plugins are updated here, the `version` numbers are bumped. If Harbor doesn't pick up an update, remove the repo and re-add it — Harbor caches plugins by version.

## 🧩 Repo structure | هيكل المستودع

```
repo.json                 ← the manifest Harbor reads
olympustaff.plugin.js     ← Team-X source
3asq.plugin.js            ← مانجا العاشق source
azorafly.plugin.js        ← AzoraFly source
```

Each plugin implements Harbor's five source methods (`popular`, `search`, `detail`, `chapters`, `pageUrls`) plus optional `tags` for genre filtering.

## ⚖️ Disclaimer | إخلاء مسؤولية

These plugins only read **publicly accessible pages** from the listed scanlation sites. They log into nothing and bypass no password, paywall, or access control. No manga content is hosted in this repository — it contains configuration and parsing code only. All content belongs to its respective owners and the scanlation teams who translate it. You are responsible for how you use these plugins and for complying with each site's terms and your local laws.

هذه الإضافات تقرأ الصفحات **المتاحة للعموم فقط** من مواقع الترجمة المذكورة، ولا تتجاوز أي تسجيل دخول أو محتوى مدفوع. لا يستضيف هذا المستودع أي محتوى مانجا — بل يحتوي على ملفات إعداد وتحليل فقط. جميع الحقوق محفوظة لأصحابها ولفرق الترجمة.

---

