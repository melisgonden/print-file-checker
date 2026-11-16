/* =====================================================================
   PRINT FILE CHECKER
   Idea: the same "check the product against the specification" logic
   used in quality control, applied to print files.
   ===================================================================== */

// ---- The print specification (like a product spec sheet) ----
const SPEC = {
  bleedMm: 3, // extra image area outside the final size, cut off after printing
  safeMm: 3, // keep text this far inside the final size
  goodDpi: 300, // sharp print
  minDpi: 150, // below this, print looks blurry or pixelated
};
const MM_PER_INCH = 25.4;

const $ = (id) => document.getElementById(id);
let lastReport = "";
let lastRun = null; // input for the AI review

// ---- File input & drag-and-drop ----
$("file").addEventListener(
  "change",
  (e) => e.target.files[0] && handleFile(e.target.files[0]),
);
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
$("product").addEventListener("change", () => {
  if (window._lastFile) handleFile(window._lastFile);
});

async function handleFile(file) {
  window._lastFile = file;
  if (!/image\/(png|jpeg)/.test(file.type)) {
    showResults(
      [
        {
          status: "bad",
          title: "Unsupported file type",
          text: `"${file.name}" is not a PNG or JPG.`,
          fix: "Export your design as PNG or high-quality JPG and try again.",
        },
      ],
      null,
    );
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const img = await loadImage(file);
  const [wMm, hMm] = $("product").value.split("x").map(Number);
  const checks = runChecks(img, bytes, file.type, wMm, hMm);
  showResults(checks, img, wMm, hMm);
  // Keep what the AI review needs: the product, the measured results and a small copy of the image.
  lastRun = {
    product: $("product").selectedOptions[0].textContent,
    checks,
    image: await smallJpeg(img),
  };
  $("aiOut").innerHTML = "";
  $("aiCard").classList.remove("hidden");
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* =====================================================================
   THE CHECKS
   Each check returns { status: "ok" | "warn" | "bad", title, text, fix }
   ===================================================================== */
function runChecks(img, bytes, mime, wMm, hMm) {
  const W = img.naturalWidth,
    H = img.naturalHeight;

  // Match orientation: a landscape file for a portrait product is fine, just rotated.
  if (W > H !== wMm > hMm) [wMm, hMm] = [hMm, wMm];

  const fullW = wMm + 2 * SPEC.bleedMm,
    fullH = hMm + 2 * SPEC.bleedMm; // size incl. bleed
  const checks = [];

  // ---- 1. Size & bleed: does the shape of the file match the product? ----
  const fileRatio = W / H;
  const ratioWithBleed = fullW / fullH,
    ratioTrim = wMm / hMm;
  const close = (a, b) => Math.abs(a - b) / b < 0.015; // within 1.5 %
  let hasBleed = false;
  if (close(fileRatio, ratioWithBleed)) {
    hasBleed = true;
    checks.push({
      status: "ok",
      title: "Size and bleed",
      text: `Proportions match ${wMm} × ${hMm} mm plus 3 mm bleed on every side.`,
    });
  } else if (close(fileRatio, ratioTrim)) {
    checks.push({
      status: "warn",
      title: "No bleed",
      text: `The file matches the final size (${wMm} × ${hMm} mm) but has no bleed. A tiny shift in cutting can leave a white edge.`,
      fix: `Make the document ${fullW} × ${fullH} mm and extend the background 3 mm past every edge.`,
    });
  } else {
    checks.push({
      status: "bad",
      title: "Wrong proportions",
      text: `The file is ${W} × ${H} px (ratio ${fileRatio.toFixed(2)}), but this product needs ratio ${ratioWithBleed.toFixed(2)}. It would be stretched or cropped.`,
      fix: `Set the document to ${fullW} × ${fullH} mm (final size + 3 mm bleed).`,
    });
  }

  // ---- 2. Resolution: enough pixels for a sharp print? ----
  const printWmm = hasBleed ? fullW : wMm; // the physical width the pixels will cover
  const dpi = Math.round(W / (printWmm / MM_PER_INCH));
  const needW = Math.ceil((fullW / MM_PER_INCH) * SPEC.goodDpi),
    needH = Math.ceil((fullH / MM_PER_INCH) * SPEC.goodDpi);
  if (dpi >= SPEC.goodDpi) {
    checks.push({
      status: "ok",
      title: "Resolution",
      text: `About ${dpi} DPI at print size. It will print sharp.`,
    });
  } else if (dpi >= SPEC.minDpi) {
    checks.push({
      status: "warn",
      title: "Resolution is low",
      text: `About ${dpi} DPI at print size. Photos may look soft and small text may blur.`,
      fix: `Export at least ${needW} × ${needH} px (300 DPI).`,
    });
  } else {
    checks.push({
      status: "bad",
      title: "Resolution too low",
      text: `Only about ${dpi} DPI at print size. It will look pixelated.`,
      fix: `Export at least ${needW} × ${needH} px (300 DPI). Enlarging this file will not help; go back to the original design.`,
    });
  }

  // ---- Read the pixels once (scaled down for speed) for checks 3 to 5 ----
  const scale = Math.min(1, 800 / Math.max(W, H));
  const cw = Math.round(W * scale),
    ch = Math.round(H * scale);
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, cw, ch);
  const px = ctx.getImageData(0, 0, cw, ch).data;

  // ---- 3. Safe zone: is there content too close to the cutting line? ----
  // Background colours = colours that cover a big part of the outer edge of the file
  // (a plain background, or a full-width colour stripe). Those may run to the edge.
  const bgs = edgeColours(px, cw, ch);
  const pxPerMm = cw / (hasBleed ? fullW : wMm);
  const trim = hasBleed ? SPEC.bleedMm * pxPerMm : 0; // where the trim line sits, in pixels
  const safe = trim + SPEC.safeMm * pxPerMm; // where the safe zone starts
  let inBand = 0,
    busy = 0;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const d = Math.min(x, y, cw - 1 - x, ch - 1 - y); // distance to nearest file edge
      if (d >= safe) continue; // inside safe zone: fine
      if (hasBleed && d < trim) continue; // in the bleed: is cut off anyway
      inBand++;
      const i = (y * cw + x) * 4;
      if (bgs.every((c) => colourDistance(px[i], px[i + 1], px[i + 2], c) > 60))
        busy++;
    }
  const busyPct = inBand ? (busy / inBand) * 100 : 0;
  if (busyPct < 0.5) {
    checks.push({
      status: "ok",
      title: "Safe zone",
      text: "No text or logos detected close to the cutting line.",
    });
  } else if (busyPct < 10) {
    checks.push({
      status: "warn",
      title: "Content close to the edge",
      text: `Some content (${busyPct.toFixed(1)} % of the edge band) sits within 3 mm of the cutting line. If it is text or a logo, it may be cut.`,
      fix: "Move text and logos at least 3 mm inside the final size (inside the green line in the preview). Backgrounds and photos can stay.",
    });
  } else {
    checks.push({
      status: "warn",
      title: "Busy edges",
      text: `A lot of detail (${busyPct.toFixed(0)} %) runs up to the cutting line. That is fine for a full-bleed photo or pattern, but not for text.`,
      fix: "Check the preview: nothing important should cross the green line.",
    });
  }

  // ---- 4. Colour: RGB or CMYK? Bright colours that will dull in print? ----
  const isCmyk = mime === "image/jpeg" && jpegIsCmyk(bytes);
  let vivid = 0,
    total = 0;
  for (let i = 0; i < px.length; i += 16) {
    // sample every 4th pixel
    total++;
    if (outOfPrintGamut(px[i], px[i + 1], px[i + 2])) vivid++;
  }
  const vividPct = (vivid / total) * 100;
  if (isCmyk) {
    checks.push({
      status: "ok",
      title: "Colour mode",
      text: "File is CMYK, the colour mode printers use.",
    });
  } else if (vividPct > 5) {
    checks.push({
      status: "warn",
      title: "Very bright RGB colours",
      text: `The file is RGB and about ${vividPct.toFixed(0)} % of it uses very bright colours (neon, electric blue, vivid green) that printers cannot reproduce. They will look duller on paper.`,
      fix: "Convert to CMYK in your design tool and check the colours, or choose slightly softer shades.",
    });
  } else {
    checks.push({
      status: "ok",
      title: "Colour mode",
      text: "File is RGB, which the printer will convert to CMYK. No problem colours detected, so the result should look close to the screen.",
    });
  }

  // ---- 5. Transparency: see-through areas print as white ----
  let transparent = 0;
  for (let i = 3; i < px.length; i += 16) if (px[i] < 250) transparent++;
  if (transparent / total > 0.01) {
    checks.push({
      status: "warn",
      title: "Transparent areas",
      text: "Part of the design is transparent. Transparent areas print as white paper.",
      fix: "Add a background colour or export without transparency.",
    });
  }

  return checks;
}

