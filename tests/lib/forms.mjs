// Fills Onboarded's hosted onboarding forms the way a candidate would, page by page.
// Every value it types is made up (the SSN and date of birth below are not anyone's).

export const snapshot = (frame) => frame.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const heading = [...document.querySelectorAll("h1,h2,h3")].filter(vis).map((h) => h.innerText.trim()).slice(0, 4);
  const items = [];
  for (const el of document.querySelectorAll("input, select, textarea, button, [role=radio], [role=checkbox], [role=combobox], canvas")) {
    if (!vis(el)) continue;
    const attrs = {};
    for (const a of el.attributes) if (/^(id|name|type|role|data-testid|data-state|aria-pressed|aria-checked|aria-invalid|placeholder|disabled)$/.test(a.name)) attrs[a.name] = a.value.slice(0, 60);
    const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (el.tagName === "BUTTON" && !text && !attrs.id && !attrs["data-testid"]) continue;
    items.push({ tag: el.tagName.toLowerCase(), ...attrs, text, val: "value" in el ? String(el.value).slice(0, 30) : undefined });
  }
  const errors = [...document.querySelectorAll("[role=alert], [aria-invalid=true]")].filter(vis).map((e) => (e.innerText || e.id || "").trim().slice(0, 120)).filter(Boolean).slice(0, 8);
  return { url: location.pathname + location.search, heading, items, errors, body: document.body.innerText.slice(0, 400) };
});

const TEXT_VALUES = [
  [/social_security_number/, "512-45-6789"],
  [/date_of_birth/, "1994-03-14"],
  [/(_total|_amount|allowances|_count)$/, "0"],
];

/** Fills what one page asks for. `choices` maps a field id (or testid) to the option or button text to pick. */
export async function fillPage(frame, opts = {}) {
  // Answers can reveal more fields: fill until a pass finds nothing new.
  const done = new Set();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = done.size;
    await fillPass(frame, opts, done);
    if (done.size === before) break;
    await frame.waitForTimeout(250);
  }
}

