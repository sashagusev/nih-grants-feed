(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  var LAST_VISIT_KEY = 'nih_grants_last_visit';
  var SAVED_KEY      = 'nih_grants_saved';
  var SECTIONS       = ['posted', 'forecasted', 'highlighted'];

  // ── State ────────────────────────────────────────────────────────────────────
  var lastVisit       = localStorage.getItem(LAST_VISIT_KEY);
  var currentSection  = 'posted';
  var allData         = {};
  var currentItems    = [];   // items currently displayed (post-filter)
  var filtersSection  = null; // section for which institute filter was built
  var awardRange      = null; // null=Any, 'lt250', '250-750', 'gt750'
  var lightTheme      = false;
  var hoverTimer      = null;

  var savedGrants = {};
  try { savedGrants = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch (_) {}

  function saveId(item) {
    return String(item.opportunity_id || item.id || item.number || '');
  }
  function isSaved(item) { return !!savedGrants[saveId(item)]; }
  function toggleSaved(item) {
    var id = saveId(item);
    if (savedGrants[id]) { delete savedGrants[id]; } else { savedGrants[id] = item; }
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(savedGrants)); } catch (_) {}
    updateSavedUI();
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(str) {
    if (!str) return '\u2014';
    try {
      var d = str.length === 10 ? new Date(str + 'T00:00:00Z') : new Date(str);
      return d.toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
      });
    } catch (_) { return str; }
  }

  function fmtAmount(n) {
    if (!n) return '';
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000)    return '$' + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 0) + 'K';
    return '$' + n;
  }

  function isNew(dateStr) {
    if (!lastVisit || !dateStr) return false;
    try {
      var posted = dateStr.length === 10
        ? new Date(dateStr + 'T00:00:00Z')
        : new Date(dateStr);
      return posted > new Date(lastVisit);
    } catch (_) { return false; }
  }

  // ── Mechanism extraction ─────────────────────────────────────────────────────
  function getMechanism(item) {
    var title = item.title || '';
    var re = /\(([A-Z]\d{2})\b/g;
    var results = [], m;
    while ((m = re.exec(title)) !== null) {
      if (results.indexOf(m[1]) === -1) results.push(m[1]);
    }
    return results.length ? results : ['Other'];
  }

  // ── URL state sync ────────────────────────────────────────────────────────────
  function getUrlParams() {
    var params = {};
    location.hash.slice(1).split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq > 0) params[decodeURIComponent(pair.slice(0, eq))] =
                        decodeURIComponent(pair.slice(eq + 1));
    });
    return params;
  }

  function getCheckedValues(listEl) {
    var all = listEl ? listEl.querySelectorAll('input') : [];
    var checked = [];
    all.forEach(function (cb) { if (cb.checked) checked.push(cb.value); });
    return checked.length === all.length ? null : checked;   // null = no filter
  }

  function setUrlState() {
    var params = { s: currentSection };
    var mv = getCheckedValues(mechFilterList);
    var iv = getCheckedValues(instFilterList);
    var cv = getCheckedValues(cfdaFilterList);
    if (mv) params.m = mv.join(',');
    if (iv) params.i = iv.join(',');
    if (cv) params.c = cv.join(',');
    if (awardRange) params.a = awardRange;
    if (lightTheme) params.t = '1';
    var hash = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    history.replaceState(null, '', '#' + hash);
  }

  function applyUrlToList(listEl, csv) {
    if (!csv || !listEl) return;
    var set = {};
    csv.split(',').forEach(function (v) { set[v] = true; });
    listEl.querySelectorAll('input').forEach(function (cb) {
      cb.checked = !!set[cb.value];
    });
  }

  // ── Detail panel ─────────────────────────────────────────────────────────────
  var detailPanel  = document.getElementById('detail-panel');
  var detailNumber = document.getElementById('detail-number');
  var detailTitle  = document.getElementById('detail-title');
  var detailBody   = document.getElementById('detail-body');

  function showDetail(item) {
    detailNumber.textContent = item.number || item.id || '';
    detailTitle.textContent  = item.title  || 'Untitled';

    var html = '';

    if (item.abstract) {
      // Highlighted topics carry pre-sanitized HTML; all others are plain text
      var abstractContent = item.abstract_is_html
        ? item.abstract
        : esc(item.abstract);
      html += '<div class="detail-section-label">Abstract</div>' +
              '<div class="detail-abstract">' + abstractContent + '</div>';
    }

    var contactName  = item.contact_name  || '';
    var contactEmail = item.contact_email || '';
    if (contactName || contactEmail) {
      html += '<div class="detail-contact">';
      if (contactName)  html += '<div>' + esc(contactName) + '</div>';
      if (contactEmail) html += '<div><a href="mailto:' + esc(contactEmail) + '">' +
                                esc(contactEmail) + '</a></div>';
      html += '</div>';
    }

    detailBody.innerHTML = html;
    // Position panel to fill from right edge of main content to viewport right
    var mainEl = document.querySelector('.main-content');
    if (mainEl && window.innerWidth >= 700) {
      detailPanel.style.left = Math.round(mainEl.getBoundingClientRect().right) + 'px';
    } else {
      detailPanel.style.left = '';
    }
    detailPanel.classList.add('is-visible');
  }

  window.addEventListener('resize', function () {
    if (detailPanel.classList.contains('is-visible')) {
      var mainEl = document.querySelector('.main-content');
      if (mainEl && window.innerWidth >= 700) {
        detailPanel.style.left = Math.round(mainEl.getBoundingClientRect().right) + 'px';
      }
    }
  });

  function hideDetail() {
    detailPanel.classList.remove('is-visible');
  }

  // Keep panel open when mouse moves into it
  detailPanel.addEventListener('mouseenter', function () {
    clearTimeout(hoverTimer);
  });
  detailPanel.addEventListener('mouseleave', function () {
    hoverTimer = setTimeout(hideDetail, 200);
  });

  // ── Saved grants UI ──────────────────────────────────────────────────────────
  var savedBadge = document.getElementById('saved-badge');
  var savedPills = document.getElementById('saved-pills');

  // Initialise badge from persisted state immediately on load
  (function () {
    var count = Object.keys(savedGrants).length;
    savedBadge.textContent = count;
    savedBadge.hidden      = count === 0;
    savedPills.hidden      = count === 0;
  }());

  function updateSavedUI() {
    var count = Object.keys(savedGrants).length;
    savedBadge.textContent = count;
    savedBadge.hidden      = count === 0;
    savedPills.hidden      = count === 0;
    if (currentSection === 'saved') renderSavedSection();
  }

  function renderSavedSection() {
    var contentEl = document.getElementById('content');
    document.getElementById('new-notice').hidden = true;
    filterBlock.hidden = true;
    var items = Object.values(savedGrants).sort(function (a, b) {
      var da = a.post_date || a.posted_date || '';
      var db = b.post_date || b.posted_date || '';
      return db.localeCompare(da);
    });
    currentItems = items;
    hideDetail();
    if (items.length === 0) {
      contentEl.innerHTML = '<p class="status-msg">No saved grants yet \u2014 click any card to save it.</p>';
      setUrlState();
      return;
    }
    contentEl.innerHTML = '<p class="section-count">' + items.length +
      ' item' + (items.length !== 1 ? 's' : '') + '</p>' +
      '<ul class="grant-list">' + items.map(renderItem).join('') + '</ul>';
    setUrlState();
  }

  document.getElementById('export-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var items = Object.values(savedGrants);
    var cols  = ['Title','Number','Institute','Status','Post Date','Close Date',
                 'Opening Date','Award Ceiling','Num Awards','Assistance Listings','URL'];
    function cell(v) {
      var s = String(v == null ? '' : v);
      return (s.search(/[,"\n]/) !== -1) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var rows = items.map(function (g) {
      return [
        g.title || '', g.number || '', g.institute || g.lead_ico || '', g.status || '',
        g.post_date || g.posted_date || '', g.close_date || g.expiration_date || '',
        g.opening_date || '', g.award_ceiling || '', g.num_awards || '',
        (g.cfda_list || []).map(function (c) { return c.title || c.number; }).join('; '),
        g.url || ''
      ].map(cell).join(',');
    });
    var csv  = [cols.map(cell).join(',')].concat(rows).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'nih-grants-saved.csv';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  });

  document.getElementById('clear-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var count = Object.keys(savedGrants).length;
    if (!confirm('Clear all ' + count + ' saved grant' + (count !== 1 ? 's' : '') + '?')) return;
    savedGrants = {};
    try { localStorage.removeItem(SAVED_KEY); } catch (_) {}
    updateSavedUI();
    if (currentSection !== 'saved') {
      var items = (allData[currentSection] || {}).data || [];
      renderContent(items);
    }
  });

  // ── Filters ──────────────────────────────────────────────────────────────────
  var filterBlock      = document.getElementById('filter-block');
  var mechFilterList   = document.getElementById('mech-filter-list');
  var mechAllLink      = document.getElementById('filter-mech-all');
  var mechNoneLink     = document.getElementById('filter-mech-none');
  var mechSection      = document.getElementById('mech-section');
  var instFilterList   = document.getElementById('institute-filter-list');
  var instAllLink      = document.getElementById('filter-inst-all');
  var instNoneLink     = document.getElementById('filter-inst-none');
  var cfdaFilterList   = document.getElementById('cfda-filter-list');
  var cfdaAllLink      = document.getElementById('filter-cfda-all');
  var cfdaNoneLink     = document.getElementById('filter-cfda-none');
  var cfdaSection      = cfdaFilterList.closest('.filter-section');
  var awardSection     = document.querySelector('.award-filter-btns').closest('.filter-section');

  function buildChecklist(listEl, allLink, noneLink, getKey, items) {
    var counts = {};
    items.forEach(function (item) {
      var keys = getKey(item);
      keys.forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
    });

    var sorted = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a];
    });

    listEl.innerHTML = sorted.map(function (k) {
      return '<label class="filter-check">' +
        '<input type="checkbox" value="' + esc(k) + '" checked>' +
        '<span>' + esc(k) + '</span>' +
        '<span class="filter-count">(' + counts[k] + ')</span>' +
        '</label>';
    }).join('');

    listEl.querySelectorAll('input').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var items = (allData[currentSection] || {}).data || [];
        renderContent(items);
      });
    });

    allLink.onclick = function (e) {
      e.preventDefault();
      listEl.querySelectorAll('input').forEach(function (cb) { cb.checked = true; });
      var items = (allData[currentSection] || {}).data || [];
      renderContent(items);
    };

    noneLink.onclick = function (e) {
      e.preventDefault();
      listEl.querySelectorAll('input').forEach(function (cb) { cb.checked = false; });
      var items = (allData[currentSection] || {}).data || [];
      renderContent(items);
    };
  }

  function getChecked(listEl) {
    var all = listEl.querySelectorAll('input');
    var checked = [];
    all.forEach(function (cb) { if (cb.checked) checked.push(cb.value); });
    if (checked.length === all.length) return null;
    var s = {};
    checked.forEach(function (v) { s[v] = true; });
    return s;
  }

  // Award filter buttons
  document.querySelectorAll('.award-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.award-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      awardRange = btn.dataset.range === 'any' ? null : btn.dataset.range;
      var items = (allData[currentSection] || {}).data || [];
      renderContent(items);
    });
  });

  function applyFilters(items) {
    // Highlighted topics have no mechanism or CFDA data — those filters are
    // hidden for this section and should be ignored regardless of their state.
    var isHighlighted = currentSection === 'highlighted';
    var mechs = isHighlighted ? null : getChecked(mechFilterList);
    var insts = getChecked(instFilterList);
    var cfdas = isHighlighted ? null : getChecked(cfdaFilterList);
    return items.filter(function (item) {
      // Mechanism filter
      if (mechs) {
        var itemMechs = getMechanism(item);
        if (!itemMechs.some(function (m) { return mechs[m]; })) return false;
      }
      // Institute filter
      if (insts) {
        var inst = item.institute || item.lead_ico || 'NIH (general)';
        if (!insts[inst]) return false;
      }
      // CFDA filter: include if any of the item's CFDAs is selected
      if (cfdas) {
        var cfList = item.cfda_list || [];
        var match = cfList.some(function (c) { return cfdas[c.title]; });
        if (!match) return false;
      }
      // Award range filter (only applied when ceiling is known)
      if (awardRange && item.award_ceiling != null) {
        var c = item.award_ceiling;
        if (awardRange === 'lt250'   && c >= 250000)                    return false;
        if (awardRange === '250-750' && (c < 250000 || c > 750000))     return false;
        if (awardRange === 'gt750'   && c <= 750000)                    return false;
      }
      return true;
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  function renderItem(item, idx) {
    var postDate  = item.post_date    || item.posted_date    || '';
    var closeDate = item.close_date   || item.expiration_date || '';
    var openDate  = item.opening_date || '';
    var url       = item.url          || '#';
    var fresh     = isNew(postDate);

    // Meta line: posted · closes
    var metaParts = [];
    if (postDate)  metaParts.push('posted\u00a0' + fmtDate(postDate));
    if (closeDate) metaParts.push('closes\u00a0' + fmtDate(closeDate));

    // Sub line: institute · opens · award · num awards
    var subParts = [];
    var inst = item.institute || item.lead_ico || '';
    if (inst) subParts.push({ cls: 'institute', text: inst });
    if (openDate)           subParts.push({ cls: '', text: 'opens\u00a0' + fmtDate(openDate) });
    if (item.award_ceiling) subParts.push({ cls: '', text: fmtAmount(item.award_ceiling) + '\u00a0max' });
    if (item.num_awards)    subParts.push({ cls: '', text: item.num_awards + '\u00a0award' +
                                            (item.num_awards !== '1' ? 's' : '') });

    var subHtml = subParts.map(function (p) {
      return '<span class="grant-sub-item ' + p.cls + '">' + esc(p.text) + '</span>';
    }).join('');

    var saved = isSaved(item);
    return [
      '<li class="grant-item' + (fresh ? ' is-new' : '') + (saved ? ' is-saved' : '') + '" data-idx="' + idx + '">',
        '<div class="grant-inner">',
          '<span class="save-icon" title="' + (saved ? 'Remove from saved' : 'Save this grant') + '">' +
            (saved ? '\u2605' : '\u2606') + '</span>',
          '<div class="grant-meta">',
            esc(metaParts.join(' \u00b7 ')),
            fresh ? ' <span class="new-badge">new</span>' : '',
          '</div>',
          '<div class="grant-title">',
            '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">',
              esc(item.title || 'Untitled'),
            '</a>',
          '</div>',
          subHtml ? '<div class="grant-sub">' + subHtml + '</div>' : '',
          item.cfda_list && item.cfda_list.length
            ? '<div class="grant-cfda">' +
              item.cfda_list.slice(0, 3).map(function (c) {
                return esc(c.title || c.number);
              }).join(', ') +
              (item.cfda_list.length > 3 ? ', ...' : '') +
              '</div>'
            : '',
        '</div>',
      '</li>'
    ].join('');
  }

  function renderContent(allItems) {
    var contentEl = document.getElementById('content');
    var noticeEl  = document.getElementById('new-notice');

    var filtered = applyFilters(allItems);
    currentItems = filtered;
    hideDetail();

    var newCount = filtered.reduce(function (n, item) {
      return n + (isNew(item.post_date || item.posted_date || '') ? 1 : 0);
    }, 0);

    if (newCount > 0 && lastVisit) {
      noticeEl.textContent =
        '\u25b2\u00a0' + newCount + ' new posting' + (newCount > 1 ? 's' : '') +
        ' since your last visit (' + fmtDate(lastVisit) + ')';
      noticeEl.hidden = false;
    } else {
      noticeEl.hidden = true;
    }

    var countLine = '<p class="section-count">' + filtered.length +
      (filtered.length !== allItems.length ? ' of ' + allItems.length : '') +
      ' item' + (filtered.length !== 1 ? 's' : '') + '</p>';

    contentEl.innerHTML = countLine +
      '<ul class="grant-list">' + filtered.map(renderItem).join('') + '</ul>';

    setUrlState();
  }

  function renderSection(section) {
    var contentEl = document.getElementById('content');
    var noticeEl  = document.getElementById('new-notice');

    document.querySelectorAll('nav a').forEach(function (a) {
      a.classList.toggle('active', a.dataset.section === section);
    });

    if (section === 'saved') {
      renderSavedSection();
      return;
    }

    var bucket = allData[section];

    if (!bucket) {
      contentEl.innerHTML = '<p class="status-msg">Loading\u2026</p>';
      noticeEl.hidden = true;
      filterBlock.hidden = true;
      return;
    }

    var items = bucket.data || [];

    if (items.length === 0) {
      contentEl.innerHTML =
        '<p class="status-msg">No data yet \u2014 GitHub Actions populates this daily. ' +
        'Trigger the workflow manually or wait for the next scheduled run.</p>';
      noticeEl.hidden = true;
      filterBlock.hidden = true;
      return;
    }

    // Determine what filter types this section supports
    var hasInst   = items.some(function (g) { return g.institute || g.lead_ico; });
    var hasCfda   = items.some(function (g) { return g.cfda_list && g.cfda_list.length; });
    var hasAward  = items.some(function (g) { return g.award_ceiling != null; });

    // Build filters only when switching sections
    if (section !== filtersSection && hasInst) {
      var hasMech = items.some(function (g) {
        return getMechanism(g).some(function (m) { return m !== 'Other'; });
      });
      if (hasMech) {
        buildChecklist(mechFilterList, mechAllLink, mechNoneLink,
          getMechanism, items);
      }
      buildChecklist(instFilterList, instAllLink, instNoneLink,
        function (item) { return [item.institute || item.lead_ico || 'NIH (general)']; },
        items);
      if (hasCfda) {
        buildChecklist(cfdaFilterList, cfdaAllLink, cfdaNoneLink,
          function (item) { return (item.cfda_list || []).map(function (c) { return c.title || c.number; }).filter(Boolean); },
          items);
      }
      filtersSection = section;
      // Reset award filter
      awardRange = null;
      document.querySelectorAll('.award-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.range === 'any');
      });

      // Apply any URL-encoded filter state
      var p = getUrlParams();
      if (p.m) applyUrlToList(mechFilterList, p.m);
      if (p.i) applyUrlToList(instFilterList, p.i);
      if (p.c) applyUrlToList(cfdaFilterList, p.c);
      if (p.a) {
        awardRange = p.a;
        document.querySelectorAll('.award-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.range === (awardRange || 'any'));
        });
      }
    }

    // Show/hide filter sub-sections based on available data
    var hasMechItems = items.some(function (g) {
      return getMechanism(g).some(function (m) { return m !== 'Other'; });
    });
    filterBlock.hidden  = !hasInst;
    mechSection.hidden  = !hasMechItems;
    cfdaSection.hidden  = !hasCfda;
    awardSection.hidden = !hasAward;

    renderContent(items);

    if (bucket.updated_at) {
      document.getElementById('last-fetch').textContent = 'data: ' + fmtDate(bucket.updated_at);
    }
  }

  // ── Hover delegation for detail panel ────────────────────────────────────────
  document.getElementById('content').addEventListener('mouseover', function (e) {
    var li = e.target.closest('.grant-item');
    if (!li) return;
    clearTimeout(hoverTimer);
    var idx = parseInt(li.dataset.idx, 10);
    if (!isNaN(idx) && currentItems[idx]) {
      hoverTimer = setTimeout(function () { showDetail(currentItems[idx]); }, 80);
    }
  });

  document.getElementById('content').addEventListener('mouseout', function (e) {
    var li = e.target.closest('.grant-item');
    if (!li) return;
    // Don't hide if moving to another grant item or the detail panel
    var to = e.relatedTarget;
    if (to && (to.closest('.grant-item') || to.closest('.detail-panel'))) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(hideDetail, 200);
  });

  // ── Click to save ────────────────────────────────────────────────────────────
  document.getElementById('content').addEventListener('click', function (e) {
    if (e.target.closest('a')) return;        // let link clicks through
    var li = e.target.closest('.grant-item');
    if (!li) return;
    var idx = parseInt(li.dataset.idx, 10);
    if (isNaN(idx) || !currentItems[idx]) return;
    var item = currentItems[idx];
    toggleSaved(item);
    var nowSaved = isSaved(item);
    li.classList.toggle('is-saved', nowSaved);
    // update star icon without full re-render
    var icon = li.querySelector('.save-icon');
    if (icon) {
      icon.textContent = nowSaved ? '\u2605' : '\u2606';
      icon.title = nowSaved ? 'Remove from saved' : 'Save this grant';
    }
  });

  // ── Data loading ─────────────────────────────────────────────────────────────
  function loadAll() {
    var pending = SECTIONS.length;

    SECTIONS.forEach(function (section) {
      fetch('data/' + section + '.json')
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        })
        .then(function (json) {
          allData[section] = json;
          if (section === currentSection) renderSection(currentSection);
        })
        .catch(function (err) {
          console.warn('Could not load data/' + section + '.json:', err);
          allData[section] = { data: [], updated_at: null };
          if (section === currentSection) renderSection(currentSection);
        })
        .finally(function () {
          pending -= 1;
          if (pending === 0) scheduleLastVisitUpdate();
        });
    });
  }

  function scheduleLastVisitUpdate() {
    setTimeout(function () {
      localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    }, 6000);
  }

  // ── Nav clicks ───────────────────────────────────────────────────────────────
  document.querySelectorAll('nav a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      currentSection = a.dataset.section;
      filtersSection = null;  // force filter rebuild on section switch
      renderSection(currentSection);
      document.getElementById('content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ── Theme toggle ──────────────────────────────────────────────────────────────
  function setTheme(light) {
    lightTheme = light;
    document.body.classList.toggle('light-theme', light);
  }

  document.getElementById('theme-toggle').addEventListener('click', function () {
    setTheme(!lightTheme);
    setUrlState();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  (function () {
    var p = getUrlParams();
    var validSections = SECTIONS.concat(['saved']);
    if (p.s && validSections.indexOf(p.s) !== -1) currentSection = p.s;
    if (p.t === '1') setTheme(true);
  }());

  window.addEventListener('hashchange', function () {
    var p = getUrlParams();
    var validSections = SECTIONS.concat(['saved']);
    if (p.s && validSections.indexOf(p.s) !== -1 && p.s !== currentSection) {
      currentSection = p.s;
      renderSection(currentSection);
    }
    setTheme(p.t === '1');
  });

  loadAll();
})();