/* ---- Helpers ---- */
function colourDistance(r, g, b, c) {
  return Math.hypot(r - c[0], g - c[1], b - c[2]);
}

function edgeColours(px, w, h) {
  // Count colours (rounded to buckets of 16) along the outer 2 px border;
  // return every colour that covers at least 10 % of the border.
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const key = [px[i] >> 4, px[i + 1] >> 4, px[i + 2] >> 4].join(",");
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) add(x, y);
  for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) add(x, y);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const main = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n], idx) => idx === 0 || n / total >= 0.1);
  return main.map(([key]) => key.split(",").map((v) => Number(v) * 16 + 8));
}

function outOfPrintGamut(r, g, b) {
  // Rough rule of thumb: very saturated AND very bright blues, greens, purples and neons
  // fall outside what CMYK ink can print.
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.8 || max < 200) return false;
  const isWarm = r === max && g < 200; // reds and oranges print fine
  return !isWarm;
}

function jpegIsCmyk(b) {
  // A JPEG stores its number of colour channels in the "start of frame" marker:
  // 3 channels = RGB, 4 channels = CMYK.
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return b[i + 9] === 4;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return false;
}

/* =====================================================================
   SHOW THE REPORT
   ===================================================================== */
function showResults(checks, img, wMm, hMm) {
  const worst = checks.some((c) => c.status === "bad")
    ? "bad"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  const verdictText = {
    ok: "✅ Ready to print",
    warn: "⚠️ Printable, but check the points below",
    bad: "❌ Not ready for print yet",
  }[worst];
  const icon = { ok: "✅", warn: "⚠️", bad: "❌" };

  $("verdict").className = "verdict v-" + worst;
  $("verdict").textContent = verdictText;
  $("checks").innerHTML = checks
    .map(
      (c) => `
    <div class="check">
      <div class="ico">${icon[c.status]}</div>
      <div><h3>${c.title}</h3><p>${c.text}</p>${c.fix ? `<p class="fix"><strong>Fix:</strong> ${c.fix}</p>` : ""}</div>
    </div>`,
    )
    .join("");
  $("results").classList.remove("hidden");

  lastReport = [
    verdictText,
    "",
    ...checks.map(
      (c) =>
        `${icon[c.status]} ${c.title}: ${c.text}${c.fix ? " Fix: " + c.fix : ""}`,
    ),
  ].join("\n");

  if (img) drawPreview(img, wMm, hMm);
  else $("previewCard").classList.add("hidden");
}

