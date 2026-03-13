#!/usr/bin/env python3
"""
Fetch NIH grant data and write it to data/*.json for the static site.

Sources
-------
1. simpler.grants.gov REST API  (requires GRANTS_API_KEY env var, free to obtain)
   Fallback: legacy grants.gov REST API (public, no key required).

2. grants.nih.gov highlighted topics
   Uses the public, unauthenticated AWS API Gateway endpoint that the
   NIH highlighted-topics page calls at runtime.

Usage
-----
    # with API key (best structured data):
    GRANTS_API_KEY=your_key python scripts/fetch_data.py

    # without API key (uses public legacy grants.gov API):
    python scripts/fetch_data.py
"""

import html as _html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# ── Config ────────────────────────────────────────────────────────────────────
SIMPLER_API_URL  = "https://api.simpler.grants.gov/v1/opportunities/search"
LEGACY_API_URL   = "https://apply07.grants.gov/grantsws/rest/opportunities/search"
DETAIL_URL       = "https://apply07.grants.gov/grantsws/rest/opportunity/details"
HIGHLIGHTED_URL  = "https://zs1rum7xd7.execute-api.us-east-1.amazonaws.com/prod/hst"
DATA_DIR         = os.path.join(os.path.dirname(__file__), "..", "data")

HEADERS = {
    "User-Agent": "NIHGrantsFeed/1.0 (https://github.com) Python/requests",
    "Content-Type": "application/json",
}
DETAIL_HEADERS = {"User-Agent": HEADERS["User-Agent"]}

# Page size for the legacy API (max the server accepts)
PAGE_SIZE      = 1000
DETAIL_WORKERS = 20


# ── NIH institute code lookup ─────────────────────────────────────────────────
NIH_IC_NAMES = {
    "AA": "NIAAA",  "AG": "NIA",    "AI": "NIAID",  "AR": "NIAMS",
    "AT": "NCCIH",  "CA": "NCI",    "DA": "NIDA",   "DC": "NIDCD",
    "DE": "NIDCR",  "DK": "NIDDK",  "EB": "NIBIB",  "ES": "NIEHS",
    "EY": "NEI",    "GM": "NIGMS",  "HD": "NICHD",  "HG": "NHGRI",
    "HL": "NHLBI",  "LM": "NLM",    "MD": "NIMHD",  "MH": "NIMH",
    "NR": "NINR",   "NS": "NINDS",  "OD": "OD",     "RR": "ORIP",
    "TW": "FIC",    "TR": "NCATS",
}
_IC_SET = set(NIH_IC_NAMES.values())


def _clean_text(text):
    """Decode HTML entities and strip any stray tags from a plain-text field."""
    if not text:
        return ""
    return _html.unescape(re.sub(r"<[^>]+>", " ", text)).strip()


def _extract_institute(number):
    """RFA-AI-27-019 → 'NIAID', PAR-26-042 → '' (multi-IC, no code in number)."""
    if not number:
        return ""
    parts = number.split("-")
    if len(parts) >= 3 and len(parts[1]) == 2 and parts[1].isalpha():
        code = parts[1].upper()
        return NIH_IC_NAMES.get(code, code)
    return ""


def _parse_institute_from_text(text):
    """Extract NIH acronym from contact text like '(NCI)' or 'NCI Program...'"""
    if not text:
        return ""
    # Pattern 1: parenthetical "(NCI)", "(NIAID)", etc.
    for m in re.finditer(r'\(([A-Z]{2,8})\)', text):
        acr = m.group(1)
        if acr in _IC_SET:
            return acr
    # Pattern 2: acronym at start of string "NCI MetNet Program..."
    m = re.match(r'^([A-Z]{2,8})\b', text.strip())
    if m and m.group(1) in _IC_SET:
        return m.group(1)
    return ""


