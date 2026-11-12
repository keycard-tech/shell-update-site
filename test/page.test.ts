// This page fails silently more easily than any other here, so these read the template and the script instead of running them

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

// The four steps are what makes this the old verification flow, camera handling and all
test("the page is the old four step flow", () => {
  for (const step of ["kpro_web__verify-step1", "kpro_web__verify-step2", "kpro_web__verify-step3", "kpro_web__verify-step4"]) {
    assert.ok(idsInPage.has(step), `${step} is missing`);
  }
});

// Step 4 of the old flow drew a second QR for the Shell to scan; there is nothing left for it to say
test("the page generates no QR of its own after the response", () => {
  for (const name of ["device_success__qr", "verify-success-qr-container", "success-qr"]) {
    assert.ok(!PAGE.includes(name), `${name} is back in the markup`);
    assert.ok(!SCRIPT.includes(name), `${name} is back in the script`);
  }

  assert.equal([...SCRIPT.matchAll(/new QRious\(/g)].length, 1, "exactly one QR on this page: the challenge");
  assert.match(SCRIPT, /verifyQR\.set\(\{ size: QR_SIZE, value: urEncode\(DEV_AUTH_TYPE, encodeDevAuthInit\(challenge\)\) \}\)/);
  assert.ok(!/qrcode-generator|jsQR|toDataURL/.test(SCRIPT + PAGE), "a second QR generator is back");
});

test("the challenge is shown blurred until the allowlist has authenticated", () => {
  assert.match(PAGE, /<canvas class="keycard_shell__qr keycard_shell__qr-blurred" id="device_verify__qr">/);
  assert.match(PAGE, /id="device_verify__qr-loading"/);
  assert.match(SCRIPT, /classList\.remove\("keycard_shell__qr-blurred"\)/);
  assert.match(SCRIPT, /getElementById\("device_verify__qr-loading"\)/);
  assert.match(CSS, /\.keycard_shell__qr-blurred\s*\{[^}]*filter:\s*blur/);
});

// Blurred and labelled is only worth anything if nobody can get past it meanwhile
test("there is nothing to click until the allowlist is verified", () => {
  assert.match(PAGE, /id="device_verify__next-button"[^>]*disabled|disabled[^>]*id="device_verify__next-button"/);
  assert.match(SCRIPT, /if \(allowlist === null\) return;/);
});

// The page must not reach past its document for a file: the document is what the sync certifies
test("the page reads a document and never an artifact", () => {
  assert.match(PAGE, /id="device_verify__media-prefix"[^>]*value="\{% get_media_prefix %\}"/);
  assert.match(SCRIPT, /get-units\.json/);

  for (const name of Object.values(ARTIFACTS)) {
    assert.ok(!SCRIPT.includes(`"${name}"`), `verify.ts names ${name} directly; get-units.json is what names it`);
  }
});

// One destination for someone who needs help: the article the copy links is the one the result button opens
test("the help article in the copy is the one the result button opens", () => {
  const [, article] = PAGE.match(/href="(https:\/\/keycard\.tech\/[^"]*verify[^"]*)"/) ?? [];

  assert.ok(article !== undefined, "the page links to no article of its own");
  assert.ok(SCRIPT.includes(`"${article}"`), "verify.ts sends a visitor somewhere else");
});

// Nothing identifying about the Shell reaches the screen, whichever verdict came
test("the result names neither the key nor the uid", () => {
  assert.ok(!/device\.hex|err\.uid|pubkey/.test(SCRIPT), "the result line carries device identity");
  assert.match(SCRIPT, /verifyDeviceResponse\(allowlist, challenge, payload\);/);
  assert.match(SCRIPT, /producedUnitsListUpdated\(updatedOn\(allowlist\.version\)\)/);
});

test("every class the page uses is in the stylesheet", () => {
  const used = new Set([...PAGE.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean));
  const missing = [...used].filter((name) => !CSS.includes(`.${name}`));

  assert.deepEqual(missing, [], `${missing.join(", ")} used but never styled`);
});

// .keycard_shell__display-none is a plain display:none mid-stylesheet, so any later rule giving the same element a display of its own needs a compound rule to be hidden at all
test("nothing the page hides has a display that outranks the hide utility", () => {
  const utility = CSS.indexOf(".keycard_shell__display-none {");
  const steps = SCRIPT.slice(SCRIPT.indexOf("const steps = ["), SCRIPT.indexOf("];", SCRIPT.indexOf("const steps = [")));

  // the elements this script hides: the step array, and anything else it toggles the utility on
  const hidden = new Set([...steps.matchAll(/getElementById\("([^"]+)"/g)].map((match) => match[1]));

  for (const [, name, id] of SCRIPT.matchAll(/const (\w+) = document\.getElementById\("([^"]+)"\)/g)) {
    if (new RegExp(`${name}\\.classList\\.(add|toggle)\\(HIDE`).test(SCRIPT)) hidden.add(id);
  }

  assert.ok(utility > 0, "the hide utility is missing from the stylesheet");
  assert.equal(hidden.size, 5, `expected the four steps and the loading overlay, found ${[...hidden].join(", ") || "nothing"}`);

  for (const id of hidden) {
    const classes = new Set([...PAGE.matchAll(new RegExp(`class="([^"]+)"[^>]*id="${id}"|id="${id}"[^>]*class="([^"]+)"`, "g"))].flatMap((match) => (match[1] ?? match[2]).split(/\s+/)));

    for (const name of classes) {
      const fighting = [...CSS.matchAll(new RegExp(`\\.${name}(?![\\w-])([^{]*)\\{[^}]*\\}`, "g"))].filter(
        (rule) => rule.index !== undefined && rule.index > utility && /display:\s*/.test(rule[0]) && !rule[1].includes("keycard_shell__display-none"),
      );

      assert.ok(
        fighting.length === 0 || CSS.includes(`.${name}.keycard_shell__display-none`),
        `.${name} sets a display in ${fighting.length} rule(s) below the hide utility, so ${id} could never be hidden: add .${name}.keycard_shell__display-none { display: none }`,
      );
    }
  }
});
