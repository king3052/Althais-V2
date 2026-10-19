# Althais Claim Check (browser extension prototype)

A side panel for Chrome or Edge. On an EMR claim screen you press **Read this page**, look over what it found, fix anything wrong, and press **Check claim**. Althais runs the same checks it runs on uploads and shows what to fix before you submit.

## Install (Windows, Chrome or Edge)
1. Open `chrome://extensions` (Edge: `edge://extensions`). Turn on **Developer mode**.
2. Press **Load unpacked** and choose this `extension` folder.
3. In Althais, go to **Revenue > Connect EMR > Browser Extension > Create Token**. Copy the token.
4. Click the Althais icon in the toolbar (pin it from the puzzle-piece menu). In the panel, press the gear, paste the token, press **Test connection**.

## Use
Open a claim in your EMR, press **Read this page**. The first time on a site Chrome asks to allow reading it. Check the fields, press **Check claim**.

## Automatic mode (v0.4)
With **Automatic** on (the default), keep the panel open and click through claims in your EMR. Althais reads each claim as it opens and checks it, without pressing anything.
- It only runs while the side panel is open and visible. Close the panel and nothing runs.
- It only reads sites you've allowed. The first time on a new site, press **Read this page** once and choose Allow.
- If you edit a field, your edit is kept until you move to a different claim.
- It ignores pages with no procedure or diagnosis codes, and never auto-reads Althais's own app pages.
- Turn the switch off to go back to pressing the button for each claim.

## Two extra tools (v0.2)
- **Frames:** EMRs like athenaOne put claim screens inside frames. Read this page now looks inside all of them and merges the results. Chrome asks once per site.
- **Fetch by claim ID:** if athenahealth is connected in Althais, press *Fetch codes from athenahealth by claim ID*. Althais reads the claim through the API, so layout guessing isn't needed. Only codes, payer, date and charge come back.
- **Page report:** under *Trouble reading a page?* builds a layout report with every value masked (letters become a, digits become 9). Send it to Althais so the reader can be tuned to that screen.

## What it does and doesn't do
- Reads the page when you press the button, or automatically while the panel is open on a site you've allowed. Nothing runs when the panel is closed.
- Looks for claim ID, date of service, payer, CPT/HCPCS, ICD-10, modifiers, charge. It does not look for or send patient name or date of birth.
- Sends those fields to Althais with a revocable token. Althais stores nothing about the check.
- It is a pre-submission check, not a guarantee of payment. It never edits the EMR.
- Page reading is pattern based. On an EMR layout it hasn't seen it may miss fields or guess; the panel says when it guessed, and you can type values in.

## Before real patient data
Test on sandbox or test data only until your practice has a signed agreement with Althais and has checked the EMR vendor's terms for third-party tools.