def _get_announcement_text(opp_id):
    """Return the plain text of the Full Announcement for an opportunity.

    Handles three cases:
    1. Real HTML: files.simpler.grants.gov/…/XXX-Full-Announcement.html
    2. Meta-refresh stub that redirects to grants.nih.gov/grants/guide/…/XXX.html
    3. No stub file — grants.nih.gov link appears directly on the opportunity page
    """
    # Step 1: find the Full Announcement URL from the simpler.grants.gov opportunity page
    page = requests.get(f"https://simpler.grants.gov/opportunity/{opp_id}",
                        headers=HEADERS, timeout=30)
    page.raise_for_status()

    # Case 1 & 2: stub file on files.simpler.grants.gov
    m = re.search(
        r'https://files\.simpler\.grants\.gov/[^\s"\'<>]+Full-Announcement\.html',
        page.text)
    if m:
        html_r = requests.get(m.group(0), headers=HEADERS, timeout=30)
        html_r.raise_for_status()

        # Case 2: meta-refresh redirect to grants.nih.gov guide page
        refresh = re.search(
            r'<meta[^>]+http-equiv=["\']refresh["\'][^>]+content=["\'][^"\']*URL=["\']?([^"\'>\s]+)',
            html_r.text, re.IGNORECASE)
        if refresh:
            redirect_url = refresh.group(1).rstrip("'\"")
            target_url = redirect_url if redirect_url.startswith("http") \
                         else "https://grants.nih.gov" + redirect_url
            guide_r = requests.get(target_url, headers=HEADERS, timeout=30)
            guide_r.raise_for_status()
            return BeautifulSoup(guide_r.text, "html.parser").get_text()

        # Case 1: real Full Announcement HTML
        return BeautifulSoup(html_r.text, "html.parser").get_text()

    # Case 3: direct grants.nih.gov/grants/guide link on the opportunity page
    guide_m = re.search(
        r'https?://(?:www\.)?grants\.nih\.gov/grants/guide/[^\s"\'<>\\]+\.html',
        page.text)
    if guide_m:
        guide_url = guide_m.group(0).rstrip("\\")
        guide_r = requests.get(guide_url, headers=HEADERS, timeout=30)
        guide_r.raise_for_status()
        return BeautifulSoup(guide_r.text, "html.parser").get_text()

    return ""


def _fetch_announcement_icos(opp_id, _retries=3, _backoff=2.0):
    """Scrape the Full Announcement HTML on simpler.grants.gov and return the list of
    participating IC acronyms from the 'Components of Participating Organizations' section."""
    last_exc = None
    for attempt in range(_retries):
        try:
            text = _get_announcement_text(opp_id)
            if not text:
                return []
            idx = text.find("Components of Participating Organ")
            if idx < 0:
                return []
            section = text[idx: idx + 1000]
            ics = []
            for pm in re.finditer(r'\(([A-Z]{2,8})\)', section):
                code = pm.group(1)
                if code in _IC_SET and code not in ics:
                    ics.append(code)
            return ics
        except Exception as exc:
            last_exc = exc
            if attempt < _retries - 1:
                time.sleep(_backoff * (attempt + 1))
    # Surface the error to the caller so we can log it
    raise last_exc


# ── Highlighted Topics (always works — public API) ────────────────────────────
# Tags whose HTML structure we want to preserve in the detail panel
_SAFE_HTML_TAGS = frozenset(
    "p strong b em i u ul ol li h2 h3 h4 h5 br blockquote".split()
)

# Boilerplate patterns — elements whose text fully matches these are removed
_BOILERPLATE_PATS = [
    re.compile(r"apply\s+through\s+an\s+appropriate", re.I),
    re.compile(r"when\s+beginning\s+your\s+next\s+investigator", re.I),
    re.compile(r"^topic\s+description$", re.I),
    re.compile(r"^(post\s+date|expiration\s+date):", re.I),
]


def _elem_to_safe_html(el):
    """Serialize a BS4 element to HTML, keeping only safe tags (no attributes)."""
    from bs4 import Tag, NavigableString, Comment
    if isinstance(el, Comment):
        return ""
    if isinstance(el, NavigableString):
        return _html.escape(str(el))
    if not isinstance(el, Tag):
        return ""
    tag = (el.name or "").lower()
    inner = "".join(_elem_to_safe_html(c) for c in el.children)
    if tag in _SAFE_HTML_TAGS:
        return f"<{tag}>{inner}</{tag}>"
    return inner   # include text content of structural/unknown tags without the wrapper


