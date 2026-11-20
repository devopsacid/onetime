# Abuse runbook (internal)

How the operator of the hosted site (`https://onetimepass.pages.dev`) handles abuse notices and orders from
authorities. The public side is the privacy page's `#abuse` section (single point of contact, what a notice must
contain) and `/terms#moderation`. Contact: michal@maxian.sk, Slovak and English.

Ground rules, always:

- **Never open a reported link with its key.** Not to check, not to "confirm". Deletion needs only the id.
- **Never store or forward a key.** If a reporter sends a full link, cut out the id, delete the rest from the record
  and from any reply you quote, and tell the reporter not to send keys.
- The service has no accounts, IP addresses, request logs, keys or readable contents. Nothing can be looked up about
  a sender, and nothing else may be promised.

## 1. A notice from a user

1. **Confirm receipt** by email, the same day if possible. Short and plain, e.g. "We received your notice about
   item `<id>` and will reply with the decision."
2. **Validate the notice.** It should have: the id, why the content is illegal, the reporter's name and email (not
   required for child sexual abuse material: never ask for it then), and a good-faith statement. A missing reason or
   statement is a reason to ask once, not to ignore the notice; anything about child sexual abuse material or a
   threat to someone's life is acted on at once.
3. **Validate the id.** It is the part of the link between the first and the second dot (`#2f.<id>.<key>`), or before
   the only dot for older links (`#<id>.<key>`). It must match `^[A-Za-z0-9_-]{22}$`. The script below checks this
   too and accepts a pasted link, taking only the id.
4. **Delete it:**

   ```sh
   node tools/burn-id.mjs https://onetimepass.pages.dev '<id>'
   ```

   It sends only the id and prints `deleted` (it was stored and is gone) or `not stored` (already opened, expired,
   or a wrong id). Exit code 5 means a network or server error: try again later. Fallback, with the owner's approval:
   `wrangler d1 execute onetime --remote --command "DELETE FROM secrets WHERE id = '<validated id>'"`.
5. **Reply with the decision**: deleted, or no longer stored (nothing left to delete), or not acted on and why. Say
   that contents cannot be read, the sender cannot be identified or told, and that D1 keeps encrypted data in its
   recovery history for 7 days (never keys).
6. **Keep a minimal record**, one line per notice, in a private file outside the repo:
   `date received | date handled | id | outcome (deleted / not stored / rejected: reason) | authority or user`.
   No keys, no links, no copies of contents. Keep the reporter's email only in the mail thread, not in the record.

## 2. An order from an authority

Treat any order from a court, police or another authority (Slovak or from another EU member state) as urgent and act
**without undue delay**.

- **Removal order** (remove specific content): take the id from the order, check it as in 1.3, run `burn-id.mjs`,
  and tell the issuing authority what was done and when (`deleted` with the time, or `not stored`: already opened or
  expired). If the order gives only a full link, use only its id.
- **Information order** (provide data about a user or an item): answer honestly that the service has no accounts and
  its code keeps no IP addresses, request logs, keys or readable contents, so there is no such data to provide. A
  stored item exists only as encrypted data until it is opened or expires. Cloudflare, the host, handles connections
  like any host; questions about its data go to Cloudflare. Do not guess or add anything beyond this.
- Keep the order and the reply in the mail archive and add a line to the record.

## 3. Threats to life or safety (Art. 18 DSA)

If a notice or anything else gives reason to suspect a criminal offence that threatens someone's life or safety
(happened, happening, or likely), **inform the police at once** with all information you have (the notice text, the
id, dates; never a key). In Slovakia: 158
(police) or 112 (EU emergency number) for urgent cases. Then handle the item as in section 1.

## 4. Digital Services Coordinator

Slovakia's Digital Services Coordinator is the **Rada pre mediálne služby** (Council for Media Services), Bratislava
(**verify** the current name, address and contact before relying on it). It supervises this service under the DSA;
keep its contact at hand for questions and for orders it forwards.

## 5. Terrorist content (Regulation (EU) 2021/784)

The Terrorist Content Online Regulation obliges hosting providers to remove content within **one hour** of a removal
order. It probably does not apply here, because one-time links are private and not disseminated to the public. The
procedure above meets it anyway: `burn-id.mjs` deletes an item within seconds, so a removal order is met as long as
it is read and acted on within the hour.

## Self-hosted instances

The same script works for any instance: `node tools/burn-id.mjs https://<instance> '<id>'`. Each operator is
responsible for their own instance; this runbook does not cover them.
