# NIH Grants Feed

A minimal static website that aggregates NIH funding opportunities — open grants,
forecasted grants, and highlighted research topics — and highlights anything posted
since your last visit.

## File layout

```
├── index.html                   static site entry point
├── style.css                    blogroll-inspired stylesheet
├── app.js                       client-side rendering + localStorage tracking
├── data/
│   ├── posted.json              open NIH grants  (auto-updated)
│   ├── forecasted.json          forecasted grants (auto-updated)
│   └── highlighted.json        highlighted topics (auto-updated)
├── scripts/
│   └── fetch_data.py            data-fetch script run by CI
└── .github/workflows/
    └── update-data.yml          scheduled GitHub Actions workflow
```

## How it works

1. **GitHub Actions** runs `scripts/fetch_data.py` every day at 07:00 UTC and
   commits updated JSON files to `data/`.
2. **The static site** (`index.html`) reads those JSON files and renders them.
3. **New-since-last-visit** highlighting uses `localStorage`: the timestamp of
   your last page view is stored in the browser, and any item posted after that
   timestamp gets a red `new` badge.

## Hosting on GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**, set source to *Deploy from branch → main / (root)*.
3. Your site will be live at `https://<username>.github.io/<repo-name>/`.

## Data sources

| Section | Source |
|---|---|
| Open grants | `simpler.grants.gov` API (agency `HHS-NIH`, status `posted`) |
| Forecasted grants | `simpler.grants.gov` API (agency `HHS-NIH`, status `forecasted`) |
| Highlighted topics | `grants.nih.gov` public AWS API endpoint |

## Optional: add an API key for reliable grant data

The NIH highlighted-topics data uses a fully public API and always works.

For the open/forecasted grants the script first tries the official
`simpler.grants.gov` REST API; if no key is configured it falls back to
scraping the HTML search page.  The API is **free** and gives more reliable,
structured results.

**To get a key:**

1. Register at <https://simpler.grants.gov/developer> (free, instant).
2. In your GitHub repository go to **Settings → Secrets and variables → Actions**.
3. Add a secret named `GRANTS_API_KEY` with your key as the value.

The workflow reads it automatically via `${{ secrets.GRANTS_API_KEY }}`.

## Running the fetch script locally

```bash
pip install requests beautifulsoup4

# with API key
GRANTS_API_KEY=your_key python scripts/fetch_data.py

# without key (HTML scrape fallback)
python scripts/fetch_data.py
```

Then open `index.html` in a browser (you'll need a local server to avoid
CORS restrictions on `fetch()`):

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Triggering a manual refresh

In the GitHub repository go to **Actions → Update NIH Grant Data → Run workflow**.
