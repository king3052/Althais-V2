# Althais Claim Check (browser extension prototype)

A side panel for Chrome or Edge. On an EMR claim screen you press **Read this page**, look over what it found, fix anything wrong, and press **Check claim**. Althais runs the same checks it runs on uploads and shows what to fix before you submit.

## Install (Windows, Chrome or Edge)
1. Open `chrome://extensions` (Edge: `edge://extensions`). Turn on **Developer mode**.
2. Press **Load unpacked** and choose this `extension` folder.
3. In Althais, go to **Revenue > Connect EMR > Browser Extension > Create Token**. Copy the token.
4. Click the Althais icon in the toolbar (pin it from the puzzle-piece menu). In the panel, press the gear, paste the token, press **Test connection**.

## Use
Open a claim in your EMR, press **Read this page**. The first time on a site Chrome asks to allow reading it. Check the fields, press **Check claim**.

## What it does and doesn't do
- Reads the page only when you press the button. Nothing runs in the background.
- Looks for claim ID, date of service, payer, CPT/HCPCS, ICD-10, modifiers, charge. It does not look for or send patient name or date of birth.
- Sends those fields to Althais with a revocable token. Althais stores nothing about the check.
- It is a pre-submission check, not a guarantee of payment. It never edits the EMR.
- Page reading is pattern based. On an EMR layout it hasn't seen it may miss fields or guess; the panel says when it guessed, and you can type values in.

## Before real patient data
Test on sandbox or test data only until your practice has a signed agreement with Althais and has checked the EMR vendor's terms for third-party tools.
