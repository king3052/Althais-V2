# Althais Claim Check (browser extension prototype)

Checks each claim as the biller opens it in their EMR. A small Althais badge on the claim screen shows **Ready to submit**, **Worth a look** or **Fix first**, outlines the fields to fix, and warns if someone presses the EMR's Submit button while the claim still has problems. A side panel holds the full breakdown, manual editing and settings.

## Install (Chrome or Edge)
1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. Press **Load unpacked** and choose this `extension` folder. Pin the Althais icon from the puzzle-piece menu.
3. In Althais, open **Revenue › Connect EMR › Browser Extension** and press **Connect This Browser**. That's it: no token to copy.
   (If the button isn't there, reload the Althais page. You can also press **Create Token** and paste it under the gear in the side panel.)

## Use
- Open a claim in your EMR. The first time on a new site, click the Althais icon, press **Read page** and choose **Allow**. From then on the badge appears on that site by itself.
- Click the badge for the problems and how to fix each one. **Show on page** scrolls to the field and flashes its outline.
- Drag the badge anywhere; it remembers the spot for each site. **Alt+Shift+A** shows or hides it.
- **Hide on this site** turns it off for that site. Turn it back on under the gear in the side panel.
- The toolbar icon shows the number of problems on the current claim.

## Test it with fake patients
Open `/static/mock-emr/index.html` on your Althais server. Seven synthetic claims each carry a known problem (no diagnosis, an ICD-9 code, NCCI bundling, a $0 charge, an aging visit, no payer). Click through them and watch the badge.

## How it works
- `content.js` runs in each frame of a site you allowed (EMRs like athenaOne put claim screens inside frames). It notices page changes, reads the page with `parse.js` when asked, outlines fields, and draws the badge in an isolated layer that can't change the EMR's styling.
- `background.js` merges what every frame found, asks Althais to check it (only when the claim changed), and sends the result to the page, the toolbar badge and the side panel.
- `pair.js` runs only on Althais's own pages and handles the one-click connection.
- `panel.html` / `panel.js` is the side panel: full results, manual edits, Fetch by claim ID (athenahealth), the page report, and settings, including turning the on-page overlay off.

## What it does and doesn't do
- Reads only sites you allowed, plus Althais's own test screens.
- Looks for claim ID, date of service, payer, CPT/HCPCS, ICD-10, modifiers and charge. It never looks for or sends the patient's name or date of birth.
- Sends those fields to Althais with a revocable token. Althais stores nothing about the check.
- Never edits the EMR and never blocks a click, including Submit. It's a pre-submission check, not a guarantee of payment.
- Page reading is pattern based. On a layout it hasn't seen it may miss fields; the side panel's page report (every value masked) helps tune it.

## Before real patient data
Test on sandbox or test data only until the practice has a signed agreement with Althais. Drawing on top of an EMR's screens should also be cleared against that vendor's terms for third-party tools before a clinic uses it.
