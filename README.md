# Roots — Arabic Root & Form Visualizer

A Manifest V3 Chrome extension that helps Arabic learners and researchers read
non-vocalized web text: hover a recognized verb to see its trilateral root and
attested Forms I–X, toggle full diacritics (tashkeel) on a text selection, and
spot low-frequency/academic vocabulary via a subtle heatmap.

## Load it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Navigate to a page with Arabic text, then click the Roots icon in the
   toolbar — this opens the side panel **and** activates Roots on that page
   in the same click.

There is no build step — it's plain HTML/CSS/JS, loaded directly.

`test/sample.html` is a small bundled Arabic passage (using several of the
seeded lexicon roots) for trying the hover popover, diacritic toggle, and
heatmap without needing a live site. Serve it over `http://` rather than
opening it directly as a `file://` URL — `chrome.scripting` needs the
extension's "Allow access to file URLs" toggle enabled for `file://` pages,
which is an extra manual step most real usage never needs:

```sh
cd test && python3 -m http.server 8000
# then open http://localhost:8000/sample.html
```

### A note on activeTab and why activation lives on the icon click

This extension deliberately requests only `activeTab` (no `tabs` permission,
no host permissions), matching the spec it was built to. `activeTab` access
is granted only by specific gestures Chrome recognizes as "invoking the
extension" — clicking the toolbar icon is always one of them. **Clicking a
button inside an already-open side panel is not** (confirmed empirically:
it fails with "Cannot access contents of the page..."), so activation is
triggered directly from `chrome.action.onClicked` in the background worker
(`src/background/background.js`), which both opens the side panel and
injects the content script in the same gesture. Because of this,
`sidePanel.setPanelBehavior({ openPanelOnActionClick: ... })` is set to
`false`, not `true` — otherwise Chrome would auto-open the panel and
`onClicked` would never fire at all.

The side panel's own "Activate on this page" / "Deactivate on this page"
button still works for toggling on the *same* tab afterward, since
deactivating just messages the already-injected content script (no fresh
`activeTab` needed), and reactivating on that same tab reuses the grant from
the original icon click — which stays valid until the tab navigates. If you
navigate to a new page in that tab, click the toolbar icon again.

## Architecture

```
manifest.json              MV3 manifest — activeTab, scripting, storage, sidePanel only
src/background/            Service worker: per-tab activation state, messaging, settings
src/content/               Content script + scoped CSS, injected on demand into the active tab
src/sidepanel/             Primary UI: activate/deactivate, feature toggles, live stats
src/options/               Full settings page: theme, typography, feature defaults
src/shared/settings.js     Settings shape + defaults shared by background/side panel/options
src/data/lexicon.json      Seed root → forms dictionary
src/data/frequency.json    Seed word-frequency tiers for the heatmap
```

**No broad host permissions.** The manifest only requests `activeTab`,
`scripting`, `storage`, and `sidePanel` — there's no `<all_urls>` or `tabs`
permission. The content script and CSS are injected on demand
(`chrome.scripting.executeScript` / `insertCSS`) triggered by a user gesture
in the side panel, which is what grants `activeTab` access for that tab.

**Two isolation strategies**, deliberately different because they solve
different problems:
- The inline word highlights (`[data-roots-verb]`, `[data-roots-heat]`) live
  in the page's own DOM, because they need to flow inline with the
  surrounding paragraph text. `content.css` only ever targets these
  `data-roots-*` attribute selectors — never a bare element or a class name a
  site might already use — so it cannot leak style onto the host page.
- The popover and the floating diacritic-toggle button render inside a single
  Shadow DOM host appended to `<html>`, fully isolated in both directions
  from the page's own stylesheet.

## Feature scope & honest limitations

- **Root/form lexicon** (`src/data/lexicon.json`) is a curated seed set of
  ~20 real trilateral roots with linguistically verified forms (only forms
  that are actually attested are listed — no invented conjugations). It's
  structured so a generated/larger lexicon can be dropped in without code
  changes.
- **Word matching** uses a lightweight heuristic affix-stripper (common
  attached prefixes/suffixes) to match inflected surface forms back to a
  dictionary entry — it is not a full morphological analyzer. This gives
  reasonable coverage for common conjugations but will miss more irregular
  forms.
- **Frequency heatmap** (`src/data/frequency.json`) is a curated starter word
  list split into two tiers, not a corpus-derived frequency ranking. Anything
  outside those tiers is treated as "advanced." Swap in a real frequency
  corpus for production-scale accuracy.
- **Diacritics** can only be shown for words the extension recognizes (i.e.
  lexicon matches) — there's no general-purpose auto-diacritization engine
  for arbitrary Arabic text.

## Settings

Stored in `chrome.storage.sync` under a single `settings` key (small object,
well under the 8 KB per-item sync quota):

| Key | Values | Default |
|---|---|---|
| `theme` | `light` / `dark` / `sepia` | `light` |
| `fontFamily` | `cairo` / `amiri` / `system` | `cairo` |
| `fontScale` | `0.85`–`1.4` | `1` |
| `rootVisualizer` | boolean | `true` |
| `diacritics` | boolean | `true` |
| `heatmap` | boolean | `true` |
| `heatmapSensitivity` | `low` / `medium` / `high` | `medium` |

Changing a setting anywhere (side panel or options page) broadcasts to every
currently-active tab immediately.
