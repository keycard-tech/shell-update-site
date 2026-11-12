// The verify page fails silently more easily than any other page here: a typo in an id leaves a button
// dead, a class missing from the stylesheet leaves a QR on a background its camera cannot read, and
// neither shows up as a failed request. These read the source rather than run it, because the checks are
// textual and a DOM harness would be a larger dependency than the page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ARTIFACTS } from "../scripts/site.mjs";

const PAGE = readFileSync(new URL("../templates/verify.html", import.meta.url), "utf8");
const SCRIPT = readFileSync(new URL("../src/js/verify.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/css/style.css", import.meta.url), "utf8");

const idsInPage = new Set([...PAGE.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const idsWanted = [...SCRIPT.matchAll(/getElementById\("([^"]+)"\)|new Html5Qrcode\("([^"]+)"\)/g)].map((match) => match[1] ?? match[2]);

test("every element the page reaches for is in the markup", () => {
  const missing = [...new Set(idsWanted)].filter((id) => !idsInPage.has(id));

  assert.deepEqual(missing, [], `no markup for ${missing.join(", ")}`);
  assert.ok(idsWanted.length > 10, "the page is expected to reach for a lot of elements; finding none means the grep broke");
});

// The four steps are what makes this the old verification flow, camera handling and all; a fifth screen
// of our own invention is the thing that was wrong with the first port.
test("the page is the old four step flow", () => {
  for (const step of ["kpro_web__verify-step1", "kpro_web__verify-step2", "kpro_web__verify-step3", "kpro_web__verify-step4"]) {
    assert.ok(idsInPage.has(step), `${step} is missing`);
  }
});

// Step 4 of the old flow drew a second QR, generated here, for the Shell to scan so the device could
// check the site. There is no such QR now: the site has nothing to be trusted about, since the answer is
// computed here against a file this page authenticated itself.
test("the page generates no QR of its own after the response", () => {
  for (const name of ["device_success__qr", "verify-success-qr-container", "success-qr"]) {
    assert.ok(!PAGE.includes(name), `${name} is back in the markup`);
    assert.ok(!SCRIPT.includes(name), `${name} is back in the script`);
  }

  assert.equal([...SCRIPT.matchAll(/displayQr|new QRious/g)].length, 2, "exactly one QR, the challenge: one construction, one draw");
});

test("the challenge is shown blurred until the allowlist has authenticated", () => {
  assert.match(PAGE, /<canvas class="keycard_shell__qr keycard_shell__qr-blurred" id="device_verify__qr">/);
  assert.match(PAGE, /id="device_verify__qr-loading"/);
  assert.match(SCRIPT, /classList\.remove\("keycard_shell__qr-blurred"\)/);
  assert.match(SCRIPT, /getElementById\("device_verify__qr-loading"\)/);
  assert.match(CSS, /\.keycard_shell__qr-blurred\s*\{[^}]*filter:\s*blur/);
});

// Blurred and labelled is only worth anything if nobody can get past it meanwhile: the button is disabled
// in the markup, not enabled by the script and disabled later.
test("there is nothing to click until the allowlist is verified", () => {
  assert.match(PAGE, /id="device_verify__next-button"[^>]*disabled|disabled[^>]*id="device_verify__next-button"/);
  assert.match(SCRIPT, /if \(allowlist === null\) return;/);
});

// The page must not reach past its document for a file: the document is what the sync certifies and what
// check-site compares against what is served.
test("the page reads a document and never an artifact", () => {
  assert.match(PAGE, /id="device_verify__media-prefix"[^>]*value="\{% get_media_prefix %\}"/);
  assert.match(SCRIPT, /get-units\.json/);

  for (const name of Object.values(ARTIFACTS)) {
    assert.ok(!SCRIPT.includes(`"${name}"`), `verify.ts names ${name} directly; get-units.json is what names it`);
  }
});

test("every class the page uses is in the stylesheet", () => {
  const used = new Set([...PAGE.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean));
  const missing = [...used].filter((name) => !CSS.includes(`.${name}`));

  assert.deepEqual(missing, [], `${missing.join(", ")} used but never styled`);
});

// `.keycard_shell__display-none` is a plain `display: none` in the middle of a 2700 line stylesheet, so any
// rule after it that gives the same element a display of its own wins, and that element can never be hidden.
// That is how "Loading the allowlist…" stayed on screen forever: the overlay needs `display: flex`, and the
// utility could no longer touch it. A class that sets display down here must outrank the utility explicitly.
test("nothing the page hides has a display that outranks the hide utility", () => {
  const utility = CSS.indexOf(".keycard_shell__display-none {");

  assert.ok(utility > 0, "the hide utility is missing from the stylesheet");

  const used = [...new Set([...PAGE.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean))];

  for (const name of used) {
    if (name === "keycard_shell__display-none") continue;

    const fighting = [...CSS.matchAll(new RegExp(`\\.${name}(?![\\w-])([^{]*)\\{[^}]*\\}`, "g"))].filter(
      (rule) => rule.index !== undefined && rule.index > utility && /display:\s*/.test(rule[0]) && !rule[1].includes("keycard_shell__display-none"),
    );

    if (fighting.length === 0) continue;

    assert.ok(
      CSS.includes(`.${name}.keycard_shell__display-none`),
      `.${name} sets a display in ${fighting.length} rule(s) below the hide utility, so nothing could hide it: add .${name}.keycard_shell__display-none { display: none }`,
    );
  }
});
