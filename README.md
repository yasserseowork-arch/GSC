# Agital GSC Auto Reporter

Chrome extension (Manifest V3) that automates the weekly Google Search Console workflow:

1. Opens each selected property in **Performance** with `num_of_days=7&compare_date=PREV`.
2. Runs the integrated **Agital percentage-change** calculation (the purple button’s logic) on the report cards and tables.
3. Checks clicks against the previous week. By default, if clicks have declined, it saves **no comparison image** for that property and moves on.
4. Saves a cropped Performance screenshot.
5. Opens **Generative AI features**, applies its comparison calculation, and saves a second screenshot when that report is available.

Downloads are named and grouped like this:

```text
Downloads/
└── GSC week over week/
    └── example.com/
        ├── performance-week-over-week-YYYY-MM-DD.png
        └── generative-ai-week-over-week-YYYY-MM-DD.png
```

> The extension saves files through Chrome Downloads. A Chrome extension package cannot permanently write files inside its own installed directory.

## Install locally

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the folder `Agital - GSC Calculations` from this repository.
5. Open a property in [Google Search Console](https://search.google.com/search-console), then open the extension.

## Usage

- **Current property:** Leave the sites field empty to run only the property currently open in Search Console.
- **Several stores/sites:** Enter one property per line. Supported forms include:
  - `sc-domain:example.com`
  - `https://www.example.com/`
  - a full GSC URL containing `resource_id=`
- **Import available properties:** The import button attempts to read the open GSC property switcher. If Google changes this UI or the properties menu is closed, paste the property list manually instead.
- Keep **“skip if clicks declined”** checked to meet the requested rule: negative week-over-week clicks produce no Performance or Generative AI screenshot.
- Keep **Generative AI features** checked to capture the second report. Search Console only exposes this report for eligible properties; unavailable reports are logged as unavailable and do not stop the next property.

The popup can safely be closed after starting a run. Progress is stored in extension storage and will appear when it is opened again. Leave the GSC tab and its Chrome window open until the run finishes; avoid switching away from that tab while a screenshot is being captured.

## Manual Agital tools

The original tools remain in the popup under **أدوات Agital اليدوية**:

- **Calculate Percentage Change** injects the percentage labels into a GSC comparison view.
- **Add Algorithm Updates** adds the existing algorithm-update markers to a date graph.

## Notes and limitations

- The extension uses the Google account already signed into the active Chrome profile. It does not request passwords or bypass Google authentication.
- Google Search Console is a client-rendered product and may change CSS selectors or report routes. In that event the run record shows the affected site/report as an error rather than silently downloading an incorrect image.
- The Generative AI report is addressed at `/search-console/performance/search-analytics/ai`; properties without access to the report are skipped gracefully.
- Screenshots are temporarily taken at 80% tab zoom so the GSC report card fits in one image. The previous tab zoom is restored when the run ends or is cancelled.
