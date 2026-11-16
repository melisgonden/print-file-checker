# Print File Checker

**Catch print problems at upload, before they become complaints and reprints.**

**Live demo:** https://melisgonden.github.io/print-file-checker/

Customers often upload files that look fine on screen but fail in print: too low resolution, no bleed, text too close to the cutting line, bright RGB colours that turn dull. The problem usually shows up only when the box arrives, and then it costs a reprint and an unhappy customer.

This tool checks a design against the print specification the moment it is uploaded and explains the result in plain language.

## Checks

| Check | What it measures |
|---|---|
| Size & bleed | Does the file match the product plus 3 mm bleed? |
| Resolution | DPI at the real print size (300 good, < 150 too low) |
| Safe zone | Text or logos within 3 mm of the cutting line |
| Colour | CMYK vs RGB, and very bright colours that print cannot reproduce |
| Transparency | Transparent areas that would print as white |

You get a verdict (ready / check / not ready), concrete fixes and a preview with bleed, trim and safe-zone lines.

Products: business card, A6 postcard, A5 and A4 flyer, A3 poster.

## AI review

The rule-based checks measure facts. An AI review then **looks at the design itself** for what rules cannot catch (small or low-contrast text, typos, crowded layout), treats the measured facts as given, ranks the fixes and writes a friendly message for the customer. Output is structured JSON, so it renders reliably.

## Project structure

| File | Role |
|---|---|
| `index.html` | Page structure |
| `style.css` | Look and feel |
| `script.js` | Checks, preview drawing and the AI review |
| `samples/` | Three test files |

## Run it

No build step, and the file never leaves the browser.

- **Online:** open the live demo and click one of the sample buttons.
- **Locally:** open the folder in VS Code and start Live Server.
- **AI review:** paste an Anthropic API key in the AI box (kept in memory only, never stored).

## Sample files

- `samples/1_good_business_card.jpg`: ready to print
- `samples/2_bad_business_card.png`: low resolution, no bleed, text at the edge, neon colours
- `samples/3_wrong_size.png`: wrong proportions

## What I learned

In testing, a full-width background stripe was flagged as "content near the edge": a false positive. Backgrounds may run to the edge, text may not. I changed the check to ignore colours that cover a large part of the border. Next I would build a test set of known good and bad files and measure accuracy, the way you validate a quality check before trusting it.

## Next steps

- PDF support (what most customers upload)
- One-click fixes: extend background for bleed, shrink content into the safe zone, flatten transparency

*Prototype by Melis Gönden.*