def _fetch_topic_description(topic_id):
    """Scrape the description HTML from an individual highlighted topic page."""
    url = (f"https://grants.nih.gov/funding/find-a-fit-for-your-research/"
           f"highlighted-topics/{topic_id}")
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": HEADERS["User-Agent"]})
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        block = soup.select_one("#block-nihod5-subtheme-content")
        if not block:
            return ""

        # Remove boilerplate elements from the tree in-place
        for el in block.find_all(["p", "h1", "h2", "h3", "h4", "h5", "li"]):
            if not el.parent:      # already decomposed
                continue
            t = re.sub(r"\s+", " ", el.get_text(" ")).strip()
            if len(t) < 10 or any(pat.search(t) for pat in _BOILERPLATE_PATS):
                el.decompose()

        # Walk the cleaned block, collecting block-level elements as safe HTML
        parts = []

        def _walk(node):
            from bs4 import Tag as _Tag
            if not isinstance(node, _Tag):
                return
            tag = (node.name or "").lower()
            if tag in {"p", "ul", "ol", "h2", "h3", "h4", "h5", "blockquote"}:
                t = re.sub(r"\s+", " ", node.get_text(" ")).strip()
                if t:
                    parts.append(_elem_to_safe_html(node))
            else:
                for child in node.children:
                    _walk(child)

        _walk(block)

        # Truncate at ~2 000 text characters (HTML budget is larger)
        result, text_len = [], 0
        for chunk in parts:
            result.append(chunk)
            text_len += len(re.sub(r"<[^>]+>", "", chunk))
            if text_len >= 2000:
                break

        html = "".join(result)
        # Fix nested <p><p> artifacts that can appear when BS4 parses invalid HTML
        html = re.sub(r"<p>\s*<p>", "<p>", html)
        html = re.sub(r"</p>\s*</p>", "</p>", html)
        return html
    except Exception:
        return ""


def fetch_highlighted_topics():
    print("→ highlighted topics …", flush=True)
    try:
        r = requests.get(HIGHLIGHTED_URL, headers=HEADERS, timeout=30)
        r.raise_for_status()
        raw = r.json()
    except Exception as exc:
        print(f"  ✗ {exc}", file=sys.stderr)
        return []

    topics = []
    for hit in raw.get("hits", {}).get("hits", []):
        src = hit.get("_source", {})
        lead_ico = src.get("lead_ico", "")
        all_icos = [spec["ico"] for spec in src.get("ico_specifics", []) if spec.get("ico")]
        participating_icos = [ico for ico in all_icos if ico != lead_ico]
        topics.append({
            "id":                 src.get("id"),
            "title":              _clean_text(src.get("title") or ""),
            "lead_ico":           lead_ico,
            "participating_icos": participating_icos,
            "posted_date":        (src.get("posted_date") or "")[:10],
            "expiration_date":    (src.get("expiration_date") or "")[:10],
            "status":             src.get("status", ""),
            "url": (
                f"https://grants.nih.gov/funding/"
                f"find-a-fit-for-your-research/highlighted-topics/{src.get('id', '')}"
            ),
            "contacts": [
                c.get("email", "")
                for c in src.get("central_contacts", [])
                if c.get("email")
            ],
        })

    topics.sort(key=lambda x: x.get("posted_date") or "", reverse=True)

    # Enrich with descriptions scraped in parallel from individual pages
    print(f"  → fetching descriptions for {len(topics)} topics …", flush=True)
    id_to_idx = {t["id"]: i for i, t in enumerate(topics)}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_fetch_topic_description, t["id"]): t["id"] for t in topics}
        for fut in as_completed(futures):
            tid  = futures[fut]
            desc = fut.result()
            if desc:
                topics[id_to_idx[tid]]["abstract"]         = desc
                topics[id_to_idx[tid]]["abstract_is_html"] = True
    print(f"  ✓ {len(topics)} topics")
    return topics


