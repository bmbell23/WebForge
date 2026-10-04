// #177: what "Add to Stash" learns from the page: title, performers, studio,
// date, tags, and (for galleries) every linked full-size image.
//
// ONE copy for both apps: Windows runs it with executeJavaScript, Android with
// evaluateJavascript (staged into the APK's assets). It evaluates to a plain
// object. collect() only reads the DOM; every decision is in distill(), which
// windows/stash.test.js exercises by defining __stashExport before eval.
(function () {
  var IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
  var PERFORMER_PATH = /^\/(pornstars?|models?|performers?|stars?|actors?|actress(es)?|girls?)\/[^/]+\/?$/i;
  var STUDIO_PATH = /^\/(channels?|sites?|studios?|paysites?|networks?)\/[^/]+\/?$/i;

  // Listing and nav links share the performer/studio paths ("Top Models", "All girls", "123 videos").
  var GENERIC = /^(all|top|new|newest|popular|best|more|view|see|browse|random|models?|pornstars?|girls?|stars?|channels?|sites?|studios?)\b|\d/i;

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function dedupe(list, max) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < list.length && out.length < max; i++) {
      var v = clean(list[i]), k = v.toLowerCase();
      if (v && !seen[k]) { seen[k] = 1; out.push(v); }
    }
    return out;
  }

  function day(s) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(s));
    return m ? m[1] : null;
  }

  function names(v) { // JSON-LD person/org fields: string, object or a list of either
    if (!v) return [];
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v.reduce(function (a, x) { return a.concat(names(x)); }, []);
    return typeof v.name === 'string' ? [v.name] : [];
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // raw = {url, title, h1, meta: {name: content}, ld: [objects], links: [{href, text}]}
  function distill(raw) {
    var meta = raw.meta || {}, ld = [], links = raw.links || [];
    (raw.ld || []).forEach(function (o) { ld = ld.concat(o && o['@graph'] ? o['@graph'] : [o]); });
    var site = hostOf(raw.url);

    var ldTitle = '', ldDate = null, ldPeople = [], ldStudio = [], ldTags = [];
    ld.forEach(function (o) {
      if (!o || typeof o !== 'object') return;
      ldTitle = ldTitle || clean(o.headline || o.name);
      ldDate = ldDate || day(o.uploadDate || o.datePublished || o.dateCreated);
      ldPeople = ldPeople.concat(names(o.actor), names(o.actors), names(o.performer));
      ldStudio = ldStudio.concat(names(o.productionCompany), names(o.publisher));
      if (o.keywords) ldTags = ldTags.concat(Array.isArray(o.keywords) ? o.keywords : String(o.keywords).split(','));
    });

    var title = clean(meta['og:title'] || ldTitle || raw.h1 || raw.title);
    var siteName = clean(meta['og:site_name']);
    // "Set name - SiteName" / "Set name | site.com": the site is already sent
    // separately. Only an exact match with the site's name or domain is cut.
    var tail = /\s+[|\-–—]\s+([^|\-–—]+)$/.exec(title);
    if (tail) {
      var squash = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); };
      var t = squash(tail[1]);
      var parts = site.split('.');
      var label = parts.length >= 2 ? parts[parts.length - 2] : '';
      if (t && ((siteName && t === squash(siteName)) || (label.length >= 3 && (t === label || t === squash(site))))) {
        title = title.slice(0, tail.index);
      }
    }

    // Performer links: a gallery page names its own models; a sidebar of
    // "related models" would be noise, so with more than one link keep only the
    // names the title or heading actually mentions. JSON-LD and video:actor
    // come first and are trusted as they are.
    var perfLinks = [], studioLinks = [];
    links.forEach(function (l) {
      var p;
      try { p = new URL(l.href).pathname; } catch (e) { return; }
      var text = clean(l.text);
      if (!text || text.length > 40 || GENERIC.test(text)) return;
      if (PERFORMER_PATH.test(p)) perfLinks.push(text);
      else if (STUDIO_PATH.test(p)) studioLinks.push(text);
    });
    perfLinks = dedupe(perfLinks, 50);
    if (perfLinks.length > 1) {
      var hay = (title + ' ' + clean(raw.h1)).toLowerCase();
      perfLinks = perfLinks.filter(function (n) { return hay.indexOf(n.toLowerCase()) >= 0; });
    }
    var metaActors = [].concat(meta['video:actor'] || [], meta['og:video:actor'] || []);
    var performers = dedupe([].concat(ldPeople, metaActors, perfLinks), 10);

    studioLinks = dedupe(studioLinks, 50);
    var studio = clean(ldStudio[0] || (studioLinks.length === 1 ? studioLinks[0] : '') || siteName) || null;

    var tags = dedupe([].concat(String(meta.keywords || '').split(','), ldTags), 20);

    var images = [];
    links.forEach(function (l) {
      try {
        var u = new URL(l.href);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && IMAGE.test(u.pathname)) images.push(u.href);
      } catch (e) { /* not a URL */ }
    });
    images = dedupe(images, 500);

    return {
      title: title || null,
      performers: performers,
      studio: studio,
      site: site || null,
      date: ldDate || day(meta['article:published_time'] || meta['og:published_time'] || meta['video:release_date']),
      tags: tags,
      image_urls: images,
    };
  }

  function collect(doc, url) {
    var meta = {};
    var ms = doc.querySelectorAll('meta[property], meta[name]');
    for (var i = 0; i < ms.length; i++) {
      var k = (ms[i].getAttribute('property') || ms[i].getAttribute('name') || '').toLowerCase();
      var v = ms[i].getAttribute('content');
      if (!k || v == null) continue;
      if (k === 'video:actor' || k === 'og:video:actor') (meta[k] = meta[k] || []).push(v);
      else if (!(k in meta)) meta[k] = v;
    }
    var ld = [];
    var ss = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < ss.length; j++) {
      try { var o = JSON.parse(ss[j].textContent); ld = ld.concat(Array.isArray(o) ? o : [o]); } catch (e) { /* bad JSON-LD */ }
    }
    var links = [];
    var as = doc.querySelectorAll('a[href]');
    for (var n = 0; n < as.length && n < 5000; n++) links.push({ href: as[n].href, text: as[n].textContent });
    var h1 = doc.querySelector('h1');
    return { url: url, title: doc.title, h1: h1 ? h1.textContent : '', meta: meta, ld: ld, links: links };
  }

  if (typeof __stashExport === 'function') return __stashExport({ distill: distill, collect: collect });
  return distill(collect(document, location.href));
})();