async function fillPass(frame, { pace = 0, choices = {}, files = null, signer = null, log = () => {} } = {}, done = new Set()) {
  const wait = (ms) => (ms > 0 ? frame.waitForTimeout(ms) : Promise.resolve());

  // Option-button groups: several buttons share one name; pick the wanted one, else the first.
  const names = await frame.locator("button[name]").evaluateAll((bs) => [...new Set(bs.filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("name")))]);
  for (const name of names) {
    if (done.has(`group:${name}`)) continue;
    const group = frame.locator(`button[name="${name}"]`);
    done.add(`group:${name}`);
    if (await group.evaluateAll((bs) => bs.some((b) => /(^|\s)bg-primary(\s|$)/.test(b.className)))) continue;
    const want = choices[name];
    const pick = want ? group.filter({ hasText: want }).first() : group.first();
    if ((await pick.count()) === 0) continue;
    if (await pick.isDisabled()) { done.delete(`group:${name}`); continue; }
    await pick.click(); log(`option ${name} = ${(await pick.innerText()).trim().slice(0, 40)}`); await wait(pace);
  }

  // Signatures: type the name, then the sign button (an option group of one) turns on.
  for (const input of await frame.locator('input[placeholder*="name to sign" i]').all()) {
    if (!(await input.isVisible()) || (await input.inputValue()) !== "" || !signer) continue;
    done.add(`sign:${done.size}`);
    await input.click(); await input.pressSequentially(signer, { delay: pace > 0 ? 45 : 0 }); log(`signature ${signer}`); await wait(Math.max(pace, 300));
  }
  // Segmented date fields (month / day / year spin buttons): type the digits into the first segment.
  for (const group of await frame.locator('[role="group"][id]:has([role="spinbutton"][data-placeholder])').all()) {
    if (!(await group.isVisible())) continue;
    const id = (await group.getAttribute("id")) ?? "";
    if (done.has(`segdate:${id}`)) continue;
    done.add(`segdate:${id}`);
    const iso = choices[id] ?? new Date().toLocaleDateString("en-CA");
    const [y, m, d] = iso.split("-");
    await group.locator('[role="spinbutton"]').first().click();
    const keyboard = frame.keyboard ?? frame.page().keyboard;
    await keyboard.type(`${m}${d}${y}`, { delay: pace > 0 ? 60 : 10 });
    log(`date ${id} = ${iso}`); await wait(pace);
  }
  // Native date inputs.
  for (const input of await frame.locator('input[type="date"]').all()) {
    if (!(await input.isVisible()) || (await input.inputValue()) !== "") continue;
    const id = (await input.getAttribute("id")) ?? "";
    done.add(`date:${id}`);
    const value = choices[id] ?? TEXT_VALUES.find(([re]) => re.test(id))?.[1] ?? new Date().toLocaleDateString("en-CA");
    await input.fill(value); log(`date ${id} = ${value}`); await wait(pace);
  }
  // Text inputs.
  for (const input of await frame.locator('input:not([type]), input[type="text"], input[type="tel"], input[type="number"], textarea').all()) {
    if (!(await input.isVisible()) || (await input.inputValue()) !== "" || (await input.isDisabled())) continue;
    const id = (await input.getAttribute("id")) ?? (await input.getAttribute("name")) ?? "";
    const value = choices[id] ?? TEXT_VALUES.find(([re]) => re.test(id))?.[1];
    if (value === undefined) continue;
    done.add(`text:${id}`);
    await input.click(); await input.pressSequentially(value, { delay: pace > 0 ? 35 : 0 }); log(`text ${id} = ${value}`); await wait(pace);
  }
  // Yes/No toggle groups: the Yes button carries the field id, No is its sibling.
  for (const yes of await frame.locator('button[id]:not([name]):has-text("Yes")').all()) {
    if (!(await yes.isVisible())) continue;
    const id = (await yes.getAttribute("id")) ?? "";
    if (done.has(`toggle:${id}`)) continue;
    done.add(`toggle:${id}`);
    const selected = (b) => b.evaluate((el) => /(^|\s)bg-primary(\s|$)/.test(el.className));
    const answered = await yes.locator("xpath=..").locator("button").evaluateAll((bs) => bs.some((b) => /(^|\s)bg-primary(\s|$)/.test(b.className)));
    if (answered && choices[id] === undefined) continue;
    const want = choices[id] ?? "No";
    const group = yes.locator("xpath=..");
    const target = want === "Yes" ? yes : group.locator("button", { hasText: /^No\b/ }).first();
    if ((await target.count()) === 0) continue;
    // Clicking the selected answer again would clear it.
    if (await selected(target)) continue;
    await target.click(); log(`toggle ${id} = ${want}`); await wait(pace);
  }
  // Comboboxes still on their placeholder.
  for (const combo of await frame.locator('button[role="combobox"]').all()) {
    if (!(await combo.isVisible())) continue;
    const testid = (await combo.getAttribute("data-testid")) ?? "";
    if (testid === "dropdown") continue; // the language switcher
    const text = (await combo.innerText()).trim();
    if (text !== "" && !/select/i.test(text)) continue;
    if (done.has(`combo:${testid}`)) continue;
    done.add(`combo:${testid}`);
    await combo.click(); await wait(Math.max(pace, 200));
    const options = frame.locator('[role="option"]');
    const want = choices[testid];
    let pick = want ? options.filter({ hasText: want }).first() : options.first();
    if ((await pick.count()) === 0) {
      // A search box (the address lookup): type into it and take the first suggestion.
      const search = frame.locator('[cmdk-input], [role="dialog"] input, [data-radix-popper-content-wrapper] input').first();
      if ((await search.count()) > 0) {
        await search.fill(choices[`${testid}:search`] ?? "1420 E 4th St, Los Angeles, CA");
        for (let i = 0; i < 40 && (await options.count()) === 0; i += 1) await wait(200);
        pick = options.first();
      }
    }
    if ((await pick.count()) === 0) { log(`combo ${testid}: no options`); await frame.page().keyboard.press("Escape"); done.delete(`combo:${testid}`); continue; }
    const picked = (await pick.innerText()).trim();
    await pick.click(); log(`combo ${testid} = ${picked}`); await wait(pace);
  }
  // File uploads (document photos).
  for (const input of await frame.locator('input[type="file"]').all()) {
    const id = (await input.getAttribute("id")) ?? "";
    if (done.has(`file:${id}`)) continue;
    done.add(`file:${id}`);
    if (!files) continue;
    await input.setInputFiles(files); log(`file ${id}`); await wait(Math.max(pace, 600));
  }
  // Checkboxes: tick each unticked one.
  for (const box of await frame.locator('[role="checkbox"], input[type="checkbox"]').all()) {
    if (!(await box.isVisible())) continue;
    const state = (await box.getAttribute("aria-checked")) ?? (await box.getAttribute("data-state"));
    if (state === "true" || state === "checked") continue;
    done.add(`box:${(await box.getAttribute("id")) ?? done.size}`);
    await box.click(); log(`checkbox ${(await box.getAttribute("id")) ?? ""}`); await wait(pace);
  }
}

export async function submitPage(frame) {
  const button = frame.locator('button[type="submit"]').last();
  const label = (await button.innerText()).trim();
  await button.click();
  return label;
}