function drawPreview(img, wMm, hMm) {
  const W = img.naturalWidth,
    H = img.naturalHeight;
  if (W > H !== wMm > hMm) [wMm, hMm] = [hMm, wMm];
  const fullW = wMm + 2 * SPEC.bleedMm;
  const hasBleed =
    Math.abs(W / H - fullW / (hMm + 2 * SPEC.bleedMm)) /
      (fullW / (hMm + 2 * SPEC.bleedMm)) <
    0.015;
  const scale = Math.min(1, 900 / Math.max(W, H));
  const cv = $("preview");
  cv.width = Math.round(W * scale);
  cv.height = Math.round(H * scale);
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  const pxPerMm = cv.width / (hasBleed ? fullW : wMm);
  const trim = hasBleed ? SPEC.bleedMm * pxPerMm : 0,
    safe = trim + SPEC.safeMm * pxPerMm;
  const box = (inset, colour) => {
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colour;
    ctx.strokeRect(
      inset + 1,
      inset + 1,
      cv.width - 2 * inset - 2,
      cv.height - 2 * inset - 2,
    );
  };
  box(0, "#2b7bd8");
  box(trim, "#d93025");
  box(safe, "#1e9e5a");
  $("previewCard").classList.remove("hidden");
}

// ---- Copy report (for pasting into a chat or email) ----
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastReport);
    $("copied").textContent = "Copied";
  } catch {
    $("copied").textContent =
      "Copy not allowed here. Select the text above instead.";
  }
  setTimeout(() => ($("copied").textContent = ""), 2500);
});

/* =====================================================================
   AI LAYER
   Rules measure (DPI, ratio, colours). The AI adds judgement:
   it looks at the image, combines it with the measured facts,
   ranks the fixes and writes a customer message.
   Two ways to reach the model:
     1. inside claude.ai  -> the page's built-in "sample" capability
     2. anywhere else (GitHub Pages) -> the Anthropic API with your own key
   ===================================================================== */
let claudeSample = null;

(async function connectAI() {
  // Inside claude.ai the page gets a "claude" helper; give it up to 3 seconds to appear.
  for (let i = 0; i < 30 && !(window.claude && window.claude.use); i++)
    await new Promise((r) => setTimeout(r, 100));
  try {
    if (window.claude && window.claude.use)
      claudeSample = await window.claude.use("sample");
  } catch {
    claudeSample = null;
  }
  // No built-in AI here: ask for an API key instead.
  if (!claudeSample) $("keyBox").classList.remove("hidden");
})();

function smallJpeg(img) {
  // A 1024 px JPEG is plenty for the model to read text and judge layout, and keeps the request small.
  const s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}