# ── Grants — simpler.grants.gov REST API (preferred, needs key) ───────────────
def fetch_grants_simpler_api(status, api_key):
    print(f"→ {status} grants (simpler.grants.gov API) …", flush=True)
    headers = {**HEADERS, "X-Auth-Token": api_key}
    body = {
        "filters": {
            "status": {"one_of": [status]},
            "agency": {"one_of": ["HHS-NIH"]},
        },
        "pagination": {"page_offset": 1, "page_size": MAX_ROWS},
        "sorting":    {"sort_by": "post_date", "order_by": "desc"},
    }
    try:
        r = requests.post(SIMPLER_API_URL, json=body, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        grants = _normalize_simpler(data.get("data", []), status)
        print(f"  ✓ {len(grants)} grants")
        return grants
    except Exception as exc:
        print(f"  ✗ API error: {exc}", file=sys.stderr)
        return None   # signal to try fallback


# ── Grants — legacy grants.gov REST API (public, no key needed) ───────────────
def fetch_grants_legacy_api(status):
    print(f"→ {status} grants (legacy grants.gov API) …", flush=True)
    grants = []
    offset = 0

    while True:
        body = {
            "oppStatuses":    status,
            "agencies":       "HHS-NIH11",
            "rows":           PAGE_SIZE,
            "startRecordNum": offset,
            "sortBy":         "openDate|desc",
        }
        try:
            r = requests.post(LEGACY_API_URL, json=body, headers=HEADERS, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as exc:
            print(f"  ✗ Legacy API error (offset {offset}): {exc}", file=sys.stderr)
            break

        hits      = data.get("oppHits", [])
        hit_count = data.get("hitCount", 0)
        grants.extend(_normalize_legacy(h, status) for h in hits)

        offset += len(hits)
        if offset >= hit_count or not hits:
            print(f"  ✓ {len(grants)} grants (of {hit_count} total)")
            break
        print(f"  … fetched {offset}/{hit_count}", flush=True)

    return grants


# ── Detail enrichment (parallel) ──────────────────────────────────────────────
def _fetch_one_detail(opp_id):
    """Fetch detail page for one grant. Returns dict of extra fields."""
    try:
        r = requests.post(DETAIL_URL, data={"oppId": str(opp_id)},
                          headers=DETAIL_HEADERS, timeout=15)
        r.raise_for_status()
        d = r.json()
    except Exception:
        return {}

    syn   = d.get("synopsis") or {}
    fcast = d.get("forecast") or {}
    pkgs  = d.get("opportunityPkgs") or []

    # Institute: forecast contact name is most reliable (has e.g. "(NCI)")
    contact_block = (fcast.get("agencyContactName") or
                     syn.get("agencyContactDesc") or
                     syn.get("agencyContactName") or "")
    institute = _parse_institute_from_text(contact_block)

    # Award ceiling
    ceiling_raw = syn.get("awardCeiling") or ""
    try:
        award_ceiling = int(ceiling_raw) if ceiling_raw and ceiling_raw != "none" else None
    except (ValueError, TypeError):
        award_ceiling = None

    # Number of awards
    num_awards = str(fcast.get("numberOfAwards") or syn.get("numberOfAwards") or "").strip()

    # Contact (first line of contact block)
    contact_name  = _clean_text(contact_block.split("\n")[0]) if contact_block else ""
    contact_email = (fcast.get("agencyContactEmail") or
                     syn.get("agencyContactEmail") or "").strip()

    # Abstract — synopsis for posted grants, forecastDesc for forecasted grants
    # Strip HTML tags and decode entities so JS can display as plain text
    raw_abstract = syn.get("synopsisDesc") or fcast.get("forecastDesc") or ""
    abstract = _html.unescape(re.sub(r"<[^>]+>", " ", raw_abstract)).strip()
    abstract = re.sub(r"\s{2,}", " ", abstract)

    # Application opening date (when submissions open, distinct from posting date)
    opening_date = ""
    if pkgs:
        ds = pkgs[0].get("openingDateStr") or ""   # "2026-05-22-00-00-00"
        if ds:
            parts = ds.split("-")
            if len(parts) >= 3:
                opening_date = f"{parts[0]}-{parts[1]}-{parts[2]}"

    # Assistance listings (CFDA numbers + program titles)
    cfda_list = [
        {"number": c["cfdaNumber"], "title": c.get("programTitle", "")}
        for c in (d.get("cfdas") or [])
        if c.get("cfdaNumber")
    ]

    result = {
        "award_ceiling": award_ceiling,
        "num_awards":    num_awards,
        "contact_name":  contact_name,
        "contact_email": contact_email,
        "abstract":      abstract,
        "opening_date":  opening_date,
        "cfda_list":     cfda_list,
    }
    if institute:   # only override number-derived institute if detail has one
        result["institute"] = institute
    return result


def enrich_with_details(grants):
    """Fetch detail pages in parallel and merge fields into each grant record."""
    if not grants:
        return grants
    print(f"  → fetching details for {len(grants)} grants …", flush=True)
    id_to_idx = {g["opportunity_id"]: i for i, g in enumerate(grants)}

    with ThreadPoolExecutor(max_workers=DETAIL_WORKERS) as ex:
        futures = {ex.submit(_fetch_one_detail, oid): oid for oid in id_to_idx}
        done = 0
        for fut in as_completed(futures):
            oid    = futures[fut]
            detail = fut.result()
            grants[id_to_idx[oid]].update(detail)
            done  += 1
    print(f"  ✓ enriched {done} grants")

    # Fetch participating ICs from Full Announcement HTML for grants whose
    # institute is not encoded in the grant number (PAR, PA, etc.)
    needs_html = {g["opportunity_id"]: i for i, g in enumerate(grants)
                  if not g.get("institute")}
    if needs_html:
        print(f"  → fetching full announcements for {len(needs_html)} grants …", flush=True)
        error_counts: dict = {}
        with ThreadPoolExecutor(max_workers=4) as ex:
            futures = {ex.submit(_fetch_announcement_icos, oid): oid
                       for oid in needs_html}
            found = 0
            for fut in as_completed(futures):
                oid = futures[fut]
                try:
                    ics = fut.result()
                except Exception as exc:
                    err_key = type(exc).__name__
                    error_counts[err_key] = error_counts.get(err_key, 0) + 1
                    continue
                if ics:
                    idx = needs_html[oid]
                    grants[idx]["participating_icos"] = ics
                    # Only assign a specific institute when exactly one IC is listed;
                    # true multi-IC announcements stay as "NIH (general)" for display
                    # but all ICs are available for filter matching via participating_icos
                    if len(ics) == 1:
                        grants[idx]["institute"] = ics[0]
                    found += 1
        if error_counts:
            print(f"  ⚠ errors during announcement fetch: {error_counts}", file=sys.stderr)
        print(f"  ✓ resolved institute for {found} of {len(needs_html)} grants")

    return grants


# ── Normalisation helpers ─────────────────────────────────────────────────────
def _normalize_simpler(raw, status):
    out = []
    for g in raw:
        summary   = g.get("opportunity_summary") or {}
        post_date = (g.get("post_date") or summary.get("post_date") or
                     (g.get("created_at") or "")[:10] or "")
        close_date = g.get("close_date") or summary.get("close_date") or ""
        opp_id = str(g.get("opportunity_id") or g.get("id") or "")
        number = g.get("opportunity_number") or g.get("number") or ""
        out.append({
            "opportunity_id": opp_id,
            "title":          _clean_text(g.get("opportunity_title") or g.get("title") or ""),
            "agency_name":    g.get("agency_name") or "",
            "agency_code":    g.get("agency_code") or "",
            "institute":      _extract_institute(number),
            "post_date":      post_date[:10] if post_date else "",
            "close_date":     close_date[:10] if close_date else "",
            "status":         g.get("opportunity_status") or status,
            "url": (
                f"https://simpler.grants.gov/opportunities/{opp_id}"
                if opp_id else "https://simpler.grants.gov"
            ),
        })
    return out


def _parse_mdY(date_str):
    """Convert MM/DD/YYYY → YYYY-MM-DD, or return '' on failure."""
    if not date_str:
        return ""
    try:
        return datetime.strptime(date_str.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return date_str.strip()[:10]


def _normalize_legacy(h, status):
    opp_id = str(h.get("id", ""))
    number = h.get("number", "")
    return {
        "opportunity_id": opp_id,
        "number":         number,
        "title":          _clean_text(h.get("title") or ""),
        "agency_name":    h.get("agency", ""),
        "agency_code":    h.get("agencyCode", ""),
        "institute":      _extract_institute(number),
        "post_date":      _parse_mdY(h.get("openDate", "")),
        "close_date":     _parse_mdY(h.get("closeDate", "")),
        "status":         h.get("oppStatus") or status,
        "url": (
            f"https://simpler.grants.gov/search?query={h.get('number', '')}"
            if h.get("number")
            else f"https://www.grants.gov/search-results-detail/{opp_id}"
        ),
    }


# ── JSON persistence ──────────────────────────────────────────────────────────
def save(data, filename):
    os.makedirs(DATA_DIR, exist_ok=True)
    path    = os.path.join(DATA_DIR, filename)
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "count":      len(data),
        "data":       data,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    print(f"  → saved to {os.path.basename(path)} ({len(data)} records)\n")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    api_key = os.environ.get("GRANTS_API_KEY", "").strip()

    # 1. Highlighted topics — always public (no detail endpoint available)
    save(fetch_highlighted_topics(), "highlighted.json")

    # 2. Grants — fetch list, then enrich with detail pages
    for status in ("posted", "forecasted"):
        grants = None
        if api_key:
            grants = fetch_grants_simpler_api(status, api_key)
        if grants is None:
            grants = fetch_grants_legacy_api(status)
        grants = enrich_with_details(grants or [])
        save(grants or [], f"{status}.json")

    print("Done.")


if __name__ == "__main__":
    main()
