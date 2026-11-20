import { test } from "node:test";
import assert from "node:assert/strict";
import { domainListed, PERSONAL_EMAIL_DOMAINS } from "../../src/shared/builder.ts";
import { PERSONAL_EMAIL_DOMAIN_LIST } from "../../src/server/data/personalEmailDomains.ts";

const list = new Set([...PERSONAL_EMAIL_DOMAIN_LIST.split("\n"), ...PERSONAL_EMAIL_DOMAINS]);

test("the list is the size of the two open lists, and every entry is a domain", () => {
  assert.ok(list.size > 30000, String(list.size));
  for (const entry of list) assert.match(entry, /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/);
});

test("personal mailbox providers and throwaway inboxes are on it", () => {
  for (const domain of ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "gmx.com", "qq.com", "comcast.net", "hey.com", "mailinator.com", "yopmail.com", "guerrillamail.com", "10minutemail.com"]) assert.equal(domainListed(list, domain), domain, domain);
});

test("a mailbox at a sub-domain of a listed provider is caught by the provider", () => {
  assert.equal(domainListed(list, "mail.gmail.com"), "gmail.com");
  assert.equal(domainListed(list, "GMAIL.com"), "gmail.com");
});

test("company, school and public-body domains are not on it", () => {
  for (const domain of ["onboarded.com", "nike.com", "cloudflare.com", "adecco.com", "randstad.com", "kellyservices.com", "roberthalf.com", "bullhorn.com", "microsoft.com", "apple.com", "amazon.com", "google.com", "ibm.com", "marriott.com", "harvard.edu", "ca.gov", "nhs.uk", "larkspur-staffing.example"]) assert.equal(domainListed(list, domain), null, domain);
});

test("a bare ending is never matched", () => {
  assert.equal(domainListed(new Set(["com"]), "anything.com"), null);
  assert.equal(domainListed(new Set(["com"]), "com"), null);
  assert.equal(domainListed(list, ""), null);
});