function buildPrompt(run) {
  return `You are the pre-flight specialist at an online print shop. A customer uploaded a design for: ${run.product}.

Automatic checks already measured these facts (treat them as correct, do not contradict them):
${JSON.stringify(
  run.checks.map(({ status, title, text }) => ({ status, title, text })),
  null,
  2,
)}

Now look at the attached image yourself and judge what rules cannot measure:
- text that is too small or too thin to read in print (business card: under about 7 pt is risky)
- low contrast between text and background
- spelling mistakes or obviously wrong details (for example an email or phone number that looks broken)
- important elements that look cut off or crowded

Reply with ONLY a JSON object, no other text, in this shape:
{
  "verdict": "ready" | "fix_first" | "high_reprint_risk",
  "summary": "one or two plain sentences",
  "fixes": [ { "problem": "...", "how_to_fix": "concrete steps in common design tools", "found_by": "automatic check" | "visual review" } ],
  "visual_notes": [ "short observations from looking at the design, including positive ones" ],
  "customer_message": "a short, friendly message the shop could send to this customer"
}
Order "fixes" from most to least important. Use an empty list when there is nothing to fix. Keep everything brief and concrete.`;
}

async function askModel(prompt, imageBlob) {
  // Route 1: built-in capability inside claude.ai
  if (claudeSample) {
    let images;
    try {
      const lim = await claudeSample.limits();
      if (lim && lim.images) images = [imageBlob];
    } catch {}
    const res = await claudeSample(prompt, { images, modelTier: "default" });
    return res.text;
  }
  // Route 2: Anthropic API with the user's own key
  const key = $("apiKey").value.trim();
  if (!key) throw new Error("Enter an Anthropic API key first.");
  const b64 = await new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result.split(",")[1]);
    fr.readAsDataURL(imageBlob);
  });
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: b64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  const data = await resp.json();
  return data.content.map((c) => c.text || "").join("");
}

function parseJson(text) {
  // Models sometimes wrap JSON in ``` fences: take the part between the first { and the last }.
  const a = text.indexOf("{"),
    b = text.lastIndexOf("}");
  return JSON.parse(text.slice(a, b + 1));
}

const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

$("aiBtn").addEventListener("click", async () => {
  if (!lastRun) return;
  const out = $("aiOut"),
    btn = $("aiBtn");
  btn.disabled = true;
  out.innerHTML = '<span class="spinner"></span>Looking at your design…';
  try {
    const r = parseJson(await askModel(buildPrompt(lastRun), lastRun.image));
    const label =
      {
        ready: "✅ Ready to print",
        fix_first: "⚠️ Fix these first",
        high_reprint_risk: "❌ High risk of a reprint",
      }[r.verdict] || r.verdict;
    out.innerHTML = `
      <p><strong>${esc(label)}</strong><br>${esc(r.summary)}</p>
      ${
        r.fixes && r.fixes.length
          ? `<strong>What to fix, in order</strong><ol>${r.fixes
              .map(
                (f) =>
                  `<li><strong>${esc(f.problem)}</strong> <span class="tag">· ${esc(f.found_by)}</span><br>${esc(f.how_to_fix)}</li>`,
              )
              .join("")}</ol>`
          : ""
      }
      ${r.visual_notes && r.visual_notes.length ? `<p style="margin-top:10px"><strong>What the AI saw</strong></p><ul>${r.visual_notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <p style="margin-top:10px"><strong>Message for the customer</strong></p>
      <div class="msg" id="custMsg">${esc(r.customer_message)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" id="copyMsg">Copy message</button><span id="msgCopied"></span></div>`;
    $("copyMsg").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(r.customer_message);
        $("msgCopied").textContent = "Copied";
      } catch {
        $("msgCopied").textContent = "Copy not allowed here.";
      }
    });
  } catch (e) {
    const why =
      e && e.code === "rate_limited"
        ? "Too many requests right now. Try again in a minute."
        : e && e.code === "not_granted"
          ? "AI access was not allowed for this page."
          : (e && e.message) || "Something went wrong.";
    out.innerHTML = `<p class="note">AI review not available: ${esc(why)} The automatic checks above still apply.</p>`;
  } finally {
    btn.disabled = false;
  }
});

// ---- Sample files: try the checker without your own design ----
document.querySelectorAll("[data-sample]").forEach((b) =>
  b.addEventListener("click", async () => {
    try {
      const r = await fetch(b.dataset.sample);
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      $("product").value = b.dataset.product || $("product").value;
      handleFile(
        new File([blob], b.dataset.sample.split("/").pop(), {
          type: blob.type,
        }),
      );
    } catch {
      alertSample();
    }
  }),
);
function alertSample() {
  $("sampleNote").textContent =
    "Samples load when the page is served (GitHub Pages or Live Server), not from a double-clicked file.";
}
